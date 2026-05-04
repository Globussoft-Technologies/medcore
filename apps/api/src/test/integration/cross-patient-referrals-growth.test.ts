// Cross-patient BOLA regression suite for referrals + growth handlers — issue #511.
//
// What this file covers
// ---------------------
// Issue #511 (HIGH, OWASP API1:2023 BOLA / CWE-285) is the post-#474
// audit sweep. This file closes two related route slices in one
// fixture-shared spec:
//
// - apps/api/src/routes/referrals.ts — clinical referrals (PHI: which
//   doctor a patient is being referred to and why)
// - apps/api/src/routes/growth.ts    — pediatric growth charts,
//   developmental milestones, immunization compliance, feeding logs
//
// Why a separate file from cross-patient-rbac.test.ts
// ---------------------------------------------------
// The #511 sweep is being done by multiple agents in parallel (one per
// route file). Putting all agents' regression cases in the single
// existing `cross-patient-rbac.test.ts` would create constant merge
// collisions. Each agent owns its own `cross-patient-<area>.test.ts`
// file; the runner picks them all up via the same `*.test.ts` glob.
//
// Modules / handlers asserted
// ---------------------------
// referrals.ts
// - GET /api/v1/referrals/:id                                  (BOLA: per-row owner)
// - GET /api/v1/referrals/inbox                                (STAFF-ONLY: doctor inbox)
// - PATCH /api/v1/referrals/:id                                (STAFF-ONLY: status update)
//
// growth.ts
// - GET  /api/v1/growth/patient/:patientId                     (BOLA: per-row owner)
// - GET  /api/v1/growth/patient/:patientId/chart               (BOLA: per-row owner)
// - GET  /api/v1/growth/patient/:patientId/milestones          (BOLA: per-row owner)
// - GET  /api/v1/growth/patient/:patientId/immunization-compliance (BOLA)
// - GET  /api/v1/growth/patient/:patientId/velocity            (BOLA: per-row owner)
// - GET  /api/v1/growth/patient/:id/ftt-check                  (BOLA: per-row owner)
// - POST /api/v1/growth/patient/:id/feeding                    (BOLA: PATIENT in authorize list, no row check)
// - GET  /api/v1/growth/patient/:id/feeding                    (BOLA: per-row owner)
//
// Per cited route the suite asserts up to three cases:
//   1. PATIENT-A's token GETs PATIENT-B's resource → 403  (the bug)
//   2. PATIENT-A's token GETs PATIENT-A's own resource → 200/201  (positive control)
//   3. DOCTOR's token GETs the same resource → 200  (staff RBAC unbroken)
// For STAFF-ONLY handlers only (1) (PATIENT denied → 403) and (3) apply.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createDoctorFixture } from "../factories";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientBToken: string;
let patientAId: string;
let patientBId: string;
let doctorId: string;
let referralAId: string;
let referralBId: string;
let growthAId: string;
let growthBId: string;

// Local re-impl of cross-patient-rbac.test.ts's helper. Inlined to keep
// each per-route spec independently runnable and avoid coupling fanout
// agents to a shared module.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_refgrowth_${label}_${Date.now()}_${Math.random()
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
      mrNumber: `MR-RG-${label}-${Date.now()}`,
      // Children's pediatric routes care about dateOfBirth; pick a recent
      // date so age-in-months is non-zero and immunization/milestone
      // computations have something to chew on.
      dateOfBirth: new Date("2024-01-01"),
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

