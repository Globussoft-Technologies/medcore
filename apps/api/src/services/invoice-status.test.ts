/**
 * Invoice ↔ insurance financial reconciliation — unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: pins `services/invoice-status.ts` — `recomputeInvoiceStatus`
 *   (PAID / PARTIAL / PENDING from captured payments) and the provider-agnostic
 *   `postInsurancePayment` (posts an INSURANCE Payment, flips paymentStatus,
 *   idempotent by deterministic transactionId, caps at the outstanding balance
 *   so co-pay falls out as the residual, refuses non-positive / already-paid).
 * - MODULES: mocks `@medcore/db` (prisma + a $transaction that runs the callback
 *   with the mock as tx). `@medcore/shared` (computeInvoiceTotals /
 *   derivePaymentStatus) is the REAL pure implementation — no mock.
 * - WHY: closes the historical gap where a SETTLED claim never moved the
 *   invoice. This is money movement, so the idempotency + co-pay-cap behaviour
 *   must be regression-locked.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    invoice: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    payment: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({ id: "pay-new", ...args.data })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: undefined as any,
  };
  base.$transaction = vi.fn(async (fn: (tx: any) => unknown) => fn(base));
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import { recomputeInvoiceStatus, postInsurancePayment } from "./invoice-status";

/** A 10,000-total invoice with no GST (empty items + persisted overrides). */
function invoice(over: Partial<any> = {}) {
  return {
    id: "inv-1",
    tenantId: "t-1",
    paymentStatus: "PENDING",
    subtotal: 10000,
    taxAmount: 0,
    cgstAmount: 0,
    sgstAmount: 0,
    discountAmount: 0,
    totalAmount: 10000,
    items: [],
    payments: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.payment.findUnique.mockResolvedValue(null);
  prismaMock.payment.create.mockImplementation(async (args: any) => ({ id: "pay-new", ...args.data }));
  prismaMock.invoice.update.mockResolvedValue({});
  prismaMock.auditLog.create.mockResolvedValue({});
});

describe("recomputeInvoiceStatus", () => {
  it("marks a fully-paid invoice PAID and persists the change", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue(
      invoice({ payments: [{ amount: 10000, status: "CAPTURED" }] })
    );
    const r = await recomputeInvoiceStatus("inv-1");
    expect(r?.paymentStatus).toBe("PAID");
    expect(prismaMock.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paymentStatus: "PAID" } })
    );
  });

  it("marks a part-paid invoice PARTIAL", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue(
      invoice({ payments: [{ amount: 4000, status: "CAPTURED" }] })
    );
    const r = await recomputeInvoiceStatus("inv-1");
    expect(r?.paymentStatus).toBe("PARTIAL");
    expect(r?.balance).toBe(6000);
  });

  it("leaves an unpaid PENDING invoice untouched (no write)", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue(invoice({ payments: [] }));
    const r = await recomputeInvoiceStatus("inv-1");
    expect(r?.paymentStatus).toBe("PENDING");
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
  });

  it("ignores FAILED payments when computing net paid", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue(
      invoice({ payments: [{ amount: 10000, status: "FAILED" }] })
    );
    const r = await recomputeInvoiceStatus("inv-1");
    expect(r?.paymentStatus).toBe("PENDING");
  });

  it("returns null for a missing invoice", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue(null);
    expect(await recomputeInvoiceStatus("nope")).toBeNull();
  });
});

describe("postInsurancePayment", () => {
  const base = {
    invoiceId: "inv-1",
    provider: "PMJAY",
    claimId: "claim-1",
    claimRef: "REF1",
  };

  it("posts an INSURANCE payment and marks the invoice PARTIAL (co-pay remains)", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue(invoice({ payments: [] }));
    const r = await postInsurancePayment({ ...base, amount: 8000 });
    expect(r.posted).toBe(true);
    expect(r.amountPosted).toBe(8000);
    expect(r.paymentStatus).toBe("PARTIAL");
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: "inv-1",
          amount: 8000,
          mode: "INSURANCE",
          status: "CAPTURED",
          transactionId: "INS-SETTLE-PMJAY-REF1",
        }),
      })
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });

  it("is idempotent — an existing settlement payment is a no-op", async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ id: "pay-existing" });
    const r = await postInsurancePayment({ ...base, amount: 8000 });
    expect(r.posted).toBe(false);
    expect(r.reason).toMatch(/already settled/i);
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
  });

  it("caps the posted amount at the outstanding balance (over-approval → PAID, no overpay)", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue(
      invoice({ payments: [{ amount: 5000, status: "CAPTURED" }] })
    );
    const r = await postInsurancePayment({ ...base, amount: 8000 });
    expect(r.posted).toBe(true);
    expect(r.amountPosted).toBe(5000); // only the 5,000 still owed
    expect(r.paymentStatus).toBe("PAID");
  });

  it("skips when the invoice is already fully paid", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue(
      invoice({ paymentStatus: "PAID", payments: [{ amount: 10000, status: "CAPTURED" }] })
    );
    const r = await postInsurancePayment({ ...base, amount: 5000 });
    expect(r.posted).toBe(false);
    expect(r.reason).toMatch(/already fully paid/i);
  });

  it("refuses a non-positive settlement amount without opening a transaction", async () => {
    const r = await postInsurancePayment({ ...base, amount: 0 });
    expect(r.posted).toBe(false);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("builds the idempotency key from claimRef when present, else claimId", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue(invoice({ payments: [] }));
    await postInsurancePayment({ ...base, claimRef: null, amount: 1000 });
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ transactionId: "INS-SETTLE-PMJAY-claim-1" }),
      })
    );
  });
});
