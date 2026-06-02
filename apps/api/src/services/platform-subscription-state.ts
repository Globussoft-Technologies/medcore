/**
 * Pearl ERP Stage 1 §8.3 (gap rows 215-218 closure piece 3c, 2026-05-25) —
 * platform-subscription state-machine transitions + grace-period sweep
 * + proration helper.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: pure transition functions over `TenantSubscription.status`
 *   (`trial → active → past_due → suspended → cancelled`) plus a daily
 *   grace-period sweep that flips long-overdue tenants to `suspended`
 *   and a proration helper that emits a one-line `PlatformInvoice` line
 *   item when a tenant changes plan mid-cycle.
 * - MODULES:
 *   - Reads/writes `TenantSubscription` (and reads a few related
 *     `Tenant` fields for naming in audit details) from `@medcore/db`.
 *   - On proration, writes one `PlatformInvoice` + one
 *     `PlatformInvoiceLineItem` row via the same `PI-YYYYMM-NNNN`
 *     numbering convention as the monthly generator (piece 3b). The
 *     proration row is a separate same-month invoice so the per-month
 *     sequence stays contiguous and the GST math is recomputed on the
 *     deltas only.
 *   - Reads pricing from `@medcore/shared` (`PLAN_DEFINITIONS`) — same
 *     source-of-truth that the monthly generator pins.
 *   - Writes `AuditLog` rows for every transition so the super-admin
 *     trail captures every state change.
 * - WHY: piece 3a (commit 7f9f2a1) shipped the schema + status enum;
 *   piece 3b (commit 886e7b2) shipped the monthly invoice generator +
 *   `markInvoicePaid` helper. This piece closes the chain — without
 *   these transitions, the `past_due` and `suspended` columns would
 *   never be written, the Razorpay webhook (sibling file) would have
 *   no business-logic surface to call, and mid-cycle plan changes
 *   would silently under/over-bill. All five transition functions are
 *   idempotent so the webhook can re-fire any Razorpay event without
 *   double-flipping state.
 *
 * Grace-period semantics
 * ──────────────────────
 * `GRACE_PERIOD_DAYS` (7, from `@medcore/shared`) is the read-only
 * window between `past_due` (failed charge OR trial ended without
 * paid conversion) and `suspended` (login blocked except for billing
 * surface). `checkGracePeriodExpirations` walks every `past_due` row
 * whose `pastDueSince + GRACE_PERIOD_DAYS < now` and flips them to
 * `suspended`. Safe to re-run — already-`suspended` rows are skipped
 * by the `status: "past_due"` filter.
 *
 * Proration math
 * ──────────────
 * `applyProration` computes `(newMonthlyPaise - oldMonthlyPaise) *
 * (remainingDaysInCycle / totalCycleDays)` and writes the delta as a
 * separate invoice row. Negative deltas (downgrade) yield a negative
 * line item (i.e. credit). Re-using `PlatformInvoice` rather than a
 * dedicated `Credit` table keeps the GST trail in one place and lets
 * the existing operator UI surface the proration alongside monthly
 * billables without a new column.
 */
import type { Prisma, PrismaClient } from "@medcore/db";
import { GRACE_PERIOD_DAYS, type Plan } from "@medcore/shared";
import { requirePlanByKey } from "./plan-catalog";

const CGST_RATE = 9;
const SGST_RATE = 9;
const IGST_RATE = 18;
const SAAS_HSN_SAC = "998314";

// Mirror of PLATFORM_OPERATOR_STATE in platform-invoice-generator.ts. Kept
// duplicated rather than re-imported so the proration helper has no
// circular dep on the generator's mock-aware export shape — both files
// share the schema-level default of "Karnataka" today, and when the
// operator's place of supply moves both constants are flipped together.
const PLATFORM_OPERATOR_STATE = "Karnataka";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MONTH_LABEL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export type TransitionResult =
  | { changed: true; status: string; subscriptionId: string }
  | { changed: false; status: string; subscriptionId: string; reason: string };

async function writeStateAudit(
  prisma: PrismaClient,
  action: string,
  subscriptionId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        entity: "tenant_subscription",
        entityId: subscriptionId,
        details: details as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error(
      "[platform_subscription_state] failed to write audit row for",
      subscriptionId,
      action,
      err,
    );
  }
}

/**
 * Move `trial` or `past_due` → `active`. Idempotent — re-calling on an
 * already-`active` subscription is a no-op. Clears `pastDueSince` when
 * lifting out of `past_due` so the grace clock restarts cleanly on the
 * next failed charge.
 */
