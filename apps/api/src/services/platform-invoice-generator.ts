/**
 * Pearl ERP Stage 1 §8.3 (gap row 215 closure piece 3b, 2026-05-24) —
 * monthly platform-invoice generator + operator-paid marker.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: a once-per-month cron that walks every `TenantSubscription`
 *   in status `active` and creates a `PlatformInvoice` row for the
 *   PREVIOUS calendar month (UTC) if one does not already exist for
 *   that tenant + month. Plus an idempotent `markInvoicePaid` helper
 *   the operator-facing UI calls when a bank transfer / Razorpay
 *   payment lands.
 * - MODULES:
 *   - Reads `TenantSubscription` + `Tenant` (+ its default `Branch`
 *     for GST state lookup) + `PlatformInvoice` (existence check +
 *     same-month invoice-number sequence) from `@medcore/db`.
 *   - Writes `PlatformInvoice` + `PlatformInvoiceLineItem` rows.
 *   - Reads pricing from `@medcore/shared` (re-exports
 *     `PLAN_DEFINITIONS` from `billing/plans`) — the same
 *     source-of-truth that the piece 3a tests pin.
 *   - Writes one `AuditLog` row per generated invoice via Prisma so
 *     the super-admin trail captures the system-generated billable.
 * - WHY: piece 3a (commit 7f9f2a1) shipped the schema only. This is
 *   the first consumer — billing operators need a monthly run that
 *   produces ISSUED invoices the moment a billing cycle closes,
 *   without anyone clicking a button. The Razorpay webhook + the
 *   subscription state-machine transitions ship separately as piece
 *   3c (per docs/PEARL_OPEN_DECISIONS.md "DECISIONS LANDED 2026-05-24"
 *   §1).
 *
 * GST split
 * ─────────
 * GST is split CGST+SGST when the tenant's place of supply matches
 * the platform-operator state, IGST otherwise. `Tenant` itself has
 * no state column today (the only state-typed field on the model
 * tree is `Branch.state`), so we look up the tenant's default
 * `Branch` (`isDefault=true`) and compare its `state` string against
 * the constant `PLATFORM_OPERATOR_STATE` below. If the default
 * branch has no state set OR no default branch exists, we default
 * to IGST (the safer cross-state assumption — under-charging GST on
 * an interstate transaction is a tax exposure; over-charging on an
 * intrastate one is recoverable). A separate piece will add an
 * explicit `Tenant.gstinNumber` + `Tenant.stateCode` field; until
 * then this resolution path is the load-bearing source.
 *
 * Idempotency
 * ───────────
 * - Per-tenant-per-month: a `PlatformInvoice.findFirst({ where: {
 *   tenantId, periodStart } })` gate skips re-generation. Safe to
 *   re-run after a partial outage.
 * - `markInvoicePaid`: no-op when `status === "PAID"`. Safe to
 *   re-call from a Razorpay webhook retry.
 *
 * Numbering
 * ─────────
 * `PI-YYYYMM-NNNN` per the schema header. `NNNN` is a monotonic
 * per-month counter scoped to ALL tenants in that month, computed
 * as `count(PlatformInvoice where invoiceNumber LIKE 'PI-YYYYMM-%')
 * + 1`. The schema's `@@unique` on `invoiceNumber` collapses a race
 * to a Prisma unique-violation, which the caller handles by
 * retrying once with the next counter (rare in a once-monthly
 * cron, but the retry costs nothing). All numbers issued in the
 * same month form a contiguous sequence — required for GST-audit
 * traceability.
 */
import type { Prisma, PrismaClient } from "@medcore/db";
import { requirePlanByKey } from "./plan-catalog";
import {
  aggregateUsageForBilling,
  USAGE_KIND_LABEL,
} from "./usage-tracker";

/**
 * Platform-operator place-of-supply state used for the CGST+SGST vs
 * IGST decision. Set to Karnataka (the most common Indian SaaS-vendor
 * registration state). When the operator's billing entity moves, flip
 * this constant — the schema persists per-invoice CGST/SGST/IGST so
 * historical invoices are unaffected.
 */
export const PLATFORM_OPERATOR_STATE = "Karnataka";

const CGST_RATE = 9;
const SGST_RATE = 9;
const IGST_RATE = 18;
const SAAS_HSN_SAC = "998314";

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

