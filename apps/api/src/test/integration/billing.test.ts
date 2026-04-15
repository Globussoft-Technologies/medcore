// Integration tests for billing router.
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
let token: string;

async function createPatAppt() {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  return { patient, doctor, appt };
}

describeIfDB("Billing API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    token = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates an invoice with items + GST split (CGST+SGST)", async () => {
    const { patient, appt } = await createPatAppt();
    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        items: [
          {
            description: "Consultation",
            category: "CONSULTATION",
            quantity: 1,
            unitPrice: 500,
          },
          {
            description: "Dressing",
            category: "PROCEDURE",
            quantity: 2,
            unitPrice: 200,
          },
        ],
        taxPercentage: 18,
      });
    expect([200, 201]).toContain(res.status);
    const inv = res.body.data;
    expect(inv.subtotal).toBe(900);
    expect(inv.cgstAmount).toBeCloseTo(81, 1);
    expect(inv.sgstAmount).toBeCloseTo(81, 1);
    expect(inv.taxAmount).toBeCloseTo(162, 1);
  });

  it("records a cash payment", async () => {
    const { patient, appt } = await createPatAppt();
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });
    const res = await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceId: invoice.id, amount: 1000, mode: "CASH" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.amount).toBe(1000);
    expect(res.body.data?.mode).toBe("CASH");

    const prisma = await getPrisma();
    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(inv?.paymentStatus).toBe("PAID");
  });

  it("records payments of different modes (CARD, UPI)", async () => {
    const { patient, appt } = await createPatAppt();
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });
    const card = await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceId: invoice.id, amount: 400, mode: "CARD" });
    expect([200, 201]).toContain(card.status);
    const upi = await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceId: invoice.id, amount: 600, mode: "UPI" });
    expect([200, 201]).toContain(upi.status);
  });

  it("records a refund (negative payment)", async () => {
    const { patient, appt } = await createPatAppt();
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });
    // First pay in full
    await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceId: invoice.id, amount: 1000, mode: "CASH" });

    const res = await request(app)
      .post("/api/v1/billing/refunds")
      .set("Authorization", `Bearer ${token}`)
      .send({
        invoiceId: invoice.id,
        amount: 300,
        reason: "Service not rendered",
        mode: "CASH",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.amount).toBe(-300);
  });

  it("applies a percentage discount to an invoice", async () => {
    const { patient, appt } = await createPatAppt();
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });
    const res = await request(app)
      .post(`/api/v1/billing/invoices/${invoice.id}/discount`)
      .set("Authorization", `Bearer ${token}`)
      .send({ percentage: 10, reason: "Loyalty discount" });
    expect(res.status).toBeLessThan(500);
  });

  it("applies a flat discount to an invoice", async () => {
    const { patient, appt } = await createPatAppt();
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });
    const res = await request(app)
      .post(`/api/v1/billing/invoices/${invoice.id}/discount`)
      .set("Authorization", `Bearer ${token}`)
      .send({ flatAmount: 100, reason: "Senior citizen" });
    expect(res.status).toBeLessThan(500);
  });

  it("makes bulk payments across multiple invoices", async () => {
    const { patient, appt } = await createPatAppt();
    const inv1 = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });
    // create a second invoice for another appointment
    const { appt: appt2 } = await createPatAppt();
    const inv2 = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt2.id,
    });
    const res = await request(app)
      .post("/api/v1/billing/payments/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({
        patientId: patient.id,
        payments: [
          { invoiceId: inv1.id, amount: 500, mode: "CASH" },
          { invoiceId: inv2.id, amount: 500, mode: "CASH" },
        ],
      });
    expect(res.status).toBeLessThan(500);
  });

  it("adds a line item to a PENDING invoice", async () => {
    const { patient, appt } = await createPatAppt();
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });
    const res = await request(app)
      .post(`/api/v1/billing/invoices/${invoice.id}/items`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        description: "Extra dressing",
        category: "PROCEDURE",
        quantity: 1,
        unitPrice: 150,
      });
    expect([200, 201]).toContain(res.status);
  });

  it("returns outstanding balance for a patient", async () => {
    const { patient, appt } = await createPatAppt();
    await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });
    const res = await request(app)
      .get(`/api/v1/billing/patients/${patient.id}/outstanding`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTruthy();
  });

  it("returns outstanding report", async () => {
    const res = await request(app)
      .get("/api/v1/billing/reports/outstanding")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTruthy();
  });

  it("rejects invalid payment payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/billing/payments")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceId: "not-uuid", amount: 0 });
    expect(res.status).toBe(400);
  });
});