export async function transitionToActive(
  prisma: PrismaClient,
  subscriptionId: string,
  now: Date = new Date(),
): Promise<TransitionResult> {
  const row = await prisma.tenantSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, status: true, tenantId: true, plan: true },
  });
  if (!row) throw new Error(`TenantSubscription ${subscriptionId} not found`);
  if (row.status === "active") {
    return {
      changed: false,
      status: row.status,
      subscriptionId,
      reason: "ALREADY_ACTIVE",
    };
  }
  if (row.status === "cancelled" || row.status === "suspended") {
    return {
      changed: false,
      status: row.status,
      subscriptionId,
      reason: `CANNOT_ACTIVATE_FROM_${row.status.toUpperCase()}`,
    };
  }

  const fromStatus = row.status;
  await prisma.tenantSubscription.update({
    where: { id: subscriptionId },
    data: {
      status: "active",
      pastDueSince: null,
    },
  });
  await writeStateAudit(prisma, "PLATFORM_SUBSCRIPTION_ACTIVATED", subscriptionId, {
    tenantId: row.tenantId,
    plan: row.plan,
    fromStatus,
    toStatus: "active",
    at: now.toISOString(),
  });
  return { changed: true, status: "active", subscriptionId };
}

/**
 * Move `active` → `past_due`. Idempotent — re-calling on a row that's
 * already `past_due` re-writes neither `pastDueSince` nor the audit row.
 * Refuses to flip cancelled/suspended rows (those are terminal-ish from
 * the auto-debit pipeline's point of view).
 */
export async function transitionToPastDue(
  prisma: PrismaClient,
  subscriptionId: string,
  now: Date = new Date(),
): Promise<TransitionResult> {
  const row = await prisma.tenantSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, status: true, tenantId: true, plan: true, pastDueSince: true },
  });
  if (!row) throw new Error(`TenantSubscription ${subscriptionId} not found`);
  if (row.status === "past_due") {
    return {
      changed: false,
      status: row.status,
      subscriptionId,
      reason: "ALREADY_PAST_DUE",
    };
  }
  if (row.status === "cancelled" || row.status === "suspended") {
    return {
      changed: false,
      status: row.status,
      subscriptionId,
      reason: `CANNOT_PAST_DUE_FROM_${row.status.toUpperCase()}`,
    };
  }

  const fromStatus = row.status;
  await prisma.tenantSubscription.update({
    where: { id: subscriptionId },
    data: {
      status: "past_due",
      pastDueSince: now,
    },
  });
  await writeStateAudit(prisma, "PLATFORM_SUBSCRIPTION_PAST_DUE", subscriptionId, {
    tenantId: row.tenantId,
    plan: row.plan,
    fromStatus,
    toStatus: "past_due",
    pastDueSince: now.toISOString(),
  });
  return { changed: true, status: "past_due", subscriptionId };
}

/**
 * Move `past_due` → `suspended`. Idempotent — `suspended` rows are
 * left alone. Refuses to suspend from any other state so the grace
 * window can never be skipped accidentally.
 */
export async function transitionToSuspended(
  prisma: PrismaClient,
  subscriptionId: string,
  now: Date = new Date(),
): Promise<TransitionResult> {
  const row = await prisma.tenantSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, status: true, tenantId: true, plan: true, pastDueSince: true },
  });
  if (!row) throw new Error(`TenantSubscription ${subscriptionId} not found`);
  if (row.status === "suspended") {
    return {
      changed: false,
      status: row.status,
      subscriptionId,
      reason: "ALREADY_SUSPENDED",
    };
  }
  if (row.status !== "past_due") {
    return {
      changed: false,
      status: row.status,
      subscriptionId,
      reason: `CANNOT_SUSPEND_FROM_${row.status.toUpperCase()}`,
    };
  }

  await prisma.tenantSubscription.update({
    where: { id: subscriptionId },
    data: { status: "suspended" },
  });
  await writeStateAudit(prisma, "PLATFORM_SUBSCRIPTION_SUSPENDED", subscriptionId, {
    tenantId: row.tenantId,
    plan: row.plan,
    fromStatus: "past_due",
    toStatus: "suspended",
    pastDueSince: row.pastDueSince ? row.pastDueSince.toISOString() : null,
    suspendedAt: now.toISOString(),
  });
  return { changed: true, status: "suspended", subscriptionId };
}

/**
 * Move any non-terminal state → `cancelled`. Idempotent — `cancelled`
 * rows are left alone. Stamps `cancelledAt` so the operator UI can
 * surface "cancelled on X" without scanning AuditLog.
 */