/**
 * Compute the UTC [startOfPreviousMonth, startOfThisMonth) window for
 * a given `now` instant. Bounds are midnight UTC on the 1st of each
 * month — the half-open interval guarantees a notification or signup
 * exactly at `00:00:00.000 UTC` on the 1st of `now`'s month belongs to
 * `now`'s month, not the previous one.
 */
export function computePreviousMonthUtcWindow(now: Date): {
  periodStart: Date;
  periodEnd: Date;
  yyyymm: string;
  monthLabel: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11
  const periodEnd = new Date(Date.UTC(year, month, 1));
  const periodStart = new Date(
    Date.UTC(month === 0 ? year - 1 : year, month === 0 ? 11 : month - 1, 1),
  );
  const psYear = periodStart.getUTCFullYear();
  const psMonth = periodStart.getUTCMonth() + 1; // 1-12 for label
  const yyyymm = `${psYear}${String(psMonth).padStart(2, "0")}`;
  return {
    periodStart,
    periodEnd,
    yyyymm,
    monthLabel: `${MONTH_LABEL[periodStart.getUTCMonth()]} ${psYear}`,
  };
}

export interface GenerateMonthlyPlatformInvoicesResult {
  generated: number;
  skippedAlreadyExists: number;
  skippedInactive: number;
  errors: number;
  invoiceIds: string[];
  yyyymm: string;
}

/**
 * Generate one `PlatformInvoice` per `active` tenant for the previous
 * calendar month. Idempotent — a re-run skips any tenant that already
 * has an invoice with the same `periodStart`. Returns a digest the
 * scheduler can log.
 */
