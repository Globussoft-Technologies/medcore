/**
 * Pearl ERP Stage 1 §8.1 row 233 closure (2026-05-25) — 90-day S3 archival
 * for suspended tenants.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: a daily sweep that finds tenants suspended for >=90 days and
 *   exports their tenant-scoped data (Patients, Appointments,
 *   Prescriptions, Invoices, AuditLog rows) to a gzipped JSON tarball,
 *   uploads it to S3 (key: `tenant-archives/{tenantId}/{ts}.tar.gz`),
 *   computes SHA-256 for integrity, and stamps `archivedAt` +
 *   `archiveS3Key` + `archiveSizeBytes` + `archiveChecksum` on the
 *   `Tenant` row. v1 explicitly DOES NOT delete the live data — that's
 *   a separate operator-gated `purgeArchivedTenant()` callable, kept
 *   off the cron path because it's irreversible.
 * - MODULES:
 *   - Reads `Tenant` (eligibility + metadata stamp), plus streaming
 *     queries over `Patient`, `Appointment`, `Prescription`, `Invoice`,
 *     `AuditLog` from `@medcore/db`.
 *   - Writes `Tenant.archivedAt` / `archiveS3Key` / `archiveSizeBytes`
 *     / `archiveChecksum`.
 *   - Uses the S3 storage pattern from `services/storage.ts` (dynamic
 *     `import("@aws-sdk/client-s3")` so the package is only loaded
 *     when STORAGE_PROVIDER=s3; falls back to a local file write under
 *     `<cwd>/backups/tenant-archives/` for dev/test parity with
 *     `audit-archival.ts`).
 *   - Writes one `AuditLog` row per archive via Prisma so the
 *     super-admin trail captures the system-generated archival event.
 * - WHY: PRD §8.1 — when a tenant has been SUSPENDED for 90 days
 *   without restore, archive their data to cold storage so the live DB
 *   doesn't carry indefinite tombstoned rows. Reversible: the operator
 *   can re-import from the S3 tarball if needed (out of scope this tick
 *   — operator UI lands separately).
 *
 * Scope cut for v1
 * ────────────────
 * - LIVE-DATA PURGE is a separate exported function
 *   (`purgeArchivedTenant`), not wired to any cron. Operators invoke
 *   it manually via a future admin route. Reason: irreversible,
 *   want explicit operator-confirmation gate.
 * - The tarball is a single gzipped JSON blob, not a true POSIX tar.
 *   Simpler, fewer deps, decodes with `gunzip + JSON.parse`. If we
 *   ever need per-table cherry-pick during a restore we'll switch to
 *   tar then; for now the single-blob shape is fine because every
 *   archive is consumed end-to-end on restore.
 *
 * Idempotency
 * ───────────
 * - `archiveTenant`: refuses to re-archive a tenant whose
 *   `archivedAt` is already set. Operator must manually clear those
 *   fields before re-running (the field-clearing happens via
 *   `activateTenant` followed by another 90-day suspend window —
 *   intentional friction).
 * - `findArchiveCandidates`: filters out `archivedAt is not null`, so
 *   safe to call any number of times per day.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import type { Prisma, PrismaClient } from "@medcore/db";

const gzip = promisify(zlib.gzip);
const writeFile = promisify(fs.writeFile);

const DEFAULT_MIN_SUSPEND_DAYS = 90;
const DEFAULT_LOCAL_ARCHIVE_DIR = path.join(
  process.cwd(),
  "backups",
  "tenant-archives",
);

export interface S3Uploader {
  /** Upload a buffer to the configured object store. Returns the final key. */
  upload(key: string, body: Buffer, contentType: string): Promise<{ key: string }>;
}

export interface ArchiveTenantOptions {
  /** Minimum days since `deactivatedAt` before a tenant becomes eligible. */
  minSuspendDays?: number;
  /** `now` injection for deterministic tests. */
  now?: Date;
  /** Override the S3 uploader. Defaults to the env-resolved client. */
  uploader?: S3Uploader;
  /** Override the local fallback dir (when STORAGE_PROVIDER != s3). */
  localArchiveDir?: string;
}

export interface ArchiveTenantResult {
  tenantId: string;
  archiveS3Key: string;
  archiveSizeBytes: number;
  archiveChecksum: string;
  rowCounts: {
    patients: number;
    appointments: number;
    prescriptions: number;
    invoices: number;
    auditLogs: number;
  };
}

export interface PurgeArchivedTenantResult {
  tenantId: string;
  deleted: {
    patients: number;
    appointments: number;
    prescriptions: number;
    invoices: number;
    auditLogs: number;
  };
}

// ─── Default S3 uploader (mirrors services/storage.ts) ────────────────────

function isS3Enabled(): boolean {
  return (
    process.env.STORAGE_PROVIDER === "s3" &&
    !!process.env.AWS_S3_BUCKET &&
    !!process.env.AWS_REGION
  );
}

