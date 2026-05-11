// Integration tests for the Lab Result Intelligence router (/api/v1/ai/lab-intel).
// lab-intel service is mocked — no SARVAM_API_KEY required.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createLabTestFixture,
  createLabOrderFixture,
} from "../factories";

const MOCK_INTEL = {
  interpretation:
    "Hemoglobin is mildly below the reference range, consistent with early iron-deficiency anaemia.",
  trend: "worsening",
  baselineComparison: "Down from 12.4 g/dL one month ago.",
  recommendedActions: [
    "Order iron panel (ferritin, serum iron, TIBC)",
    "Consider oral iron replacement",
  ],
  urgency: "soon",
};

vi.mock("../../services/ai/lab-intel", () => ({
  analyzeLabResult: vi.fn().mockResolvedValue(MOCK_INTEL),
}));

let app: any;
let doctorToken: string;
let adminToken: string;
let patientToken: string;

async function setupLabResult(): Promise<{
  labResultId: string;
}> {
  const prisma = await getPrisma();
  const patient = await createPatientFixture({ age: 35, gender: "FEMALE" });
  const { doctor } = await createDoctorWithToken();
  const test = await createLabTestFixture();
  const order = await createLabOrderFixture({
    patientId: patient.id,
    doctorId: doctor.id,
    testIds: [test.id],
  });
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  const result = await prisma.labResult.create({
    data: {
      orderItemId: order.items[0].id,
      parameter: "Hemoglobin",
      value: "11.2",
      unit: "g/dL",
      normalRange: "13-17",
      flag: "LOW",
      enteredBy: admin!.id,
    },
  });
  return { labResultId: result.id };
}

describeIfDB("AI Lab Intelligence API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── GET /:labResultId ────────────────────────────────────────────────

  it("returns AI analysis for a lab result", async () => {
    const { analyzeLabResult } = await import("../../services/ai/lab-intel");
    vi.mocked(analyzeLabResult).mockClear();

    const { labResultId } = await setupLabResult();

    const res = await request(app)
      .get(`/api/v1/ai/lab-intel/${labResultId}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.analysis.trend).toBe("worsening");
    expect(res.body.data.analysis.urgency).toBe("soon");
    expect(res.body.data.analysis.recommendedActions.length).toBeGreaterThan(0);
    expect(vi.mocked(analyzeLabResult)).toHaveBeenCalledOnce();
  });

  it("returns 404 for an unknown lab result", async () => {
    const res = await request(app)
      .get(`/api/v1/ai/lab-intel/550e8400-e29b-41d4-a716-446655440000`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects PATIENT role (403)", async () => {
    const { labResultId } = await setupLabResult();
    const res = await request(app)
      .get(`/api/v1/ai/lab-intel/${labResultId}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    const res = await request(app).get(`/api/v1/ai/lab-intel/whatever`);
    expect(res.status).toBe(401);
  });

  // ─── POST /:labResultId/persist ───────────────────────────────────────

  it("persists the AI analysis to the lab result notes", async () => {
    const { labResultId } = await setupLabResult();

    const res = await request(app)
      .post(`/api/v1/ai/lab-intel/${labResultId}/persist`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.labResultId).toBe(labResultId);
    expect(res.body.data.analysis.urgency).toBe("soon");
    expect(res.body.data.persistedAt).toBeTruthy();

    const prisma = await getPrisma();
    const updated = await prisma.labResult.findUnique({ where: { id: labResultId } });
    expect(updated!.notes).toContain("[AI_INTEL]");
    expect(updated!.notes).toContain("worsening");
  });

  it("persists a caller-supplied analysis payload without recomputing", async () => {
    const { analyzeLabResult } = await import("../../services/ai/lab-intel");
    vi.mocked(analyzeLabResult).mockClear();
    const { labResultId } = await setupLabResult();

    const custom = {
      interpretation: "Custom note",
      trend: "stable",
      baselineComparison: "Flat line",
      recommendedActions: ["Recheck in 3 months"],
      urgency: "routine",
    };
    const res = await request(app)
      .post(`/api/v1/ai/lab-intel/${labResultId}/persist`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ analysis: custom });

    expect(res.status).toBe(201);
    expect(res.body.data.analysis.interpretation).toBe("Custom note");
    // analyzer must NOT have been called because caller supplied analysis
    expect(vi.mocked(analyzeLabResult)).not.toHaveBeenCalled();
  });

  it("returns 404 when persisting against an unknown lab result", async () => {
    const res = await request(app)
      .post(`/api/v1/ai/lab-intel/550e8400-e29b-41d4-a716-446655440000/persist`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("rejects PATIENT role on persist (403)", async () => {
    const { labResultId } = await setupLabResult();
    const res = await request(app)
      .post(`/api/v1/ai/lab-intel/${labResultId}/persist`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({});
    expect(res.status).toBe(403);
  });
});
