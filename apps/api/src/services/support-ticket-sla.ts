/**
 * Pearl ERP Stage 1 §8.5 (2026-05-28) — plan-aware ticket SLA.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: pure helper that resolves a `slaDueAt` deadline for a
 *   `SupportTicket` from the tenant's subscription plan + the ticket's
 *   priority. Plan tiers buy faster response: a STARTER tenant's
 *   NORMAL ticket gets 72h, a GROWTH NORMAL gets 24h, an ENTERPRISE
 *   NORMAL gets 8h, etc.
 * - MODULES: reads `TenantSubscription.plan` via the supplied PrismaClient.
 *   Called from `routes/support-tickets.ts` on ticket create AND on
 *   priority change.
 * - WHY: §8.5 requires "per-tenant SLA visibility (depends on the
 *   tenant's plan)". Persisting `slaDueAt` + `slaPlan` (rather than
 *   computing on read) means the operator UI can render the deadline
 *   directly + sort the queue by it; plan re-pricing later doesn't
 *   retro-shift historical deadlines.
 *
 * SLA matrix (hours from ticket creation):
 *
 *   priority \ plan │ STARTER │ GROWTH │ ENTERPRISE
 *   ────────────────┼─────────┼────────┼──────────
 *   URGENT          │   8     │   2    │   1
 *   HIGH            │  24     │   8    │   4
 *   NORMAL          │  72     │  24    │   8
 *   LOW             │ 168     │  72    │  24
 *
 * Tenants without a `TenantSubscription` row fall back to STARTER.
 */
import type { PrismaClient } from "@medcore/db";

export type TicketPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type SlaPlan = "STARTER" | "GROWTH" | "ENTERPRISE";

const SLA_HOURS: Record<SlaPlan, Record<TicketPriority, number>> = {
  STARTER: { URGENT: 8, HIGH: 24, NORMAL: 72, LOW: 168 },
  GROWTH: { URGENT: 2, HIGH: 8, NORMAL: 24, LOW: 72 },
  ENTERPRISE: { URGENT: 1, HIGH: 4, NORMAL: 8, LOW: 24 },
};

const VALID_PLANS = new Set<SlaPlan>(["STARTER", "GROWTH", "ENTERPRISE"]);

/**
 * Resolve the tenant's billing plan. Falls back to STARTER if the
 * tenant has no subscription row (e.g. legacy tenants created before
 * the subscription model landed).
 */
export async function resolveTenantSlaPlan(
  prisma: PrismaClient,
  tenantId: string | null,
): Promise<SlaPlan> {
  if (!tenantId) return "STARTER"; // Internal/super-admin tickets — STARTER default.
  const sub = await prisma.tenantSubscription.findUnique({
    where: { tenantId },
    select: { plan: true },
  });
  const plan = sub?.plan as string | undefined;
  if (plan && VALID_PLANS.has(plan as SlaPlan)) return plan as SlaPlan;
  return "STARTER";
}

export interface SlaResult {
  slaDueAt: Date;
  slaPlan: SlaPlan;
  slaHours: number;
}

/**
 * Compute the SLA deadline for a ticket. `now` is the anchor point
 * (defaults to current wall clock); `slaPlan` is the plan resolved
 * for the tenant via `resolveTenantSlaPlan`.
 */
export function computeSlaDueAt(
  priority: TicketPriority,
  slaPlan: SlaPlan,
  now: Date = new Date(),
): SlaResult {
  const hours = SLA_HOURS[slaPlan][priority];
  return {
    slaDueAt: new Date(now.getTime() + hours * 60 * 60 * 1000),
    slaPlan,
    slaHours: hours,
  };
}

/**
 * One-shot helper for routes — looks up the tenant's plan and
 * returns the full SLA result. Avoids forcing every caller to do the
 * two-step (resolveTenantSlaPlan then computeSlaDueAt).
 */
export async function resolveSlaForTicket(
  prisma: PrismaClient,
  tenantId: string | null,
  priority: TicketPriority,
  now: Date = new Date(),
): Promise<SlaResult> {
  const plan = await resolveTenantSlaPlan(prisma, tenantId);
  return computeSlaDueAt(priority, plan, now);
}