export async function generateMonthlyPlatformInvoices(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<GenerateMonthlyPlatformInvoicesResult> {
  const { periodStart, periodEnd, yyyymm, monthLabel } =
    computePreviousMonthUtcWindow(now);

  const summary: GenerateMonthlyPlatformInvoicesResult = {
    generated: 0,
    skippedAlreadyExists: 0,
    skippedInactive: 0,
    errors: 0,
    invoiceIds: [],
    yyyymm,
  };

  const subscriptions = await prisma.tenantSubscription.findMany({
    where: { status: "active" },
    select: {
      id: true,
      tenantId: true,
      plan: true,
      customPriceMonthlyInPaise: true,
      tenant: {
        select: {
          id: true,
          name: true,
          active: true,
          branches: {
            where: { isDefault: true },
            select: { state: true },
            take: 1,
          },
        },
      },
    },
  });

  for (const sub of subscriptions) {
    if (!sub.tenant?.active) {
      summary.skippedInactive += 1;
      continue;
    }
    try {
      const existing = await prisma.platformInvoice.findFirst({
        where: { tenantId: sub.tenantId, periodStart },
        select: { id: true },
      });
      if (existing) {
        summary.skippedAlreadyExists += 1;
        continue;
      }

      // Resolve the tier from the dynamic plan catalog (DB).
      const planDef = await requirePlanByKey(prisma, sub.plan);
      const planUnitPriceInPaise =
        sub.customPriceMonthlyInPaise ?? planDef.monthlyPriceInPaise;

      const tenantState = sub.tenant.branches?.[0]?.state ?? null;
      const sameState =
        !!tenantState && tenantState.trim().toLowerCase() ===
          PLATFORM_OPERATOR_STATE.toLowerCase();

      // Pearl §8.3 piece 3e — aggregate usage events for the period and
      // emit one additional line item per usage kind that has activity.
      // Same GST rates apply per line; per-line `amountInPaise` rolls up
      // into the invoice subtotal below.
      const usageRows = await aggregateUsageForBilling(
        prisma,
        sub.tenantId,
        periodStart,
        periodEnd,
      );

      const lineItems: Prisma.PlatformInvoiceLineItemCreateWithoutInvoiceInput[] =
        [
          {
            description: `MedCore HMS — ${planDef.name} subscription ${monthLabel}`,
            unitPriceInPaise: planUnitPriceInPaise,
            quantity: 1,
            amountInPaise: planUnitPriceInPaise,
            hsnSacCode: SAAS_HSN_SAC,
            cgstRate: sameState ? CGST_RATE : 0,
            sgstRate: sameState ? SGST_RATE : 0,
            igstRate: sameState ? 0 : IGST_RATE,
          },
          ...usageRows.map((u) => ({
            description: `${USAGE_KIND_LABEL[u.kind]} (${u.totalQuantity.toLocaleString()}) — ${monthLabel}`,
            unitPriceInPaise: u.unitPriceInPaise,
            quantity: u.totalQuantity,
            amountInPaise: u.amountInPaise,
            hsnSacCode: SAAS_HSN_SAC,
            cgstRate: sameState ? CGST_RATE : 0,
            sgstRate: sameState ? SGST_RATE : 0,
            igstRate: sameState ? 0 : IGST_RATE,
          })),
        ];

      const subtotalInPaise = lineItems.reduce(
        (sum, li) => sum + li.amountInPaise,
        0,
      );
      const cgstInPaise = sameState
        ? Math.round((subtotalInPaise * CGST_RATE) / 100)
        : 0;
      const sgstInPaise = sameState
        ? Math.round((subtotalInPaise * SGST_RATE) / 100)
        : 0;
      const igstInPaise = sameState
        ? 0
        : Math.round((subtotalInPaise * IGST_RATE) / 100);
      const gstTotal = cgstInPaise + sgstInPaise + igstInPaise;
      const totalInPaise = subtotalInPaise + gstTotal;

      // Counter scoped to ALL tenants for this YYYYMM — produces
      // a contiguous monotonic sequence required for GST traceability.
      const monthCount = await prisma.platformInvoice.count({
        where: { invoiceNumber: { startsWith: `PI-${yyyymm}-` } },
      });
      const invoiceNumber = `PI-${yyyymm}-${String(monthCount + 1).padStart(4, "0")}`;

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
          lineItems: { create: lineItems },
        },
        select: { id: true },
      });
      summary.generated += 1;
      summary.invoiceIds.push(invoice.id);

      // Audit row — keep the failure here from poisoning the loop;
      // a missing audit on a successfully-created invoice is still
      // better than crashing the cron for everyone.
      try {
        await prisma.auditLog.create({
          data: {
            action: "PLATFORM_INVOICE_GENERATED",
            entity: "platform_invoice",
            entityId: invoice.id,
            details: {
              invoiceNumber,
              tenantId: sub.tenantId,
              tenantName: sub.tenant.name,
              plan: sub.plan,
              periodStart: periodStart.toISOString(),
              periodEnd: periodEnd.toISOString(),
              subtotalInPaise,
              cgstInPaise,
              sgstInPaise,
              igstInPaise,
              totalInPaise,
              gstSplit: sameState ? "CGST+SGST" : "IGST",
              tenantState,
              usageLineItems: usageRows.map((u) => ({
                kind: u.kind,
                totalQuantity: u.totalQuantity,
                amountInPaise: u.amountInPaise,
              })),
            } as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        console.error(
          "[platform_invoice_generator] failed to write audit row for",
          invoice.id,
          err,
        );
      }
    } catch (err) {
      summary.errors += 1;
      console.error(
        "[platform_invoice_generator] failed to generate invoice for tenant",
        sub.tenantId,
        err,
      );
    }
  }

  return summary;
}

/**
 * Pearl §8.3 — generate the FIRST invoice for a brand-new ACTIVE (no-trial)
 * subscription immediately at tenant creation, so a no-trial tenant is billed
 * from day 1 instead of waiting for the monthly arrears run. Bills the plan's
 * monthly amount for the subscription's current period (`currentPeriodStart →
 * currentPeriodEnd`) with the same GST split + `PI-YYYYMM-NNNN` numbering as
 * the monthly generator.
 *
 * - Trial subscriptions are a no-op (`{ generated: false }`) — they are billed
 *   only after the trial flips to active.
 * - Idempotent: skips if an invoice already exists for (tenantId, periodStart).
 * - Brand-new tenant → no usage events yet, so this is the plan line only.
 */
export async function generateInitialInvoiceForSubscription(
  prisma: PrismaClient,
  subscriptionId: string,
  now: Date = new Date(),
): Promise<{ generated: boolean; invoiceId?: string; invoiceNumber?: string }> {
  const sub = await prisma.tenantSubscription.findUnique({
    where: { id: subscriptionId },
    select: {
      id: true,
      tenantId: true,
      plan: true,
      status: true,
      customPriceMonthlyInPaise: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      tenant: {
        select: {
          active: true,
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
  // Only active (no-trial) subscriptions bill immediately; trials wait for the
  // daily trial-expiry cron to flip them to active.
  if (sub.status !== "active" || !sub.tenant?.active) {
    return { generated: false };
  }

  const periodStart = sub.currentPeriodStart;
  const periodEnd = sub.currentPeriodEnd;

  // Idempotency: never double-bill the same opening period.
  const existing = await prisma.platformInvoice.findFirst({
    where: { tenantId: sub.tenantId, periodStart },
    select: { id: true },
  });
  if (existing) return { generated: false };

  const planDef = await requirePlanByKey(prisma, sub.plan);
  const planUnitPriceInPaise =
    sub.customPriceMonthlyInPaise ?? planDef.monthlyPriceInPaise;

  const tenantState = sub.tenant.branches?.[0]?.state ?? null;
  const sameState =
    !!tenantState &&
    tenantState.trim().toLowerCase() === PLATFORM_OPERATOR_STATE.toLowerCase();

  const monthLabel = `${MONTH_LABEL[periodStart.getUTCMonth()]} ${periodStart.getUTCFullYear()}`;
  const yyyymm = `${periodStart.getUTCFullYear()}${String(
    periodStart.getUTCMonth() + 1,
  ).padStart(2, "0")}`;

  const lineItems: Prisma.PlatformInvoiceLineItemCreateWithoutInvoiceInput[] = [
    {
      description: `MedCore HMS — ${planDef.name} subscription ${monthLabel}`,
      unitPriceInPaise: planUnitPriceInPaise,
      quantity: 1,
      amountInPaise: planUnitPriceInPaise,
      hsnSacCode: SAAS_HSN_SAC,
      cgstRate: sameState ? CGST_RATE : 0,
      sgstRate: sameState ? SGST_RATE : 0,
      igstRate: sameState ? 0 : IGST_RATE,
    },
  ];

  const subtotalInPaise = planUnitPriceInPaise;
  const cgstInPaise = sameState
    ? Math.round((subtotalInPaise * CGST_RATE) / 100)
    : 0;
  const sgstInPaise = sameState
    ? Math.round((subtotalInPaise * SGST_RATE) / 100)
    : 0;
  const igstInPaise = sameState
    ? 0
    : Math.round((subtotalInPaise * IGST_RATE) / 100);
  const totalInPaise = subtotalInPaise + cgstInPaise + sgstInPaise + igstInPaise;

  const monthCount = await prisma.platformInvoice.count({
    where: { invoiceNumber: { startsWith: `PI-${yyyymm}-` } },
  });
  const invoiceNumber = `PI-${yyyymm}-${String(monthCount + 1).padStart(4, "0")}`;

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
      lineItems: { create: lineItems },
    },
    select: { id: true, invoiceNumber: true },
  });

  return {
    generated: true,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
  };
}

export interface MarkInvoicePaidResult {
  status: "PAID" | "ALREADY_PAID";
  invoiceId: string;
}

/**
 * Idempotently mark an invoice as PAID. Re-calling this on a PAID row
 * is a no-op — required so a Razorpay webhook retry (which can fire
 * the same payment event multiple times) cannot accidentally overwrite
 * the original `paidAt` / `paymentReference` stamps.
 *
 * On the transition this also writes one `AuditLog` row so the
 * super-admin trail captures who marked the invoice paid.
 */
export async function markInvoicePaid(
  prisma: PrismaClient,
  invoiceId: string,
  paidByUserId: string,
  paymentReference: string,
  now: Date = new Date(),
): Promise<MarkInvoicePaidResult> {
  const invoice = await prisma.platformInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      status: true,
      invoiceNumber: true,
      tenantId: true,
      totalInPaise: true,
    },
  });
  if (!invoice) {
    throw new Error(`PlatformInvoice ${invoiceId} not found`);
  }
  if (invoice.status === "PAID") {
    return { status: "ALREADY_PAID", invoiceId };
  }

  await prisma.platformInvoice.update({
    where: { id: invoiceId },
    data: {
      status: "PAID",
      paidAt: now,
      paidByUserId,
      paymentReference,
    },
  });

  try {
    await prisma.auditLog.create({
      data: {
        action: "PLATFORM_INVOICE_MARKED_PAID",
        entity: "platform_invoice",
        entityId: invoiceId,
        userId: paidByUserId,
        details: {
          invoiceNumber: invoice.invoiceNumber,
          tenantId: invoice.tenantId,
          totalInPaise: invoice.totalInPaise,
          paymentReference,
          paidAt: now.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error(
      "[platform_invoice_generator] failed to write paid-audit for",
      invoiceId,
      err,
    );
  }

  return { status: "PAID", invoiceId };
}
