// Unit-level idempotency tests for the Razorpay webhook handler.
//
// The integration suite at apps/api/src/test/integration/razorpay-webhook.test.ts
// already exercises the happy paths against a real DB:
//   - Missing signature (401), bad signature (401)
//   - Valid payment.captured marks invoice PAID
//   - Replay of payment.captured is idempotent (single Payment row)
//   - payment.failed records FAILED row
//   - /verify-payment orderId mismatch returns 400
//
// This file pins the THIN spots around the Payment.transactionId @unique
// idempotency that the audit flagged:
//
//   - payment.failed replay is also idempotent (existing test only sends
//     it once).
//   - refund.processed replay is idempotent against `RZP_REFUND:<id>`.
//   - P2002 (unique-constraint) race during create is swallowed and acked
//     200 — i.e. when /verify-payment wins the race, the webhook still
//     replies success.
//   - Unknown event types ack 200 (not 400) so Razorpay doesn't retry.
//   - Malformed JSON body returns 400.
//   - Missing payment.entity payload returns 200 without DB writes.
//   - Webhooks arriving for an unknown order_id are logged + ignored
//     (no Payment row created, 200 ack).
//
// Honorable mention #15 from the 2026-05-03 test gaps audit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

const WEBHOOK_SECRET = "test_webhook_secret_unit";

// Mock everything the heavy billing.ts module imports so that pulling in
// the webhook router doesn't drag in real Prisma / PDF / OpenAI clients.
const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    payment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(async () => []),
    },
    invoice: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (cb: any) => {
      // The handler invokes $transaction with a callback (tx) shape; just
      // call it with the same delegate object so the inner tx.payment.create
      // / tx.invoice.update calls land back on our mocks.
      if (typeof cb === "function") {
        return cb({
          payment: base.payment,
          invoice: base.invoice,
        });
      }
      return Promise.all(cb);
    }),
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("../services/tenant-prisma", () => ({ tenantScopedPrisma: prismaMock }));
vi.mock("../services/notification-triggers", () => ({
  onPaymentReceived: vi.fn(async () => {}),
  onBillGenerated: vi.fn(async () => {}),
}));
vi.mock("../services/pdf", () => ({
  generateInvoicePDF: vi.fn(async () => Buffer.from("pdf")),
}));
vi.mock("../services/pdf-generator", () => ({
  generateInvoicePDFBuffer: vi.fn(async () => Buffer.from("pdf")),
}));
vi.mock("../services/revenue", () => ({
  getRevenue: vi.fn(),
  getRefunds: vi.fn(),
  getOutstanding: vi.fn(),
}));
vi.mock("../services/razorpay", () => ({
  createPaymentOrder: vi.fn(),
  verifyPayment: vi.fn(() => true),
  fetchOrderAmountPaid: vi.fn(async () => null),
  // Real HMAC verify so signature behaviour is exercised, not stubbed.
  verifyWebhookSignature: (raw: Buffer, signature: string, secret: string | undefined) => {
    if (!secret) return false;
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  },
}));
const { auditLogMock } = vi.hoisted(() => ({
  auditLogMock: vi.fn(async () => {}),
}));
vi.mock("../middleware/audit", () => ({
  auditLog: auditLogMock,
}));
vi.mock("../services/ops-helpers", () => ({
  splitGst: vi.fn(() => ({ cgst: 0, sgst: 0, igst: 0 })),
}));

import { razorpayWebhookRouter } from "./billing";

function buildApp() {
  const app = express();
  // The webhook route uses express.raw internally; do not register a JSON
  // parser at the top level here — the inner middleware handles it.
  app.use("/api/v1/billing", razorpayWebhookRouter);
  return app;
}

