// Cross-patient AI-triage POST handlers + nurse-rounds GET BOLA regression — issue #511.
//
// What this file covers
// ---------------------
// Issue #511 long-tail (OWASP API1:2023 BOLA / CWE-285) — three handlers
// missed by the original /:sessionId GET/DELETE patches:
//
//   - POST /api/v1/ai/triage/:sessionId/message    (only `authenticate`)
//   - POST /api/v1/ai/triage/:sessionId/handoff    (only `authenticate`)
//   - GET  /api/v1/nurse-rounds?admissionId=       (no role gate, no per-row)
//
// The triage POST handlers continued/handed-off another patient's in-flight
// session. The nurse-rounds GET allowed any authenticated PATIENT to
// enumerate clinical notes for any admission by guessing the admissionId.
//
// The fixes:
//   - ai-triage.ts: load the session, then `assertPatientOwnsResource`.
//   - nurse-rounds.ts: add `authorize(Role.ADMIN, Role.NURSE, Role.DOCTOR)`
//     to the GET — nurse-round entries are operational/clinical staff data,
//     mirroring the POST handler's gating in the same file.
//
// Why a separate file from cross-patient-ai-sessions.test.ts
// ----------------------------------------------------------
// The existing cross-patient-ai-sessions file covers the original GET+DELETE
// /:sessionId patches. This file covers the second pass — keeping the
// regression suites isolated keeps the per-issue blame story clear.

import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createDoctorFixture } from "../factories";

// Sarvam (Claude wrapper) is the only LLM dependency for the AI triage router
// loaded transitively via app.ts. Mock it so the test suite never reaches
// the real Anthropic API even if a code path triggers an LLM call.
vi.mock("../../services/ai/sarvam", () => ({
  runTriageTurn: vi.fn().mockResolvedValue({
    reply: "Tell me more about your symptoms.",
    isEmergency: false,
  }),
  extractSymptomSummary: vi.fn(),
  generateSOAPNote: vi.fn(),
  translateText: vi.fn(),
}));

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientBToken: string;
let patientAId: string;
let patientBId: string;
let doctorId: string;

async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000000",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-${label}-${Date.now()}`,
      dateOfBirth: new Date("1990-01-01"),
      gender: "MALE" as any,
    },
  });
  const token = jwt.sign(
    { userId: user.id, email, role: "PATIENT" },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
  return { patientId: patient.id, userId: user.id, token };
}

describeIfDB("Cross-patient ai-triage POST + nurse-rounds GET (issue #511)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("A511t");
    const b = await createPatientWithToken("B511t");
    patientAToken = a.token;
    patientBToken = b.token;
    patientAId = a.patientId;
    patientBId = b.patientId;

    const doctor = await createDoctorFixture();
    doctorId = doctor.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── ai/triage POST :sessionId/message ────────────────────────────────

  it("ai/triage POST /:sessionId/message: PATIENT-A cannot post into PATIENT-B's session (403)", async () => {
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.create({
      data: {
        patientId: patientBId,
        language: "en",
        inputMode: "text",
        chiefComplaint: "Cough",
        messages: [] as any,
        status: "ACTIVE" as any,
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/triage/${session.id}/message`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({ message: "I am hijacking" });
    expect(res.status).toBe(403);

    // Defense-in-depth: verify the BOLA reject fired BEFORE the message was
    // appended to the session — `messages` length must remain 0.
    const after = await prisma.aITriageSession.findUnique({
      where: { id: session.id },
    });
    expect((after?.messages as any[])?.length ?? 0).toBe(0);
  });

  it("ai/triage POST /:sessionId/message: PATIENT-A CAN post into own session (200) [positive control]", async () => {
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.create({
      data: {
        patientId: patientAId,
        language: "en",
        inputMode: "text",
        chiefComplaint: "Cough",
        messages: [] as any,
        status: "ACTIVE" as any,
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/triage/${session.id}/message`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({ message: "I have a cough" });
    expect(res.status).toBe(200);
  });

  // ─── ai/triage POST :sessionId/handoff ────────────────────────────────

  it("ai/triage POST /:sessionId/handoff: PATIENT-A cannot hand off PATIENT-B's session (403)", async () => {
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.create({
      data: {
        patientId: patientBId,
        language: "en",
        inputMode: "text",
        chiefComplaint: "Cough",
        messages: [] as any,
        status: "ACTIVE" as any,
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/triage/${session.id}/handoff`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({});
    expect(res.status).toBe(403);

    // Defense-in-depth: verify status is unchanged + no chat room created.
    const after = await prisma.aITriageSession.findUnique({
      where: { id: session.id },
    });
    expect(after?.status).toBe("ACTIVE");
    expect(after?.handoffChatRoomId).toBeNull();
  });

  it("ai/triage POST /:sessionId/handoff: PATIENT-A CAN hand off own session (200 or 503) [positive control]", async () => {
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.create({
      data: {
        patientId: patientAId,
        language: "en",
        inputMode: "text",
        chiefComplaint: "Cough",
        messages: [] as any,
        status: "ACTIVE" as any,
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/triage/${session.id}/handoff`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({});
    // 200 if a receptionist is seeded; 503 otherwise. The point is NOT 403.
    expect(res.status).not.toBe(403);
  });

  // ─── nurse-rounds GET / ───────────────────────────────────────────────

  it("nurse-rounds GET /: PATIENT cannot read nurse rounds for any admission (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/nurse-rounds?admissionId=00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("nurse-rounds GET /: DOCTOR CAN read nurse rounds (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/nurse-rounds?admissionId=00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