export async function cancelSubscription(
  prisma: PrismaClient,
  subscriptionId: string,
  now: Date = new Date(),
): Promise<TransitionResult> {
  const row = await prisma.tenantSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, status: true, tenantId: true, plan: true },
  });
  if (!row) throw new Error(`TenantSubscription ${subscriptionId} not found`);
  if (row.status === "cancelled") {
    return {
      changed: false,
      status: row.status,
      subscriptionId,
      reason: "ALREADY_CANCELLED",
    };
  }

  const fromStatus = row.status;
  await prisma.tenantSubscription.update({
    where: { id: subscriptionId },
    data: {
      status: "cancelled",
      cancelledAt: now,
    },
  });
  await writeStateAudit(prisma, "PLATFORM_SUBSCRIPTION_CANCELLED", subscriptionId, {
    tenantId: row.tenantId,
    plan: row.plan,
    fromStatus,
    toStatus: "cancelled",
    cancelledAt: now.toISOString(),
  });
  return { changed: true, status: "cancelled", subscriptionId };
}

export interface TrialExpirationSweepResult {
  inspected: number;
  pastDued: number;
  pastDuedIds: string[];
  errors: number;
}

/**
 * Pearl §8.3 piece 3d (2026-05-28) — trial expiry → past_due sweep.
 * Walks every `trial` subscription whose `trialEndsAt < now` and flips it
 * to `past_due`, starting the 7-day grace clock. After the grace window
 * the existing `checkGracePeriodExpirations` cron will suspend them.
 *
 * Pure / idempotent — already-`past_due`/`active`/`suspended` rows are
 * untouched (filtered by `status: "trial"`). Safe to re-run.
 */
