// Pearl §6.3 row 342 — UPI bill payment completes within 5s and updates invoice status.
//
// What:    Brackets POST /api/v1/billing/razorpay-webhook (payment.captured) with
//          Date.now() and asserts the response-to-invoice-PAID round trip stays
//          under the 5_000 ms budget specified by the Pearl PRD M5 acceptance row.
// Modules: routes/billing.ts (razorpay-webhook handler), Invoice/Payment Prisma models,
//          HMAC-SHA256 signature scheme (X-Razorpay-Signature, same secret env var
//          as the existing razorpay-webhook.test.ts: RAZORPAY_WEBHOOK_SECRET).
// Why:     Existing razorpay-webhook.test.ts proves correctness (sig verify, PAID flip,
//          idempotency) but does not assert latency. This file closes the timing gap
//          surfaced as PEARL_STAGE1_GAP_ANALYSIS row 342. Handler is synchronous
//          (response returns AFTER `await prisma.invoice.update`), so the response
//          status itself indicates the invoice flip — no poll needed.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
  createInvoiceFixture,
} from "../factories";

const WEBHOOK_SECRET = "test_webhook_secret_123";
const PAYMENT_SECRET = "test_payment_secret_456";

let app: any;

function signWebhook(body: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

async function freshPendingInvoice(totalAmount: number) {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  return createInvoiceFixture({
    patientId: patient.id,
    appointmentId: appt.id,
    overrides: { subtotal: totalAmount, totalAmount },
  });
}

describeIfDB("Pearl §6.3 row 342 — Razorpay UPI webhook latency < 5s", () => {
  beforeAll(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.RAZORPAY_KEY_SECRET = PAYMENT_SECRET;
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  it("processes a valid payment.captured webhook end-to-end (signature verify + invoice PAID flip) in under 5000 ms", async () => {
    const invoice = await freshPendingInvoice(750);
    const orderId = `order_timing_${invoice.id.slice(0, 8)}`;
    const paymentId = `pay_timing_${invoice.id.slice(0, 8)}`;
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
            amount: 75000, // 750 INR in paise
            status: "captured",
          },
        },
      },
    };
    const body = JSON.stringify(event);
    const signature = signWebhook(body);

    const t0 = Date.now();
    const res = await request(app)
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", signature)
      .send(body);
    const t1 = Date.now();
    const elapsedMs = t1 - t0;

    // Pearl PRD M5 §6.3 row 342 — must complete in < 5s.
    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(5000);

    // Correctness invariant — handler updated invoice synchronously before responding.
    const after = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { payments: true },
    });
    expect(after?.paymentStatus).toBe("PAID");
    expect(after?.payments).toHaveLength(1);
    expect(after?.payments[0].transactionId).toBe(paymentId);
    expect(after?.payments[0].status).toBe("CAPTURED");
    expect(after?.payments[0].amount).toBe(750);

    // Observability for CI logs — surfaces the actual headroom vs the 5s budget.
    // eslint-disable-next-line no-console
    console.log(
      `[Pearl §6.3 row 342] Razorpay webhook -> invoice PAID in ${elapsedMs} ms (budget: 5000 ms)`
    );
  });

  it("rejects bad-signature webhook quickly without touching the invoice (negative path)", async () => {
    const invoice = await freshPendingInvoice(400);
    const orderId = `order_badsig_${invoice.id.slice(0, 8)}`;
    const paymentId = `pay_badsig_${invoice.id.slice(0, 8)}`;
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
            amount: 40000,
            status: "captured",
          },
        },
      },
    };
    const body = JSON.stringify(event);

    const t0 = Date.now();
    const res = await request(app)
      .post("/api/v1/billing/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", "deadbeef".repeat(8))
      .send(body);
    const t1 = Date.now();

    expect(res.status).toBe(401);
    expect(t1 - t0).toBeLessThan(5000);

    const after = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      include: { payments: true },
    });
    expect(after?.paymentStatus).toBe("PENDING");
    expect(after?.payments).toHaveLength(0);
  });
});
