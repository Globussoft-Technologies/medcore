// Integration tests for billing router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
  createInvoiceFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
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
    // #902: when the client doesn't pass dueDate, the server defaults
    // to createdAt + 14 days (configurable via the
    // `invoice_default_due_days` SystemConfig). Pin both the
    // not-null-ness and the ~14-day delta so receivables can age and
    // dunning has a baseline to fire against.
    expect(inv.dueDate).toBeTruthy();
    const dueMs = new Date(inv.dueDate).getTime();
    const createdMs = new Date(inv.createdAt).getTime();
    const deltaDays = (dueMs - createdMs) / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBeGreaterThanOrEqual(13.9);
    expect(deltaDays).toBeLessThanOrEqual(14.1);

    // #894: each line item must carry its own GST breakdown + HSN/SAC.
    // Previously cgst/sgst/gstRate landed at 0 and hsnSac at null, which
    // failed CGST Rule 46. Sum of line cgst/sgst must equal header
    // cgstAmount/sgstAmount so GSTR-1 reconciles.
    expect(inv.items).toHaveLength(2);
    const sumLineCgst = inv.items.reduce(
      (s: number, it: { cgst: number }) => s + it.cgst,
      0,
    );
    const sumLineSgst = inv.items.reduce(
      (s: number, it: { sgst: number }) => s + it.sgst,
      0,
    );
    expect(sumLineCgst).toBeCloseTo(inv.cgstAmount, 1);
    expect(sumLineSgst).toBeCloseTo(inv.sgstAmount, 1);
    for (const it of inv.items) {
      expect(it.gstRate).toBe(18);
      // CONSULTATION + PROCEDURE both map to 9993 (healthcare services SAC)
      expect(it.hsnSac).toBe("9993");
      expect(it.cgst).toBeGreaterThan(0);
      expect(it.sgst).toBeGreaterThan(0);
    }
  });

  // Issue #890: an invoice must not be raised against a NO_SHOW or
  // CANCELLED appointment — the patient was never seen.
  it("rejects an invoice raised against a NO_SHOW appointment (409, issue #890)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { status: "NO_SHOW" },
    });
    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        patientId: patient.id,
        items: [
          {
            description: "General consultation",
            category: "CONSULTATION",
            quantity: 1,
            unitPrice: 500,
          },
        ],
        taxPercentage: 18,
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/NO_SHOW|not seen/i);
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

  // ─── GET /billing/hospital-profile (Issue #43, source of truth for
  //    invoice headers) ────────────────────────────────────────────────────

  it("GET /hospital-profile returns the configured hospital identity with all invoice-header fields", async () => {
    const prisma = await getPrisma();
    // Seed the rows the endpoint reads — keys it touches are name/address/
    // phone/email/gstin/registration/tagline/logo_url.
    const seed = [
      { key: "hospital_name", value: "Acme Wellness" },
      { key: "hospital_address", value: "1 Acme Plaza, Bengaluru 560001" },
      { key: "hospital_phone", value: "+91-80-0000-0000" },
      { key: "hospital_email", value: "hello@acme.test" },
      { key: "hospital_gstin", value: "29AAACA1234Z1Z5" },
      { key: "hospital_registration", value: "REG-ACME-2026" },
      { key: "hospital_tagline", value: "Care, first" },
    ];
    for (const row of seed) {
      await prisma.systemConfig.upsert({
        where: { key: row.key },
        create: row,
        update: { value: row.value },
      });
    }

    const res = await request(app)
      .get("/api/v1/billing/hospital-profile")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Acme Wellness");
    expect(res.body.data.gstin).toBe("29AAACA1234Z1Z5");
    expect(res.body.data.registration).toBe("REG-ACME-2026");
    expect(res.body.data.tagline).toBe("Care, first");
    expect(res.body.data.email).toBe("hello@acme.test");
  });

  it("GET /hospital-profile falls back to sensible defaults when SystemConfig rows are absent", async () => {
    const prisma = await getPrisma();
    // Clear any previously-seeded rows so the defaults kick in.
    await prisma.systemConfig.deleteMany({
      where: {
        key: {
          in: [
            "hospital_name",
            "hospital_address",
            "hospital_phone",
            "hospital_email",
            "hospital_gstin",
            "hospital_registration",
            "hospital_tagline",
            "hospital_logo_url",
          ],
        },
      },
    });

    const res = await request(app)
      .get("/api/v1/billing/hospital-profile")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Defaults exist so QA envs never show raw placeholders.
    expect(res.body.data.name).toMatch(/Hospital/i);
    expect(res.body.data.email).toMatch(/@/);
    expect(res.body.data.gstin).toMatch(/^[0-9]{2}[A-Z]/);
  });

  it("GET /hospital-profile still requires authentication (401 without a token)", async () => {
    const res = await request(app).get("/api/v1/billing/hospital-profile");
    expect(res.status).toBe(401);
  });

  // ─── GET /billing/invoices `status=` query-param edge cases (Issue #479) ───
  //
  // The patient dashboard widget calls
  // `GET /api/v1/billing/invoices?mine=true&status=PENDING,PARTIAL&limit=5`
  // and was getting a 500 because the comma-separated literal was passed
  // straight to Prisma against a `PaymentStatus` enum column. These cases
  // pin the contract: every plausible `status=` shape returns 200 or 4xx —
  // never 500.

  it("GET /invoices?status=PENDING accepts a single-status filter (200)", async () => {
    const res = await request(app)
      .get("/api/v1/billing/invoices?status=PENDING&limit=5")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET /invoices?status=PENDING,PARTIAL accepts a comma-separated list without 500 (Issue #479)", async () => {
    const res = await request(app)
      .get("/api/v1/billing/invoices?mine=true&status=PENDING,PARTIAL&limit=5")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET /invoices?status= (empty) is treated as no-filter (200)", async () => {
    const res = await request(app)
      .get("/api/v1/billing/invoices?status=&limit=5")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("GET /invoices?status=BOGUS returns a clean 400 envelope (not 500)", async () => {
    const res = await request(app)
      .get("/api/v1/billing/invoices?status=BOGUS")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/invalid status/i);
  });

  it("GET /invoices?mine=false&status=PENDING,PARTIAL still resolves cleanly (200)", async () => {
    const res = await request(app)
      .get("/api/v1/billing/invoices?mine=false&status=PENDING,PARTIAL&limit=5")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("GET /invoices as PATIENT with comma-separated status is the dashboard widget repro (200, never 500) (Issue #479)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/billing/invoices?mine=true&status=PENDING,PARTIAL&limit=5")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  // #900: POST /billing/consolidated must increment admissions.totalBillAmount
  // by the invoice total. Previously admissions sat at 0 for 30-day stays
  // because the consolidated invoice was created but the admission column
  // was never updated.
  it("POST /billing/consolidated increments admissions.totalBillAmount atomically (#900)", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const admission = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });

    // Baseline — admission starts at totalBillAmount = 0 (or null).
    const before = await prisma.admission.findUnique({
      where: { id: admission.id },
    });
    expect(before?.totalBillAmount ?? 0).toBe(0);

    const res = await request(app)
      .post("/api/v1/billing/consolidated")
      .set("Authorization", `Bearer ${token}`)
      .send({
        admissionId: admission.id,
        taxPercentage: 18,
        discountAmount: 0,
        applyAdvance: false,
      });
    expect([200, 201]).toContain(res.status);
    const inv = res.body.data;
    expect(inv.totalAmount).toBeGreaterThan(0);

    // Admission column must now equal the invoice total.
    const after = await prisma.admission.findUnique({
      where: { id: admission.id },
    });
    expect(after?.totalBillAmount).toBeCloseTo(inv.totalAmount, 1);
  });
});
