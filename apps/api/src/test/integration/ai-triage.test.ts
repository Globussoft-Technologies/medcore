// Integration tests for the AI Triage router.
// Claude service is mocked — no ANTHROPIC_API_KEY required.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture, createDoctorWithToken } from "../factories";

// Mock the Claude AI service so tests run without a real API key
vi.mock("../../services/ai/sarvam", () => ({
  runTriageTurn: vi.fn().mockResolvedValue({
    reply: "Can you tell me more about your symptoms — how long have you had this?",
    isEmergency: false,
  }),
  extractSymptomSummary: vi.fn().mockResolvedValue({
    chiefComplaint: "Persistent headache",
    onset: "3 days ago",
    duration: "72 hours",
    severity: 5,
    location: "Forehead",
    associatedSymptoms: ["nausea", "light sensitivity"],
    relevantHistory: "None",
    currentMedications: [],
    knownAllergies: [],
    age: 32,
    gender: "FEMALE",
    specialties: [
      { specialty: "Neurology", confidence: 0.75, reasoning: "Recurrent headache with nausea" },
      { specialty: "General Physician", confidence: 0.6, reasoning: "Initial evaluation" },
    ],
    confidence: 0.75,
  }),
  generateSOAPNote: vi.fn().mockResolvedValue({
    subjective: { chiefComplaint: "Headache", hpi: "3-day history of headache" },
    objective: { vitals: "BP 120/80", examinationFindings: "Normal" },
    assessment: { impression: "Tension headache", icd10Codes: [] },
    plan: { medications: [], investigations: [], followUpTimeline: "1 week" },
  }),
}));

let app: any;
let patientToken: string;
let receptionToken: string;
let adminToken: string;

