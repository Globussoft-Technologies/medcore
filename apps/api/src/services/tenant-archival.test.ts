// Unit tests for the tenant 90-day S3 archival service —
// Pearl §8.1 row 233 closure (2026-05-25).
//
// What / which modules / why:
//   - Validates `findArchiveCandidates(prisma, now, minSuspendDays)`
//     returns only the tenants that are simultaneously suspended,
//     suspended for >= minSuspendDays, NOT already archived, and not
//     the seed `default` tenant.
//   - Validates `archiveTenant(prisma, id, opts)` refuses to run on
//     active tenants and on tenants whose `deactivatedAt` is too
//     recent, happy-paths through a mocked S3 uploader, stamps the
//     four `archive*` metadata fields, and writes the
//     `TENANT_ARCHIVED` audit row.
//   - Validates `purgeArchivedTenant(prisma, id)` refuses to run when
//     `archivedAt` is null.
//   - S3 client is replaced with an in-memory uploader injected via
//     `opts.uploader` — no AWS SDK loaded, no network.
//   - COLOCATED at `services/tenant-archival.test.ts` so the
//     `test:coverage:unit` glob picks it up (mirrors the
//     `dpdp-purge.test.ts` / `audit-archival.test.ts` convention).

import { describe, it, expect, vi } from "vitest";
import {
  archiveTenant,
  findArchiveCandidates,
  purgeArchivedTenant,
  type S3Uploader,
} from "./tenant-archival";

// Build a Prisma mock that captures every call. Each table has a tiny
// surface — just enough for the service's findUnique / findMany /
// update / create / deleteMany call sites.
function makePrismaMock(opts: {
  tenant?: {
    id: string;
    name: string;
    subdomain: string;
    active: boolean;
    deactivatedAt: Date | null;
    archivedAt: Date | null;
    archiveChecksum?: string | null;
  } | null;
  archiveCandidates?: Array<{
    id: string;
    subdomain: string;
    deactivatedAt: Date | null;
  }>;
  rowCounts?: Partial<{
    patients: number;
    appointments: number;
    prescriptions: number;
    invoices: number;
    auditLogs: number;
  }>;
} = {}) {
  const counts = opts.rowCounts ?? {};
  const mkRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `row-${i}` }));

  const tenantUpdate = vi.fn().mockResolvedValue({});
  const auditLogCreate = vi.fn().mockResolvedValue({ id: "audit-1" });
  const patientDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const appointmentDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
  const prescriptionDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
  const invoiceDeleteMany = vi.fn().mockResolvedValue({ count: 4 });
  const auditLogDeleteMany = vi.fn().mockResolvedValue({ count: 5 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    tenant: {
      findUnique: vi.fn().mockResolvedValue(opts.tenant ?? null),
      findMany: vi.fn().mockResolvedValue(opts.archiveCandidates ?? []),
      update: tenantUpdate,
    },
    patient: {
      findMany: vi.fn().mockResolvedValue(mkRows(counts.patients ?? 0)),
      deleteMany: patientDeleteMany,
    },
    appointment: {
      findMany: vi.fn().mockResolvedValue(mkRows(counts.appointments ?? 0)),
      deleteMany: appointmentDeleteMany,
    },
    prescription: {
      findMany: vi.fn().mockResolvedValue(mkRows(counts.prescriptions ?? 0)),
      deleteMany: prescriptionDeleteMany,
    },
    invoice: {
      findMany: vi.fn().mockResolvedValue(mkRows(counts.invoices ?? 0)),
      deleteMany: invoiceDeleteMany,
    },
    auditLog: {
      findMany: vi.fn().mockResolvedValue(mkRows(counts.auditLogs ?? 0)),
      create: auditLogCreate,
      deleteMany: auditLogDeleteMany,
    },
  };
  return { prisma, tenantUpdate, auditLogCreate };
}

function makeUploader(): { uploader: S3Uploader; calls: Array<{ key: string; size: number }> } {
  const calls: Array<{ key: string; size: number }> = [];
  const uploader: S3Uploader = {
    async upload(key, body) {
      calls.push({ key, size: body.length });
      return { key };
    },
  };
  return { uploader, calls };
}

const NINETY_ONE_DAYS_AGO = new Date("2026-02-23T00:00:00.000Z");
const ONE_DAY_AGO = new Date("2026-05-24T00:00:00.000Z");
const NOW = new Date("2026-05-25T00:00:00.000Z");