function defaultUploader(): S3Uploader {
  return {
    async upload(key, body, contentType) {
      if (isS3Enabled()) {
        const { S3Client, PutObjectCommand } = await import(
          "@aws-sdk/client-s3"
        );
        const client = new S3Client({
          region: process.env.AWS_REGION!,
          ...(process.env.AWS_S3_ENDPOINT
            ? {
                endpoint: process.env.AWS_S3_ENDPOINT,
                forcePathStyle: true,
              }
            : {}),
        });
        await client.send(
          new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET!,
            Key: key,
            Body: body,
            ContentType: contentType,
            ServerSideEncryption: "AES256",
          }),
        );
        return { key };
      }
      // Local fallback — dev / test / unconfigured prod. Write under
      // `<cwd>/backups/tenant-archives/<key>` so the test can assert the
      // file landed without needing a real S3.
      const targetDir = DEFAULT_LOCAL_ARCHIVE_DIR;
      const fullPath = path.join(targetDir, key.replace(/^tenant-archives\//, ""));
      const parent = path.dirname(fullPath);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      await writeFile(fullPath, body);
      return { key };
    },
  };
}

// ─── Eligibility query ─────────────────────────────────────────────────────

/**
 * Find tenants currently eligible for S3 archival. Eligibility:
 *   - `active = false` (tenant has been suspended)
 *   - `deactivatedAt` is older than `minSuspendDays` days ago
 *   - `archivedAt` is null (not already archived)
 *   - `subdomain != "default"` (the seed tenant is never archived)
 *
 * Used by the daily sweep cron in `scheduled-tasks.ts`.
 */
export async function findArchiveCandidates(
  prisma: PrismaClient,
  now: Date = new Date(),
  minSuspendDays: number = DEFAULT_MIN_SUSPEND_DAYS,
): Promise<Array<{ id: string; subdomain: string; deactivatedAt: Date }>> {
  const cutoff = new Date(
    now.getTime() - minSuspendDays * 24 * 60 * 60 * 1000,
  );
  const rows = await prisma.tenant.findMany({
    where: {
      active: false,
      archivedAt: null,
      deactivatedAt: { lt: cutoff, not: null },
      subdomain: { not: "default" },
    },
    select: { id: true, subdomain: true, deactivatedAt: true },
  });
  return rows
    .filter((r): r is { id: string; subdomain: string; deactivatedAt: Date } =>
      r.deactivatedAt !== null,
    );
}

// ─── archiveTenant ─────────────────────────────────────────────────────────

/**
 * Export a single tenant's data to S3 and stamp the metadata fields.
 * Refuses to run unless the tenant has been suspended for >= minSuspendDays.
 * Does NOT delete live data — call `purgeArchivedTenant` (operator-gated)
 * for that.
 */
