// Integration tests for the Razorpay webhook handler and the hardened
// /verify-payment endpoint.
//
// Coverage:
//   1. Missing signature  → 401
//   2. Bad signature      → 401
//   3. Valid payment.captured → 200, Payment row, Invoice PAID
//   4. Replay of (3)      → 200, no duplicate row (idempotency)
//   5. payment.failed     → Payment with status FAILED, Invoice still unpaid
//   6. /verify-payment with spoofed amount → 400
//
// These tests intentionally drive the signed flow end-to-end (HMAC computed
// here with the same secret the server uses) so we exercise the real verify
// path — not a stub.

import { it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
  createInvoiceFixture,
} from "../factories";

const WEBHOOK_SECRET = "test_webhook_secret_123";
const PAYMENT_SECRET = "test_payment_secret_456";

let app: any;
let token: string;

function signWebhook(body: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function signPayment(orderId: string, paymentId: string): string {
  return crypto
    .createHmac("sha256", PAYMENT_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

async function freshInvoice(opts: { totalAmount?: number } = {}) {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  return createInvoiceFixture({
    patientId: patient.id,
    appointmentId: appt.id,
    overrides: opts.totalAmount
      ? { subtotal: opts.totalAmount, totalAmount: opts.totalAmount }
      : undefined,
  });
}

describeIfDB("Razorpay webhook + verify-payment hardening", () => {
  beforeAll(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.RAZORPAY_KEY_SECRET = PAYMENT_SECRET;
    // Intentionally leave RAZORPAY_KEY_ID unset so fetchOrderAmountPaid
    // returns null in mock mode and we control the amount-mismatch test
    // explicitly via signature-only tampering.
    await resetDB();
    token = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  beforeEach(async () => {
    // Each test creates its own invoice/orderId so cleanup is unnecessary.
  });

  it("rejects webhook with missing signature header (401)", async () => {
    const body = JSON.stringify({ event: "payment.captured" });
    const res = await request(app)
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("rejects webhook with a bad signature (401)", async () => {
    const body = JSON.stringify({ event: "payment.captured" });
    const res = await request(app)
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", "deadbeef".repeat(8))
      .send(body);
    expect(res.status).toBe(401);
  });

  it("processes a valid payment.captured: marks invoice PAID, records Payment", async () => {
    const invoice = await freshInvoice({ totalAmount: 500 });
    const orderId = `order_test_${invoice.id.slice(0, 8)}`;
    const paymentId = `pay_test_${invoice.id.slice(0, 8)}`;
    const prisma = await getPrisma();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { razorpayOrderId: orderId },
    });

    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            amount: 50000, // 500 INR in paise
            status: "captured",
          },
        },
      },
    };
    const body = JSON.stringify(event);

    const res = await request(app)
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", signWebhook(body))
      .send(body);
    expect(res.status).toBe(200);

    const after = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { payments: true },
    });
    expect(after?.paymentStatus).toBe("PAID");
    expect(after?.payments).toHaveLength(1);
    expect(after?.payments[0].transactionId).toBe(paymentId);
    expect(after?.payments[0].status).toBe("CAPTURED");
    expect(after?.payments[0].amount).toBe(500);
  });

  it("is idempotent: replaying the same valid webhook does not duplicate the Payment", async () => {
    const invoice = await freshInvoice({ totalAmount: 250 });
    const orderId = `order_idem_${invoice.id.slice(0, 8)}`;
    const paymentId = `pay_idem_${invoice.id.slice(0, 8)}`;
    const prisma = await getPrisma();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { razorpayOrderId: orderId },
    });

    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            amount: 25000,
            status: "captured",
          },
        },
      },
    };
    const body = JSON.stringify(event);
    const sig = signWebhook(body);

    const r1 = await request(app)
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sig)
      .send(body);
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sig)
      .send(body);
    expect(r2.status).toBe(200);

    const payments = await prisma.payment.findMany({
      where: { transactionId: paymentId },
    });
    expect(payments).toHaveLength(1);
  });

  it("payment.failed records a FAILED Payment and leaves the invoice unpaid", async () => {
    const invoice = await freshInvoice({ totalAmount: 800 });
    const orderId = `order_fail_${invoice.id.slice(0, 8)}`;
    const paymentId = `pay_fail_${invoice.id.slice(0, 8)}`;
    const prisma = await getPrisma();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { razorpayOrderId: orderId },
    });

    const event = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            amount: 80000,
            status: "failed",
            error_description: "card declined",
          },
        },
      },
    };
    const body = JSON.stringify(event);
    const res = await request(app)
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", signWebhook(body))
      .send(body);
    expect(res.status).toBe(200);

    const after = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { payments: true },
    });
    expect(after?.paymentStatus).toBe("PENDING");
    expect(after?.payments).toHaveLength(1);
    expect(after?.payments[0].status).toBe("FAILED");
    expect(after?.payments[0].transactionId).toBe(paymentId);
  });

  it("/verify-payment rejects when the signed orderId does not belong to the invoice", async () => {
    // Set up TWO invoices: a cheap one and an expensive one. The attacker
    // pays for the cheap one, then attempts to mark the expensive one PAID
    // by replaying the (signed) cheap orderId against the expensive invoiceId.
    const cheap = await freshInvoice({ totalAmount: 10 });
    const expensive = await freshInvoice({ totalAmount: 10000 });
    const cheapOrderId = `order_cheap_${cheap.id.slice(0, 8)}`;
    const cheapPaymentId = `pay_cheap_${cheap.id.slice(0, 8)}`;
    const prisma = await getPrisma();
    await prisma.invoice.update({
      where: { id: cheap.id },
      data: { razorpayOrderId: cheapOrderId },
    });
    // expensive intentionally has its own (different) recorded orderId
    await prisma.invoice.update({
      where: { id: expensive.id },
      data: { razorpayOrderId: `order_expensive_${expensive.id.slice(0, 8)}` },
    });

    // A correctly-signed callback for the cheap order — but POSTed against
    // the expensive invoiceId.
    const sig = signPayment(cheapOrderId, cheapPaymentId);
    const res = await request(app)
      .post("/api/v1/billing/verify-payment")
      .set("Authorization", `Bearer ${token}`)
      .send({
        invoiceId: expensive.id,
        razorpayOrderId: cheapOrderId,
        razorpayPaymentId: cheapPaymentId,
        razorpaySignature: sig,
      });
    expect(res.status).toBe(400);

    const expAfter = await prisma.invoice.findUnique({
      where: { id: expensive.id },
      include: { payments: true },
    });
    expect(expAfter?.paymentStatus).toBe("PENDING");
    expect(expAfter?.payments).toHaveLength(0);
  });
});
