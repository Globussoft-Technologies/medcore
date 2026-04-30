// Integration tests covering PHI-read audit-log coverage.
//
// These tests assert that the endpoints newly instrumented with `auditLog`
// for PHI reads actually produce an audit_logs row on a successful request.
// They also pin down the redaction rules — e.g. FHIR search parameter values
// must never leak into the audit trail, only param names + hasValue booleans.
//
// Skipped unless DATABASE_URL_TEST is set (same pattern as the rest of the
// integration suite). Claude/Sarvam services are mocked so we never hit the
// real LLM.

import { it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createAppointmentFixture,
} from "../factories";

// Mock AI services so tests don't need network access.
vi.mock("../../services/ai/sarvam", () => ({
  generateText: vi.fn(async () => "The patient has a history of diabetes [1]."),
  runTriageTurn: vi.fn().mockResolvedValue({
    reply: "Can you tell me more?",
    isEmergency: false,
  }),
  extractSymptomSummary: vi.fn().mockResolvedValue({
    chiefComplaint: "Headache",
    specialties: [],
    confidence: 0.6,
  }),
  generateSOAPNote: vi.fn().mockResolvedValue({
    subjective: { chiefComplaint: "Headache", hpi: "3-day history" },
    objective: { vitals: "BP 120/80", examinationFindings: "Normal" },
    assessment: { impression: "Tension headache", icd10Codes: [] },
    plan: { medications: [], investigations: [], followUpTimeline: "1 week" },
  }),
}));

vi.mock("../../services/ai/no-show-predictor", () => ({
  predictNoShow: vi.fn(async (appointmentId: string) => ({
    appointmentId,
    riskScore: 0.42,
    riskLevel: "medium" as const,
    factors: ["Monday appointment"],
    recommendation: "Send a reminder call",
    source: "rules" as const,
  })),
  batchPredictNoShow: vi.fn().mockResolvedValue([]),
}));

let app: any;
let adminToken: string;
let doctorToken: string;
let receptionToken: string;

/**
 * Prune any audit rows that existed before the test ran so assertions about
 * "this action was logged exactly N times for this entity" are not polluted
 * by seed data (login events, etc.).
 */
async function clearAuditFor(action: string) {
  const prisma = await getPrisma();
  await prisma.auditLog.deleteMany({ where: { action } });
}

