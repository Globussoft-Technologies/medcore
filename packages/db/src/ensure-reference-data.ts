// Idempotent reference-data bootstrap (Pearl §8.3).
//
// What / why: ensures the rows the app CANNOT function without exist — today
// that's the `PlatformPlan` baseline tiers (STARTER/GROWTH/ENTERPRISE) plus a
// one-time legacy `Tenant.plan` key backfill. Designed to be called on every
// API start (`server.ts`) so a fresh or partially-migrated DB always has a
// usable plan catalog without a manual `npm run db:seed`.
//
// CRITICAL difference from `seed.ts`: this is CREATE-IF-MISSING, never
// overwrite. A super admin may have edited STARTER's price/features via the
// platform-billing UI; re-running this on the next restart must NOT clobber
// those edits. (The full `seed.ts` deliberately upserts-with-update because
// it's an explicit reset, not a boot-time guard.) It also does NOT seed any
// demo data (tenants, users, patients) — that belongs only in `seed.ts`.

import type { PrismaClient } from "@prisma/client";
import { PLAN_DEFINITIONS } from "@medcore/shared";

const PLAN_NAMES: Record<string, string> = {
  STARTER: "Starter",
  GROWTH: "Growth",
  ENTERPRISE: "Enterprise",
};

export interface EnsureReferenceDataResult {
  plansCreated: number;
  legacyTenantsBackfilled: number;
  /** True when the catalog already had data and the whole bootstrap was skipped. */
  skipped: boolean;
}

export async function ensureReferenceData(
  prisma: PrismaClient,
): Promise<EnsureReferenceDataResult> {
  // Fast path — if the plan catalog already has ANY rows, the DB has been
  // bootstrapped before. Skip the entire migration (no per-plan existence
  // checks, no backfill) after a single cheap COUNT. "If data exists, skip."
  const existingPlans = await prisma.platformPlan.count();
  if (existingPlans > 0) {
    return { plansCreated: 0, legacyTenantsBackfilled: 0, skipped: true };
  }

  // 1. Baseline plan tiers — create only the ones that don't exist yet, so
  //    operator edits to existing tiers survive a restart.
  let planSort = 1;
  let plansCreated = 0;
  for (const def of Object.values(PLAN_DEFINITIONS)) {
    const existing = await prisma.platformPlan.findUnique({
      where: { key: def.key },
    });
    if (!existing) {
      await prisma.platformPlan.create({
        data: {
          key: def.key,
          name: PLAN_NAMES[def.key] ?? def.key,
          monthlyPriceInPaise: def.monthlyPriceInPaise,
          includedFeatures: def.includedFeatures,
          sortOrder: planSort,
        },
      });
      plansCreated += 1;
    }
    planSort += 1;
  }

  // 2. Legacy key backfill — old tenants created when Tenant.plan was the
  //    BASIC/PRO/ENTERPRISE enum. This is a ONE-TIME migration: we only run it
  //    on the first-ever bootstrap, i.e. when we just created the baseline
  //    plans. If the catalog already existed, the DB has been bootstrapped
  //    before and is already migrated — so we skip the data migration entirely
  //    rather than firing no-op UPDATEs on every boot.
  let legacyTenantsBackfilled = 0;
  if (plansCreated > 0) {
    const basic = await prisma.tenant.updateMany({
      where: { plan: "BASIC" },
      data: { plan: "STARTER" },
    });
    const pro = await prisma.tenant.updateMany({
      where: { plan: "PRO" },
      data: { plan: "GROWTH" },
    });
    legacyTenantsBackfilled = basic.count + pro.count;
  }

  return { plansCreated, legacyTenantsBackfilled, skipped: false };
}
