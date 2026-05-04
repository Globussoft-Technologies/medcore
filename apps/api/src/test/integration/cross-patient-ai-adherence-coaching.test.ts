// Cross-patient regression tests for the AI Adherence + Coaching routes —
// issue #511 (BOLA sweep, follow-up to #474).
//
// What this file covers
// ---------------------
// Issue #511 (HIGH) flagged four `/:patientId` / `/:scheduleId` handlers in
// `apps/api/src/routes/ai-adherence.ts` and `apps/api/src/routes/ai-coaching.ts`
// that did not appear to enforce per-row patient ownership. The handlers
// already had inline ownership checks; the fix in this wave refactored
// those checks to use the canonical `assertPatientOwnsResource` helper so
// the gating is uniform across the codebase. This file is the regression
// fence — it asserts the BOLA fix in concrete terms so future drift on
// the helper or any of these handlers fails CI.
//
// Modules / routes asserted
// -------------------------
// - GET    /api/v1/ai/adherence/:patientId         (BOLA: per-row owner)
// - DELETE /api/v1/ai/adherence/:scheduleId        (BOLA via schedule.patientId)
// - GET    /api/v1/ai/adherence/:scheduleId/doses  (BOLA via schedule.patientId)
// - GET    /api/v1/ai/coaching/plans/:patientId    (BOLA: per-row owner)
//
// Per cited route the suite asserts up to three cases:
//   1. PATIENT-A's token GETs PATIENT-B's resource → 403  (the bug)
//   2. PATIENT-A's token GETs PATIENT-A's own resource → 200  (positive control)
//   3. DOCTOR's token GETs the same resource → 200  (staff RBAC unbroken)
//
// Why a separate file from cross-patient-rbac.test.ts
// ---------------------------------------------------
// `cross-patient-rbac.test.ts` is the canonical fence for #474 (the
// original CRITICAL sweep). #511 is a HIGH follow-up audit that pulled in
// dozens of additional handlers. To keep test files scoped to a single
// fanout slice and avoid merge conflicts when several agents close
// different parts of #511 in parallel, this file is dedicated to the
// AI adherence + coaching slice only.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createDoctorWithToken,
  createAppointmentFixture,
  createPrescriptionFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientAId: string;
let patientBId: string;
let patientAUserId: string;
let patientBUserId: string;

// Helper: create a PATIENT user + linked Patient row with a unique email,
// then mint a JWT for that user. We need TWO so we can assert PATIENT-A
// vs PATIENT-B ownership boundaries.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `aiadh_${label}_${Date.now()}_${Math.random()
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
      mrNumber: `MR-AIADH-${label}-${Date.now()}`,
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

describeIfDB("Cross-patient AI adherence + coaching (issue #511)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("A");
    const b = await createPatientWithToken("B");
    patientAToken = a.token;
    patientAId = a.patientId;
    patientBId = b.patientId;
    patientAUserId = a.userId;
    patientBUserId = b.userId;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ────────────────────────────────────────────────────────────
  // GET /api/v1/ai/adherence/:patientId (BOLA: per-row owner)
  // ────────────────────────────────────────────────────────────

  it("ai/adherence/:patientId — PATIENT-A cannot list PATIENT-B's schedules (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/ai/adherence/${patientBId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("ai/adherence/:patientId — PATIENT-A CAN list own schedules (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/ai/adherence/${patientAId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("ai/adherence/:patientId — DOCTOR can list any patient's schedules (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/ai/adherence/${patientAId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ────────────────────────────────────────────────────────────
  // DELETE /api/v1/ai/adherence/:scheduleId (BOLA: schedule.patientId)
  // ────────────────────────────────────────────────────────────

  it("ai/adherence/:scheduleId DELETE — PATIENT-A cannot unenroll PATIENT-B's schedule (403)", async () => {
    const { doctor, token: docToken } = await createDoctorWithToken();
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId: doctor.id });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId: doctor.id,
      appointmentId: apt.id,
    });
    const enroll = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${docToken}`)
      .send({ prescriptionId: rx.id });
    expect(enroll.status).toBe(200);

    const res = await request(app)
      .delete(`/api/v1/ai/adherence/${enroll.body.data.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("ai/adherence/:scheduleId DELETE — DOCTOR can unenroll any schedule (200) [staff control]", async () => {
    const { doctor, token: docToken } = await createDoctorWithToken();
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId: doctor.id });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId: doctor.id,
      appointmentId: apt.id,
    });
    const enroll = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${docToken}`)
      .send({ prescriptionId: rx.id });

    const res = await request(app)
      .delete(`/api/v1/ai/adherence/${enroll.body.data.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
  });

  // ────────────────────────────────────────────────────────────
  // GET /api/v1/ai/adherence/:scheduleId/doses (BOLA: schedule.patientId)
  // ────────────────────────────────────────────────────────────

  it("ai/adherence/:scheduleId/doses GET — PATIENT-A cannot list PATIENT-B's dose log (403)", async () => {
    const { doctor, token: docToken } = await createDoctorWithToken();
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId: doctor.id });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId: doctor.id,
      appointmentId: apt.id,
    });
    const enroll = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${docToken}`)
      .send({ prescriptionId: rx.id });

    const res = await request(app)
      .get(`/api/v1/ai/adherence/${enroll.body.data.id}/doses`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("ai/adherence/:scheduleId/doses GET — DOCTOR can list any dose log (200) [staff control]", async () => {
    const { doctor, token: docToken } = await createDoctorWithToken();
    const apt = await createAppointmentFixture({ patientId: patientAId, doctorId: doctor.id });
    const rx = await createPrescriptionFixture({
      patientId: patientAId,
      doctorId: doctor.id,
      appointmentId: apt.id,
    });
    const enroll = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${docToken}`)
      .send({ prescriptionId: rx.id });

    const res = await request(app)
      .get(`/api/v1/ai/adherence/${enroll.body.data.id}/doses`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  // ────────────────────────────────────────────────────────────
  // GET /api/v1/ai/coaching/plans/:patientId (BOLA: per-row owner)
  // ────────────────────────────────────────────────────────────

  it("ai/coaching/plans/:patientId — PATIENT-A cannot view PATIENT-B's plans (403)", async () => {
    // Seed a plan on B so the path exists
    const prisma = await getPrisma();
    await prisma.chronicCarePlan.create({
      data: {
        patientId: patientBId,
        condition: "HYPERTENSION" as any,
        checkInFrequencyDays: 7,
        thresholds: {} as any,
        active: true,
        createdBy: patientBUserId, // any user id; not asserted
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/coaching/plans/${patientBId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("ai/coaching/plans/:patientId — PATIENT-A CAN view own plans (200) [positive control]", async () => {
    const prisma = await getPrisma();
    await prisma.chronicCarePlan.create({
      data: {
        patientId: patientAId,
        condition: "DIABETES" as any,
        checkInFrequencyDays: 3,
        thresholds: {} as any,
        active: true,
        createdBy: patientAUserId,
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/coaching/plans/${patientAId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("ai/coaching/plans/:patientId — DOCTOR can view any patient's plans (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/ai/coaching/plans/${patientBId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });
});
