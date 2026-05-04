// Cross-patient AI-session BOLA regression suite — issue #511.
//
// What this file covers
// ---------------------
// Issue #511 (Critical, OWASP API1:2023 BOLA / CWE-285) — three AI route
// handlers held a per-patient artefact (scribe transcript, triage symptom
// JSON, lab-report explanation) but had EITHER no role gate OR no per-row
// ownership check, so a PATIENT-role JWT could fetch / mutate another
// patient's row by guessing the UUID:
//
//   - DELETE /api/v1/ai/scribe/:sessionId      (no authorize, no per-row)
//   - GET    /api/v1/ai/triage/:sessionId      (only `authenticate`)
//   - DELETE /api/v1/ai/triage/:sessionId      (only `authenticate`)
//   - GET    /api/v1/ai/reports/:labOrderId    (had inline check; harmonised)
//
// The fixes (same commit) load the row first, then call
// `assertPatientOwnsResource(req, res, row.patientId)` so PATIENT callers
// can only touch their own; staff (DOCTOR/ADMIN) pass through.
//
// Modules / routes asserted
// -------------------------
// Per cited route the suite asserts the standard three cases:
//   1. PATIENT-A's token GETs/DELETEs PATIENT-B's resource → 403  (the bug)
//   2. PATIENT-A's token GETs/DELETEs PATIENT-A's own resource → 200  (positive control)
//   3. DOCTOR's token GETs/DELETEs the same resource → 200  (staff RBAC unbroken)
//
// Why a separate file from cross-patient-rbac.test.ts
// ---------------------------------------------------
// The original cross-patient sweep was issue #474; #511 is a follow-up
// agent fanout that touched a different family of routes. Keeping this
// in its own file lets each issue's regression coverage fail/pass in
// isolation, which is easier to debug than a single mega-suite. The
// fixture-creation helper is duplicated intentionally to avoid coupling
// the two files (mirrors the pattern in cross-patient-rbac.test.ts).

import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createDoctorFixture,
  createAppointmentFixture,
  createLabTestFixture,
  createLabOrderFixture,
} from "../factories";

