// Invoice ↔ insurance financial reconciliation.
//
// Closes the long-standing gap where a SETTLED insurance claim never touched
// its Invoice: the balance stayed at the full amount even after the TPA paid.
// `postInsurancePayment` is deliberately PROVIDER-AGNOSTIC — the same code
// settles PM-JAY, Medi Assist, Paramount, Star Health, FHPL and ICICI, keyed
// only by the claim's `tpaProvider` string. `recomputeInvoiceStatus` reuses the
// shared single-source-of-truth helpers (`computeInvoiceTotals` +
// `derivePaymentStatus`) so the resulting paymentStatus agrees with every
// billing UI. Safe to call from a background worker: no `req`/ALS dependency,
// tenantId is passed explicitly, and posting is idempotent by a deterministic
// Payment.transactionId.

import { prisma } from "@medcore/db";
import { computeInvoiceTotals, derivePaymentStatus } from "@medcore/shared";

/** Coerce a Prisma.Decimal / number / string to a JS number for arithmetic. */
function dec(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const anyV = v as { toNumber?: () => number };
  return typeof anyV.toNumber === "function" ? anyV.toNumber() : Number(v);
}

/** Statuses we are allowed to write back to Invoice.paymentStatus. */
const WRITABLE_STATUSES = new Set(["PENDING", "PARTIAL", "PAID", "REFUNDED"]);

/** Minimal shape of a Prisma client / transaction client we depend on. */
type Db = typeof prisma;

interface InvoiceForTotals {
  paymentStatus: string;
  subtotal: unknown;
  taxAmount: unknown;
  cgstAmount: unknown;
  sgstAmount: unknown;
  discountAmount: unknown;
  totalAmount: unknown;
  items: Array<{ amount: unknown; category?: string | null }>;
  payments: Array<{ amount: number; status: string }>;
}

function totalsAndPaid(inv: InvoiceForTotals): { total: number; netPaid: number } {
  const totals = computeInvoiceTotals(
    inv.items.map((it) => ({ amount: dec(it.amount), category: it.category })),
    {
      subtotal: dec(inv.subtotal),
      taxAmount: dec(inv.taxAmount),
      cgstAmount: dec(inv.cgstAmount),
      sgstAmount: dec(inv.sgstAmount),
      discountAmount: dec(inv.discountAmount),
      totalAmount: dec(inv.totalAmount),
    }
  );
  // Net paid = captured payments only (FAILED never counts; REFUNDED reverses).
  const netPaid = +inv.payments
    .reduce((s, p) => s + (p.status === "CAPTURED" ? Number(p.amount) : 0), 0)
    .toFixed(2);
  return { total: totals.totalAmount, netPaid };
}

export interface RecomputeResult {
  paymentStatus: string;
  totalAmount: number;
  netPaid: number;
  balance: number;
}

/**
 * Recompute an invoice's paymentStatus from its items + captured payments and
 * persist it when it changed. Pure of any settlement logic — reusable anywhere
 * an invoice's balance may have moved.
 */
export async function recomputeInvoiceStatus(
  invoiceId: string,
  client: Db = prisma
): Promise<RecomputeResult | null> {
  const inv = (await client.invoice.findUnique({
    where: { id: invoiceId },
    include: { items: true, payments: true },
  })) as InvoiceForTotals | null;
  if (!inv) return null;

  const { total, netPaid } = totalsAndPaid(inv);
  const status = derivePaymentStatus(inv.paymentStatus, total, netPaid);

  if (WRITABLE_STATUSES.has(status) && status !== inv.paymentStatus) {
    await client.invoice.update({
      where: { id: invoiceId },
      // status is one of the PaymentStatus enum members after the guard above.
      data: { paymentStatus: status as never },
    });
  }
  return { paymentStatus: status, totalAmount: total, netPaid, balance: +(total - netPaid).toFixed(2) };
}

