// Integration tests for the AI Predictions router (/api/v1/ai/predictions).
// no-show-predictor service is mocked so we can assert route behaviour.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createAppointmentFixture,
} from "../factories";

// security(F-PRED-2): the route now `validateUuidParams(["appointmentId"])`
// before reaching the handler — an unknown non-UUID id 400s before the mock
// fires. Use a UUID-shaped sentinel for the not-found path.
const MISSING_APPT_UUID = "00000000-0000-0000-0000-00000000dead";

vi.mock("../../services/ai/no-show-predictor", () => ({
  predictNoShow: vi.fn(async (appointmentId: string) => {
    if (appointmentId === MISSING_APPT_UUID) {
      throw new Error(`Appointment ${appointmentId} not found`);
    }
    return {
      appointmentId,
      riskScore: 0.42,
      riskLevel: "medium" as const,
      factors: ["Monday appointment (higher no-show day)"],
      recommendation: "Send a reminder call",
      source: "rules" as const,
    };
  }),
  batchPredictNoShow: vi.fn().mockResolvedValue([]),
}));

let app: any;
let adminToken: string;
let receptionToken: string;
let doctorToken: string;
let patientToken: string;

describeIfDB("AI Predictions API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── GET /no-show/:appointmentId ──────────────────────────────────────

  it("returns a no-show prediction for a valid appointment (DOCTOR)", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const res = await request(app)
      .get(`/api/v1/ai/predictions/no-show/${appt.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.appointmentId).toBe(appt.id);
    expect(res.body.data.riskLevel).toBe("medium");
    expect(Array.isArray(res.body.data.factors)).toBe(true);
  });

  it("returns a no-show prediction for RECEPTION role", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const res = await request(app)
      .get(`/api/v1/ai/predictions/no-show/${appt.id}`)
      .set("Authorization", `Bearer ${receptionToken}`);

    expect(res.status).toBe(200);
  });

  it("returns a no-show prediction for ADMIN role", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const res = await request(app)
      .get(`/api/v1/ai/predictions/no-show/${appt.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
  });

  it("requires authentication for GET /no-show/:appointmentId", async () => {
    const res = await request(app).get("/api/v1/ai/predictions/no-show/some-id");
    expect(res.status).toBe(401);
  });

  it("rejects PATIENT role (403)", async () => {
    const res = await request(app)
      .get("/api/v1/ai/predictions/no-show/any-id")
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(403);
  });

  it("maps 'not found' error from service into 404", async () => {
    const res = await request(app)
      .get(`/api/v1/ai/predictions/no-show/${MISSING_APPT_UUID}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // ─── GET /no-show/batch ───────────────────────────────────────────────

  it("returns batch no-show predictions for a date with BOOKED appointments", async () => {
    const { predictNoShow } = await import("../../services/ai/no-show-predictor");

    // Create a patient, doctor, and one BOOKED appointment on tomorrow
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { date: tomorrow, slotStart: "10:00", slotEnd: "10:15", status: "BOOKED" },
    });

    // Make predictNoShow return a predictable value for this appointment
    vi.mocked(predictNoShow).mockResolvedValueOnce({
      appointmentId: appt.id,
      riskScore: 0.7,
      riskLevel: "high",
      factors: ["Patient had a no-show in the last 60 days"],
      recommendation: "Call patient to confirm + book a backup slot",
      source: "rules",
    });

    const dateStr = tomorrow.toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/v1/ai/predictions/no-show/batch?date=${dateStr}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].appointmentId).toBe(appt.id);
    expect(res.body.data[0].appointment).toBeTruthy();
    expect(res.body.data[0].appointment.patientId).toBe(patient.id);
    expect(res.body.data[0].appointment.doctorId).toBe(doctor.id);
    expect(res.body.data[0].appointment.patientName).toBeTruthy();
  });

  it("returns empty array when no appointments on the given date", async () => {
    const res = await request(app)
      .get("/api/v1/ai/predictions/no-show/batch?date=2099-12-31")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("returns 400 when date query param is missing", async () => {
    const res = await request(app)
      .get("/api/v1/ai/predictions/no-show/batch")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/date/i);
  });

  it("returns 400 when date is not YYYY-MM-DD", async () => {
    const res = await request(app)
      .get("/api/v1/ai/predictions/no-show/batch?date=2099/01/01")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });

  it("rejects DOCTOR role on batch endpoint (403) — only ADMIN/RECEPTION", async () => {
    const res = await request(app)
      .get("/api/v1/ai/predictions/no-show/batch?date=2099-01-01")
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(403);
  });

  it("allows RECEPTION on batch endpoint", async () => {
    const res = await request(app)
      .get("/api/v1/ai/predictions/no-show/batch?date=2099-01-02")
      .set("Authorization", `Bearer ${receptionToken}`);

    expect(res.status).toBe(200);
  });

  it("requires authentication for batch endpoint", async () => {
    const res = await request(app).get(
      "/api/v1/ai/predictions/no-show/batch?date=2099-01-01"
    );
    expect(res.status).toBe(401);
  });
});