// Sarvam (Claude wrapper) is the only LLM dependency for the AI scribe /
// triage routers loaded transitively via app.ts. Mock it so the test
// suite never reaches the real Anthropic API even if a stray code path
// triggers an LLM call. None of the assertions below actually exercise
// LLM-bound endpoints — only DELETE and GET on existing rows — but the
// mock keeps the test independent of network + secrets.
vi.mock("../../services/ai/sarvam", () => ({
  runTriageTurn: vi.fn(),
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

// Helper: create a PATIENT user + linked Patient row with a unique email,
// then mint a JWT for that user. Mirrors the pattern in
// cross-patient-rbac.test.ts so PATIENT-A vs PATIENT-B can be asserted
// without polluting the shared canonical PATIENT fixture.
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

describeIfDB("Cross-patient AI sessions (issue #511 — BOLA / CWE-285)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("A511");
    const b = await createPatientWithToken("B511");
    patientAToken = a.token;
    patientBToken = b.token;
    patientAId = a.patientId;
    patientBId = b.patientId;

    const doctor = await createDoctorFixture();
    doctorId = doctor.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── ai/scribe DELETE :sessionId ──────────────────────────────────────

  it("ai/scribe DELETE: PATIENT-A cannot DELETE PATIENT-B's session (403)", async () => {
    const prisma = await getPrisma();
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const session = await prisma.aIScribeSession.create({
      data: {
        appointmentId: apt.id,
        doctorId,
        patientId: patientBId,
        consentObtained: true,
        consentAt: new Date(),
        status: "ACTIVE" as any,
      },
    });

    const res = await request(app)
      .delete(`/api/v1/ai/scribe/${session.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);

    // Also assert the session was NOT mutated — the BOLA fix must reject
    // BEFORE the prisma.update fires.
    const after = await prisma.aIScribeSession.findUnique({ where: { id: session.id } });
    expect(after?.status).toBe("ACTIVE");
  });

  it("ai/scribe DELETE: PATIENT-A CAN DELETE own session (200) [positive control]", async () => {
    const prisma = await getPrisma();
    const apt = await createAppointmentFixture({ patientId: patientAId, doctorId });
    const session = await prisma.aIScribeSession.create({
      data: {
        appointmentId: apt.id,
        doctorId,
        patientId: patientAId,
        consentObtained: true,
        consentAt: new Date(),
        status: "ACTIVE" as any,
      },
    });

    const res = await request(app)
      .delete(`/api/v1/ai/scribe/${session.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);

    const after = await prisma.aIScribeSession.findUnique({ where: { id: session.id } });
    expect(after?.status).toBe("CONSENT_WITHDRAWN");
  });

  it("ai/scribe DELETE: DOCTOR can DELETE any session (200) [staff control]", async () => {
    const prisma = await getPrisma();
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const session = await prisma.aIScribeSession.create({
      data: {
        appointmentId: apt.id,
        doctorId,
        patientId: patientBId,
        consentObtained: true,
        consentAt: new Date(),
        status: "ACTIVE" as any,
      },
    });

    const res = await request(app)
      .delete(`/api/v1/ai/scribe/${session.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("ai/scribe DELETE: 404 when session does not exist", async () => {
    const res = await request(app)
      .delete(`/api/v1/ai/scribe/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(404);
  });

  // ─── ai/triage GET :sessionId ─────────────────────────────────────────

  it("ai/triage GET: PATIENT-A cannot GET PATIENT-B's session (403)", async () => {
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.create({
      data: {
        patientId: patientBId,
        language: "en",
        inputMode: "text",
        chiefComplaint: "Cough",
        messages: [] as any,
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/triage/${session.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("ai/triage GET: PATIENT-A CAN GET own session (200) [positive control]", async () => {
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.create({
      data: {
        patientId: patientAId,
        language: "en",
        inputMode: "text",
        chiefComplaint: "Cough",
        messages: [] as any,
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/triage/${session.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.session?.id).toBe(session.id);
  });

  it("ai/triage GET: DOCTOR can GET any session (200) [staff control]", async () => {
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.create({
      data: {
        patientId: patientBId,
        language: "en",
        inputMode: "text",
        chiefComplaint: "Cough",
        messages: [] as any,
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/triage/${session.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ─── ai/triage DELETE :sessionId ──────────────────────────────────────

  it("ai/triage DELETE: PATIENT-A cannot DELETE PATIENT-B's session (403)", async () => {
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.create({
      data: {
        patientId: patientBId,
        language: "en",
        inputMode: "text",
        chiefComplaint: "Cough",
        messages: [] as any,
      },
    });

    const res = await request(app)
      .delete(`/api/v1/ai/triage/${session.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);

    const after = await prisma.aITriageSession.findUnique({ where: { id: session.id } });
    expect(after?.status).not.toBe("ABANDONED");
  });

  it("ai/triage DELETE: PATIENT-A CAN DELETE own session (200) [positive control]", async () => {
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.create({
      data: {
        patientId: patientAId,
        language: "en",
        inputMode: "text",
        chiefComplaint: "Cough",
        messages: [] as any,
      },
    });

    const res = await request(app)
      .delete(`/api/v1/ai/triage/${session.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);

    const after = await prisma.aITriageSession.findUnique({ where: { id: session.id } });
    expect(after?.status).toBe("ABANDONED");
  });

  it("ai/triage DELETE: DOCTOR can DELETE any session (200) [staff control]", async () => {
    const prisma = await getPrisma();
    const session = await prisma.aITriageSession.create({
      data: {
        patientId: patientBId,
        language: "en",
        inputMode: "text",
        chiefComplaint: "Cough",
        messages: [] as any,
      },
    });

    const res = await request(app)
      .delete(`/api/v1/ai/triage/${session.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ─── ai/reports GET :labOrderId ───────────────────────────────────────

  it("ai/reports GET: PATIENT-A cannot GET PATIENT-B's lab explanation (403)", async () => {
    const prisma = await getPrisma();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patientBId,
      doctorId,
      testIds: [test.id],
    });
    await prisma.labReportExplanation.create({
      data: {
        labOrderId: order.id,
        patientId: patientBId,
        explanation: "Mock explanation",
        flaggedValues: [] as any,
        language: "en",
        status: "APPROVED",
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/reports/${order.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("ai/reports GET: PATIENT-A CAN GET own lab explanation (200) [positive control]", async () => {
    const prisma = await getPrisma();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patientAId,
      doctorId,
      testIds: [test.id],
    });
    await prisma.labReportExplanation.create({
      data: {
        labOrderId: order.id,
        patientId: patientAId,
        explanation: "Mock explanation",
        flaggedValues: [] as any,
        language: "en",
        status: "APPROVED",
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/reports/${order.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.labOrderId).toBe(order.id);
  });

  it("ai/reports GET: DOCTOR can GET any lab explanation (200) [staff control]", async () => {
    const prisma = await getPrisma();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patientBId,
      doctorId,
      testIds: [test.id],
    });
    await prisma.labReportExplanation.create({
      data: {
        labOrderId: order.id,
        patientId: patientBId,
        explanation: "Mock explanation",
        flaggedValues: [] as any,
        language: "en",
        status: "APPROVED",
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/reports/${order.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });
});