async function findAudit(action: string, entityId?: string) {
  const prisma = await getPrisma();
  return prisma.auditLog.findMany({
    where: { action, ...(entityId ? { entityId } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

describeIfDB("PHI read audit logging (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  beforeEach(async () => {
    // Clean slate for each test so count assertions are tight.
    const prisma = await getPrisma();
    await prisma.auditLog.deleteMany({
      where: {
        action: {
          in: [
            "AI_CHART_SEARCH_PATIENT",
            "AI_CHART_SEARCH_COHORT",
            "AI_TRIAGE_SESSION_READ",
            "AI_SCRIBE_READ",
            "AI_NO_SHOW_BATCH",
            "FHIR_SEARCH_PATIENT",
            "INSURANCE_CLAIMS_LIST",
          ],
        },
      },
    });
  });

  // ── 1: chart search per patient ─────────────────────────────────────────

  it("writes AI_CHART_SEARCH_PATIENT audit on POST /chart-search/patient/:id with truncated query", async () => {
    const patient = await createPatientFixture();
    const { doctor, token } = await createDoctorWithToken();
    await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    // Build a >200-char query to verify truncation.
    const longQuery = "diabetes metformin " + "x".repeat(500);

    const res = await request(app)
      .post(`/api/v1/ai/chart-search/patient/${patient.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ query: longQuery, limit: 5 });

    expect(res.status).toBe(200);

    const rows = await findAudit("AI_CHART_SEARCH_PATIENT", patient.id);
    expect(rows.length).toBe(1);
    expect(rows[0].entity).toBe("Patient");
    const details = rows[0].details as any;
    expect(typeof details.query).toBe("string");
    // Truncated to 200 chars.
    expect(details.query.length).toBeLessThanOrEqual(200);
  });

  // ── 2: AI triage session GET ────────────────────────────────────────────

  it("writes AI_TRIAGE_SESSION_READ audit on GET /ai/triage/:sessionId", async () => {
    // Start a session first (via the POST path) so we have a real sessionId.
    const start = await request(app)
      .post("/api/v1/ai/triage/start")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ consentGiven: true, language: "en", inputMode: "text" });
    expect(start.status).toBe(200);
    const sessionId: string = start.body.data.sessionId;

    await clearAuditFor("AI_TRIAGE_SESSION_READ");

    const res = await request(app)
      .get(`/api/v1/ai/triage/${sessionId}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);

    const rows = await findAudit("AI_TRIAGE_SESSION_READ", sessionId);
    expect(rows.length).toBe(1);
    expect(rows[0].entity).toBe("AITriageSession");
    const details = rows[0].details as any;
    // Must include status; must NOT include the conversation content (PHI).
    expect(details.status).toBeTruthy();
    expect(JSON.stringify(details)).not.toContain("Hello!");
  });

  // ── 3: AI scribe SOAP read ──────────────────────────────────────────────

  it("writes AI_SCRIBE_READ audit on GET /ai/scribe/:sessionId/soap", async () => {
    const patient = await createPatientFixture();
    const { doctor, token } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });

    // Create a scribe session directly via Prisma — avoids running the full
    // /start flow, which we already cover in ai-scribe.test.ts.
    const prisma = await getPrisma();
    const session = await prisma.aIScribeSession.create({
      data: {
        appointmentId: appt.id,
        doctorId: doctor.id,
        patientId: patient.id,
        consentObtained: true,
        consentAt: new Date(),
        modelVersion: "claude-sonnet-4-6",
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/scribe/${session.id}/soap`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);

    const rows = await findAudit("AI_SCRIBE_READ", session.id);
    expect(rows.length).toBe(1);
    expect(rows[0].entity).toBe("AIScribeSession");
    const details = rows[0].details as any;
    expect(typeof details.hasSoapFinal).toBe("boolean");
    // Must not leak transcript/SOAP content.
    expect(JSON.stringify(details)).not.toMatch(/Cough|fever|chief[Cc]omplaint/);
  });

  // ── 4: no-show batch with resultCount ───────────────────────────────────

  it("writes AI_NO_SHOW_BATCH audit with resultCount on GET /no-show/batch", async () => {
    // Seed 2 appointments on a specific date so the batch endpoint returns > 0.
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const date = new Date("2026-06-01");
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { date, status: "BOOKED" },
    });
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { date, status: "BOOKED" },
    });

    const res = await request(app)
      .get("/api/v1/ai/predictions/no-show/batch?date=2026-06-01")
      .set("Authorization", `Bearer ${receptionToken}`);

    expect(res.status).toBe(200);

    const rows = await findAudit("AI_NO_SHOW_BATCH");
    expect(rows.length).toBe(1);
    expect(rows[0].entity).toBe("Appointment");
    const details = rows[0].details as any;
    expect(details.date).toBe("2026-06-01");
    expect(typeof details.resultCount).toBe("number");
    // resultCount should mirror the seeded appointments we actually returned.
    expect(details.resultCount).toBeGreaterThanOrEqual(2);
  });

  // ── 5: FHIR Patient search must not leak param values ───────────────────

  it("FHIR_SEARCH_PATIENT audit logs redacted params (no identifier value leak)", async () => {
    const secretId = "SECRET-IDENTIFIER-1234";
    const secretFamily = "PrivateFamilyName";

    const res = await request(app)
      .get(`/api/v1/fhir/Patient?identifier=${secretId}&family=${secretFamily}&_count=5`)
      .set("Authorization", `Bearer ${doctorToken}`);

    // We don't care if the search returned 0 or 200 — only that it produced
    // an audit row that did NOT contain the raw identifier value.
    expect([200, 400]).toContain(res.status);

    const rows = await findAudit("FHIR_SEARCH_PATIENT");
    // When the request produced a 200, we expect an audit row.
    if (res.status === 200) {
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const details = rows[0].details as any;
      const stringified = JSON.stringify(details);
      expect(stringified).not.toContain(secretId);
      expect(stringified).not.toContain(secretFamily);
      // Param *names* should be present with hasValue booleans.
      expect(details.params.identifier).toEqual({ hasValue: true });
      expect(details.params.family).toEqual({ hasValue: true });
      expect(typeof details.resultCount).toBe("number");
    }
  });

  // ── 6: Insurance claims list audit with resultCount ─────────────────────

  it("writes INSURANCE_CLAIMS_LIST audit on GET /api/v1/claims with filters + resultCount", async () => {
    const res = await request(app)
      .get("/api/v1/claims?status=SUBMITTED")
      .set("Authorization", `Bearer ${adminToken}`);

    // Route must at least be reachable (200 or even 200 with empty list).
    expect(res.status).toBe(200);

    const rows = await findAudit("INSURANCE_CLAIMS_LIST");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.entity).toBe("insurance_claim");
    const details = row.details as any;
    expect(details.status).toBe("SUBMITTED");
    expect(typeof details.resultCount).toBe("number");
  });

  // ── 7: audit write failure must not break the response ──────────────────
  //
  // We spy on `auditLog` to throw, then hit the FHIR search endpoint. The
  // response must still be 200 (or 400 for a validation error) — NOT 500.

  it("response still succeeds when the audit write rejects (best-effort)", async () => {
    const auditMod = await import("../../middleware/audit");
    const spy = vi
      .spyOn(auditMod, "auditLog")
      .mockRejectedValueOnce(new Error("simulated audit DB outage"));

    try {
      const res = await request(app)
        .get("/api/v1/ai/predictions/no-show/batch?date=2026-06-02")
        .set("Authorization", `Bearer ${receptionToken}`);

      // The endpoint short-circuits to [] when no appointments match — that
      // path also calls auditLog via safeAudit. Must not 500.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
