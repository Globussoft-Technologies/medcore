// Integration tests for the AI Pre-visit router (/api/v1/ai/previsit).
// Previsit generator is mocked — no SARVAM_API_KEY required.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createAppointmentFixture,
} from "../factories";
import jwt from "jsonwebtoken";

vi.mock("../../services/ai/previsit", () => ({
  generatePrevisitChecklist: vi.fn().mockResolvedValue({
    items: [
      {
        label: "Government photo ID (Aadhaar / PAN)",
        category: "ID",
        required: true,
        reason: "Required for registration.",
      },
      {
        label: "Past lab reports",
        category: "REPORT",
        required: false,
        reason: "So the doctor can compare trends.",
      },
      {
        label: "Current prescription",
        category: "MEDICATION",
        required: true,
        reason: "For medication review.",
      },
    ],
  }),
}));

let app: any;
let adminToken: string;

function signPatientToken(userId: string): string {
  return jwt.sign(
    { userId, email: "p@test.local", role: "PATIENT" },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
}

describeIfDB("AI Previsit API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("generates and caches a checklist for the owning patient", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const patientToken = signPatientToken(patient.userId);

    const res = await request(app)
      .get(`/api/v1/ai/previsit/${appt.id}`)
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.appointmentId).toBe(appt.id);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.items[0].category).toBe("ID");
  });

  it("returns the cached checklist on a second call (no regeneration)", async () => {
    const { generatePrevisitChecklist } = await import(
      "../../services/ai/previsit"
    );
    vi.mocked(generatePrevisitChecklist).mockClear();

    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const patientToken = signPatientToken(patient.userId);

    const first = await request(app)
      .get(`/api/v1/ai/previsit/${appt.id}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(first.status).toBe(200);
    expect(vi.mocked(generatePrevisitChecklist)).toHaveBeenCalledOnce();

    vi.mocked(generatePrevisitChecklist).mockClear();

    const second = await request(app)
      .get(`/api/v1/ai/previsit/${appt.id}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(vi.mocked(generatePrevisitChecklist)).not.toHaveBeenCalled();
  });

  it("regenerates when ?regenerate=1", async () => {
    const { generatePrevisitChecklist } = await import(
      "../../services/ai/previsit"
    );
    vi.mocked(generatePrevisitChecklist).mockClear();

    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const patientToken = signPatientToken(patient.userId);

    await request(app)
      .get(`/api/v1/ai/previsit/${appt.id}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(vi.mocked(generatePrevisitChecklist)).toHaveBeenCalledOnce();

    await request(app)
      .get(`/api/v1/ai/previsit/${appt.id}?regenerate=1`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(vi.mocked(generatePrevisitChecklist)).toHaveBeenCalledTimes(2);
  });

  it("forbids a different patient from viewing someone else's checklist", async () => {
    const patientA = await createPatientFixture();
    const patientB = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patientA.id,
      doctorId: doctor.id,
    });
    const patientBToken = signPatientToken(patientB.userId);

    const res = await request(app)
      .get(`/api/v1/ai/previsit/${appt.id}`)
      .set("Authorization", `Bearer ${patientBToken}`);

    expect(res.status).toBe(403);
  });

  it("returns 404 for unknown appointment id", async () => {
    const res = await request(app)
      .get(`/api/v1/ai/previsit/550e8400-e29b-41d4-a716-446655440000`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it("rejects malformed UUID (400 from validateUuidParams)", async () => {
    const res = await request(app)
      .get(`/api/v1/ai/previsit/not-a-uuid`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });
});