describe("findArchiveCandidates", () => {
  it("returns tenants that are inactive, suspended for >=90 days, and not yet archived", async () => {
    const candidates = [
      {
        id: "ten-eligible",
        subdomain: "old-suspended",
        deactivatedAt: NINETY_ONE_DAYS_AGO,
      },
    ];
    const { prisma } = makePrismaMock({ archiveCandidates: candidates });

    const rows = await findArchiveCandidates(prisma, NOW, 90);

    expect(rows).toEqual(candidates);
    expect(prisma.tenant.findMany).toHaveBeenCalledWith({
      where: {
        active: false,
        archivedAt: null,
        deactivatedAt: {
          lt: expect.any(Date),
          not: null,
        },
        subdomain: { not: "default" },
      },
      select: { id: true, subdomain: true, deactivatedAt: true },
    });
    // Cutoff is 90 days before NOW.
    const callArg = (prisma.tenant.findMany as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { where: { deactivatedAt: { lt: Date } } };
    expect(callArg.where.deactivatedAt.lt.toISOString()).toBe(
      new Date(NOW.getTime() - 90 * 86400000).toISOString(),
    );
  });
});

describe("archiveTenant", () => {
  it("refuses to archive an active tenant", async () => {
    const { prisma } = makePrismaMock({
      tenant: {
        id: "ten-1",
        name: "Active Hosp",
        subdomain: "active-hosp",
        active: true,
        deactivatedAt: null,
        archivedAt: null,
      },
    });
    const { uploader } = makeUploader();

    await expect(
      archiveTenant(prisma, "ten-1", { uploader, now: NOW }),
    ).rejects.toThrow(/active tenant/i);
  });

  it("refuses to archive when deactivatedAt is younger than minSuspendDays", async () => {
    const { prisma } = makePrismaMock({
      tenant: {
        id: "ten-2",
        name: "Fresh Suspension",
        subdomain: "fresh",
        active: false,
        deactivatedAt: ONE_DAY_AGO,
        archivedAt: null,
      },
    });
    const { uploader } = makeUploader();

    await expect(
      archiveTenant(prisma, "ten-2", { uploader, now: NOW, minSuspendDays: 90 }),
    ).rejects.toThrow(/requires >= 90 days/);
  });

  it("happy path: uploads gzipped JSON, stamps metadata, writes audit row", async () => {
    const { prisma, tenantUpdate, auditLogCreate } = makePrismaMock({
      tenant: {
        id: "ten-3",
        name: "Eligible Hospital",
        subdomain: "eligible",
        active: false,
        deactivatedAt: NINETY_ONE_DAYS_AGO,
        archivedAt: null,
      },
      rowCounts: {
        patients: 5,
        appointments: 7,
        prescriptions: 3,
        invoices: 4,
        auditLogs: 11,
      },
    });
    const { uploader, calls } = makeUploader();

    const result = await archiveTenant(prisma, "ten-3", {
      uploader,
      now: NOW,
      minSuspendDays: 90,
    });

    // Uploader was called once with the conventional key shape.
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toMatch(
      /^tenant-archives\/ten-3\/\d{8}T\d{6}Z\.tar\.gz$/,
    );
    expect(calls[0].size).toBeGreaterThan(0);

    // Metadata stamp on the Tenant row.
    expect(tenantUpdate).toHaveBeenCalledWith({
      where: { id: "ten-3" },
      data: {
        archivedAt: NOW,
        archiveS3Key: calls[0].key,
        archiveSizeBytes: calls[0].size,
        archiveChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    // Audit row written with TENANT_ARCHIVED.
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    const auditArgs = auditLogCreate.mock.calls[0][0] as {
      data: {
        action: string;
        entity: string;
        entityId: string;
        details: Record<string, unknown>;
      };
    };
    expect(auditArgs.data.action).toBe("TENANT_ARCHIVED");
    expect(auditArgs.data.entity).toBe("tenant");
    expect(auditArgs.data.entityId).toBe("ten-3");
    expect(auditArgs.data.details).toMatchObject({
      subdomain: "eligible",
      archiveS3Key: calls[0].key,
      rowCounts: {
        patients: 5,
        appointments: 7,
        prescriptions: 3,
        invoices: 4,
        auditLogs: 11,
      },
    });

    // Return value mirrors the stamped metadata.
    expect(result).toMatchObject({
      tenantId: "ten-3",
      archiveS3Key: calls[0].key,
      archiveSizeBytes: calls[0].size,
      rowCounts: {
        patients: 5,
        appointments: 7,
        prescriptions: 3,
        invoices: 4,
        auditLogs: 11,
      },
    });
    expect(result.archiveChecksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses to re-archive a tenant whose archivedAt is already set", async () => {
    const { prisma } = makePrismaMock({
      tenant: {
        id: "ten-4",
        name: "Already archived",
        subdomain: "already",
        active: false,
        deactivatedAt: NINETY_ONE_DAYS_AGO,
        archivedAt: new Date("2026-05-20T00:00:00.000Z"),
      },
    });
    const { uploader } = makeUploader();

    await expect(
      archiveTenant(prisma, "ten-4", { uploader, now: NOW }),
    ).rejects.toThrow(/already archived/);
  });
});

describe("purgeArchivedTenant", () => {
  it("refuses to purge when archivedAt is null", async () => {
    const { prisma } = makePrismaMock({
      tenant: {
        id: "ten-5",
        name: "Not yet archived",
        subdomain: "not-yet",
        active: false,
        deactivatedAt: NINETY_ONE_DAYS_AGO,
        archivedAt: null,
        archiveChecksum: null,
      },
    });

    await expect(purgeArchivedTenant(prisma, "ten-5")).rejects.toThrow(
      /archivedAt or archiveChecksum is null/,
    );
  });
});
