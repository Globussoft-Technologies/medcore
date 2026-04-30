// Integration tests for emergency router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
} from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;

describeIfDB("Emergency API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("registers an emergency case for an existing patient", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        chiefComplaint: "Chest pain",
        arrivalMode: "Walk-in",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.caseNumber).toMatch(/^ER\d+/);
    expect(res.body.data?.status).toBe("WAITING");
  });

  it("registers an unknown patient emergency case", async () => {
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        unknownName: "John Doe",
        unknownAge: 45,
        unknownGender: "MALE",
        chiefComplaint: "Unresponsive",
        arrivalMode: "Ambulance",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.unknownName).toBe("John Doe");
  });

  it("rejects case without patientId AND unknownName", async () => {
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ chiefComplaint: "Collapse" });
    expect(res.status).toBe(400);
  });

  it("triages a case (sets triageLevel, triagedAt)", async () => {
    const patient = await createPatientFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Fever" });
    const caseId = createRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${caseId}/triage`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        triageLevel: "URGENT",
        vitalsBP: "130/80",
        vitalsPulse: 90,
        vitalsSpO2: 97,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.triageLevel).toBe("URGENT");
    expect(res.body.data?.triagedAt).toBeTruthy();
    expect(res.body.data?.status).toBe("TRIAGED");
  });

  it("assigns a doctor to a case", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Fracture" });
    const caseId = createRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${caseId}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ attendingDoctorId: doctor.id });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.attendingDoctorId).toBe(doctor.id);
    expect(res.body.data?.status).toBe("IN_TREATMENT");
  });

  it("computes trauma score (RTS)", async () => {
    const patient = await createPatientFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "RTA" });
    const caseId = createRes.body.data.id;
    const res = await request(app)
      .post(`/api/v1/emergency/cases/${caseId}/trauma-score`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rtsRespiratory: 4, rtsSystolic: 4, rtsGCS: 4 });
    expect([200, 201]).toContain(res.status);
  });

  it("closes a case with disposition", async () => {
    const patient = await createPatientFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Headache" });
    const caseId = createRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${caseId}/close`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "DISCHARGED", disposition: "Home", outcomeNotes: "Stable" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("DISCHARGED");
    expect(res.body.data?.closedAt).toBeTruthy();
  });

  it("lists active cases", async () => {
    const res = await request(app)
      .get("/api/v1/emergency/cases/active")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("returns stats", async () => {
    const res = await request(app)
      .get("/api/v1/emergency/stats")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/v1/emergency/cases");
    expect(res.status).toBe(401);
  });

  // Issue #424 (Apr 2026): the ER intake / close form was a stored XSS sink
  // because chiefComplaint, outcomeNotes, etc. went straight to the DB and
  // were rendered later in the chart. Schema-level refinements now reject any
  // HTML/script-shaped payload with 400 before persistence.
  it("strips <script> from chiefComplaint and stores sanitized value (issue #424)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        chiefComplaint: "<script>alert(1)</script>Severe chest pain",
        arrivalMode: "Walk-in",
      });
    expect([200, 201]).toContain(res.status);
    // Stored value must NOT contain <script> or any tag — the upstream
    // sanitize middleware strips HTML before persistence.
    const stored = res.body.data?.chiefComplaint ?? "";
    expect(stored).not.toContain("<script>");
    expect(stored).not.toMatch(/<[^>]+>/);
    // Plain-text content survives.
    expect(stored).toContain("Severe chest pain");
  });

  it("rejects HTML payload in unknownName with 400 (issue #424)", async () => {
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        unknownName: '<img src=x onerror=alert(1)>',
        chiefComplaint: "Unresponsive",
        arrivalMode: "Ambulance",
      });
    expect(res.status).toBe(400);
  });

  it("strips <script> from close-case outcomeNotes and stores sanitized value (issue #424)", async () => {
    const patient = await createPatientFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Cough" });
    const caseId = createRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${caseId}/close`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        status: "DISCHARGED",
        disposition: "Home",
        outcomeNotes: "<script>alert(1)</script>Patient discharged stable",
      });
    expect(res.status).toBe(200);
    const stored = res.body.data?.outcomeNotes ?? "";
    expect(stored).not.toContain("<script>");
    expect(stored).not.toMatch(/<[^>]+>/);
    expect(stored).toContain("Patient discharged stable");
  });

  it("accepts plain-text chiefComplaint with normal punctuation (issue #424 negative case)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        chiefComplaint: "Severe chest pain (radiating to left arm) - 2hr",
        arrivalMode: "Walk-in",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.chiefComplaint).toContain("chest pain");
  });

  // Regression: issue #5 — before the fix, a single stale WAITING case from
  // 9 days ago pushed avgWaitMin to ~13371 (9d in minutes). The stat should
  // never exceed 24h (1440 min) regardless of how stale the underlying rows
  // are: we either window to <=24h samples or cap outliers.
  it("stats.avgWaitMin stays ≤ 1440 even with stale WAITING rows (issue #5)", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();

    // Insert a stale case from 9 days ago, still WAITING — the exact shape
    // that produced the 13371-min reading in production.
    await prisma.emergencyCase.create({
      data: {
        caseNumber: `ER${Date.now()}S1`,
        patientId: patient.id,
        chiefComplaint: "Forgotten visit",
        arrivedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        status: "WAITING",
      },
    });
    // Also insert a realistic 15-minute wait so there is a valid sample.
    await prisma.emergencyCase.create({
      data: {
        caseNumber: `ER${Date.now()}S2`,
        patientId: patient.id,
        chiefComplaint: "Fresh wait",
        arrivedAt: new Date(Date.now() - 15 * 60 * 1000),
        status: "WAITING",
      },
    });

    const res = await request(app)
      .get("/api/v1/emergency/stats")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.avgWaitMin).toBeDefined();
    // 24h outlier cap — anything higher means the bug has regressed.
    expect(res.body.data.avgWaitMin).toBeLessThanOrEqual(1440);
    // And it should be dominated by the fresh 15-min sample, not the stale one.
    expect(res.body.data.avgWaitMin).toBeLessThanOrEqual(60);
  });
});