describeIfDB("Cross-patient referrals + growth BOLA (issue #511)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("A");
    const b = await createPatientWithToken("B");
    patientAToken = a.token;
    patientBToken = b.token;
    patientAId = a.patientId;
    patientBId = b.patientId;

    const doctor = await createDoctorFixture();
    doctorId = doctor.id;

    const prisma = await getPrisma();

    // One referral per patient — re-targeted across handler tests.
    const refA = await prisma.referral.create({
      data: {
        referralNumber: `REF-XP-A-${Date.now()}`,
        patientId: patientAId,
        fromDoctorId: doctorId,
        toDoctorId: doctorId,
        reason: "Cardiology consult",
        status: "PENDING" as any,
      },
    });
    const refB = await prisma.referral.create({
      data: {
        referralNumber: `REF-XP-B-${Date.now()}`,
        patientId: patientBId,
        fromDoctorId: doctorId,
        toDoctorId: doctorId,
        reason: "Endocrinology consult",
        status: "PENDING" as any,
      },
    });
    referralAId = refA.id;
    referralBId = refB.id;

    // One growth record per patient — backs the patient/:id family of
    // growth handlers.
    const growthA = await prisma.growthRecord.create({
      data: {
        patientId: patientAId,
        ageMonths: 12,
        weightKg: 9.0,
        heightCm: 74,
        recordedBy: doctor.userId,
      },
    });
    const growthB = await prisma.growthRecord.create({
      data: {
        patientId: patientBId,
        ageMonths: 12,
        weightKg: 9.5,
        heightCm: 75,
        recordedBy: doctor.userId,
      },
    });
    growthAId = growthA.id;
    growthBId = growthB.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/referrals/:id  (PATCHED)
  // ───────────────────────────────────────────────────────

  it("referrals/:id: PATIENT-A cannot GET PATIENT-B's referral (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/referrals/${referralBId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("referrals/:id: PATIENT-A CAN GET own referral (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/referrals/${referralAId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(referralAId);
  });

  it("referrals/:id: DOCTOR can GET any referral (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/referrals/${referralBId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/referrals/inbox  (STAFF-ONLY)
  // ───────────────────────────────────────────────────────

  it("referrals/inbox: PATIENT cannot enumerate doctor inbox (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/referrals/inbox?doctorId=${doctorId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("referrals/inbox: DOCTOR can list inbox (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/referrals/inbox?doctorId=${doctorId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // PATCH /api/v1/referrals/:id  (STAFF-ONLY)
  // ───────────────────────────────────────────────────────

  it("referrals/:id PATCH: PATIENT cannot update referral status (403)", async () => {
    const res = await request(app)
      .patch(`/api/v1/referrals/${referralAId}`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({ status: "ACCEPTED" });
    expect(res.status).toBe(403);
  });

  it("referrals/:id PATCH: DOCTOR can update referral status (200) [staff control]", async () => {
    const res = await request(app)
      .patch(`/api/v1/referrals/${referralBId}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ status: "ACCEPTED" });
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/growth/patient/:patientId  (PATCHED)
  // ───────────────────────────────────────────────────────

  it("growth/patient/:id: PATIENT-A cannot GET PATIENT-B's growth records (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("growth/patient/:id: PATIENT-A CAN GET own growth records (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientAId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("growth/patient/:id: DOCTOR can GET any growth records (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/growth/patient/:patientId/chart  (PATCHED)
  // ───────────────────────────────────────────────────────

  it("growth/.../chart: PATIENT-A cannot GET PATIENT-B's chart (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/chart`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("growth/.../chart: PATIENT-A CAN GET own chart (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientAId}/chart`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
  });

  it("growth/.../chart: DOCTOR can GET any chart (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/chart`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/growth/patient/:patientId/milestones  (PATCHED)
  // ───────────────────────────────────────────────────────

  it("growth/.../milestones: PATIENT-A cannot GET PATIENT-B's milestones (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/milestones`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("growth/.../milestones: PATIENT-A CAN GET own milestones (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientAId}/milestones`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
  });

  it("growth/.../milestones: DOCTOR can GET any milestones (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/milestones`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/growth/patient/:patientId/immunization-compliance (PATCHED)
  // ───────────────────────────────────────────────────────

  it("growth/.../immunization-compliance: PATIENT-A cannot GET PATIENT-B's compliance (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/immunization-compliance`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("growth/.../immunization-compliance: PATIENT-A CAN GET own compliance (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientAId}/immunization-compliance`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
  });

  it("growth/.../immunization-compliance: DOCTOR can GET any compliance (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/immunization-compliance`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/growth/patient/:patientId/velocity  (PATCHED)
  // ───────────────────────────────────────────────────────

  it("growth/.../velocity: PATIENT-A cannot GET PATIENT-B's velocity (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/velocity`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("growth/.../velocity: PATIENT-A CAN GET own velocity (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientAId}/velocity`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
  });

  it("growth/.../velocity: DOCTOR can GET any velocity (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/velocity`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/growth/patient/:id/ftt-check  (PATCHED)
  // ───────────────────────────────────────────────────────

  it("growth/.../ftt-check: PATIENT-A cannot GET PATIENT-B's FTT check (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/ftt-check`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("growth/.../ftt-check: PATIENT-A CAN GET own FTT check (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientAId}/ftt-check`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
  });

  it("growth/.../ftt-check: DOCTOR can GET any FTT check (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/ftt-check`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // POST /api/v1/growth/patient/:id/feeding  (PATCHED — PATIENT in
  // authorize() list, but per-row ownership added in #511.)
  // ───────────────────────────────────────────────────────

  it("growth/.../feeding POST: PATIENT-A cannot log feed for PATIENT-B (403)", async () => {
    const res = await request(app)
      .post(`/api/v1/growth/patient/${patientBId}/feeding`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({ feedType: "BOTTLE_FORMULA", volumeMl: 100 });
    expect(res.status).toBe(403);
  });

  it("growth/.../feeding POST: PATIENT-A CAN log feed for own (201) [positive control]", async () => {
    const res = await request(app)
      .post(`/api/v1/growth/patient/${patientAId}/feeding`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({ feedType: "BOTTLE_FORMULA", volumeMl: 100 });
    expect(res.status).toBe(201);
  });

  it("growth/.../feeding POST: DOCTOR can log feed for any (201) [staff control]", async () => {
    const res = await request(app)
      .post(`/api/v1/growth/patient/${patientBId}/feeding`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ feedType: "BOTTLE_FORMULA", volumeMl: 120 });
    expect(res.status).toBe(201);
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/growth/patient/:id/feeding  (PATCHED)
  // ───────────────────────────────────────────────────────

  it("growth/.../feeding GET: PATIENT-A cannot GET PATIENT-B's feeds (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/feeding`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("growth/.../feeding GET: PATIENT-A CAN GET own feeds (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientAId}/feeding`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
  });

  it("growth/.../feeding GET: DOCTOR can GET any feeds (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patientBId}/feeding`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // Suppress unused-var warning for symmetry with cross-patient-rbac.test.ts
  it("smoke: patientBToken + growthAId/growthBId fixtures exist (sanity)", () => {
    expect(typeof patientBToken).toBe("string");
    expect(patientBToken.length).toBeGreaterThan(10);
    expect(growthAId).toBeTruthy();
    expect(growthBId).toBeTruthy();
  });
});
