// Integration tests for the AI Radiology router (/api/v1/ai/radiology).
//
// The Sarvam `generateStructured` call is mocked via the radiology-reports
// service mock so no live LLM is required. The test mounts the router into
// a test-only Express instance because app.ts registration is deliberately
// out of scope for this pass.
//
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture, createDoctorWithToken } from "../factories";

// Mock the service so we don't depend on Sarvam. The route imports these
// named exports — the mock keeps the signatures identical and persists via
// the real Prisma when the test DB has the models.
vi.mock("../../services/ai/radiology-reports", async (importActual) => {
  const actual = await importActual<typeof import("../../services/ai/radiology-reports")>();
  return {
    ...actual,
    // Override the LLM call only; createStudy / createReportDraft /
    // approveReport / amendReport still use Prisma via the real service.
    generateDraftReport: vi.fn().mockResolvedValue({
      impression:
        "No acute abnormality detected on the provided views. Review with radiologist.",
      findings: [
        {
          description: "Mild degenerative changes at L4-L5",
          confidence: "medium" as const,
          suggestedFollowUp: "Clinical correlation",
        },
      ],
      recommendations: ["Compare with prior studies if available"],
    }),
  };
});

async function buildTestApp(): Promise<express.Express> {
  const a = express();
  a.use(express.json({ limit: "25mb" }));
  const { aiRadiologyRouter } = await import("../../routes/ai-radiology");
  a.use("/api/v1/ai/radiology", aiRadiologyRouter);
  const { errorHandler } = await import("../../middleware/error");
  a.use(errorHandler);
  return a;
}

let app: express.Express;
let adminToken: string;
let patientToken: string;
let prisma: any;
let schemaReady = false;

