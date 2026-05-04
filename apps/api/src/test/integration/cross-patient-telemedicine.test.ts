// Cross-patient BOLA regression suite — telemedicine action endpoints, issue #511.
//
// What this file covers
// ---------------------
// Issue #511's long-tail audit on `apps/api/src/routes/telemedicine.ts`
// found four `/:id`-shaped action handlers whose `authorize()` allowed
// `PATIENT` but never re-asserted that the caller actually owned the
// telemedicine session being acted on. Once a PATIENT-role JWT had any
// session UUID, they could:
//   - PATCH /:id/join              → flip arbitrary sessions to WAITING
//   - PATCH /:id/tech-issues       → write tech-issue notes onto any session
//   - GET   /:id/messages          → read any session's chat transcript
//   - POST  /:id/messages          → post messages into any session's chat
// OWASP API1:2023 BOLA / CWE-285. Each handler is now patched with
// `assertPatientOwnsResource` after the parent fetch.
//
// Why a separate file
// -------------------
// `cross-patient-rbac.test.ts` is the canonical IDOR/BOLA suite and
// already covers `GET /api/v1/telemedicine/:id` (post-#474). The 2026-05-04
// #511 fan-out has multiple agents touching that file concurrently; per
// the /medcore-bola-sweep skill, each route file gets its own
// `cross-patient-<route>.test.ts` to avoid merge collisions.
//
// Routes asserted (each gets cross-patient 403 / self 2xx / doctor 2xx)
// --------------------------------------------------------------------
// - PATCH /api/v1/telemedicine/:id/join
// - PATCH /api/v1/telemedicine/:id/tech-issues
// - GET   /api/v1/telemedicine/:id/messages
// - POST  /api/v1/telemedicine/:id/messages
//
// Note: GET /api/v1/telemedicine/:id is in cross-patient-rbac.test.ts
// (post-#474). We do NOT duplicate it here.
// `/cancel`, `/rating`, `/waiting-room/join`, `/precheck`, `/chat` were
// VERIFIED-SAFE (already had inline ownership checks; refactored to the
// canonical helper for drift prevention but assertions unchanged).

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

// Helper mirrors cross-patient-rbac.test.ts: spin up two PATIENT users
// with their own Patient row + JWT so we can assert PATIENT-A vs
// PATIENT-B per-row ownership behaviour.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_tel_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000002",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-TEL-${label}-${Date.now()}`,
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

async function createSession(patientId: string, doctorIdArg: string) {
  const prisma = await getPrisma();
  return prisma.telemedicineSession.create({
    data: {
      sessionNumber: `TMS-XP-${patientId.slice(0, 4)}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      patientId,
      doctorId: doctorIdArg,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      fee: 500,
    },
  });
}

describeIfDB(
  "Cross-patient BOLA — telemedicine action endpoints (issue #511)",
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

      // Reference unused token to suppress lint without weakening
      // intent: patientBToken is reserved for future inverse cases.
      void patientBToken;

      const mod = await import("../../app");
      app = mod.app;
    });

    // ───────────────────────────────────────────────────────
    // PATCH /:id/join
    // ───────────────────────────────────────────────────────

    it("join: PATIENT-A cannot PATCH PATIENT-B's session (403)", async () => {
      const sessionB = await createSession(patientBId, doctorId);
      const res = await request(app)
        .patch(`/api/v1/telemedicine/${sessionB.id}/join`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("join: PATIENT-A CAN PATCH own session (200) [positive control]", async () => {
      const sessionA = await createSession(patientAId, doctorId);
      const res = await request(app)
        .patch(`/api/v1/telemedicine/${sessionA.id}/join`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("join: DOCTOR can PATCH any session (200) [staff control]", async () => {
      const sessionA = await createSession(patientAId, doctorId);
      const res = await request(app)
        .patch(`/api/v1/telemedicine/${sessionA.id}/join`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // PATCH /:id/tech-issues
    // ───────────────────────────────────────────────────────

    it("tech-issues: PATIENT-A cannot PATCH PATIENT-B's session (403)", async () => {
      const sessionB = await createSession(patientBId, doctorId);
      const res = await request(app)
        .patch(`/api/v1/telemedicine/${sessionB.id}/tech-issues`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({ technicalIssues: "audio dropped" });
      expect(res.status).toBe(403);
    });

    it("tech-issues: PATIENT-A CAN PATCH own session (200) [positive control]", async () => {
      const sessionA = await createSession(patientAId, doctorId);
      const res = await request(app)
        .patch(`/api/v1/telemedicine/${sessionA.id}/tech-issues`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({ technicalIssues: "audio dropped" });
      expect(res.status).toBe(200);
    });

    it("tech-issues: DOCTOR can PATCH any session (200) [staff control]", async () => {
      const sessionA = await createSession(patientAId, doctorId);
      const res = await request(app)
        .patch(`/api/v1/telemedicine/${sessionA.id}/tech-issues`)
        .set("Authorization", `Bearer ${doctorToken}`)
        .send({ technicalIssues: "video froze" });
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/messages
    // ───────────────────────────────────────────────────────

    it("messages GET: PATIENT-A cannot read PATIENT-B's chat (403)", async () => {
      const sessionB = await createSession(patientBId, doctorId);
      const res = await request(app)
        .get(`/api/v1/telemedicine/${sessionB.id}/messages`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("messages GET: PATIENT-A CAN read own chat (200) [positive control]", async () => {
      const sessionA = await createSession(patientAId, doctorId);
      const res = await request(app)
        .get(`/api/v1/telemedicine/${sessionA.id}/messages`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("messages GET: DOCTOR can read any chat (200) [staff control]", async () => {
      const sessionA = await createSession(patientAId, doctorId);
      const res = await request(app)
        .get(`/api/v1/telemedicine/${sessionA.id}/messages`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // POST /:id/messages
    // ───────────────────────────────────────────────────────

    it("messages POST: PATIENT-A cannot post into PATIENT-B's chat (403)", async () => {
      const sessionB = await createSession(patientBId, doctorId);
      const res = await request(app)
        .post(`/api/v1/telemedicine/${sessionB.id}/messages`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({ text: "hello", sender: "PATIENT" });
      expect(res.status).toBe(403);
    });

    it("messages POST: PATIENT-A CAN post into own chat (201) [positive control]", async () => {
      const sessionA = await createSession(patientAId, doctorId);
      const res = await request(app)
        .post(`/api/v1/telemedicine/${sessionA.id}/messages`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({ text: "hello", sender: "PATIENT" });
      expect(res.status).toBe(201);
    });

    it("messages POST: DOCTOR can post into any chat (201) [staff control]", async () => {
      const sessionA = await createSession(patientAId, doctorId);
      const res = await request(app)
        .post(`/api/v1/telemedicine/${sessionA.id}/messages`)
        .set("Authorization", `Bearer ${doctorToken}`)
        .send({ text: "good morning", sender: "DOCTOR" });
      expect(res.status).toBe(201);
    });
  }
);