export interface PostInsurancePaymentInput {
  invoiceId: string;
  /** Amount the TPA approved / paid the hospital (INR). */
  amount: number;
  /** tpaProvider string (PMJAY, MEDI_ASSIST, …) — used in the idempotency key + audit. */
  provider: string;
  /** Our internal claim id (for the audit trail). */
  claimId: string;
  /** The provider's claim reference — the stable half of the idempotency key. */
  claimRef?: string | null;
  /** Explicit tenant for background (no-ALS) callers. Falls back to the invoice's. */
  tenantId?: string | null;
  /** User id for audit attribution; null for scheduler-driven settlements. */
  createdBy?: string | null;
}

export interface PostInsurancePaymentResult {
  posted: boolean;
  reason?: string;
  paymentId?: string;
  paymentStatus?: string;
  amountPosted?: number;
}

/**
 * Post an insurance settlement as an `INSURANCE`-mode Payment against the linked
 * Invoice and recompute its status — the write-back that turns a SETTLED claim
 * into real money movement.
 *
 * Idempotent: the Payment carries a deterministic `transactionId`
 * (`INS-SETTLE-<provider>-<ref>`) which is `@unique`, so a replay (retry, double
 * reconcile tick, both the poller and a manual `?sync=1` firing) is a no-op.
 *
 * Co-pay / partial settlement fall out naturally: we post at most the current
 * outstanding balance, so whatever the insurer did NOT cover remains as the
 * patient-payable balance and the status lands on PARTIAL rather than PAID.
 */
export async function postInsurancePayment(
  input: PostInsurancePaymentInput
): Promise<PostInsurancePaymentResult> {
  if (!(input.amount > 0)) {
    return { posted: false, reason: "non-positive settlement amount" };
  }
  const txnId = `INS-SETTLE-${input.provider}-${input.claimRef ?? input.claimId}`;

  return prisma.$transaction(async (tx) => {
    // Idempotency guard — deterministic transactionId is @unique on Payment.
    const existing = await tx.payment.findUnique({ where: { transactionId: txnId } });
    if (existing) {
      return { posted: false, reason: "already settled", paymentId: existing.id };
    }

    const inv = (await tx.invoice.findUnique({
      where: { id: input.invoiceId },
      include: { items: true, payments: true },
    })) as (InvoiceForTotals & { tenantId: string | null }) | null;
    if (!inv) return { posted: false, reason: "invoice not found" };

    const { total, netPaid } = totalsAndPaid(inv);
    const outstanding = +(total - netPaid).toFixed(2);
    if (outstanding <= 0.01) {
      return { posted: false, reason: "invoice already fully paid" };
    }

    // Never post more than what is owed — the remainder (if the insurer paid
    // less than the balance) stays as the patient's co-pay.
    const amountPosted = +Math.min(input.amount, outstanding).toFixed(2);
    const tenantId = input.tenantId ?? inv.tenantId ?? null;

    const payment = await tx.payment.create({
      data: {
        invoiceId: input.invoiceId,
        amount: amountPosted,
        mode: "INSURANCE" as never,
        status: "CAPTURED" as never,
        transactionId: txnId,
        tenantId,
      },
    });

    const newNetPaid = +(netPaid + amountPosted).toFixed(2);
    const status = derivePaymentStatus(inv.paymentStatus, total, newNetPaid);
    if (WRITABLE_STATUSES.has(status) && status !== inv.paymentStatus) {
      await tx.invoice.update({
        where: { id: input.invoiceId },
        data: { paymentStatus: status as never },
      });
    }

    // Background-safe audit: explicit tenantId, nullable userId (scheduler path).
    await tx.auditLog.create({
      data: {
        action: "INSURANCE_SETTLEMENT_PAYMENT",
        entity: "payment",
        entityId: payment.id,
        userId: input.createdBy ?? null,
        tenantId,
        details: {
          invoiceId: input.invoiceId,
          claimId: input.claimId,
          provider: input.provider,
          amountApproved: input.amount,
          amountPosted,
          resultingStatus: status,
        } as never,
      },
    });

    return { posted: true, paymentId: payment.id, paymentStatus: status, amountPosted };
  });
}
