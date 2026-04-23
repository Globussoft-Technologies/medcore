// Integration tests for the AI Scribe router.
// Claude service is mocked — no ANTHROPIC_API_KEY required.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createAppointmentFixture,
} from "../factories";

const MOCK_SOAP = {
  subjective: {
    chiefComplaint: "Cough and fever",
    hpi: "Patient reports dry cough for 5 days with fever 101°F. No chills.",
    pastMedicalHistory: "None",
    medications: [],
    allergies: ["Penicillin"],
  },
  objective: {
    vitals: "BP 118/76, HR 88, Temp 38.3°C, SpO2 98%",
    examinationFindings: "Mild pharyngeal erythema, lungs clear on auscultation",
  },
  assessment: {
    impression: "Viral upper respiratory tract infection",
    icd10Codes: [
      {
        code: "J06.9",
        description: "Acute upper respiratory infection, unspecified",
        confidence: 0.85,
        evidenceSpan: "dry cough for 5 days with fever",
      },
    ],
  },
  plan: {
    medications: [
      { name: "Paracetamol", dose: "500mg", frequency: "TID", duration: "5 days", notes: "After food" },
    ],
    investigations: [],
    procedures: [],
    referrals: [],
    followUpTimeline: "7 days if not improving",
    patientInstructions: "Rest, fluids, avoid cold beverages",
  },
};

vi.mock("../../services/ai/sarvam", () => ({
  runTriageTurn: vi.fn(),
  extractSymptomSummary: vi.fn(),
  generateSOAPNote: vi.fn().mockResolvedValue(MOCK_SOAP),
}));

let app: any;

