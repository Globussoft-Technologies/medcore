// Integration tests for the AI Bill Explainer router (/api/v1/ai/bill-explainer).
// Sarvam service is mocked — no SARVAM_API_KEY required.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createAppointmentFixture,
  createInvoiceFixture,
} from "../factories";

vi.mock("../../services/ai/bill-explainer", () => ({
  generateBillExplanation: vi.fn().mockResolvedValue({
    content:
      "Your bill totals ₹1000 covering your consultation today. Insurance is not on file, so the amount is payable in full. Please speak to our billing desk if you have questions.",
    flaggedItems: [],
    language: "en",
  }),
}));

let app: any;
let adminToken: string;
let receptionToken: string;
let patientToken: string;

describeIfDB("AI Bill Explainer API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /:invoiceId/generate ────────────────────────────────────────

  it("generates a DRAFT bill explanation (happy path)", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });

    const res = await request(app)
      .post(`/api/v1/ai/bill-explainer/${invoice.id}/generate`)
      .set("Authorization", `Bearer ${receptionToken}`);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("DRAFT");
    expect(res.body.data.invoiceId).toBe(invoice.id);
    expect(res.body.data.patientId).toBe(patient.id);
    expect(res.body.data.language).toBe("en");
    expect(res.body.data.content).toContain("₹1000");
  });

  it("rejects a DOCTOR role — only PATIENT/ADMIN/RECEPTION may generate", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });

    const res = await request(app)
      .post(`/api/v1/ai/bill-explainer/${invoice.id}/generate`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(403);
  });

  it("rejects a non-owner PATIENT from generating someone else's bill", async () => {
    const patientA = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patientA.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patientA.id,
      appointmentId: appt.id,
    });

    // Different patient token
    const res = await request(app)
      .post(`/api/v1/ai/bill-explainer/${invoice.id}/generate`)
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/forbidden/i);
  });

  it("returns 404 for non-existent invoice", async () => {
    const res = await request(app)
      .post(`/api/v1/ai/bill-explainer/550e8400-e29b-41d4-a716-446655440000/generate`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it("rejects malformed invoice UUID (400)", async () => {
    const res = await request(app)
      .post(`/api/v1/ai/bill-explainer/not-a-uuid/generate`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });

  // ─── POST /:id/approve ────────────────────────────────────────────────

  it("approves a draft and marks it SENT", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });

    const gen = await request(app)
      .post(`/api/v1/ai/bill-explainer/${invoice.id}/generate`)
      .set("Authorization", `Bearer ${adminToken}`);
    const explanationId = gen.body.data.id;

    const res = await request(app)
      .post(`/api/v1/ai/bill-explainer/${explanationId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("SENT");
    expect(res.body.data.approvedAt).toBeTruthy();
    expect(res.body.data.sentAt).toBeTruthy();
  });

  it("rejects PATIENT role for approve endpoint", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });

    const gen = await request(app)
      .post(`/api/v1/ai/bill-explainer/${invoice.id}/generate`)
      .set("Authorization", `Bearer ${adminToken}`);
    const explanationId = gen.body.data.id;

    const res = await request(app)
      .post(`/api/v1/ai/bill-explainer/${explanationId}/approve`)
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(403);
  });

  // ─── GET /pending ─────────────────────────────────────────────────────

  it("lists DRAFT explanations for reception", async () => {
    // Fresh invoice + draft
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
    });
    await request(app)
      .post(`/api/v1/ai/bill-explainer/${invoice.id}/generate`)
      .set("Authorization", `Bearer ${receptionToken}`);

    const res = await request(app)
      .get("/api/v1/ai/bill-explainer/pending")
      .set("Authorization", `Bearer ${receptionToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((r: any) => r.invoiceId === invoice.id)).toBe(true);
  });

  // ─── GET /:id ─────────────────────────────────────────────────────────

  it("returns 404 for unknown explanation id", async () => {
    const res = await request(app)
      .get(`/api/v1/ai/bill-explainer/550e8400-e29b-41d4-a716-446655440000`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});
