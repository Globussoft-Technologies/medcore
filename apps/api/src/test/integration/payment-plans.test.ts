// Integration tests for the payment-plans router.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
  createInvoiceFixture,
} from "../factories";

let app: any;
let adminToken: string;
let receptionToken: string;
let doctorToken: string;
let patientToken: string;

async function setupInvoice(overrides: { totalAmount?: number } = {}) {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  const invoice = await createInvoiceFixture({
    patientId: patient.id,
    appointmentId: appt.id,
    overrides: {
      subtotal: overrides.totalAmount ?? 6000,
      totalAmount: overrides.totalAmount ?? 6000,
    },
  });
  return { patient, doctor, appt, invoice };
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createPlan(args: {
  invoiceId: string;
  downPayment?: number;
  installments?: number;
  frequency?: string;
}) {
  return request(app)
    .post("/api/v1/payment-plans")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      invoiceId: args.invoiceId,
      downPayment: args.downPayment ?? 0,
      installments: args.installments ?? 3,
      frequency: args.frequency ?? "MONTHLY",
      startDate: todayDateString(),
    });
}

describeIfDB("Payment-Plans API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /payment-plans ──────────────────────────────────

  it("creates a plan with installments + assigned plan number (201)", async () => {
    const { invoice } = await setupInvoice({ totalAmount: 6000 });
    const res = await createPlan({
      invoiceId: invoice.id,
      downPayment: 0,
      installments: 3,
      frequency: "MONTHLY",
    });
    expect([200, 201]).toContain(res.status);
    const plan = res.body.data;
    expect(plan.planNumber).toMatch(/^PP\d{6}$/);
    expect(plan.installments).toBe(3);
    expect(plan.installmentRecords?.length).toBe(3);
    expect(plan.installmentRecords[0].amount).toBe(2000);
  });

  it("records a down-payment as an invoice payment when > 0", async () => {
    const { invoice } = await setupInvoice({ totalAmount: 6000 });
    const res = await createPlan({
      invoiceId: invoice.id,
      downPayment: 2000,
      installments: 4,
      frequency: "MONTHLY",
    });
    expect([200, 201]).toContain(res.status);

    const prisma = await getPrisma();
    const payments = await prisma.payment.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(payments.length).toBe(1);
    expect(payments[0].amount).toBe(2000);
    expect(payments[0].mode).toBe("CASH");

    const updated = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(updated?.paymentStatus).toBe("PARTIAL");
  });

  it("rejects POST when invoice does not exist (404)", async () => {
    const res = await createPlan({
      invoiceId: "00000000-0000-0000-0000-000000000404",
      installments: 3,
    });
    expect(res.status).toBe(404);
  });

  it("rejects POST when downPayment > totalAmount (400)", async () => {
    const { invoice } = await setupInvoice({ totalAmount: 1000 });
    const res = await createPlan({
      invoiceId: invoice.id,
      downPayment: 5000,
      installments: 3,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/down payment/i);
  });

  it("rejects POST with invalid payload (400 — installments < 2)", async () => {
    const { invoice } = await setupInvoice();
    const res = await request(app)
      .post("/api/v1/payment-plans")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        invoiceId: invoice.id,
        downPayment: 0,
        installments: 1,
        frequency: "MONTHLY",
        startDate: todayDateString(),
      });
    expect(res.status).toBe(400);
  });

  it("rejects POST from DOCTOR (403)", async () => {
    const { invoice } = await setupInvoice();
    const res = await request(app)
      .post("/api/v1/payment-plans")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        invoiceId: invoice.id,
        downPayment: 0,
        installments: 3,
        frequency: "MONTHLY",
        startDate: todayDateString(),
      });
    expect(res.status).toBe(403);
  });

  it("rejects POST without auth (401)", async () => {
    const res = await request(app)
      .post("/api/v1/payment-plans")
      .send({
        invoiceId: "00000000-0000-0000-0000-000000000000",
        installments: 3,
        frequency: "MONTHLY",
        startDate: todayDateString(),
      });
    expect(res.status).toBe(401);
  });

  // ─── GET /payment-plans ───────────────────────────────────

  it("lists plans (200) with derived paidCount + nextDue", async () => {
    const { invoice } = await setupInvoice();
    await createPlan({ invoiceId: invoice.id, installments: 3 });

    const res = await request(app)
      .get("/api/v1/payment-plans")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].paidCount).toBeDefined();
    expect("nextDue" in res.body.data[0]).toBe(true);
  });

  it("filters list by patientId", async () => {
    const { patient, invoice } = await setupInvoice();
    await createPlan({ invoiceId: invoice.id, installments: 2 });
    const res = await request(app)
      .get(`/api/v1/payment-plans?patientId=${patient.id}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((p: any) => p.patientId === patient.id)).toBe(true);
  });

  it("rejects GET list unauthenticated (401)", async () => {
    const res = await request(app).get("/api/v1/payment-plans");
    expect(res.status).toBe(401);
  });

  // ─── GET /payment-plans/overdue ───────────────────────────

  it("lists overdue installments (200)", async () => {
    const res = await request(app)
      .get("/api/v1/payment-plans/overdue")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("rejects GET overdue unauthenticated (401)", async () => {
    const res = await request(app).get("/api/v1/payment-plans/overdue");
    expect(res.status).toBe(401);
  });

  // ─── POST /payment-plans/due-reminders ────────────────────

  it("triggers due reminders (admin only) returning count", async () => {
    const { invoice } = await setupInvoice();
    await createPlan({ invoiceId: invoice.id, installments: 3 });
    const res = await request(app)
      .post("/api/v1/payment-plans/due-reminders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.count).toBe("number");
    expect(Array.isArray(res.body.data?.reminders)).toBe(true);
  });

  it("rejects due-reminders from RECEPTION (403)", async () => {
    const res = await request(app)
      .post("/api/v1/payment-plans/due-reminders")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("rejects due-reminders unauthenticated (401)", async () => {
    const res = await request(app)
      .post("/api/v1/payment-plans/due-reminders")
      .send({});
    expect(res.status).toBe(401);
  });

  // ─── GET /payment-plans/:id ───────────────────────────────

  it("returns plan detail with installmentRecords + invoice + patient", async () => {
    const { invoice } = await setupInvoice();
    const created = await createPlan({ invoiceId: invoice.id, installments: 3 });
    const id = created.body.data.id;

    const res = await request(app)
      .get(`/api/v1/payment-plans/${id}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.installmentRecords?.length).toBe(3);
    expect(res.body.data.invoice).toBeTruthy();
    expect(res.body.data.patient).toBeTruthy();
  });

  it("returns 404 when plan id is unknown", async () => {
    const res = await request(app)
      .get("/api/v1/payment-plans/00000000-0000-0000-0000-000000000404")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects GET /:id unauthenticated (401)", async () => {
    const res = await request(app).get(
      "/api/v1/payment-plans/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  // ─── PATCH /payment-plans/:id/pay-installment ─────────────

  it("pays an installment, marks invoice PARTIAL/PAID, marks plan COMPLETED when all paid", async () => {
    const { invoice } = await setupInvoice({ totalAmount: 3000 });
    const created = await createPlan({
      invoiceId: invoice.id,
      installments: 3,
      downPayment: 0,
    });
    const planId = created.body.data.id;
    const installments = created.body.data.installmentRecords;

    // Pay all 3 installments
    for (const inst of installments) {
      const r = await request(app)
        .patch(`/api/v1/payment-plans/${planId}/pay-installment`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ installmentId: inst.id, amount: inst.amount, mode: "CASH" });
      expect(r.status).toBe(200);
    }

    const prisma = await getPrisma();
    const refreshed = await prisma.paymentPlan.findUnique({
      where: { id: planId },
    });
    expect(refreshed?.status).toBe("COMPLETED");
    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(inv?.paymentStatus).toBe("PAID");
  });

  it("rejects double-pay on the same installment (400)", async () => {
    const { invoice } = await setupInvoice();
    const created = await createPlan({ invoiceId: invoice.id, installments: 3 });
    const planId = created.body.data.id;
    const inst = created.body.data.installmentRecords[0];

    const first = await request(app)
      .patch(`/api/v1/payment-plans/${planId}/pay-installment`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ installmentId: inst.id, amount: inst.amount, mode: "CASH" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/api/v1/payment-plans/${planId}/pay-installment`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ installmentId: inst.id, amount: inst.amount, mode: "CASH" });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already paid/i);
  });

  it("returns 404 when plan id is unknown for pay-installment", async () => {
    const res = await request(app)
      .patch(
        "/api/v1/payment-plans/00000000-0000-0000-0000-000000000404/pay-installment"
      )
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        installmentId: "00000000-0000-0000-0000-000000000111",
        amount: 100,
        mode: "CASH",
      });
    expect(res.status).toBe(404);
  });

  it("rejects pay-installment from DOCTOR (403)", async () => {
    const { invoice } = await setupInvoice();
    const created = await createPlan({ invoiceId: invoice.id, installments: 2 });
    const planId = created.body.data.id;
    const inst = created.body.data.installmentRecords[0];
    const res = await request(app)
      .patch(`/api/v1/payment-plans/${planId}/pay-installment`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ installmentId: inst.id, amount: inst.amount, mode: "CASH" });
    expect(res.status).toBe(403);
  });

  it("rejects pay-installment from PATIENT (403)", async () => {
    const { invoice } = await setupInvoice();
    const created = await createPlan({ invoiceId: invoice.id, installments: 2 });
    const planId = created.body.data.id;
    const inst = created.body.data.installmentRecords[0];
    const res = await request(app)
      .patch(`/api/v1/payment-plans/${planId}/pay-installment`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ installmentId: inst.id, amount: inst.amount, mode: "CASH" });
    expect(res.status).toBe(403);
  });

  it("rejects pay-installment with invalid payload (400)", async () => {
    const { invoice } = await setupInvoice();
    const created = await createPlan({ invoiceId: invoice.id, installments: 2 });
    const planId = created.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/payment-plans/${planId}/pay-installment`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ installmentId: "not-uuid", amount: -1, mode: "BOGUS" });
    expect(res.status).toBe(400);
  });

  it("rejects pay-installment unauthenticated (401)", async () => {
    const res = await request(app)
      .patch(
        "/api/v1/payment-plans/00000000-0000-0000-0000-000000000000/pay-installment"
      )
      .send({});
    expect(res.status).toBe(401);
  });

  // ─── PATCH /payment-plans/:id/cancel ──────────────────────

  it("cancels a plan (admin only) flipping status to CANCELLED", async () => {
    const { invoice } = await setupInvoice();
    const created = await createPlan({ invoiceId: invoice.id, installments: 2 });
    const planId = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/payment-plans/${planId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("CANCELLED");
  });

  it("rejects cancel from RECEPTION (403)", async () => {
    const { invoice } = await setupInvoice();
    const created = await createPlan({ invoiceId: invoice.id, installments: 2 });
    const planId = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/payment-plans/${planId}/cancel`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("rejects cancel unauthenticated (401)", async () => {
    const res = await request(app)
      .patch(
        "/api/v1/payment-plans/00000000-0000-0000-0000-000000000000/cancel"
      )
      .send({});
    expect(res.status).toBe(401);
  });
});
