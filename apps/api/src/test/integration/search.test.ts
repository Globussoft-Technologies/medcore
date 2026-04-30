// Integration tests for the federated /search endpoint. Covers role-based
// filtering — most importantly that PATIENT cannot search across other
// patients' records.
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
let doctorToken: string;
let patientToken: string;

describeIfDB("Search API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("returns empty data for queries shorter than 2 chars", async () => {
    const res = await request(app)
      .get("/api/v1/search?q=a")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("returns empty data when q is missing", async () => {
    const res = await request(app)
      .get("/api/v1/search")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("admin can find a patient by MR number", async () => {
    const patient = await createPatientFixture({ mrNumber: "MRSEARCH-AAA-001" });
    const res = await request(app)
      .get(`/api/v1/search?q=MRSEARCH-AAA-001&types=patients`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const hits = res.body.data.filter((h: any) => h.type === "patient");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].id).toBe(patient.id);
  });

  it("admin can find an invoice by invoice number", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });
    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(invoice.invoiceNumber)}&types=invoices`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const hits = res.body.data.filter((h: any) => h.type === "invoice");
    expect(hits.find((h: any) => h.id === invoice.id)).toBeTruthy();
  });

  it("patient cannot see other patients' records via patients search (filter excludes)", async () => {
    // Build another patient whose MR number is uniquely searchable.
    const other = await createPatientFixture({ mrNumber: "MR-OTHER-PATIENT-XYZ" });
    const res = await request(app)
      .get(`/api/v1/search?q=MR-OTHER-PATIENT-XYZ&types=patients`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    // Search router skips the "patients" entity entirely for role=PATIENT,
    // so even an exact MR-number match must not show up.
    const hits = res.body.data.filter((h: any) => h.type === "patient");
    expect(hits.find((h: any) => h.id === other.id)).toBeFalsy();
  });

  it("patient cannot see another patient's invoice", async () => {
    const other = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: other.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: other.id,
      appointmentId: appt.id,
    });
    const res = await request(app)
      .get(`/api/v1/search?q=${encodeURIComponent(invoice.invoiceNumber)}&types=invoices`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    const hits = res.body.data.filter((h: any) => h.type === "invoice");
    expect(hits.find((h: any) => h.id === invoice.id)).toBeFalsy();
  });

  it("patient can find their own appointment by querying the doctor's name", async () => {
    const prisma = await getPrisma();
    // Resolve the auto-provisioned PATIENT row from getAuthToken("PATIENT")
    const patientUser = await prisma.user.findUnique({
      where: { email: "patient@test.local" },
    });
    const selfPatient = await prisma.patient.findFirst({
      where: { userId: patientUser!.id },
    });
    const doctor = await createDoctorFixture({
      name: "Dr. Federated SearchTarget",
    });
    await createAppointmentFixture({
      patientId: selfPatient!.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .get(`/api/v1/search?q=SearchTarget&types=appointments`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    const hits = res.body.data.filter((h: any) => h.type === "appointment");
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("doctor's appointment search is scoped to their own appointments", async () => {
    const prisma = await getPrisma();
    const doctorUser = await prisma.user.findUnique({
      where: { email: "doctor@test.local" },
    });
    const myDoctor = await prisma.doctor.findFirst({
      where: { userId: doctorUser!.id },
    });
    if (!myDoctor) {
      // The doctor row is created lazily on first DOCTOR-scoped action; create
      // it here so the search has someone to scope to.
      await prisma.doctor.create({
        data: {
          userId: doctorUser!.id,
          specialization: "General",
          qualification: "MBBS",
        },
      });
    }
    // Create an appointment for *another* doctor — the logged-in doctor
    // should NOT see it.
    const otherDoctor = await createDoctorFixture();
    const patient = await createPatientFixture();
    const otherAppt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: otherDoctor.id,
      overrides: { notes: "uniqueneedle-1234567" },
    });

    const res = await request(app)
      .get(`/api/v1/search?q=uniqueneedle-1234567&types=appointments`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    const hits = res.body.data.filter((h: any) => h.type === "appointment");
    expect(hits.find((h: any) => h.id === otherAppt.id)).toBeFalsy();
  });

  it("returns module 'label' hits for navigation queries", async () => {
    const res = await request(app)
      .get("/api/v1/search?q=Pharmacy&types=labels")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const labels = res.body.data.filter((h: any) => h.type === "label");
    expect(labels.length).toBeGreaterThanOrEqual(1);
    expect(labels[0].href).toMatch(/^\/dashboard\//);
  });

  it("filters labels by role — patient sees no Users module label", async () => {
    const res = await request(app)
      .get("/api/v1/search?q=Users&types=labels")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    const labels = res.body.data.filter((h: any) => h.type === "label");
    expect(labels.find((l: any) => /Users/.test(l.title))).toBeFalsy();
  });

  it("rejects unauthenticated search (401)", async () => {
    const res = await request(app).get("/api/v1/search?q=anything");
    expect(res.status).toBe(401);
  });

  it("ignores unknown types= values silently and returns 200", async () => {
    const res = await request(app)
      .get("/api/v1/search?q=test&types=NOT_A_REAL_TYPE,labels")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
