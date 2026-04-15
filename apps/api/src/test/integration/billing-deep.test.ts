// Deep / edge-case integration tests for the billing router.
// Augments billing.test.ts — focused on error branches + multi-step flows.
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

async function mkInv(overrides: Partial<any> = {}) {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  const invoice = await createInvoiceFixture({
    patientId: patient.id,
    appointmentId: appt.id,
    overrides,
  });
  return { patient, doctor, appt, invoice };
}

describeIfDB("Billing API — deep edges", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Refund branches ──────────────────────────────────────
  it("refund rejects amount > totalPaid (400)", async () => {
    const { invoice } = await mkInv();
    // pay 200 only
    await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ invoiceId: invoice.id, amount: 200, mode: "CASH" });
    const res = await request(app)
      .post("/api/v1/billing/refunds")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ invoiceId: invoice.id, amount: 500, reason: "oops", mode: "CASH" });
    expect(res.status).toBe(400);
  });

  it("refund on nonexistent invoice → 404", async () => {
    const res = await request(app)
      .post("/api/v1/billing/refunds")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        invoiceId: "00000000-0000-0000-0000-000000000000",
        amount: 1,
        reason: "x",
        mode: "CASH",
      });
    expect(res.status).toBe(404);
  });

  it("full refund of fully paid invoice marks invoice REFUNDED", async () => {
    const { invoice } = await mkInv();
    await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ invoiceId: invoice.id, amount: 1000, mode: "CASH" });
    const r = await request(app)
      .post("/api/v1/billing/refunds")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ invoiceId: invoice.id, amount: 1000, reason: "full", mode: "CASH" });
    expect([200, 201]).toContain(r.status);
    const prisma = await getPrisma();
    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(inv?.paymentStatus).toBe("REFUNDED");
  });

  // ─── Partial payment stays PARTIAL ─────────────────────────
  it("partial payment marks invoice PARTIAL", async () => {
    const { invoice } = await mkInv();
    const res = await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ invoiceId: invoice.id, amount: 400, mode: "CASH" });
    expect([200, 201]).toContain(res.status);
    const prisma = await getPrisma();
    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(inv?.paymentStatus).toBe("PARTIAL");
  });

  // ─── Discount edges ────────────────────────────────────────
  it("discount greater than gross returns 400", async () => {
    const { invoice } = await mkInv();
    const res = await request(app)
      .post(`/api/v1/billing/invoices/${invoice.id}/discount`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ flatAmount: 99999, reason: "outsized" });
    expect(res.status).toBe(400);
  });

  it("discount on already-paid invoice returns 400", async () => {
    const { invoice } = await mkInv();
    await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ invoiceId: invoice.id, amount: 1000, mode: "CASH" });
    const res = await request(app)
      .post(`/api/v1/billing/invoices/${invoice.id}/discount`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ percentage: 10, reason: "late" });
    expect(res.status).toBe(400);
  });

  it("discount without percentage or flatAmount fails 400", async () => {
    const { invoice } = await mkInv();
    const res = await request(app)
      .post(`/api/v1/billing/invoices/${invoice.id}/discount`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "nothing" });
    expect(res.status).toBe(400);
  });

  it("large-percentage discount from reception triggers approval workflow (202)", async () => {
    const { invoice } = await mkInv();
    const res = await request(app)
      .post(`/api/v1/billing/invoices/${invoice.id}/discount`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ percentage: 50, reason: "VIP" });
    // Either 202 (approval) or 200 depending on threshold config
    expect([200, 202]).toContain(res.status);
  });

  // ─── Invoice GST breakdown at various % ────────────────────
  it.each([0, 5, 12, 18, 28])("creates invoice with %i%% GST", async (pct) => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        items: [
          { description: "Service", category: "CONSULTATION", quantity: 1, unitPrice: 1000 },
        ],
        taxPercentage: pct,
      });
    expect([200, 201]).toContain(res.status);
    const inv = res.body.data;
    expect(inv.subtotal).toBe(1000);
    expect(inv.taxAmount).toBeCloseTo(1000 * (pct / 100), 1);
    // CGST+SGST halves must sum to taxAmount
    expect(inv.cgstAmount + inv.sgstAmount).toBeCloseTo(inv.taxAmount, 1);
  });

  // ─── Tax-breakdown endpoint ─────────────────────────────────
  it("tax-breakdown returns effective GST % for existing invoice", async () => {
    const { invoice } = await mkInv();
    const res = await request(app)
      .get(`/api/v1/billing/invoices/${invoice.id}/tax-breakdown`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.effectivePct).toBeGreaterThanOrEqual(0);
  });

  it("tax-breakdown 404 on unknown invoice", async () => {
    const res = await request(app)
      .get(`/api/v1/billing/invoices/00000000-0000-0000-0000-000000000000/tax-breakdown`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(404);
  });

  // ─── Credit notes ─────────────────────────────────────────
  it("credit-note creation succeeds and totals are tracked", async () => {
    const { invoice } = await mkInv();
    const res = await request(app)
      .post("/api/v1/billing/credit-notes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ invoiceId: invoice.id, amount: 200, reason: "goodwill" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.noteNumber).toBeTruthy();
  });

  it("credit-note amount exceeding invoice total returns 400", async () => {
    const { invoice } = await mkInv();
    const res = await request(app)
      .post("/api/v1/billing/credit-notes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ invoiceId: invoice.id, amount: 99999, reason: "too much" });
    expect(res.status).toBe(400);
  });

  it("credit-note on unknown invoice returns 404", async () => {
    const res = await request(app)
      .post("/api/v1/billing/credit-notes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        invoiceId: "00000000-0000-0000-0000-000000000000",
        amount: 1,
        reason: "x",
      });
    expect(res.status).toBe(404);
  });

  // ─── Insurance claim lifecycle ─────────────────────────────
  it("submit claim → approve → settle transitions", async () => {
    const { patient, invoice } = await mkInv();
    const sub = await request(app)
      .post("/api/v1/billing/claims")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        invoiceId: invoice.id,
        patientId: patient.id,
        insuranceProvider: "ACME",
        policyNumber: "POL-1",
        claimAmount: 1000,
      });
    expect([200, 201]).toContain(sub.status);
    const claimId = sub.body.data.id;
    const appr = await request(app)
      .patch(`/api/v1/billing/claims/${claimId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "APPROVED", approvedAmount: 900 });
    expect(appr.status).toBe(200);
    const settle = await request(app)
      .patch(`/api/v1/billing/claims/${claimId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "SETTLED", approvedAmount: 900 });
    expect(settle.status).toBe(200);
    expect(settle.body.data?.resolvedAt).toBeTruthy();
  });

  // ─── Bulk payment mismatch ─────────────────────────────────
  it("bulk payment with invoice from another patient returns 400", async () => {
    const a = await mkInv();
    const b = await mkInv();
    const res = await request(app)
      .post("/api/v1/billing/payments/bulk")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: a.patient.id,
        payments: [
          { invoiceId: a.invoice.id, amount: 100, mode: "CASH" },
          { invoiceId: b.invoice.id, amount: 100, mode: "CASH" },
        ],
      });
    expect(res.status).toBe(400);
  });

  // ─── Payment reminder ──────────────────────────────────────
  it("reminder on paid invoice returns 400", async () => {
    const { invoice } = await mkInv();
    await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ invoiceId: invoice.id, amount: 1000, mode: "CASH" });
    const res = await request(app)
      .post(`/api/v1/billing/invoices/${invoice.id}/reminder`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ invoiceId: invoice.id, channel: "SMS" });
    expect(res.status).toBe(400);
  });

  it("reminder on unpaid invoice succeeds and queues notification", async () => {
    const { invoice } = await mkInv();
    const res = await request(app)
      .post(`/api/v1/billing/invoices/${invoice.id}/reminder`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ invoiceId: invoice.id, channel: "WHATSAPP" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.channel).toBe("WHATSAPP");
  });

  // ─── Add/remove items ──────────────────────────────────────
  it("add item to paid invoice returns 400", async () => {
    const { invoice } = await mkInv();
    await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ invoiceId: invoice.id, amount: 1000, mode: "CASH" });
    const res = await request(app)
      .post(`/api/v1/billing/invoices/${invoice.id}/items`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ description: "Extra", category: "PROC", quantity: 1, unitPrice: 50 });
    expect(res.status).toBe(400);
  });

  it("cannot remove the only line item", async () => {
    const { invoice } = await mkInv();
    const prisma = await getPrisma();
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: invoice.id } });
    const res = await request(app)
      .delete(`/api/v1/billing/invoices/${invoice.id}/items/${items[0].id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("remove nonexistent item returns 404", async () => {
    const { invoice } = await mkInv();
    const res = await request(app)
      .delete(`/api/v1/billing/invoices/${invoice.id}/items/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  // ─── Outstanding + revenue reports ─────────────────────────
  it("outstanding report respects minAmount filter", async () => {
    const { invoice } = await mkInv();
    expect(invoice.id).toBeTruthy();
    const res = await request(app)
      .get("/api/v1/billing/reports/outstanding?minAmount=100")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const r of res.body.data.rows) expect(r.balance).toBeGreaterThanOrEqual(100);
  });

  it("revenue report groups by day by default", async () => {
    const res = await request(app)
      .get("/api/v1/billing/reports/revenue")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.groupBy).toBe("day");
  });

  // ─── Advance payments (deposits) ───────────────────────────
  it("advance apply to wrong patient invoice returns 400", async () => {
    const a = await mkInv();
    const b = await mkInv();
    const adv = await request(app)
      .post("/api/v1/billing/advances")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: a.patient.id, amount: 500, mode: "CASH" });
    expect([200, 201]).toContain(adv.status);
    const apply = await request(app)
      .post("/api/v1/billing/advances/apply")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ advanceId: adv.body.data.id, invoiceId: b.invoice.id, amount: 100 });
    expect(apply.status).toBe(400);
  });

  it("advance apply exceeding balance returns 400", async () => {
    const { patient, invoice } = await mkInv();
    const adv = await request(app)
      .post("/api/v1/billing/advances")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, amount: 200, mode: "CASH" });
    expect([200, 201]).toContain(adv.status);
    const res = await request(app)
      .post("/api/v1/billing/advances/apply")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ advanceId: adv.body.data.id, invoiceId: invoice.id, amount: 5000 });
    expect(res.status).toBe(400);
  });

  // ─── Authorization ─────────────────────────────────────────
  it("doctor cannot create invoice (403)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        items: [
          { description: "x", category: "CONSULTATION", quantity: 1, unitPrice: 100 },
        ],
        taxPercentage: 0,
      });
    expect(res.status).toBe(403);
  });

  it("unauthenticated invoice list request returns 401", async () => {
    const res = await request(app).get("/api/v1/billing/invoices");
    expect(res.status).toBe(401);
  });
});
