// Integration tests for the AI ER Triage router (/api/v1/ai/er-triage).
// er-triage service is mocked — no SARVAM_API_KEY required.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

const MOCK_ASSESSMENT = {
  suggestedTriageLevel: 2,
  triageLevelLabel: "Emergent",
  disposition: "Treatment room",
  immediateActions: ["ECG", "IV access", "Cardiac monitoring"],
  suggestedInvestigations: ["Troponin", "CBC", "BMP"],
  redFlags: ["radiating chest pain"],
  calculatedMEWS: 4,
  aiReasoning: "Possible acute coronary syndrome — requires urgent work-up.",
  disclaimer:
    "AI-assisted triage suggestion only. Final triage decision must be made by a qualified nurse or physician.",
};

vi.mock("../../services/ai/er-triage", () => ({
  assessERPatient: vi.fn().mockResolvedValue(MOCK_ASSESSMENT),
  calculateMEWS: vi.fn().mockReturnValue(4),
}));

let app: any;
let doctorToken: string;
let nurseToken: string;
let adminToken: string;
let patientToken: string;
let receptionToken: string;

describeIfDB("AI ER Triage API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /assess (ad-hoc, no case) ───────────────────────────────────

  it("assesses an ad-hoc ER patient with vitals and returns ESI assessment", async () => {
    const { assessERPatient } = await import("../../services/ai/er-triage");
    vi.mocked(assessERPatient).mockClear();

    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        chiefComplaint: "Chest pain radiating to left arm",
        vitals: { bp: "90/60", pulse: 120, resp: 24, spO2: 94, temp: 37.1, gcs: 15 },
        patientAge: 55,
        patientGender: "MALE",
        briefHistory: "Smoker, hypertensive",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.suggestedTriageLevel).toBe(2);
    expect(res.body.data.triageLevelLabel).toBe("Emergent");
    expect(res.body.data.disclaimer).toBeTruthy();
    expect(vi.mocked(assessERPatient)).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(assessERPatient).mock.calls[0][0];
    expect(callArgs.chiefComplaint).toBe("Chest pain radiating to left arm");
    expect(callArgs.vitals.pulse).toBe(120);
  });

  it("accepts an assessment with no vitals (uses empty vitals object)", async () => {
    const { assessERPatient } = await import("../../services/ai/er-triage");
    vi.mocked(assessERPatient).mockClear();

    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ chiefComplaint: "Headache" });

    expect(res.status).toBe(200);
    const callArgs = vi.mocked(assessERPatient).mock.calls[0][0];
    expect(callArgs.vitals).toEqual({});
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .send({ chiefComplaint: "Headache" });

    expect(res.status).toBe(401);
  });

  it("rejects PATIENT role (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ chiefComplaint: "Chest pain" });

    expect(res.status).toBe(403);
  });

  it("rejects RECEPTION role (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ chiefComplaint: "Chest pain" });

    expect(res.status).toBe(403);
  });

  it("returns 400 when chiefComplaint is missing", async () => {
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ vitals: { bp: "120/80" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chiefComplaint/i);
  });

  it("returns 400 when chiefComplaint is an empty string", async () => {
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ chiefComplaint: "   " });

    expect(res.status).toBe(400);
  });

  // ─── POST /:caseId/assess (against existing EmergencyCase) ────────────

  it("assesses an existing EmergencyCase and persists MEWS score", async () => {
    const { assessERPatient } = await import("../../services/ai/er-triage");
    vi.mocked(assessERPatient).mockClear();

    const prisma = await getPrisma();
    const patient = await createPatientFixture({ gender: "MALE" });
    const emergencyCase = await prisma.emergencyCase.create({
      data: {
        caseNumber: `EC${Date.now()}`,
        patientId: patient.id,
        chiefComplaint: "Severe breathlessness",
        vitalsBP: "150/90",
        vitalsPulse: 130,
        vitalsResp: 28,
        vitalsSpO2: 88,
        vitalsTemp: 38.5,
        glasgowComa: 14,
        status: "WAITING",
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/er-triage/${emergencyCase.id}/assess`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.calculatedMEWS).toBe(4);
    expect(vi.mocked(assessERPatient)).toHaveBeenCalledOnce();

    // MEWS should have been persisted to the EmergencyCase
    const updated = await prisma.emergencyCase.findUnique({ where: { id: emergencyCase.id } });
    expect(updated?.mewsScore).toBe(4);
  });

  it("returns 404 for unknown emergency case", async () => {
    const res = await request(app)
      .post("/api/v1/ai/er-triage/00000000-0000-0000-0000-000000000000/assess")
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("rejects NURSE role on POST /:caseId/assess (only DOCTOR/ADMIN allowed)", async () => {
    const prisma = await getPrisma();
    const ec = await prisma.emergencyCase.create({
      data: {
        caseNumber: `EC${Date.now()}_n`,
        chiefComplaint: "Abdominal pain",
        status: "WAITING",
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/er-triage/${ec.id}/assess`)
      .set("Authorization", `Bearer ${nurseToken}`);

    expect(res.status).toBe(403);
  });

  it("allows ADMIN role on POST /:caseId/assess", async () => {
    const prisma = await getPrisma();
    const ec = await prisma.emergencyCase.create({
      data: {
        caseNumber: `EC${Date.now()}_a`,
        chiefComplaint: "Fall with head injury",
        status: "WAITING",
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/er-triage/${ec.id}/assess`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.suggestedTriageLevel).toBe(2);
  });

  it("derives patient age from DOB on existing case assessment", async () => {
    const { assessERPatient } = await import("../../services/ai/er-triage");
    vi.mocked(assessERPatient).mockClear();

    const prisma = await getPrisma();
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 45);
    const patient = await createPatientFixture({ dateOfBirth: dob, gender: "FEMALE" });

    const ec = await prisma.emergencyCase.create({
      data: {
        caseNumber: `EC${Date.now()}_age`,
        patientId: patient.id,
        chiefComplaint: "Dizziness",
        status: "WAITING",
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/er-triage/${ec.id}/assess`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    const callArgs = vi.mocked(assessERPatient).mock.calls[0][0];
    // 44 or 45 depending on exact DOB math
    expect(callArgs.patientAge).toBeGreaterThanOrEqual(44);
    expect(callArgs.patientAge).toBeLessThanOrEqual(45);
    expect(callArgs.patientGender).toBe("FEMALE");
  });

  // ─── security(2026-04-24): F-ER-3 — audit logs on AI inference ────────

  it("emits an AI_ER_TRIAGE_ASSESS audit entry on the ad-hoc assess endpoint", async () => {
    const prisma = await getPrisma();
    // Snapshot the audit tail *before* the call so we can scope our assertion.
    const beforeCount = await prisma.auditLog.count({
      where: { action: "AI_ER_TRIAGE_ASSESS" },
    });

    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        chiefComplaint: "Severe headache with neck stiffness",
        vitals: { bp: "150/95", pulse: 100, resp: 20, spO2: 97, temp: 38.2, gcs: 15 },
        patientAge: 40,
      });

    expect(res.status).toBe(200);

    // Audit write is fire-and-forget — give the microtask queue a beat to flush.
    await new Promise((r) => setTimeout(r, 50));

    const afterCount = await prisma.auditLog.count({
      where: { action: "AI_ER_TRIAGE_ASSESS" },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);

    const latest = await prisma.auditLog.findFirst({
      where: { action: "AI_ER_TRIAGE_ASSESS" },
      orderBy: { createdAt: "desc" },
    });
    expect(latest).toBeTruthy();
    expect(latest.entity).toBe("EmergencyCase");
    // The details JSON must carry the triageLevel + mews but NOT raw PHI.
    const details = latest.details as Record<string, any>;
    expect(details.triageLevel).toBe(2);
    expect(details.mews).toBe(4);
    expect(typeof details.chiefComplaintPreview).toBe("string");
    // Preview must be truncated (<= 100 chars).
    expect(details.chiefComplaintPreview.length).toBeLessThanOrEqual(100);
  });

  it("emits an AI_ER_TRIAGE_CASE_ASSESS audit entry that pins the EmergencyCase id", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture({ gender: "MALE" });
    const ec = await prisma.emergencyCase.create({
      data: {
        caseNumber: `EC${Date.now()}_audit`,
        patientId: patient.id,
        chiefComplaint: "Fall from height",
        vitalsBP: "110/70",
        vitalsPulse: 95,
        status: "WAITING",
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/er-triage/${ec.id}/assess`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const latest = await prisma.auditLog.findFirst({
      where: { action: "AI_ER_TRIAGE_CASE_ASSESS", entityId: ec.id },
      orderBy: { createdAt: "desc" },
    });
    expect(latest).toBeTruthy();
    expect(latest.entityId).toBe(ec.id);
    const details = latest.details as Record<string, any>;
    expect(details.triageLevel).toBe(2);
    expect(details.mewsWrittenBack).toBe(true);
  });
});