function signWebhook(body: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function postWebhook(app: express.Express, event: object) {
  const body = JSON.stringify(event);
  return request(app)
    .post("/api/v1/billing/razorpay-webhook")
    .set("Content-Type", "application/json")
    .set("x-razorpay-signature", signWebhook(body))
    .send(body);
}

describe("Razorpay webhook idempotency thin spots (honorable mention #15)", () => {
  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    prismaMock.payment.findUnique.mockReset();
    prismaMock.payment.findFirst.mockReset();
    prismaMock.payment.create.mockReset();
    prismaMock.invoice.findFirst.mockReset();
    prismaMock.invoice.findUnique.mockReset();
    prismaMock.invoice.update.mockReset();
    prismaMock.$transaction.mockClear();
  });

  it("payment.failed replay is idempotent (existing transactionId → no second create)", async () => {
    // First call: no existing payment, create one.
    prismaMock.payment.findUnique.mockResolvedValueOnce(null);
    prismaMock.invoice.findFirst.mockResolvedValueOnce({
      id: "inv-1",
      razorpayOrderId: "order_x",
      totalAmount: 100,
      payments: [],
    });
    prismaMock.payment.create.mockResolvedValueOnce({ id: "pay-1" });

    const event = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: { id: "pay_xyz", order_id: "order_x", amount: 10000, status: "failed" },
        },
      },
    };

    const app = buildApp();
    const r1 = await postWebhook(app, event);
    expect(r1.status).toBe(200);
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1);

    // Replay: idempotency check finds the existing row → no second create.
    prismaMock.payment.findUnique.mockResolvedValueOnce({ id: "pay-1", transactionId: "pay_xyz" });
    const r2 = await postWebhook(app, event);
    expect(r2.status).toBe(200);
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1); // unchanged
  });

  it("refund.processed replay is idempotent (RZP_REFUND:<id> dup is detected)", async () => {
    const event = {
      event: "refund.processed",
      payload: {
        refund: { entity: { id: "rfnd_1", payment_id: "pay_xyz", amount: 5000 } },
      },
    };
    const app = buildApp();

    // First call: original payment exists, no dup refund yet.
    // status: "CAPTURED" so the refund fraud guard (added in a later
    // commit — only allow refund.processed against CAPTURED originals)
    // does not fire.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({ id: "p-1", transactionId: "pay_xyz", amount: 100, invoiceId: "inv-1", status: "CAPTURED" })
      .mockResolvedValueOnce(null); // dup refund check
    prismaMock.payment.findMany
      // 1st findMany: prior refunds against this parent (cumulative-fraud guard
      // 3, added 2026-05-04). Empty — no prior refunds for this captured pay.
      .mockResolvedValueOnce([])
      // 2nd findMany: post-create net recompute over the invoice's payments.
      .mockResolvedValueOnce([
        { id: "p-1", invoiceId: "inv-1", amount: 100, status: "CAPTURED" },
        { id: "p-2", invoiceId: "inv-1", amount: -50, status: "REFUNDED" },
      ]);
    prismaMock.invoice.findUnique.mockResolvedValueOnce({ id: "inv-1", totalAmount: 100 });
    prismaMock.payment.create.mockResolvedValueOnce({ id: "p-2" });

    const r1 = await postWebhook(app, event);
    expect(r1.status).toBe(200);
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1);

    // Replay: dup-refund findUnique returns the existing refund row → ack
    // 200 without a second create.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({ id: "p-1", transactionId: "pay_xyz", amount: 100, invoiceId: "inv-1", status: "CAPTURED" })
      .mockResolvedValueOnce({ id: "p-2", transactionId: "RZP_REFUND:rfnd_1" });

    const r2 = await postWebhook(app, event);
    expect(r2.status).toBe(200);
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1); // unchanged
  });

  it("P2002 race during create is swallowed: webhook still acks 200", async () => {
    // /verify-payment wins the race: by the time the webhook's inner
    // tx.payment.create fires, the row is already there. Prisma raises P2002.
    prismaMock.payment.findUnique.mockResolvedValueOnce(null);
    prismaMock.invoice.findFirst.mockResolvedValueOnce({
      id: "inv-1",
      razorpayOrderId: "order_x",
      totalAmount: 100,
      payments: [],
    });
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    prismaMock.$transaction.mockRejectedValueOnce(p2002);

    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_race", order_id: "order_x", amount: 10000, status: "captured" },
        },
      },
    };

    const res = await postWebhook(buildApp(), event);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("unknown event type still acks 200 (no DB writes)", async () => {
    const event = {
      event: "subscription.charged",
      payload: { payment: { entity: { id: "pay_sub", order_id: "order_y", amount: 100 } } },
    };
    const res = await postWebhook(buildApp(), event);
    expect(res.status).toBe(200);
    expect(prismaMock.payment.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
  });

  it("malformed JSON body returns 400 (no handler invoked)", async () => {
    const rawText = "{not-json";
    const sig = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(Buffer.from(rawText, "utf8"))
      .digest("hex");
    const res = await request(buildApp())
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sig)
      .send(rawText);
    expect(res.status).toBe(400);
    expect(prismaMock.payment.findUnique).not.toHaveBeenCalled();
  });

  it("missing payment.entity payload acks 200 with no DB writes", async () => {
    const event = { event: "payment.captured", payload: {} };
    const res = await postWebhook(buildApp(), event);
    expect(res.status).toBe(200);
    expect(prismaMock.payment.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
  });

  it("payment.captured for unknown order_id is logged + ignored (no Payment row, 200 ack)", async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(null);
    prismaMock.invoice.findFirst.mockResolvedValueOnce(null); // no invoice with this orderId

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_orphan", order_id: "order_unknown", amount: 1000, status: "captured" },
        },
      },
    };
    const res = await postWebhook(buildApp(), event);
    expect(res.status).toBe(200);
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/invoice not found/i),
      expect.anything()
    );
    warnSpy.mockRestore();
  });

  it("missing signature header returns 401 (defence in depth)", async () => {
    const res = await request(buildApp())
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ event: "payment.captured" }));
    expect(res.status).toBe(401);
  });
});

