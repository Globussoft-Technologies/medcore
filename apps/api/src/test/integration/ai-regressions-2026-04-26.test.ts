// Integration tests for the 6 HIGH AI-feature regressions closed on
// 2026-04-26 (issues #189, #190, #193, #194, #205, #240). One assertion per
// issue, kept terse — these guard against regressions, not exhaustive
// behaviour. The Sarvam AI client is mocked so we can drive triage flow
// without an ANTHROPIC_API_KEY in CI.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture, createDoctorFixture } from "../factories";

vi.mock("../../services/ai/sarvam", () => ({
  runTriageTurn: vi.fn().mockResolvedValue({
    reply: "Got it — when did this start?",
    isEmergency: false,
  }),
  extractSymptomSummary: vi.fn().mockResolvedValue({
    chiefComplaint: "Cough",
    onset: "yesterday",
    duration: "1 day",
    severity: 3,
    associatedSymptoms: [],
    relevantHistory: "",
    specialties: [
      { specialty: "Pulmonology", confidence: 0.7, reasoning: "" },
    ],
    confidence: 0.7,
  }),
  generateSOAPNote: vi.fn().mockResolvedValue({}),
  translateText: vi.fn().mockResolvedValue(""),
}));

let app: any;
let adminToken: string;
let doctorToken: string;

describeIfDB("AI-feature regressions (2026-04-26)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ── #190: register accepts PHARMACIST + LAB_TECH ─────────────────────
  it("#190: /auth/register accepts PHARMACIST role (was rejected by zod enum)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        name: "Pharma Tester",
        email: `pharma_${Date.now()}@test.local`,
        phone: "9988776655",
        password: "Strong1Pass!",
        role: "PHARMACIST",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe("PHARMACIST");
  });

  it("#190: /auth/register accepts LAB_TECH role", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        name: "Lab Tester",
        email: `lab_${Date.now()}@test.local`,
        phone: "9988776656",
        password: "Strong1Pass!",
        role: "LAB_TECH",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe("LAB_TECH");
  });

  // ── #205: registering a DOCTOR also creates a Doctor row ─────────────
  it("#205: registering a DOCTOR auto-creates a Doctor row", async () => {
    const prisma = await getPrisma();
    const email = `doc_${Date.now()}@test.local`;
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        name: "Dr. Auto Created",
        email,
        phone: "9123456789",
        password: "Strong1Pass!",
        role: "DOCTOR",
      });
    expect(res.status).toBe(201);
    const userId = res.body.data.user.id;
    const doctor = await prisma.doctor.findUnique({ where: { userId } });
    expect(doctor).toBeTruthy();
    expect(doctor!.specialization).toBe("General Medicine");
  });

  // ── #189: ADMIN can read a chat room they're not a participant in ────
  it("#189: ADMIN bypasses chat-room participant check (Agent Console triage)", async () => {
    const prisma = await getPrisma();
    // Create a 1:1 ChatRoom between two non-admin users — admin is NOT
    // a participant. Pre-fix the GET would 403; post-fix it must 200.
    const a = await createPatientFixture();
    const b = await createPatientFixture();
    const room = await prisma.chatRoom.create({
      data: {
        isGroup: false,
        createdBy: a.userId,
        participants: {
          create: [{ userId: a.userId }, { userId: b.userId }],
        },
      },
    });
    const res = await request(app)
      .get(`/api/v1/chat/rooms/${room.id}/messages`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // ── #194: /appointments accepts ?search= and filters today + status ─
  it("#194: /appointments supports ?search= filter on tokenNumber/slotStart", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const today = new Date();
    today.setHours(10, 0, 0, 0);
    await prisma.appointment.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        date: today,
        slotStart: "10:00",
        slotEnd: "10:15",
        tokenNumber: 7,
        type: "SCHEDULED",
        status: "BOOKED",
      },
    });
    // Token-number search hits the row.
    const dateStr = today.toISOString().split("T")[0];
    const res = await request(app)
      .get(
        `/api/v1/appointments?patientId=${patient.id}&date=${dateStr}` +
          `&status=BOOKED,CHECKED_IN,IN_CONSULTATION&search=7`
      )
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.some((a: any) => a.tokenNumber === 7)).toBe(true);
  });

  // ── #193: /ai/scribe/start returns sessionId at data.sessionId ───────
  // Smoke test on the response *shape* — the bug was a frontend-only
  // double-walk (`res.data.data.sessionId`). We assert here that the API
  // continues to return the unwrapped shape the fixed frontend now reads.
  it("#193: /ai/scribe/start response is shaped { data: { sessionId } }", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const today = new Date();
    today.setHours(11, 0, 0, 0);
    const appt = await prisma.appointment.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        date: today,
        slotStart: "11:00",
        slotEnd: "11:15",
        tokenNumber: 1,
        type: "SCHEDULED",
        status: "CHECKED_IN",
      },
    });
    // Use the doctor that owns the appointment so the consent check passes.
    const docUser = await prisma.user.findUnique({
      where: { id: doctor.userId },
    });
    const jwt = await import("jsonwebtoken");
    const token = jwt.default.sign(
      { userId: docUser!.id, email: docUser!.email, role: "DOCTOR" },
      process.env.JWT_SECRET || "dev-secret",
      { expiresIn: "1h" }
    );
    const res = await request(app)
      .post("/api/v1/ai/scribe/start")
      .set("Authorization", `Bearer ${token}`)
      .send({
        appointmentId: appt.id,
        consentObtained: true,
        audioRetentionDays: 30,
      });
    expect([200, 201]).toContain(res.status);
    // The fix requires `data.sessionId` (NOT `data.data.sessionId`).
    expect(res.body.data?.sessionId).toBeTruthy();
    expect(typeof res.body.data.sessionId).toBe("string");
  });

  // ── #240: /ai/triage/:id/message stays up when the LLM throws ────────
  it("#240: /ai/triage/:id/message returns a graceful reply when runTriageTurn throws", async () => {
    const sarvam = await import("../../services/ai/sarvam");
    const spy = vi
      .mocked(sarvam.runTriageTurn)
      .mockRejectedValueOnce(new Error("simulated upstream failure"));

    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ language: "en", inputMode: "text", consentGiven: true });
    expect(start.status).toBe(200);
    const sessionId = start.body.data.sessionId;

    const msg = await request(app)
      .post(`/api/v1/ai/triage/${sessionId}/message`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ message: "I have a headache" });

    // Pre-fix this would 500 the request; post-fix the route returns 200
    // with a graceful fallback reply.
    expect(msg.status).toBe(200);
    expect(typeof msg.body.data?.message).toBe("string");
    expect(msg.body.data.message.length).toBeGreaterThan(0);

    spy.mockRestore?.();
  });
});
