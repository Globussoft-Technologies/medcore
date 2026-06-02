// Dynamic plan catalog — Pearl §8.3 (2026-06).
//
// Single source of truth for platform plan tiers is the `PlatformPlan` table
// (super-admin CRUD). This service replaces the former hardcoded
// `PLAN_DEFINITIONS` constant in @medcore/shared and the duplicated
// `PLAN_LABEL` maps that lived in platform-subscription-state.ts and
// platform-invoice-generator.ts. Every billing path (proration, monthly
// invoice, provisioning, change-plan) resolves prices/labels/features from
// here so plans can be created/edited at runtime with no code change.
import type { PlatformPlan, PrismaClient } from "@prisma/client";

/** Fetch one plan by its `key` (e.g. "STARTER" or a custom slug). */
export async function getPlanByKey(
  prisma: PrismaClient,
  key: string,
): Promise<PlatformPlan | null> {
  return prisma.platformPlan.findUnique({ where: { key } });
}

/**
 * Fetch a plan by key or throw — for billing paths that cannot proceed
 * without a price (proration / invoice generation). The error names the
 * missing key so a deleted/renamed plan surfaces loudly instead of silently
 * billing ₹0.
 */
export async function requirePlanByKey(
  prisma: PrismaClient,
  key: string,
): Promise<PlatformPlan> {
  const plan = await getPlanByKey(prisma, key);
  if (!plan) {
    throw new Error(`Plan "${key}" not found in the plan catalog`);
  }
  return plan;
}

/** List plans, ordered by sortOrder then price. `activeOnly` hides retired tiers. */
export async function listPlans(
  prisma: PrismaClient,
  opts: { activeOnly?: boolean } = {},
): Promise<PlatformPlan[]> {
  return prisma.platformPlan.findMany({
    where: opts.activeOnly ? { active: true } : undefined,
    orderBy: [{ sortOrder: "asc" }, { monthlyPriceInPaise: "asc" }],
  });
}

/** Human-readable label for an invoice/audit line; falls back to the key. */
export function planLabel(
  plan: Pick<PlatformPlan, "name" | "key"> | null | undefined,
  fallbackKey?: string,
): string {
  return plan?.name ?? plan?.key ?? fallbackKey ?? "—";
}

/**
 * True when an error is the dynamic-plans migration mismatch: the DB `plan`
 * column is still the old Prisma enum while the regenerated client expects
 * `String`, so Prisma throws "Error converting field `plan` … incompatible
 * value of `GROWTH`/`BASIC`". Lets routes show a clean message instead of
 * leaking the raw engine string to the UI. Fix: `npx prisma db push` + reseed.
 */
export function isPlanColumnMigrationError(err: unknown): boolean {
  const detail = err instanceof Error ? err.message : String(err);
  return (
    /\bplan\b/i.test(detail) &&
    /(converting field|incompatible value|expected non-nullable type)/i.test(
      detail,
    )
  );
}

/** Operator-friendly message shown while the plan migration is pending. */
export const PLAN_MIGRATION_USER_MESSAGE =
  "We're finishing a system update — this page will be available again shortly. Please refresh in a few minutes.";