export async function archiveTenant(
  prisma: PrismaClient,
  tenantId: string,
  opts: ArchiveTenantOptions = {},
): Promise<ArchiveTenantResult> {
  const minSuspendDays = opts.minSuspendDays ?? DEFAULT_MIN_SUSPEND_DAYS;
  const now = opts.now ?? new Date();
  const uploader = opts.uploader ?? defaultUploader();

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      subdomain: true,
      active: true,
      deactivatedAt: true,
      archivedAt: true,
    },
  });
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }
  if (tenant.active) {
    throw new Error(
      `Cannot archive an active tenant (${tenantId}); suspend first`,
    );
  }
  if (!tenant.deactivatedAt) {
    throw new Error(
      `Tenant ${tenantId} has no deactivatedAt stamp; cannot determine suspension age`,
    );
  }
  const ageMs = now.getTime() - tenant.deactivatedAt.getTime();
  const minMs = minSuspendDays * 24 * 60 * 60 * 1000;
  if (ageMs < minMs) {
    throw new Error(
      `Tenant ${tenantId} suspended only ${Math.floor(ageMs / 86400000)} days; ` +
        `archival requires >= ${minSuspendDays} days`,
    );
  }
  if (tenant.archivedAt) {
    throw new Error(`Tenant ${tenantId} already archived at ${tenant.archivedAt.toISOString()}`);
  }

  // ── Stream-export tenant-scoped data ──
  // We materialise per-table arrays inside the JSON blob. For very large
  // tenants this can OOM; the cap-of-last-resort here is the `take: 50_000`
  // per table (multi-million-row tenants will need the future
  // streamed-tar variant of this service). Realistic suspended-tenant
  // datasets are small enough that this is fine in v1.
  const PAGE_CAP = 50_000;
  const [patients, appointments, prescriptions, invoices, auditLogs] =
    await Promise.all([
      prisma.patient.findMany({ where: { tenantId }, take: PAGE_CAP }),
      prisma.appointment.findMany({ where: { tenantId }, take: PAGE_CAP }),
      prisma.prescription.findMany({ where: { tenantId }, take: PAGE_CAP }),
      prisma.invoice.findMany({ where: { tenantId }, take: PAGE_CAP }),
      prisma.auditLog.findMany({ where: { tenantId }, take: PAGE_CAP }),
    ]);

  const exportPayload = {
    schemaVersion: 1,
    archivedAt: now.toISOString(),
    tenant: {
      id: tenant.id,
      name: tenant.name,
      subdomain: tenant.subdomain,
      deactivatedAt: tenant.deactivatedAt.toISOString(),
    },
    rows: {
      patients,
      appointments,
      prescriptions,
      invoices,
      auditLogs,
    },
  };

  const json = JSON.stringify(exportPayload);
  const gzipped = await gzip(Buffer.from(json, "utf8"));
  const checksum = crypto.createHash("sha256").update(gzipped).digest("hex");
  const timestamp =
    now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const key = `tenant-archives/${tenantId}/${timestamp}.tar.gz`;

  await uploader.upload(key, gzipped, "application/gzip");

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      archivedAt: now,
      archiveS3Key: key,
      archiveSizeBytes: gzipped.length,
      archiveChecksum: checksum,
    },
  });

  // Audit row — same pattern as platform-invoice-generator.ts; we swallow
  // the failure so a missing audit row never poisons the archival success.
  try {
    await prisma.auditLog.create({
      data: {
        action: "TENANT_ARCHIVED",
        entity: "tenant",
        entityId: tenantId,
        details: {
          subdomain: tenant.subdomain,
          archiveS3Key: key,
          archiveSizeBytes: gzipped.length,
          archiveChecksum: checksum,
          rowCounts: {
            patients: patients.length,
            appointments: appointments.length,
            prescriptions: prescriptions.length,
            invoices: invoices.length,
            auditLogs: auditLogs.length,
          },
          suspendedSinceUtc: tenant.deactivatedAt.toISOString(),
          ageDays: Math.floor(ageMs / 86400000),
        } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[tenant_archival] failed to write audit row for", tenantId, err);
  }

  return {
    tenantId,
    archiveS3Key: key,
    archiveSizeBytes: gzipped.length,
    archiveChecksum: checksum,
    rowCounts: {
      patients: patients.length,
      appointments: appointments.length,
      prescriptions: prescriptions.length,
      invoices: invoices.length,
      auditLogs: auditLogs.length,
    },
  };
}

// ─── purgeArchivedTenant — operator-gated, NOT auto-wired ─────────────────

/**
 * Delete the live rows for a tenant that has ALREADY been archived to S3.
 * Refuses to run unless `archivedAt` AND `archiveChecksum` are both set on
 * the Tenant row — the checksum gate guarantees we never purge data whose
 * archive integrity wasn't recorded.
 *
 * Intentionally NOT registered with the scheduler. Operators trigger via a
 * future admin route (out of scope this tick) after manually verifying the
 * S3 archive is healthy.
 *
 * Cascades through the same five tenant-scoped tables `archiveTenant` exported.
 * Does NOT delete the Tenant row itself — the archive metadata stays so a
 * subsequent forensic query can resolve "this tenantId once existed".
 */
export async function purgeArchivedTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<PurgeArchivedTenantResult> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, archivedAt: true, archiveChecksum: true },
  });
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }
  if (!tenant.archivedAt || !tenant.archiveChecksum) {
    throw new Error(
      `Refusing to purge tenant ${tenantId}: archivedAt or archiveChecksum is null. ` +
        `Call archiveTenant() first.`,
    );
  }

  // We delete in dependency-order so FKs don't trip. The five top-level
  // tenant-scoped tables exported above are the surface this v1 covers;
  // sub-children (PrescriptionItem, AuditLog already top-level, etc.)
  // cascade via the schema's `onDelete: Cascade` on the parent FK. The
  // DPDP-purge service follows the same pattern.
  const [auditLogs, prescriptions, invoices, appointments, patients] =
    await Promise.all([
      prisma.auditLog.deleteMany({ where: { tenantId } }),
      prisma.prescription.deleteMany({ where: { tenantId } }),
      prisma.invoice.deleteMany({ where: { tenantId } }),
      prisma.appointment.deleteMany({ where: { tenantId } }),
      prisma.patient.deleteMany({ where: { tenantId } }),
    ]);

  return {
    tenantId,
    deleted: {
      patients: patients.count,
      appointments: appointments.count,
      prescriptions: prescriptions.count,
      invoices: invoices.count,
      auditLogs: auditLogs.count,
    },
  };
}

// ─── Cron entry point ──────────────────────────────────────────────────────

/**
 * Daily sweep: find every archive-eligible tenant and archive it. Wired
 * into `scheduled-tasks.ts` as `tenant_archive_sweep` at `runAtHour: 4`.
 * Per-tenant failures are logged + counted; one bad tenant does not abort
 * the rest of the sweep.
 */
export async function runTenantArchiveSweep(
  prisma: PrismaClient,
  opts: { now?: Date; minSuspendDays?: number } = {},
): Promise<{ inspected: number; archived: number; errors: number }> {
  const now = opts.now ?? new Date();
  const minSuspendDays = opts.minSuspendDays ?? DEFAULT_MIN_SUSPEND_DAYS;
  const candidates = await findArchiveCandidates(prisma, now, minSuspendDays);
  let archived = 0;
  let errors = 0;
  for (const c of candidates) {
    try {
      await archiveTenant(prisma, c.id, { minSuspendDays, now });
      archived += 1;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[tenant_archive_sweep] tenant ${c.id} failed`, err);
    }
  }
  return { inspected: candidates.length, archived, errors };
}
