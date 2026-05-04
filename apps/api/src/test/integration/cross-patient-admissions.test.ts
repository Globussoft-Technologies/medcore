// Cross-patient BOLA regression suite — admissions sub-resources, issue #511.
//
// What this file covers
// ---------------------
// Issue #511 found 9 `/:id`-shaped GET handlers under
// `apps/api/src/routes/admissions.ts` whose access pattern was checked
// only by `authenticate`. After loading the parent admission row, none
// of them re-asserted that a PATIENT-role caller actually owned that
// admission — so PATIENT-A could trivially fetch PATIENT-B's
// vitals / bill / belongings / discharge summary by guessing UUIDs.
// OWASP API1:2023 BOLA / CWE-285.
//
// Of the 9 cited handlers, `GET /:id` was already patched in the
// earlier #474 sweep — the audit grep was naive. The remaining 8 sub-
// resource handlers are patched in this commit; this file is the
// regression net.
//
// Why a separate file
// -------------------
// `cross-patient-rbac.test.ts` is the canonical IDOR/BOLA suite but the
// 2026-05-04 #511 fan-out has 4 other agents touching it concurrently.
// Writing to a per-route file avoids a 5-way merge collision, keeps
// the assertions scoped to admissions, and lets `cross-patient-rbac`
// stay the cross-route umbrella suite.
//
// Routes asserted (each gets cross-patient 403 / self 200 / doctor 200)
// --------------------------------------------------------------------
// - GET /api/v1/admissions/:id/discharge-readiness
// - GET /api/v1/admissions/:id/vitals
// - GET /api/v1/admissions/:id/bill
// - GET /api/v1/admissions/:id/intake-output
// - GET /api/v1/admissions/:id/mar
// - GET /api/v1/admissions/:id/los-prediction
// - GET /api/v1/admissions/:id/belongings
// - GET /api/v1/admissions/:id/discharge-summary-pdf
//
// Note: GET /api/v1/admissions/:id itself is covered in
// cross-patient-rbac.test.ts (post-#474). We do NOT duplicate it here.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createDoctorFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientBToken: string;
let patientAId: string;
let patientBId: string;
let doctorId: string;
let admissionAId: string;
let admissionBId: string;

// Helper mirrors cross-patient-rbac.test.ts: spin up two PATIENT users
// with their own Patient row + JWT so we can assert PATIENT-A vs
// PATIENT-B per-row ownership behaviour.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_adm_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000001",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-ADM-${label}-${Date.now()}`,
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

describeIfDB(
  "Cross-patient BOLA — admissions sub-resources (issue #511)",
  () => {
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

      // One admission per patient — every sub-resource handler scopes
      // by `:id` (admissionId), so we re-use these throughout.
      const wardA = await createWardFixture();
      const bedA = await createBedFixture({ wardId: wardA.id });
      const admA = await createAdmissionFixture({
        patientId: patientAId,
        doctorId,
        bedId: bedA.id,
      });
      admissionAId = admA.id;

      const wardB = await createWardFixture();
      const bedB = await createBedFixture({ wardId: wardB.id });
      const admB = await createAdmissionFixture({
        patientId: patientBId,
        doctorId,
        bedId: bedB.id,
      });
      admissionBId = admB.id;
      // Reference unused token to suppress lint without weakening
      // intent: patientBToken is reserved for future inverse cases.
      void patientBToken;

      const mod = await import("../../app");
      app = mod.app;
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/discharge-readiness
    // ───────────────────────────────────────────────────────

    it("discharge-readiness: PATIENT-A cannot GET PATIENT-B's checklist (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/discharge-readiness`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("discharge-readiness: PATIENT-A CAN GET own checklist (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionAId}/discharge-readiness`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("discharge-readiness: DOCTOR can GET any checklist (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/discharge-readiness`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/vitals
    // ───────────────────────────────────────────────────────

    it("vitals: PATIENT-A cannot GET PATIENT-B's vitals (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/vitals`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("vitals: PATIENT-A CAN GET own vitals (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionAId}/vitals`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("vitals: DOCTOR can GET any vitals (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/vitals`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/bill
    // ───────────────────────────────────────────────────────

    it("bill: PATIENT-A cannot GET PATIENT-B's running bill (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/bill`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("bill: PATIENT-A CAN GET own bill (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionAId}/bill`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("bill: DOCTOR can GET any bill (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/bill`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/intake-output
    // ───────────────────────────────────────────────────────

    it("intake-output: PATIENT-A cannot GET PATIENT-B's I/O (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/intake-output`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("intake-output: PATIENT-A CAN GET own I/O (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionAId}/intake-output`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("intake-output: DOCTOR can GET any I/O (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/intake-output`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/mar
    // ───────────────────────────────────────────────────────

    it("mar: PATIENT-A cannot GET PATIENT-B's MAR grid (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/mar`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("mar: PATIENT-A CAN GET own MAR grid (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionAId}/mar`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("mar: DOCTOR can GET any MAR grid (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/mar`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/los-prediction
    // ───────────────────────────────────────────────────────

    it("los-prediction: PATIENT-A cannot GET PATIENT-B's LOS estimate (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/los-prediction`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("los-prediction: PATIENT-A CAN GET own LOS estimate (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionAId}/los-prediction`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("los-prediction: DOCTOR can GET any LOS estimate (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/los-prediction`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/belongings
    // ───────────────────────────────────────────────────────

    it("belongings: PATIENT-A cannot GET PATIENT-B's belongings (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/belongings`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("belongings: PATIENT-A CAN GET own belongings (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionAId}/belongings`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("belongings: DOCTOR can GET any belongings (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/belongings`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/discharge-summary-pdf
    // ───────────────────────────────────────────────────────

    it("discharge-summary-pdf: PATIENT-A cannot GET PATIENT-B's summary (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/discharge-summary-pdf`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("discharge-summary-pdf: PATIENT-A CAN GET own summary (200|500 — never 403)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionAId}/discharge-summary-pdf`)
        .set("Authorization", `Bearer ${patientAToken}`);
      // 200 OK rendering HTML (default format) is the success criterion;
      // the underlying PDF/HTML generator may 5xx if its puppeteer host
      // isn't available in CI, but the access gate landed and that's
      // what this assertion guards.
      expect(res.status).not.toBe(403);
    });

    it("discharge-summary-pdf: DOCTOR can GET any summary (200|500 — never 403)", async () => {
      const res = await request(app)
        .get(`/api/v1/admissions/${admissionBId}/discharge-summary-pdf`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).not.toBe(403);
    });
  }
);