describe("Fraud guard — different transactionId on PAID invoice", () => {
  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    prismaMock.payment.findUnique.mockReset();
    prismaMock.payment.findFirst.mockReset();
    prismaMock.payment.create.mockReset();
    prismaMock.invoice.findFirst.mockReset();
    prismaMock.invoice.findUnique.mockReset();
    prismaMock.invoice.update.mockReset();
    prismaMock.$transaction.mockClear();
    auditLogMock.mockClear();
  });

  it("happy idempotency: same transactionId retry on a PAID invoice → 200 with idempotent ack, no new Payment, no audit", async () => {
    // Global Payment.transactionId @unique check: nothing yet (the row
    // we'll match below is invoice-scoped, simulating the case where the
    // global lookup missed for whatever reason — e.g. a different shard).
    // In practice the first global findUnique would already short-circuit
    // for a true retry, so this is the belt-and-braces invoice-scoped
    // branch firing.
    prismaMock.payment.findUnique.mockResolvedValueOnce(null);
    prismaMock.invoice.findFirst.mockResolvedValueOnce({
      id: "inv-paid-1",
      razorpayOrderId: "order_paid",
      totalAmount: 100,
      paymentStatus: "PAID",
      payments: [
        { id: "p-existing", transactionId: "pay_known", amount: 100, status: "CAPTURED" },
      ],
    });
    // Invoice-scoped lookup for the SAME transactionId → row found.
    prismaMock.payment.findFirst.mockResolvedValueOnce({ id: "p-existing" });

    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_known", order_id: "order_paid", amount: 10000, status: "captured" },
        },
      },
    };

    const res = await postWebhook(buildApp(), event);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it("fraud detection: different transactionId on a PAID invoice → 409 INVOICE_ALREADY_PAID_DIFFERENT_TXN, no Payment, audit row written", async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(null);
    prismaMock.invoice.findFirst.mockResolvedValueOnce({
      id: "inv-paid-2",
      razorpayOrderId: "order_paid_2",
      totalAmount: 100,
      paymentStatus: "PAID",
      payments: [
        { id: "p-old", transactionId: "pay_legit_old", amount: 100, status: "CAPTURED" },
      ],
    });
    // Invoice-scoped lookup for the NEW transactionId → not found.
    prismaMock.payment.findFirst.mockResolvedValueOnce(null);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_forged_new", order_id: "order_paid_2", amount: 10000, status: "captured" },
        },
      },
    };

    const res = await postWebhook(buildApp(), event);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      data: null,
      error: "Invoice already settled",
      code: "INVOICE_ALREADY_PAID_DIFFERENT_TXN",
    });
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();

    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const auditCall = auditLogMock.mock.calls[0] as unknown as unknown[];
    expect(auditCall[1]).toBe("RAZORPAY_WEBHOOK_FRAUD_SUSPECT");
    expect(auditCall[2]).toBe("Invoice");
    expect(auditCall[3]).toBe("inv-paid-2");
    expect(auditCall[4]).toMatchObject({
      incomingTransactionId: "pay_forged_new",
      invoiceStatus: "PAID",
      amountPaise: 10000,
    });

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/FRAUD SUSPECT/),
      expect.objectContaining({ invoiceId: "inv-paid-2" })
    );
    errSpy.mockRestore();
  });

  it("normal flow unaffected: different transactionId on a PENDING invoice still marks PAID and creates Payment", async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(null);
    prismaMock.invoice.findFirst.mockResolvedValueOnce({
      id: "inv-pending-1",
      razorpayOrderId: "order_pending",
      totalAmount: 100,
      paymentStatus: "PENDING",
      payments: [
        // A previous FAILED attempt — totalPaid stays 0 because handler
        // sums payment.amount (FAILED rows have amount: 0).
        { id: "p-fail-1", transactionId: "pay_fail_1", amount: 0, status: "FAILED" },
      ],
    });
    prismaMock.payment.create.mockResolvedValueOnce({ id: "pay-new" });

    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_retry_success", order_id: "order_pending", amount: 10000, status: "captured" },
        },
      },
    };

    const res = await postWebhook(buildApp(), event);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // No fraud-guard branch fired → no findFirst call, no audit row.
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
    // Payment row was created and invoice was updated to PAID.
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "inv-pending-1" },
        data: expect.objectContaining({ paymentStatus: "PAID" }),
      })
    );
  });

  it("auth still enforced: bad HMAC signature is 401 even when invoice would be PAID", async () => {
    // Even if the body looks like a fraud-attempt against a PAID invoice,
    // the HMAC check has to fail before any handler runs. No DB hit.
    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_attacker", order_id: "order_paid_3", amount: 10000, status: "captured" },
        },
      },
    };
    const body = JSON.stringify(event);
    const res = await request(buildApp())
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", "deadbeef".repeat(8)) // wrong sig
      .send(body);

    expect(res.status).toBe(401);
    expect(prismaMock.payment.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.invoice.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fraud guard — refund.processed (analogous to the captured-side guard)
//
// What it covers: handleRefundProcessed in apps/api/src/routes/billing.ts,
// reached via POST /api/v1/billing/razorpay-webhook with event=refund.processed.
//
// Surfaces touched: prisma.payment (lookup + dup check + create), audit
// log (RAZORPAY_WEBHOOK_FRAUD_SUSPECT), and the route's 409 translation.
//
// Why these tests exist: the original handler only caught duplicate
// refundIds (RZP_REFUND:<id>). A forged webhook with a fresh refundId
// pointing at a non-CAPTURED payment, or with an `amount` larger than
// the payment it claims to refund, would otherwise silently write a
// fictitious negative-amount Payment row — a refund-side analogue of
// the gap closed for handlePaymentCaptured in commit 9486409. These
// tests pin both fraud branches and the legitimate-retry path so the
// invoice can never end up REFUNDED based on a forged event.
// ---------------------------------------------------------------------------
describe("Fraud guard — refund.processed (forged refund webhooks)", () => {
  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    prismaMock.payment.findUnique.mockReset();
    prismaMock.payment.findFirst.mockReset();
    prismaMock.payment.create.mockReset();
    prismaMock.payment.findMany.mockReset();
    prismaMock.invoice.findFirst.mockReset();
    prismaMock.invoice.findUnique.mockReset();
    prismaMock.invoice.update.mockReset();
    prismaMock.$transaction.mockClear();
    auditLogMock.mockClear();
  });

  function refundEvent(opts: { refundId: string; paymentId: string; amountPaise?: number }) {
    return {
      event: "refund.processed",
      payload: {
        refund: {
          entity: {
            id: opts.refundId,
            payment_id: opts.paymentId,
            amount: opts.amountPaise,
          },
        },
      },
    };
  }

  it("rejects refund.processed against a FAILED original → 409 REFUND_AGAINST_NON_CAPTURED_PAYMENT, no Payment row written, audit logged", async () => {
    // Original payment exists but its status is FAILED — Razorpay should
    // never legitimately refund a failed capture.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({
        id: "pay-failed-1",
        transactionId: "pay_failed_orig",
        amount: 100,
        invoiceId: "inv-1",
        status: "FAILED",
      })
      .mockResolvedValueOnce(null); // dup refund check

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await postWebhook(
      buildApp(),
      refundEvent({ refundId: "rfnd_forge_1", paymentId: "pay_failed_orig", amountPaise: 5000 })
    );

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      data: null,
      code: "REFUND_AGAINST_NON_CAPTURED_PAYMENT",
    });
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();

    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const auditCall = auditLogMock.mock.calls[0] as unknown as unknown[];
    expect(auditCall[1]).toBe("RAZORPAY_WEBHOOK_FRAUD_SUSPECT");
    expect(auditCall[2]).toBe("Payment");
    expect(auditCall[3]).toBe("pay-failed-1");
    expect(auditCall[4]).toMatchObject({
      kind: "REFUND_AGAINST_NON_CAPTURED_PAYMENT",
      incomingRefundId: "rfnd_forge_1",
      originalStatus: "FAILED",
    });

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/FRAUD SUSPECT/),
      expect.objectContaining({ originalStatus: "FAILED" })
    );
    errSpy.mockRestore();
  });

  it("rejects refund.processed against an already-REFUNDED original → 409 REFUND_AGAINST_NON_CAPTURED_PAYMENT", async () => {
    // The original 'payment' row here is itself a previous refund row
    // (status=REFUNDED, negative amount). A fresh refund.processed
    // pointing at it would otherwise trigger a no-op due to the same
    // status mismatch — but more concerning, this is the shape a forged
    // event would take if the attacker harvested an old refund id.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({
        id: "pay-refunded-1",
        transactionId: "pay_already_refunded",
        amount: 100,
        invoiceId: "inv-2",
        status: "REFUNDED",
      })
      .mockResolvedValueOnce(null);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await postWebhook(
      buildApp(),
      refundEvent({ refundId: "rfnd_forge_2", paymentId: "pay_already_refunded", amountPaise: 10000 })
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REFUND_AGAINST_NON_CAPTURED_PAYMENT");
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(auditLogMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("rejects refund whose amount exceeds the original payment → 409 REFUND_EXCEEDS_PAYMENT, no Payment row written, audit logged", async () => {
    // Original payment of ₹100 (10000 paise). Forged refund claims
    // ₹500 (50000 paise) — physically impossible and the most obvious
    // class of refund forgery to catch.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({
        id: "pay-captured-1",
        transactionId: "pay_real_orig",
        amount: 100,
        invoiceId: "inv-3",
        status: "CAPTURED",
      })
      .mockResolvedValueOnce(null);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await postWebhook(
      buildApp(),
      refundEvent({ refundId: "rfnd_overrefund", paymentId: "pay_real_orig", amountPaise: 50000 })
    );

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      data: null,
      code: "REFUND_EXCEEDS_PAYMENT",
    });
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();

    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const auditCall = auditLogMock.mock.calls[0] as unknown as unknown[];
    expect(auditCall[4]).toMatchObject({
      kind: "REFUND_EXCEEDS_PAYMENT",
      originalAmount: 100,
      refundAmount: 500,
      incomingRefundId: "rfnd_overrefund",
    });

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/exceeds original payment/i),
      expect.objectContaining({ refundAmount: 500, originalAmount: 100 })
    );
    errSpy.mockRestore();
  });

  it("normal refund unchanged: amount ≤ original on a CAPTURED payment writes the negative Payment row + recomputes invoice status, no audit row", async () => {
    // A legitimate partial refund: ₹50 against a ₹100 captured payment.
    // The handler should write the negative Payment row and recompute
    // invoice status to PARTIAL — exactly the pre-existing behaviour.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({
        id: "pay-captured-2",
        transactionId: "pay_real_partial",
        amount: 100,
        invoiceId: "inv-4",
        status: "CAPTURED",
      })
      .mockResolvedValueOnce(null);
    prismaMock.payment.findMany
      // 1st findMany: prior refunds against this parent (cumulative-fraud
      // guard 3). Empty — this is the first partial refund.
      .mockResolvedValueOnce([])
      // 2nd findMany: post-create net recompute over the invoice's payments.
      .mockResolvedValueOnce([
        { id: "pay-captured-2", invoiceId: "inv-4", amount: 100, status: "CAPTURED" },
        { id: "rfnd-1", invoiceId: "inv-4", amount: -50, status: "REFUNDED" },
      ]);
    prismaMock.invoice.findUnique.mockResolvedValueOnce({ id: "inv-4", totalAmount: 100 });
    prismaMock.payment.create.mockResolvedValueOnce({ id: "rfnd-1" });

    const res = await postWebhook(
      buildApp(),
      refundEvent({ refundId: "rfnd_partial_legit", paymentId: "pay_real_partial", amountPaise: 5000 })
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "inv-4" },
        data: expect.objectContaining({ paymentStatus: "PARTIAL" }),
      })
    );
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it("rejects refund whose CUMULATIVE total against the same parent exceeds the original payment → 409 REFUND_CUMULATIVE_EXCEEDS_PAYMENT (fraud guard 3)", async () => {
    // Fraud class that guard 2 (`REFUND_EXCEEDS_PAYMENT`) lets through:
    // each individual refund event is < original (so guard 2 stays silent),
    // but the SUM of refunds against the same parent exceeds the original.
    //
    // Setup: ₹100 captured payment with two prior partial refunds totalling
    // ₹70. A new refund.processed for ₹40 would push cumulative to ₹110
    // — past the ₹100 ceiling. Guard 3 fires, no Payment row written,
    // audit logged with the cumulative arithmetic.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({
        id: "pay-cumulative-orig",
        transactionId: "pay_cumulative",
        amount: 100,
        invoiceId: "inv-cum",
        status: "CAPTURED",
      })
      .mockResolvedValueOnce(null); // dup refund check — not a dup
    prismaMock.payment.findMany.mockResolvedValueOnce([
      // Prior refunds totalling ₹70 against pay-cumulative-orig.
      { id: "rfnd-prior-1", amount: -30 },
      { id: "rfnd-prior-2", amount: -40 },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await postWebhook(
      buildApp(),
      refundEvent({
        refundId: "rfnd_cumulative_overshoot",
        paymentId: "pay_cumulative",
        amountPaise: 4000, // ₹40 — under guard 2 (≤ original ₹100), but
                           // 70 + 40 = 110 > 100, trips guard 3.
      })
    );

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      data: null,
      code: "REFUND_CUMULATIVE_EXCEEDS_PAYMENT",
    });
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();

    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const auditCall = auditLogMock.mock.calls[0] as unknown as unknown[];
    expect(auditCall[4]).toMatchObject({
      kind: "REFUND_CUMULATIVE_EXCEEDS_PAYMENT",
      originalAmount: 100,
      priorRefundTotal: 70,
      incomingRefundAmount: 40,
      cumulativeAfter: 110,
      incomingRefundId: "rfnd_cumulative_overshoot",
    });

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/cumulative refunds exceed original payment/i),
      expect.objectContaining({
        originalAmount: 100,
        priorRefundTotal: 70,
        incomingRefundAmount: 40,
      })
    );
    errSpy.mockRestore();
  });

  it("at-the-ceiling cumulative refund (sum exactly equals original) is allowed — equality is not fraud", async () => {
    // ₹100 captured, ₹60 already refunded across prior events, incoming
    // refund for ₹40 → cumulative is ₹100 == original. The guard uses
    // strict `>`, not `>=`, so this is the legitimate "fully refunded
    // across many partials" case and must pass through to the create
    // path.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({
        id: "pay-exact",
        transactionId: "pay_exact",
        amount: 100,
        invoiceId: "inv-exact",
        status: "CAPTURED",
      })
      .mockResolvedValueOnce(null);
    prismaMock.payment.findMany
      // Prior refunds: ₹60 already refunded.
      .mockResolvedValueOnce([{ id: "rfnd-p1", amount: -60 }])
      // Post-create net recompute.
      .mockResolvedValueOnce([
        { id: "pay-exact", invoiceId: "inv-exact", amount: 100, status: "CAPTURED" },
        { id: "rfnd-p1", invoiceId: "inv-exact", amount: -60, status: "REFUNDED" },
        { id: "rfnd-tip", invoiceId: "inv-exact", amount: -40, status: "REFUNDED" },
      ]);
    prismaMock.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-exact",
      totalAmount: 100,
    });
    prismaMock.payment.create.mockResolvedValueOnce({ id: "rfnd-tip" });

    const res = await postWebhook(
      buildApp(),
      refundEvent({
        refundId: "rfnd_tip",
        paymentId: "pay_exact",
        amountPaise: 4000,
      })
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1);
    expect(auditLogMock).not.toHaveBeenCalled();
    // Net is now 0 → invoice flips to REFUNDED.
    expect(prismaMock.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "inv-exact" },
        data: expect.objectContaining({ paymentStatus: "REFUNDED" }),
      })
    );
  });

  it("successful refund stamps parentPaymentId so the next refund event can sum against the same parent", async () => {
    // Defence-in-depth: if the parentPaymentId stamp goes missing on the
    // create path, every refund looks like the first one to guard 3 and
    // cumulative detection breaks silently. Pin the create-arg shape so
    // a future refactor that drops the field fails this test.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({
        id: "pay-stamp",
        transactionId: "pay_stamp",
        amount: 100,
        invoiceId: "inv-stamp",
        status: "CAPTURED",
      })
      .mockResolvedValueOnce(null);
    prismaMock.payment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "pay-stamp", invoiceId: "inv-stamp", amount: 100, status: "CAPTURED" },
        { id: "rfnd-stamp", invoiceId: "inv-stamp", amount: -25, status: "REFUNDED" },
      ]);
    prismaMock.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-stamp",
      totalAmount: 100,
    });
    prismaMock.payment.create.mockResolvedValueOnce({ id: "rfnd-stamp" });

    const res = await postWebhook(
      buildApp(),
      refundEvent({
        refundId: "rfnd_stamp",
        paymentId: "pay_stamp",
        amountPaise: 2500,
      })
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parentPaymentId: "pay-stamp",
          status: "REFUNDED",
          amount: -25,
        }),
      })
    );
  });

  it("legitimate Razorpay retry (same refundId) still acks 200 with no audit, even when the original is FAILED — dup-check fires before fraud guards", async () => {
    // Defence in depth: an attacker can't stage an invariant-violating
    // refund THEN piggyback on a real retry to escape audit. This
    // exercises the ordering: the dup-refund findUnique (line 2 of the
    // handler) returns the existing refund row → handler returns
    // immediately with no audit and no fraud-guard branch fired, even
    // though the original is FAILED.
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({
        id: "pay-misc-1",
        transactionId: "pay_dup_retry",
        amount: 100,
        invoiceId: "inv-5",
        status: "FAILED", // would trip fraud guard 1 if reached
      })
      .mockResolvedValueOnce({ id: "rfnd-prev", transactionId: "RZP_REFUND:rfnd_dup" });

    const res = await postWebhook(
      buildApp(),
      refundEvent({ refundId: "rfnd_dup", paymentId: "pay_dup_retry", amountPaise: 5000 })
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });
});
