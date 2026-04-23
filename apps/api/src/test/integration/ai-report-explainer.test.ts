// Integration tests for the AI Report Explainer router (/api/v1/ai/reports).
// report-explainer service and notification sender are mocked.
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

const MOCK_EXPLAIN_RESULT = {
  explanation:
    "Your haemoglobin is slightly below the normal range. This may indicate mild anaemia. Please discuss these results with your doctor.",
  flaggedValues: [
    {
      parameter: "Hemoglobin",
      value: "11.2",
      flag: "LOW",
      plainLanguage: "Your blood's iron-carrying capacity is a bit low.",
    },
  ],
};

vi.mock("../../services/ai/report-explainer", () => ({
  explainLabReport: vi.fn().mockResolvedValue(MOCK_EXPLAIN_RESULT),
}));

vi.mock("../../services/notification", () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

let app: any;
let adminToken: string;
let doctorToken: string;
let patientToken: string;

// Helper: build a lab order with completed results
async function setupLabOrderWithResults(): Promise<{
  patientId: string;
  patientUserId: string;
  labOrderId: string;
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
  await prisma.labResult.create({
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

  return { patientId: patient.id, patientUserId: patient.userId, labOrderId: order.id };
}

describeIfDB("AI Report Explainer API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /explain ────────────────────────────────────────────────────

  it("generates an AI explanation for a lab order with results", async () => {
    const { explainLabReport } = await import("../../services/ai/report-explainer");
    vi.mocked(explainLabReport).mockClear();

    const { labOrderId } = await setupLabOrderWithResults();

    const res = await request(app)
      .post("/api/v1/ai/reports/explain")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ labOrderId, language: "en" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.labOrderId).toBe(labOrderId);
    expect(res.body.data.explanation).toContain("haemoglobin");
    expect(res.body.data.status).toBe("PENDING_REVIEW");
    expect(Array.isArray(res.body.data.flaggedValues)).toBe(true);
    expect(vi.mocked(explainLabReport)).toHaveBeenCalledOnce();
  });

  it("returns 400 when labOrderId is missing", async () => {
    const res = await request(app)
      .post("/api/v1/ai/reports/explain")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ language: "en" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/labOrderId/);
  });

  it("returns 404 when labOrder does not exist", async () => {
    const res = await request(app)
      .post("/api/v1/ai/reports/explain")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ labOrderId: "00000000-0000-0000-0000-000000000000" });

    expect(res.status).toBe(404);
  });

  it("returns 400 when the lab order has no results", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });

    const res = await request(app)
      .post("/api/v1/ai/reports/explain")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ labOrderId: order.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no lab results/i);
  });

  it("requires authentication for POST /explain", async () => {
    const res = await request(app)
      .post("/api/v1/ai/reports/explain")
      .send({ labOrderId: "x" });
    expect(res.status).toBe(401);
  });

  it("upserts the explanation — second call updates the existing record", async () => {
    const { labOrderId } = await setupLabOrderWithResults();

    const first = await request(app)
      .post("/api/v1/ai/reports/explain")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ labOrderId });
    const second = await request(app)
      .post("/api/v1/ai/reports/explain")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ labOrderId, language: "hi" });

    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.language).toBe("hi");
    expect(second.body.data.status).toBe("PENDING_REVIEW");
  });

  // ─── PATCH /:explanationId/approve ────────────────────────────────────

  it("approves an explanation, sends notification, and marks as SENT", async () => {
    const { sendNotification } = await import("../../services/notification");
    vi.mocked(sendNotification).mockClear();

    const { labOrderId } = await setupLabOrderWithResults();

    const createRes = await request(app)
      .post("/api/v1/ai/reports/explain")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ labOrderId });
    const explanationId = createRes.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/ai/reports/${explanationId}/approve`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("SENT");
    expect(res.body.data.approvedBy).toBeTruthy();
    expect(res.body.data.sentAt).toBeTruthy();
    expect(vi.mocked(sendNotification)).toHaveBeenCalledOnce();
  });

  it("rejects PATIENT role on approve (403)", async () => {
    const res = await request(app)
      .patch("/api/v1/ai/reports/some-id/approve")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({});

    expect(res.status).toBe(403);
  });

  // ─── GET /pending ─────────────────────────────────────────────────────

  it("lists PENDING_REVIEW explanations for DOCTOR/ADMIN", async () => {
    // Reset so the previous test's SENT record is gone? No — just assert pending returns only PENDING.
    const { labOrderId } = await setupLabOrderWithResults();

    await request(app)
      .post("/api/v1/ai/reports/explain")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ labOrderId });

    const res = await request(app)
      .get("/api/v1/ai/reports/pending")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((r: any) => r.status === "PENDING_REVIEW")).toBe(true);
  });

  it("rejects PATIENT role on GET /pending (403)", async () => {
    const res = await request(app)
      .get("/api/v1/ai/reports/pending")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // ─── GET /:labOrderId ─────────────────────────────────────────────────

  it("returns 404 for GET explanation by labOrderId when none exists", async () => {
    const res = await request(app)
      .get("/api/v1/ai/reports/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(404);
  });

  it("fetches an explanation as the owning patient", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const { labOrderId, patientUserId } = await setupLabOrderWithResults();

    await request(app)
      .post("/api/v1/ai/reports/explain")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ labOrderId });

    const prisma = await getPrisma();
    const pUser = await prisma.user.findUnique({ where: { id: patientUserId } });
    const ownToken = jwt.sign(
      { userId: pUser!.id, email: pUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get(`/api/v1/ai/reports/${labOrderId}`)
      .set("Authorization", `Bearer ${ownToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.labOrderId).toBe(labOrderId);
  });

  it("forbids a different PATIENT from viewing someone else's explanation (403)", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const { labOrderId } = await setupLabOrderWithResults();

    await request(app)
      .post("/api/v1/ai/reports/explain")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ labOrderId });

    // Different patient
    const intruder = await createPatientFixture();
    const prisma = await getPrisma();
    const intruderUser = await prisma.user.findUnique({ where: { id: intruder.userId } });
    const intruderToken = jwt.sign(
      { userId: intruderUser!.id, email: intruderUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get(`/api/v1/ai/reports/${labOrderId}`)
      .set("Authorization", `Bearer ${intruderToken}`);

    expect(res.status).toBe(403);
  });

  it("requires authentication for GET /:labOrderId", async () => {
    const res = await request(app).get("/api/v1/ai/reports/whatever");
    expect(res.status).toBe(401);
  });
});
