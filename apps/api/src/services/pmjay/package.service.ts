// PM-JAY HBP package-master service.
//
// Keeps a local mirror of the PM-JAY Health Benefit Package master so claims can
// reference a validated packageCode instead of free text. `syncPackages` fetches
// the master from the gateway (or a synthetic set in simulation), computes a
// checksum, and SKIPS the write entirely when the checksum + version match what
// we already hold (refinement #3 — avoid re-downloading thousands of unchanged
// packages).

import crypto from "crypto";
import { tenantScopedPrisma as prisma } from "@medcore/db";
import { loadPmjayConfig } from "./config";
import { pmjayFetch } from "./gateway";

export interface PmjayPackageDTO {
  packageCode: string;
  packageName: string;
  specialty?: string | null;
  amount: number;
  hospitalType?: string | null;
  documentsRequired?: string[];
}

/** Deterministic synthetic HBP master for simulation / demos. */
const SIM_PACKAGES: PmjayPackageDTO[] = [
  { packageCode: "HBP-CARD-001", packageName: "Coronary Angioplasty (Single Stent)", specialty: "Cardiology", amount: 60000, hospitalType: "PRIVATE", documentsRequired: ["DISCHARGE_SUMMARY", "INVESTIGATION_REPORT"] },
  { packageCode: "HBP-ORTHO-014", packageName: "Total Knee Replacement (Unilateral)", specialty: "Orthopaedics", amount: 80000, hospitalType: "PRIVATE", documentsRequired: ["DISCHARGE_SUMMARY", "OT_NOTES"] },
  { packageCode: "HBP-GEN-003", packageName: "Appendectomy", specialty: "General Surgery", amount: 15000, hospitalType: "PUBLIC", documentsRequired: ["DISCHARGE_SUMMARY"] },
  { packageCode: "HBP-OBG-021", packageName: "Caesarean Section", specialty: "Obstetrics", amount: 12000, hospitalType: "PUBLIC", documentsRequired: ["DISCHARGE_SUMMARY", "INVESTIGATION_REPORT"] },
];

function checksumOf(pkgs: PmjayPackageDTO[]): string {
  const canonical = pkgs
    .map((p) => `${p.packageCode}:${p.packageName}:${p.amount}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export interface ListPackagesQuery {
  specialty?: string;
  search?: string;
  activeOnly?: boolean;
}

export async function listPackages(q: ListPackagesQuery = {}) {
  return prisma.pmjayPackage.findMany({
    where: {
      ...(q.activeOnly === false ? {} : { isActive: true }),
      ...(q.specialty ? { specialty: q.specialty } : {}),
      ...(q.search
        ? {
            OR: [
              { packageCode: { contains: q.search, mode: "insensitive" as const } },
              { packageName: { contains: q.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { packageCode: "asc" },
    take: 500,
  });
}

export async function getPackageByCode(packageCode: string) {
  return prisma.pmjayPackage.findFirst({ where: { packageCode } });
}

export interface SyncResult {
  synced: number;
  skipped: boolean;
  version: string;
  checksum: string;
}

/**
 * Sync the package master into the local mirror. No-op (skipped) when the newly
 * fetched checksum matches the checksum already stored. Otherwise upserts every
 * package (find-then-write, tenant-scoped) and stamps version/checksum/syncedAt.
 */
export async function syncPackages(): Promise<
  { ok: true; result: SyncResult } | { ok: false; message: string }
> {
  const cfg = await loadPmjayConfig();
  if (!cfg.enabled) return { ok: false, message: "PM-JAY integration disabled" };

  let packages: PmjayPackageDTO[];
  if (cfg.simulation) {
    packages = SIM_PACKAGES;
  } else {
    const res = await pmjayFetch(cfg, `${cfg.urls.package}/master?limit=${cfg.batchSize}`, { method: "GET" });
    if (!res.ok) return { ok: false, message: res.error.message };
    packages = ((res.data as { packages?: PmjayPackageDTO[] }).packages ?? []);
  }

  const checksum = checksumOf(packages);
  const version = `v-${checksum.slice(0, 8)}`;
  const now = new Date();

  // Checksum short-circuit: if we already hold this exact master, do nothing.
  const latest = await prisma.pmjayPackage.findFirst({
    orderBy: { lastSyncedAt: "desc" },
    select: { checksum: true },
  });
  if (latest?.checksum === checksum) {
    return { ok: true, result: { synced: 0, skipped: true, version, checksum } };
  }

  let synced = 0;
  for (const p of packages) {
    const existing = await prisma.pmjayPackage.findFirst({
      where: { packageCode: p.packageCode },
      select: { id: true },
    });
    const data = {
      packageName: p.packageName,
      specialty: p.specialty ?? null,
      amount: p.amount,
      hospitalType: p.hospitalType ?? null,
      documentsRequired: (p.documentsRequired ?? []) as never,
      packageVersion: version,
      checksum,
      lastSyncedAt: now,
      isActive: true,
    };
    if (existing) {
      await prisma.pmjayPackage.update({ where: { id: existing.id }, data });
    } else {
      await prisma.pmjayPackage.create({ data: { packageCode: p.packageCode, ...data } });
    }
    synced += 1;
  }

  return { ok: true, result: { synced, skipped: false, version, checksum } };
}
