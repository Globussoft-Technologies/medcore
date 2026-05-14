// Integration tests for the AI Differential Diagnosis router (/api/v1/ai/differential).
// differential service is mocked — no SARVAM_API_KEY required.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import { createPatientFixture } from "../factories";

const MOCK_DIFFERENTIAL = {
  differentials: [
    {
      diagnosis: "Community-acquired pneumonia",
      icd10: "J18.9",
      probability: "high",
      reasoning: "Productive cough, fever, and focal crackles suggest CAP.",
      recommendedTests: ["CXR", "CBC", "Sputum culture"],
      redFlags: ["RR > 30", "SpO2 < 92%"],
    },
    {
      diagnosis: "Acute bronchitis",
      icd10: "J20.9",
      probability: "medium",
      reasoning: "Could also present with cough and fever without infiltrate.",
      recommendedTests: ["Clinical observation"],
      redFlags: [],
    },
  ],
  guidelineReferences: ["NICE NG138", "IDSA 2019"],
};

vi.mock("../../services/ai/differential", () => ({
  analyzeDifferential: vi.fn().mockResolvedValue(MOCK_DIFFERENTIAL),
}));

let app: any;
let doctorToken: string;
let adminToken: string;
let patientToken: string;

describeIfDB("AI Differential Diagnosis API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("returns ranked differentials for a doctor given a patient + complaint", async () => {
    const { analyzeDifferential } = await import("../../services/ai/differential");
    vi.mocked(analyzeDifferential).mockClear();

    const patient = await createPatientFixture({ age: 52, gender: "MALE" });

    const res = await request(app)
      .post("/api/v1/ai/differential")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        chiefComplaint: "Productive cough and fever for 3 days",
        vitals: { temp: 38.6, pulse: 96, spo2: 94, rr: 22 },
        relevantHistory: "Smoker, no prior hospitalisations",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.differentials)).toBe(true);
    expect(res.body.data.differentials.length).toBeGreaterThan(0);
    expect(res.body.data.differentials[0].probability).toBe("high");
    expect(res.body.data.guidelineReferences).toContain("NICE NG138");
    expect(vi.mocked(analyzeDifferential)).toHaveBeenCalledOnce();
    const call = vi.mocked(analyzeDifferential).mock.calls[0][0];
    expect(call.chiefComplaint).toContain("Productive cough");
    expect(call.vitals?.spo2).toBe(94);
  });

  it("returns 400 when chiefComplaint is missing", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ai/differential")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ patientId: patient.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chiefComplaint/);
  });

  it("returns 400 when patientId is missing", async () => {
    const res = await request(app)
      .post("/api/v1/ai/differential")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ chiefComplaint: "Headache" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/patientId/);
  });

  it("returns 404 for unknown patientId", async () => {
    const res = await request(app)
      .post("/api/v1/ai/differential")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: "550e8400-e29b-41d4-a716-446655440000",
        chiefComplaint: "Fever",
      });
    expect(res.status).toBe(404);
  });

  it("rejects PATIENT role (403)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ai/differential")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Cough" });
    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/v1/ai/differential")
      .send({ patientId: "x", chiefComplaint: "Cough" });
    expect(res.status).toBe(401);
  });

  it("passes patient allergies and chronic conditions into the service call", async () => {
    const { analyzeDifferential } = await import("../../services/ai/differential");
    vi.mocked(analyzeDifferential).mockClear();

    const patient = await createPatientFixture({ age: 62, gender: "FEMALE" });
    const { getPrisma } = await import("../setup");
    const prisma = await getPrisma();
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    await prisma.patientAllergy.create({
      data: { patientId: patient.id, allergen: "Penicillin", notedBy: admin!.id },
    });
    await prisma.chronicCondition.create({
      data: { patientId: patient.id, condition: "Hypertension" },
    });

    await request(app)
      .post("/api/v1/ai/differential")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        chiefComplaint: "Chest discomfort",
      });

    expect(vi.mocked(analyzeDifferential)).toHaveBeenCalledOnce();
    const call = vi.mocked(analyzeDifferential).mock.calls[0][0];
    expect(call.allergies).toContain("Penicillin");
    expect(call.chronicConditions).toContain("Hypertension");
  });
});