describeIfDB("AI Triage API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    patientToken = await getAuthToken("PATIENT");
    receptionToken = await getAuthToken("RECEPTION");
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Session lifecycle ────────────────────────────────────────────────

  it("starts an English triage session", async () => {
    const res = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sessionId).toBeTruthy();
    expect(res.body.data.message).toContain("Hello");
    expect(res.body.data.disclaimer).toBeTruthy();
    expect(res.body.data.language).toBe("en");
  });

  it("starts a Hindi triage session with Hindi greeting", async () => {
    const res = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ consentGiven: true, language: "hi", inputMode: "voice" });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toContain("नमस्ते");
    expect(res.body.data.disclaimer).toMatch(/अपॉइंटमेंट/);
  });

  it("requires authentication to start a session", async () => {
    const res = await request(app)
      .post("/api/v1/ai/triage/start")
      .send({ consentGiven: true, language: "en", inputMode: "text" });

    expect(res.status).toBe(401);
  });

  it("rejects invalid language input", async () => {
    const res = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ consentGiven: true, language: "fr", inputMode: "text" });

    expect(res.status).toBe(400);
  });

  // ─── Sending messages ─────────────────────────────────────────────────

  it("processes a non-emergency message via Claude", async () => {
    const { runTriageTurn } = await import("../../services/ai/sarvam");

    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });
    const sessionId = start.body.data.sessionId;

    const res = await request(app)
      .post(`/api/v1/ai/triage/${sessionId}/message`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ message: "I have had a headache for 3 days" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toBeTruthy();
    expect(res.body.data.isEmergency).toBe(false);
    expect(res.body.data.turnCount).toBe(1);
    expect(vi.mocked(runTriageTurn)).toHaveBeenCalled();
  });

  it("detects emergency via red-flag layer (no LLM call needed)", async () => {
    const { runTriageTurn } = await import("../../services/ai/sarvam");
    vi.mocked(runTriageTurn).mockClear();

    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });
    const sessionId = start.body.data.sessionId;

    const res = await request(app)
      .post(`/api/v1/ai/triage/${sessionId}/message`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ message: "I have severe chest pain radiating to my left arm" });

    expect(res.status).toBe(200);
    expect(res.body.data.isEmergency).toBe(true);
    expect(res.body.data.emergencyReason).toMatch(/cardiac/i);
    expect(res.body.data.sessionStatus).toBe("EMERGENCY_DETECTED");
    // Red-flag layer catches this before Claude is called
    expect(vi.mocked(runTriageTurn)).not.toHaveBeenCalled();
  });

  it("blocks messages to a completed/emergency session", async () => {
    // Start and trigger emergency to close the session
    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });
    const sessionId = start.body.data.sessionId;

    await request(app)
      .post(`/api/v1/ai/triage/${sessionId}/message`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ message: "seizure right now" });

    // Attempt second message on closed session
    const res = await request(app)
      .post(`/api/v1/ai/triage/${sessionId}/message`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ message: "hello again" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/EMERGENCY_DETECTED/);
  });

  it("returns 404 for unknown session", async () => {
    const res = await request(app)
      .post("/api/v1/ai/triage/00000000-0000-0000-0000-000000000000/message")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ message: "hello" });

    expect(res.status).toBe(404);
  });

  // ─── Symptom extraction after 4+ turns ───────────────────────────────

  it("triggers symptom extraction and specialty suggestions after 4 turns", async () => {
    const { extractSymptomSummary } = await import("../../services/ai/sarvam");
    vi.mocked(extractSymptomSummary).mockClear();

    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });
    const sessionId = start.body.data.sessionId;

    // Send 4 messages to trigger extraction
    const messages = [
      "I have a headache",
      "It started 3 days ago",
      "The pain is around my forehead, level 5 out of 10",
      "I also feel nauseous and sensitive to light",
    ];
    let lastRes: any;
    for (const msg of messages) {
      lastRes = await request(app)
        .post(`/api/v1/ai/triage/${sessionId}/message`)
        .set("Authorization", `Bearer ${patientToken}`)
        .send({ message: msg });
    }

    expect(lastRes.status).toBe(200);
    expect(vi.mocked(extractSymptomSummary)).toHaveBeenCalled();
    expect(lastRes.body.data.readyForDoctorSuggestion).toBe(true);
    expect(lastRes.body.data.suggestedSpecialties).toBeTruthy();
    expect(lastRes.body.data.suggestedSpecialties[0].specialty).toBe("Neurology");
  });

  // ─── GET session state ────────────────────────────────────────────────

  it("fetches session state and doctor suggestions", async () => {
    const { doctor } = await createDoctorWithToken({ specialization: "Neurology" });

    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });
    const sessionId = start.body.data.sessionId;

    // Send enough messages to get specialty suggestions
    const msgs = ["headache", "3 days", "forehead", "nausea"];
    for (const msg of msgs) {
      await request(app)
        .post(`/api/v1/ai/triage/${sessionId}/message`)
        .set("Authorization", `Bearer ${patientToken}`)
        .send({ message: msg });
    }

    const res = await request(app)
      .get(`/api/v1/ai/triage/${sessionId}`)
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.session.id).toBe(sessionId);
    expect(Array.isArray(res.body.data.doctorSuggestions)).toBe(true);
    // Our Neurology doctor should appear in suggestions
    const found = res.body.data.doctorSuggestions.find(
      (d: any) => d.doctorId === doctor.id
    );
    expect(found).toBeTruthy();
    expect(found.specialty).toBe("Neurology");
  });

  it("returns 404 for GET on unknown session", async () => {
    const res = await request(app)
      .get("/api/v1/ai/triage/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(404);
  });

  // ─── Book appointment from triage ────────────────────────────────────

  it("books an appointment from a completed triage session", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken({ specialization: "Neurology" });

    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text", patientId: patient.id });
    const sessionId = start.body.data.sessionId;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    const res = await request(app)
      .post(`/api/v1/ai/triage/${sessionId}/book`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        doctorId: doctor.id,
        date: dateStr,
        slotStart: "10:00",
        slotEnd: "10:15",
        patientId: patient.id,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.appointment.doctorId).toBe(doctor.id);
    expect(res.body.data.appointment.patientId).toBe(patient.id);
    expect(res.body.data.preVisitSummary).toBeTruthy();

    // Verify session is now COMPLETED
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("COMPLETED");
    expect(session?.appointmentId).toBe(res.body.data.appointment.id);
  });

  it("prevents booking when an emergency was detected", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();

    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text", patientId: patient.id });
    const sessionId = start.body.data.sessionId;

    // Trigger emergency
    await request(app)
      .post(`/api/v1/ai/triage/${sessionId}/message`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ message: "I cannot breathe, severe breathlessness" });

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const res = await request(app)
      .post(`/api/v1/ai/triage/${sessionId}/book`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        doctorId: doctor.id,
        date: tomorrow.toISOString().slice(0, 10),
        slotStart: "11:00",
        slotEnd: "11:15",
        patientId: patient.id,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/emergency/i);
  });

  it("prevents double-booking the same slot", async () => {
    const patient1 = await createPatientFixture();
    const patient2 = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    const start1 = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });
    const start2 = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });

    const bookPayload = {
      doctorId: doctor.id,
      date: dateStr,
      slotStart: "14:00",
      slotEnd: "14:15",
    };

    const res1 = await request(app)
      .post(`/api/v1/ai/triage/${start1.body.data.sessionId}/book`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ ...bookPayload, patientId: patient1.id });
    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post(`/api/v1/ai/triage/${start2.body.data.sessionId}/book`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ ...bookPayload, patientId: patient2.id });
    expect(res2.status).toBe(409);
  });

  // ─── Abandon session ──────────────────────────────────────────────────

  it("abandons a triage session", async () => {
    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });
    const sessionId = start.body.data.sessionId;

    const res = await request(app)
      .delete(`/api/v1/ai/triage/${sessionId}`)
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("ABANDONED");
  });

  // ─── Role access ──────────────────────────────────────────────────────

  it("forbids DOCTOR role from booking via triage (wrong role)", async () => {
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const patient = await createPatientFixture();

    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });

    const res = await request(app)
      .post(`/api/v1/ai/triage/${start.body.data.sessionId}/book`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        doctorId: doctor.id,
        date: new Date().toISOString().slice(0, 10),
        slotStart: "09:00",
        slotEnd: "09:15",
        patientId: patient.id,
      });

    expect(res.status).toBe(403);
  });
});