export async function checkTrialExpirations(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<TrialExpirationSweepResult> {
  const candidates = await prisma.tenantSubscription.findMany({
    where: {
      status: "trial",
      trialEndsAt: { lt: now, not: null },
    },
    select: { id: true },
  });

  const result: TrialExpirationSweepResult = {
    inspected: candidates.length,
    pastDued: 0,
    pastDuedIds: [],
    errors: 0,
  };

  for (const c of candidates) {
    try {
      const r = await transitionToPastDue(prisma, c.id, now);
      if (r.changed) {
        result.pastDued += 1;
        result.pastDuedIds.push(c.id);
      }
    } catch (err) {
      result.errors += 1;
      console.error(
        "[platform_subscription_state] trial-expiration sweep failed for",
        c.id,
        err,
      );
    }
  }

  return result;
}

export interface GracePeriodSweepResult {
  inspected: number;
  suspended: number;
  suspendedIds: string[];
  errors: number;
}

/**
 * Walk every `past_due` subscription; flip to `suspended` any whose
 * `pastDueSince + GRACE_PERIOD_DAYS < now`. Idempotent — a second run
 * on the same day finds zero rows because the prior run already
 * suspended them.
 */
export async function checkGracePeriodExpirations(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<GracePeriodSweepResult> {
  const cutoff = new Date(now.getTime() - GRACE_PERIOD_DAYS * MS_PER_DAY);
  const candidates = await prisma.tenantSubscription.findMany({
    where: {
      status: "past_due",
      pastDueSince: { lt: cutoff },
    },
    select: { id: true },
  });

  const result: GracePeriodSweepResult = {
    inspected: candidates.length,
    suspended: 0,
    suspendedIds: [],
    errors: 0,
  };

  for (const c of candidates) {
    try {
      const r = await transitionToSuspended(prisma, c.id, now);
      if (r.changed) {
        result.suspended += 1;
        result.suspendedIds.push(c.id);
      }
    } catch (err) {
      result.errors += 1;
      console.error(
        "[platform_subscription_state] grace-period sweep failed for",
        c.id,
        err,
      );
    }
  }

  return result;
}

export interface ApplyProrationResult {
  invoiceId: string;
  invoiceNumber: string;
  deltaInPaise: number;
  prorationFactor: number;
}

/**
 * Compute `(newPrice - oldPrice) * (remainingDays / monthDays)` and
 * write the delta as a single-line `PlatformInvoice` (status `ISSUED`).
 * Negative deltas (downgrade) yield a negative line item (credit).
 * Uses the same `PI-YYYYMM-NNNN` numbering convention as the monthly
 * generator so historical traceability stays contiguous.
 *
 * If the proration delta is 0 (same-plan no-op call), returns
 * `{ deltaInPaise: 0 }` without writing anything — safe to invoke
 * speculatively from the plan-change UI.
 */
export async function applyProration(
  prisma: PrismaClient,
  subscriptionId: string,
  fromPlan: Plan,
  toPlan: Plan,
  now: Date = new Date(),
): Promise<ApplyProrationResult | null> {
  const sub = await prisma.tenantSubscription.findUnique({
    where: { id: subscriptionId },
    select: {
      id: true,
      tenantId: true,
      customPriceMonthlyInPaise: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      tenant: {
        select: {
          id: true,
          name: true,
          branches: {
            where: { isDefault: true },
            select: { state: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!sub) throw new Error(`TenantSubscription ${subscriptionId} not found`);

  // Resolve both tiers from the dynamic plan catalog (DB). Throws a clear
  // error if a key is missing (e.g. a deleted plan) rather than billing ₹0.
  const fromPlanDef = await requirePlanByKey(prisma, fromPlan);
  const toPlanDef = await requirePlanByKey(prisma, toPlan);

  // Custom-price overrides apply only to the CURRENT plan; cross-plan
  // proration always uses the plan defaults for the SOURCE so the delta
  // is computed against a stable reference. Bespoke deals re-set their
  // customPriceMonthlyInPaise on the new plan via a separate UI flow.
  const oldMonthlyPaise =
    sub.customPriceMonthlyInPaise ?? fromPlanDef.monthlyPriceInPaise;
  const newMonthlyPaise = toPlanDef.monthlyPriceInPaise;

  const periodStart = sub.currentPeriodStart;
  const periodEnd = sub.currentPeriodEnd;
  const totalCycleMs = periodEnd.getTime() - periodStart.getTime();
  const remainingMs = Math.max(0, periodEnd.getTime() - now.getTime());
  // Guard against degenerate windows (start > end or 0-length).
  const prorationFactor = totalCycleMs > 0 ? remainingMs / totalCycleMs : 0;

  const deltaInPaise = Math.round(
    (newMonthlyPaise - oldMonthlyPaise) * prorationFactor,
  );

  if (deltaInPaise === 0) {
    return {
      invoiceId: "",
      invoiceNumber: "",
      deltaInPaise: 0,
      prorationFactor,
    };
  }

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const yyyymm = `${year}${String(month).padStart(2, "0")}`;

  const tenantState = sub.tenant?.branches?.[0]?.state ?? null;
  const sameState =
    !!tenantState &&
    tenantState.trim().toLowerCase() === PLATFORM_OPERATOR_STATE.toLowerCase();

  const subtotalInPaise = deltaInPaise; // single line item, qty=1, sign-preserving
  const absForGst = Math.abs(subtotalInPaise);
  const cgstInPaise = sameState
    ? Math.sign(subtotalInPaise) * Math.round((absForGst * CGST_RATE) / 100)
    : 0;
  const sgstInPaise = sameState
    ? Math.sign(subtotalInPaise) * Math.round((absForGst * SGST_RATE) / 100)
    : 0;
  const igstInPaise = sameState
    ? 0
    : Math.sign(subtotalInPaise) * Math.round((absForGst * IGST_RATE) / 100);
  const totalInPaise =
    subtotalInPaise + cgstInPaise + sgstInPaise + igstInPaise;

  const monthCount = await prisma.platformInvoice.count({
    where: { invoiceNumber: { startsWith: `PI-${yyyymm}-` } },
  });
  const invoiceNumber = `PI-${yyyymm}-${String(monthCount + 1).padStart(4, "0")}`;

  const description = `Plan change proration — ${fromPlanDef.name} → ${toPlanDef.name} (${MONTH_LABEL[now.getUTCMonth()]} ${year})`;

  const lineItemCreate: Prisma.PlatformInvoiceLineItemCreateWithoutInvoiceInput =
    {
      description,
      unitPriceInPaise: subtotalInPaise,
      quantity: 1,
      amountInPaise: subtotalInPaise,
      hsnSacCode: SAAS_HSN_SAC,
      cgstRate: sameState ? CGST_RATE : 0,
      sgstRate: sameState ? SGST_RATE : 0,
      igstRate: sameState ? 0 : IGST_RATE,
    };

  const invoice = await prisma.platformInvoice.create({
    data: {
      invoiceNumber,
      tenantId: sub.tenantId,
      subscriptionId: sub.id,
      periodStart,
      periodEnd,
      subtotalInPaise,
      cgstInPaise,
      sgstInPaise,
      igstInPaise,
      totalInPaise,
      status: "ISSUED",
      issuedAt: now,
      hsnSacCode: SAAS_HSN_SAC,
      lineItems: { create: [lineItemCreate] },
    },
    select: { id: true, invoiceNumber: true },
  });

  await writeStateAudit(prisma, "PLATFORM_SUBSCRIPTION_PRORATED", subscriptionId, {
    tenantId: sub.tenantId,
    fromPlan,
    toPlan,
    oldMonthlyPaise,
    newMonthlyPaise,
    prorationFactor,
    deltaInPaise,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    gstSplit: sameState ? "CGST+SGST" : "IGST",
    at: now.toISOString(),
  });

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    deltaInPaise,
    prorationFactor,
  };
}