describeIfDB("AI Scribe API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Start session ────────────────────────────────────────────────────

  it("starts a scribe session as the attending doctor", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });

    const res = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 30 });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sessionId).toBeTruthy();
    expect(res.body.data.patientContext).toBeTruthy();

    const prisma = await getPrisma();
    const session = await prisma.aIScribeSession.findUnique({
      where: { id: res.body.data.sessionId },
    });
    expect(session?.status).toBe("ACTIVE");
    expect(session?.consentObtained).toBe(true);
  });

  it("returns existing session when already started (idempotent)", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });

    const first = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 30 });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 30 });
    expect(second.status).toBe(200);
    expect(second.body.data.sessionId).toBe(first.body.data.sessionId);
    expect(second.body.data.resumed).toBe(true);
  });

  it("rejects a non-attending doctor", async () => {
    const patient = await createPatientFixture();
    const { doctor: attendingDoctor } = await createDoctorWithToken();
    const { token: otherDoctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: attendingDoctor.id,
    });

    const res = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${otherDoctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 30 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/attending/i);
  });

  it("rejects a PATIENT role (requires DOCTOR or ADMIN)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });

    // Get a patient token
    const jwt = await import("jsonwebtoken");
    const patientToken = jwt.default.sign(
      { userId: patient.userId, email: "p@test.local", role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 30 });

    expect(res.status).toBe(403);
  });

  it("returns 404 when appointment does not exist", async () => {
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        appointmentId: "00000000-0000-0000-0000-000000000000",
        consentObtained: true,
        audioRetentionDays: 0,
      });

    expect(res.status).toBe(404);
  });

  // ─── Transcript & SOAP draft ──────────────────────────────────────────

  it("appends transcript entries and returns SOAP draft after 3+ entries", async () => {
    const { generateSOAPNote } = await import("../../services/ai/sarvam");
    vi.mocked(generateSOAPNote).mockClear();

    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const startRes = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 7 });
    const sessionId = startRes.body.data.sessionId;

    const entries = [
      { speaker: "DOCTOR", text: "What brings you in today?", timestamp: new Date().toISOString() },
      { speaker: "PATIENT", text: "I have a cough and fever for 5 days", timestamp: new Date().toISOString() },
      { speaker: "DOCTOR", text: "Any shortness of breath or chest pain?", timestamp: new Date().toISOString() },
    ];

    const res = await request(app)
      .post(`/api/v1/ai/scribe/${sessionId}/transcript`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ entries });

    expect(res.status).toBe(200);
    expect(res.body.data.transcriptLength).toBe(3);
    expect(res.body.data.soapDraftUpdated).toBe(true);
    expect(res.body.data.soapDraft.subjective.chiefComplaint).toBe("Cough and fever");
    expect(vi.mocked(generateSOAPNote)).toHaveBeenCalledOnce();
  });

  it("does not call Claude when fewer than 3 transcript entries", async () => {
    const { generateSOAPNote } = await import("../../services/ai/sarvam");
    vi.mocked(generateSOAPNote).mockClear();

    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const startRes = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 0 });
    const sessionId = startRes.body.data.sessionId;

    await request(app)
      .post(`/api/v1/ai/scribe/${sessionId}/transcript`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        entries: [
          { speaker: "DOCTOR", text: "Hello, how are you?", timestamp: new Date().toISOString() },
        ],
      });

    expect(vi.mocked(generateSOAPNote)).not.toHaveBeenCalled();
  });

  it("returns 400 when adding transcript to a non-active session", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const startRes = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 0 });
    const sessionId = startRes.body.data.sessionId;

    // Withdraw consent to close the session
    await request(app)
      .delete(`/api/v1/ai/scribe/${sessionId}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    const res = await request(app)
      .post(`/api/v1/ai/scribe/${sessionId}/transcript`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        entries: [{ speaker: "DOCTOR", text: "hello", timestamp: new Date().toISOString() }],
      });

    expect(res.status).toBe(400);
  });

  // ─── GET SOAP draft ───────────────────────────────────────────────────

  it("fetches SOAP draft after transcript is added", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const startRes = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 7 });
    const sessionId = startRes.body.data.sessionId;

    await request(app)
      .post(`/api/v1/ai/scribe/${sessionId}/transcript`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        entries: [
          { speaker: "DOCTOR", text: "What brings you in today?", timestamp: new Date().toISOString() },
          { speaker: "PATIENT", text: "Cough and fever", timestamp: new Date().toISOString() },
          { speaker: "DOCTOR", text: "Duration?", timestamp: new Date().toISOString() },
        ],
      });

    const res = await request(app)
      .get(`/api/v1/ai/scribe/${sessionId}/soap`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(sessionId);
    expect(res.body.data.status).toBe("ACTIVE");
    expect(res.body.data.soapDraft).toBeTruthy();
    expect(res.body.data.soapDraft.subjective.chiefComplaint).toBe("Cough and fever");
  });

  it("returns 404 for GET SOAP on unknown session", async () => {
    const { token: doctorToken } = await createDoctorWithToken();
    const res = await request(app)
      .get("/api/v1/ai/scribe/00000000-0000-0000-0000-000000000000/soap")
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(404);
  });

  // ─── Finalize / sign off ──────────────────────────────────────────────

  it("signs off session and writes SOAP to EHR", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const startRes = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 7 });
    const sessionId = startRes.body.data.sessionId;

    // Add transcript to generate draft
    await request(app)
      .post(`/api/v1/ai/scribe/${sessionId}/transcript`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        entries: [
          { speaker: "DOCTOR", text: "Describe your symptoms", timestamp: new Date().toISOString() },
          { speaker: "PATIENT", text: "Cough and fever 5 days", timestamp: new Date().toISOString() },
          { speaker: "DOCTOR", text: "Any chest pain?", timestamp: new Date().toISOString() },
        ],
      });

    const finalSoap = {
      ...MOCK_SOAP,
      assessment: {
        ...MOCK_SOAP.assessment,
        impression: "Viral URTI — doctor approved",
      },
    };

    const res = await request(app)
      .post(`/api/v1/ai/scribe/${sessionId}/finalize`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        soapFinal: finalSoap,
        icd10Codes: [{ code: "J06.9", description: "Acute URTI", confidence: 0.9 }],
        rxApproved: true,
        doctorEdits: [{ field: "assessment.impression", before: "Viral URTI", after: "Viral URTI — doctor approved" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.session.status).toBe("COMPLETED");
    expect(res.body.data.session.signedOffAt).toBeTruthy();

    // Consultation record should now exist in EHR
    const prisma = await getPrisma();
    const consultation = await prisma.consultation.findUnique({
      where: { appointmentId: appt.id },
    });
    expect(consultation).toBeTruthy();
    expect(consultation?.notes).toContain("[AI Scribe — Doctor Approved]");
    expect(consultation?.notes).toContain("Viral URTI — doctor approved");
  });

  it("rejects sign-off by non-attending doctor", async () => {
    const patient = await createPatientFixture();
    const { doctor: attending, token: attendingToken } = await createDoctorWithToken();
    const { token: otherToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: attending.id });

    const startRes = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${attendingToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 0 });
    const sessionId = startRes.body.data.sessionId;

    const res = await request(app)
      .post(`/api/v1/ai/scribe/${sessionId}/finalize`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({
        soapFinal: MOCK_SOAP,
        icd10Codes: [],
        rxApproved: false,
        doctorEdits: [],
      });

    expect(res.status).toBe(403);
  });

  // ─── Consent withdrawal ───────────────────────────────────────────────

  it("withdraws consent and purges transcript", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const startRes = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 30 });
    const sessionId = startRes.body.data.sessionId;

    // Add some transcript
    await request(app)
      .post(`/api/v1/ai/scribe/${sessionId}/transcript`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        entries: [
          { speaker: "PATIENT", text: "Personal medical history details", timestamp: new Date().toISOString() },
          { speaker: "DOCTOR", text: "I see, tell me more", timestamp: new Date().toISOString() },
          { speaker: "PATIENT", text: "More private info", timestamp: new Date().toISOString() },
        ],
      });

    const res = await request(app)
      .delete(`/api/v1/ai/scribe/${sessionId}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const prisma = await getPrisma();
    const session = await prisma.aIScribeSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("CONSENT_WITHDRAWN");
    // Transcript must be purged
    expect(session?.transcript).toEqual([]);
    // SOAP draft must also be cleared
    expect(session?.soapDraft).toBeNull();
  });

  // ─── Validation ───────────────────────────────────────────────────────

  it("rejects start without consentObtained: true", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const res = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: false, audioRetentionDays: 30 });

    expect(res.status).toBe(400);
  });

  it("rejects transcript entries with invalid speaker enum", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const startRes = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ appointmentId: appt.id, consentObtained: true, audioRetentionDays: 0 });

    const res = await request(app)
      .post(`/api/v1/ai/scribe/${startRes.body.data.sessionId}/transcript`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        entries: [{ speaker: "NURSE", text: "some text", timestamp: new Date().toISOString() }],
      });

    expect(res.status).toBe(400);
  });
});
