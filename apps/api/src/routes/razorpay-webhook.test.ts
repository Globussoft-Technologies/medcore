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
vi.mock("../middleware/audit", () => ({
  auditLog: vi.fn(async () => {}),
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
    prismaMock.payment.findUnique
      .mockResolvedValueOnce({ id: "p-1", transactionId: "pay_xyz", amount: 100, invoiceId: "inv-1" })
      .mockResolvedValueOnce(null); // dup refund check
    prismaMock.payment.findMany.mockResolvedValueOnce([
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
      .mockResolvedValueOnce({ id: "p-1", transactionId: "pay_xyz", amount: 100, invoiceId: "inv-1" })
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
