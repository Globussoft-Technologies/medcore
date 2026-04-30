// Integration tests for the growth (pediatric) router.
//
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let nurseToken: string;
let receptionToken: string;
let patientToken: string;

describeIfDB("Growth (Pediatric) API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /growth ─────────────────────────────────────────────────
  it("POST /growth creates a record with derived BMI + percentiles (201)", async () => {
    const patient = await createPatientFixture({
      dateOfBirth: new Date("2025-01-01"),
    });
    const res = await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 12,
        weightKg: 9.6,
        heightCm: 75.7,
        headCircumference: 45,
      });
    expect(res.status).toBe(201);
    expect(res.body.data?.bmi).toBeGreaterThan(10);
    // 9.6kg at 75.7cm (the median for 12mo) → percentile near 50.
    expect(res.body.data?.weightPercentile).toBeGreaterThan(20);
    expect(res.body.data?.weightPercentile).toBeLessThan(80);
  });

  it("POST /growth 401 without auth", async () => {
    const res = await request(app).post("/api/v1/growth").send({});
    expect(res.status).toBe(401);
  });

  it("POST /growth 403 for RECEPTION (only ADMIN+DOCTOR+NURSE)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, ageMonths: 6, weightKg: 7.5 });
    expect(res.status).toBe(403);
  });

  it("POST /growth 404 for unknown patient", async () => {
    const res = await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: "00000000-0000-4000-8000-000000000000",
        ageMonths: 6,
        weightKg: 7.5,
      });
    expect(res.status).toBe(404);
  });

  it("POST /growth 400 for absurd weight (issue #435 envelope)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ patientId: patient.id, ageMonths: 12, weightKg: 999 });
    expect(res.status).toBe(400);
  });

  // ─── GET /growth/patient/:patientId ──────────────────────────────
  it("GET /growth/patient/:patientId returns ordered records", async () => {
    const patient = await createPatientFixture();
    await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ patientId: patient.id, ageMonths: 6, weightKg: 7.5 });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /growth/patient/:patientId 401 without auth", async () => {
    const res = await request(app).get(
      "/api/v1/growth/patient/00000000-0000-4000-8000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  // ─── GET /growth/patient/:patientId/chart ───────────────────────
  it("GET /growth/patient/:patientId/chart splits weight/height/headCirc series", async () => {
    const patient = await createPatientFixture();
    await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 12,
        weightKg: 9.6,
        heightCm: 75,
        headCircumference: 45,
      });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/chart`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.weight)).toBe(true);
    expect(Array.isArray(res.body.data?.height)).toBe(true);
    expect(Array.isArray(res.body.data?.headCircumference)).toBe(true);
  });

  it("GET /growth/patient/:patientId/chart 401 without auth", async () => {
    const res = await request(app).get(
      "/api/v1/growth/patient/00000000-0000-4000-8000-000000000000/chart"
    );
    expect(res.status).toBe(401);
  });

  // ─── PATCH /growth/:id ──────────────────────────────────────────
  it("PATCH /growth/:id recomputes BMI + percentiles when measurements change", async () => {
    const patient = await createPatientFixture();
    const created = await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 12,
        weightKg: 9.6,
        heightCm: 75,
      });
    const id = created.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/growth/${id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ weightKg: 10.5 });
    expect(res.status).toBe(200);
    expect(res.body.data?.weightKg).toBe(10.5);
    expect(res.body.data?.bmi).toBeGreaterThan(0);
  });

  it("PATCH /growth/:id 404 for unknown id", async () => {
    const res = await request(app)
      .patch("/api/v1/growth/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ weightKg: 11 });
    expect(res.status).toBe(404);
  });

  it("PATCH /growth/:id 401 without auth", async () => {
    const res = await request(app)
      .patch("/api/v1/growth/00000000-0000-4000-8000-000000000000")
      .send({ weightKg: 11 });
    expect(res.status).toBe(401);
  });

  it("PATCH /growth/:id 403 for RECEPTION", async () => {
    const res = await request(app)
      .patch("/api/v1/growth/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ weightKg: 11 });
    expect(res.status).toBe(403);
  });

  // ─── DELETE /growth/:id ─────────────────────────────────────────
  it("DELETE /growth/:id removes the record (200) — DOCTOR/ADMIN only", async () => {
    const patient = await createPatientFixture();
    const created = await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ patientId: patient.id, ageMonths: 6, weightKg: 7.5 });
    const id = created.body.data.id;
    const res = await request(app)
      .delete(`/api/v1/growth/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const prisma = await getPrisma();
    const gone = await prisma.growthRecord.findUnique({ where: { id } });
    expect(gone).toBeNull();
  });

  it("DELETE /growth/:id 404 for unknown id", async () => {
    const res = await request(app)
      .delete("/api/v1/growth/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("DELETE /growth/:id 403 for NURSE (only ADMIN+DOCTOR)", async () => {
    const res = await request(app)
      .delete("/api/v1/growth/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("DELETE /growth/:id 401 without auth", async () => {
    const res = await request(app).delete(
      "/api/v1/growth/00000000-0000-4000-8000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  // ─── GET /growth/patient/:patientId/milestones ──────────────────
  // NB: TWO handlers exist (line 360 and line 768) for the same path.
  // Express matches the FIRST registered, so this hits the WHO-checklist
  // version (returns { ageMonths, checklist, achieved, overdue, total }).
  it("GET /growth/patient/:patientId/milestones returns the WHO checklist", async () => {
    const patient = await createPatientFixture({
      dateOfBirth: new Date("2024-01-01"),
    });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/milestones`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.checklist)).toBe(true);
    expect(typeof res.body.data?.total).toBe("number");
  });

  it("GET /growth/patient/:patientId/milestones 404 for unknown patient", async () => {
    const res = await request(app)
      .get("/api/v1/growth/patient/00000000-0000-4000-8000-000000000000/milestones")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(404);
  });

  // The second `/patient/:id/milestones` handler (catalog-diff) is shadowed
  // by the first one and is therefore unreachable through Express routing.
  it.skip("GET /patient/:id/milestones returns catalog-diff (catalog version)", async () => {
    // TODO: bug — growth.ts registers TWO `GET /patient/:patientId/milestones`
    // handlers (line 360 and line 768). Express dispatches the first one, so
    // the second (which returns { summary, diff } against MILESTONE_CATALOG)
    // is dead code. Either remove one or rename the path.
  });

  // ─── GET /growth/patient/:patientId/immunization-compliance ─────
  it("GET /growth/patient/:patientId/immunization-compliance returns schedule", async () => {
    const patient = await createPatientFixture({
      dateOfBirth: new Date("2024-01-01"),
    });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/immunization-compliance`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.schedule)).toBe(true);
    expect(typeof res.body.data?.compliancePct).toBe("number");
  });

  it("GET /growth/patient/:patientId/immunization-compliance 404 for unknown patient", async () => {
    const res = await request(app)
      .get(
        "/api/v1/growth/patient/00000000-0000-4000-8000-000000000000/immunization-compliance"
      )
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(404);
  });

  // ─── GET /growth/patient/:patientId/velocity ────────────────────
  it("GET /growth/patient/:patientId/velocity computes monthly weight gain", async () => {
    const patient = await createPatientFixture();
    await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ patientId: patient.id, ageMonths: 6, weightKg: 7.5 });
    await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ patientId: patient.id, ageMonths: 9, weightKg: 8.5 });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/velocity`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.velocity)).toBe(true);
    expect(res.body.data.velocity.length).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.data?.summary?.avgGainPerMonth).toBe("number");
  });

  it("GET /growth/patient/:patientId/velocity returns empty when <2 records", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/velocity`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.velocity).toEqual([]);
    expect(res.body.data?.summary?.avgGainPerMonth).toBeNull();
  });

  // ─── GET /growth/patient/:id/ftt-check ──────────────────────────
  it("GET /growth/patient/:id/ftt-check flags FTT on a percentile-band drop", async () => {
    const patient = await createPatientFixture();
    // The route's percentile estimator is `(measured / median) * 50` capped to
    // [1,99], and median weight at 12mo per the WHO table in growth.ts is
    // 9.6kg. Hitting `currentPercentile < 5` requires <0.96kg — impossible.
    // So we seed two records and trigger the percentile-drop branch instead:
    //   t-180d: 6mo at median (7.9kg) → ~50th percentile
    //   today : 12mo at 4.5kg        → ~23rd percentile (drop ~27 points)
    // That clears the >=25-point drop threshold and flags FTT.
    const today = new Date();
    const earlier = new Date(today.getTime() - 180 * 24 * 60 * 60 * 1000);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 6,
        weightKg: 7.9,
        heightCm: 67,
        measurementDate: ymd(earlier),
      });
    await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 12,
        weightKg: 4.5,
        heightCm: 70,
        measurementDate: ymd(today),
      });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/ftt-check`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.isFTT).toBe(true);
    expect(Array.isArray(res.body.data?.reasons)).toBe(true);
    expect(res.body.data.reasons.length).toBeGreaterThan(0);
  });

  it("GET /growth/patient/:id/ftt-check returns benign payload when no records", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/ftt-check`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.isFTT).toBe(false);
  });

  // ─── GET /growth/milestones/catalog ─────────────────────────────
  it("GET /growth/milestones/catalog returns the full catalog", async () => {
    const res = await request(app)
      .get("/api/v1/growth/milestones/catalog")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.milestones)).toBe(true);
    expect(res.body.data.milestones.length).toBeGreaterThan(0);
  });

  it("GET /growth/milestones/catalog?ageMonths= filters", async () => {
    const res = await request(app)
      .get("/api/v1/growth/milestones/catalog?ageMonths=12")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(
      (res.body.data.milestones as any[]).every((m) => m.ageMonths <= 12)
    ).toBe(true);
  });

  it("GET /growth/milestones/catalog 401 without auth", async () => {
    const res = await request(app).get("/api/v1/growth/milestones/catalog");
    expect(res.status).toBe(401);
  });

  // ─── POST /growth/milestones ────────────────────────────────────
  it("POST /growth/milestones upserts a milestone (201)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/growth/milestones")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 12,
        domain: "GROSS_MOTOR",
        milestone: "Stands with support",
        achieved: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.data?.achieved).toBe(true);
    expect(res.body.data?.achievedAt).toBeTruthy();
  });

  it("POST /growth/milestones 400 on invalid payload", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/growth/milestones")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 9999, // out of bounds
        domain: "GROSS_MOTOR",
        milestone: "x",
        achieved: true,
      });
    expect(res.status).toBe(400);
  });

  it("POST /growth/milestones 403 for RECEPTION", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/growth/milestones")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 12,
        domain: "GROSS_MOTOR",
        milestone: "Stands with support",
        achieved: true,
      });
    expect(res.status).toBe(403);
  });

  // ─── POST /growth/patient/:id/feeding ───────────────────────────
  it("POST /growth/patient/:id/feeding logs a feed (201)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post(`/api/v1/growth/patient/${patient.id}/feeding`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        feedType: "BOTTLE_FORMULA",
        durationMin: 15,
        volumeMl: 120,
      });
    expect(res.status).toBe(201);
    expect(res.body.data?.feedType).toBe("BOTTLE_FORMULA");
    expect(res.body.data?.volumeMl).toBe(120);
  });

  it("POST /growth/patient/:id/feeding 404 for unknown patient", async () => {
    const res = await request(app)
      .post(
        "/api/v1/growth/patient/00000000-0000-4000-8000-000000000000/feeding"
      )
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ feedType: "BOTTLE_FORMULA", volumeMl: 100 });
    expect(res.status).toBe(404);
  });

  it("POST /growth/patient/:id/feeding 400 on invalid feedType", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post(`/api/v1/growth/patient/${patient.id}/feeding`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ feedType: "PIZZA", volumeMl: 100 });
    expect(res.status).toBe(400);
  });

  it("POST /growth/patient/:id/feeding 401 without auth", async () => {
    const res = await request(app)
      .post(
        "/api/v1/growth/patient/00000000-0000-4000-8000-000000000000/feeding"
      )
      .send({ feedType: "BOTTLE_FORMULA" });
    expect(res.status).toBe(401);
  });

  // ─── GET /growth/patient/:id/feeding ────────────────────────────
  it("GET /growth/patient/:id/feeding returns logs + daily summary", async () => {
    const patient = await createPatientFixture();
    await request(app)
      .post(`/api/v1/growth/patient/${patient.id}/feeding`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ feedType: "BOTTLE_FORMULA", volumeMl: 100, durationMin: 12 });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/feeding`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.logs)).toBe(true);
    expect(Array.isArray(res.body.data?.daily)).toBe(true);
    expect(res.body.data.totalLogs).toBeGreaterThanOrEqual(1);
  });

  it("GET /growth/patient/:id/feeding 401 without auth", async () => {
    const res = await request(app).get(
      "/api/v1/growth/patient/00000000-0000-4000-8000-000000000000/feeding"
    );
    expect(res.status).toBe(401);
  });

  // ─── DELETE /growth/feeding/:id ─────────────────────────────────
  it("DELETE /growth/feeding/:id removes a feeding log", async () => {
    const patient = await createPatientFixture();
    const created = await request(app)
      .post(`/api/v1/growth/patient/${patient.id}/feeding`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ feedType: "BOTTLE_FORMULA", volumeMl: 80 });
    const id = created.body.data.id;
    const res = await request(app)
      .delete(`/api/v1/growth/feeding/${id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    const prisma = await getPrisma();
    const gone = await prisma.feedingLog.findUnique({ where: { id } });
    expect(gone).toBeNull();
  });

  it("DELETE /growth/feeding/:id 401 without auth", async () => {
    const res = await request(app).delete(
      "/api/v1/growth/feeding/00000000-0000-4000-8000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  it("DELETE /growth/feeding/:id 403 for RECEPTION", async () => {
    const res = await request(app)
      .delete("/api/v1/growth/feeding/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });
});