describeIfDB("AI Radiology API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    prisma = await getPrisma();
    app = await buildTestApp();

    if (!(prisma as any).radiologyStudy || !(prisma as any).radiologyReport) {
      // eslint-disable-next-line no-console
      console.warn(
        "[ai-radiology.test] RadiologyStudy / RadiologyReport not yet migrated — skipping suite."
      );
      schemaReady = false;
      return;
    }
    schemaReady = true;
  });

  afterEach(async () => {
    if (!schemaReady) return;
    await (prisma as any).radiologyReport.deleteMany({});
    await (prisma as any).radiologyStudy.deleteMany({});
  });

  // ── 1: POST /studies happy path ────────────────────────────────────────────
  it("creates a radiology study (DOCTOR happy path)", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture();
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .post("/api/v1/ai/radiology/studies")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        modality: "XRAY",
        bodyPart: "Chest",
        imageKeys: ["uploads/ehr/test-chest-xray.jpg"],
        notes: "Cough x3 days, productive",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.modality).toBe("XRAY");
    expect(res.body.data.bodyPart).toBe("Chest");
    expect(Array.isArray(res.body.data.images)).toBe(true);
    expect(res.body.data.images[0].key).toBe("uploads/ehr/test-chest-xray.jpg");
  });

  // ── 2: POST /studies forbidden for PATIENT ─────────────────────────────────
  it("rejects PATIENT role for POST /studies (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/radiology/studies")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        patientId: "x",
        modality: "XRAY",
        bodyPart: "Chest",
        imageKeys: ["k"],
      });

    expect(res.status).toBe(403);
  });

  // ── 3: POST /:studyId/draft uses the mocked Sarvam call ───────────────────
  it("generates an AI draft for a study (mocked Sarvam)", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture();
    const { token: doctorToken } = await createDoctorWithToken();

    const studyRes = await request(app)
      .post("/api/v1/ai/radiology/studies")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        modality: "MRI",
        bodyPart: "Lumbar Spine",
        imageKeys: ["uploads/ehr/test-mri-1.jpg"],
        notes: "Low back pain",
      });
    expect(studyRes.status).toBe(201);
    const studyId = studyRes.body.data.id;

    const draftRes = await request(app)
      .post(`/api/v1/ai/radiology/${studyId}/draft`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});

    expect(draftRes.status).toBe(201);
    expect(draftRes.body.success).toBe(true);
    expect(draftRes.body.data.status).toBe("DRAFT");
    expect(draftRes.body.data.aiImpression).toMatch(/radiologist/i);
    expect(Array.isArray(draftRes.body.data.aiFindings)).toBe(true);
    expect(draftRes.body.data.aiFindings.length).toBeGreaterThan(0);

    // Assert the mock was hit
    const { generateDraftReport } = await import("../../services/ai/radiology-reports");
    expect(vi.mocked(generateDraftReport)).toHaveBeenCalled();
  });

  // ── 4: POST /:reportId/approve flips status to FINAL ──────────────────────
  it("approves a DRAFT report → FINAL with radiologist edits", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture();
    const { token: doctorToken } = await createDoctorWithToken();

    const studyRes = await request(app)
      .post("/api/v1/ai/radiology/studies")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        modality: "CT",
        bodyPart: "Abdomen",
        imageKeys: ["uploads/ehr/ct-abd.jpg"],
      });
    const { id: studyId } = studyRes.body.data;
    const draftRes = await request(app)
      .post(`/api/v1/ai/radiology/${studyId}/draft`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    const { id: reportId } = draftRes.body.data;

    const approveRes = await request(app)
      .post(`/api/v1/ai/radiology/${reportId}/approve`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        finalReport:
          "CT ABDOMEN\n\nTechnique: axial, 5mm.\nFindings: No acute abnormality.\nImpression: Negative study.",
        finalImpression: "Negative study.",
      });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe("FINAL");
    expect(approveRes.body.data.approvedAt).toBeTruthy();
    expect(approveRes.body.data.approvedBy).toBeTruthy();
    expect(approveRes.body.data.finalReport).toContain("CT ABDOMEN");
  });

  // ── 5: POST /:reportId/amend flips FINAL → AMENDED ────────────────────────
  it("amends a FINAL report → AMENDED", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture();
    const { token: doctorToken } = await createDoctorWithToken();

    const studyRes = await request(app)
      .post("/api/v1/ai/radiology/studies")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        modality: "XRAY",
        bodyPart: "Left Knee",
        imageKeys: ["uploads/ehr/knee.jpg"],
      });
    const { id: studyId } = studyRes.body.data;
    const draftRes = await request(app)
      .post(`/api/v1/ai/radiology/${studyId}/draft`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    const { id: reportId } = draftRes.body.data;
    await request(app)
      .post(`/api/v1/ai/radiology/${reportId}/approve`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        finalReport: "Initial final report text — normal study.",
      });

    const amendRes = await request(app)
      .post(`/api/v1/ai/radiology/${reportId}/amend`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        finalReport:
          "AMENDMENT: On re-review, subtle effusion noted in the suprapatellar recess.",
      });

    expect(amendRes.status).toBe(200);
    expect(amendRes.body.data.status).toBe("AMENDED");
    expect(amendRes.body.data.finalReport).toContain("AMENDMENT");
    // approvedAt of original finalisation is preserved
    expect(amendRes.body.data.approvedAt).toBeTruthy();
  });

  // ── 6: GET /pending-review lists DRAFT + RADIOLOGIST_REVIEW ────────────────
  it("lists pending-review reports (DRAFT + RADIOLOGIST_REVIEW only)", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture();
    const { token: doctorToken } = await createDoctorWithToken();

    // Create 2 studies + 2 drafts, approve one.
    for (let i = 0; i < 2; i++) {
      const sRes = await request(app)
        .post("/api/v1/ai/radiology/studies")
        .set("Authorization", `Bearer ${doctorToken}`)
        .send({
          patientId: patient.id,
          modality: "XRAY",
          bodyPart: `Region ${i}`,
          imageKeys: [`uploads/ehr/s${i}.jpg`],
        });
      const dRes = await request(app)
        .post(`/api/v1/ai/radiology/${sRes.body.data.id}/draft`)
        .set("Authorization", `Bearer ${doctorToken}`)
        .send({});
      if (i === 0) {
        await request(app)
          .post(`/api/v1/ai/radiology/${dRes.body.data.id}/approve`)
          .set("Authorization", `Bearer ${doctorToken}`)
          .send({
            finalReport: "Final report body text, region zero, no acute findings.",
          });
      }
    }

    const listRes = await request(app)
      .get("/api/v1/ai/radiology/pending-review")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data)).toBe(true);
    // Only the un-approved one should be in the pending queue
    expect(listRes.body.data.length).toBe(1);
    expect(["DRAFT", "RADIOLOGIST_REVIEW"]).toContain(
      listRes.body.data[0].status
    );
  });

  // ── 7: GET /studies/:studyId returns study + report ───────────────────────
  it("GET /studies/:studyId returns study with its report", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture();
    const { token: doctorToken } = await createDoctorWithToken();

    const sRes = await request(app)
      .post("/api/v1/ai/radiology/studies")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        modality: "ULTRASOUND",
        bodyPart: "Right Upper Quadrant",
        imageKeys: ["uploads/ehr/rug.jpg"],
      });
    await request(app)
      .post(`/api/v1/ai/radiology/${sRes.body.data.id}/draft`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});

    const getRes = await request(app)
      .get(`/api/v1/ai/radiology/studies/${sRes.body.data.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.modality).toBe("ULTRASOUND");
    expect(getRes.body.data.report).toBeTruthy();
    expect(getRes.body.data.report.status).toBe("DRAFT");
  });

  // ── 8: GET /studies/:studyId → 404 for unknown id ─────────────────────────
  it("returns 404 for unknown studyId", async () => {
    if (!schemaReady) return;
    const { token: doctorToken } = await createDoctorWithToken();
    const res = await request(app)
      .get("/api/v1/ai/radiology/studies/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(404);
  });

  // ── 9: POST /studies validation — missing fields ──────────────────────────
  it("returns 400 when required fields are missing on POST /studies", async () => {
    if (!schemaReady) return;
    const { token: doctorToken } = await createDoctorWithToken();
    const res = await request(app)
      .post("/api/v1/ai/radiology/studies")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ modality: "XRAY" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  // ── 10: POST /approve refuses to re-approve a FINAL report ────────────────
  it("refuses to approve a report that is already FINAL (409)", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture();
    const { token: doctorToken } = await createDoctorWithToken();

    const sRes = await request(app)
      .post("/api/v1/ai/radiology/studies")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        modality: "MRI",
        bodyPart: "Brain",
        imageKeys: ["uploads/ehr/brain.jpg"],
      });
    const dRes = await request(app)
      .post(`/api/v1/ai/radiology/${sRes.body.data.id}/draft`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    const reportId = dRes.body.data.id;

    await request(app)
      .post(`/api/v1/ai/radiology/${reportId}/approve`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ finalReport: "First finalisation body text." });

    const second = await request(app)
      .post(`/api/v1/ai/radiology/${reportId}/approve`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ finalReport: "Second (should be rejected) finalisation body." });

    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already/i);
  });
});
