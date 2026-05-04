// Cross-patient BOLA regression suite — surgery sub-resources, issue #511.
//
// What this file covers
// ---------------------
// Issue #511 audit grep flagged 4 `/:id`-shaped surgery handlers whose
// access pattern was checked only by `authenticate`:
//   - GET  /api/v1/surgery/:id/anesthesia-record   (PATCHED via assertPatientOwnsResource)
//   - GET  /api/v1/surgery/:id/observations        (PATCHED via assertPatientOwnsResource)
//   - GET  /api/v1/surgery/ots/:id/utilization     (STAFF-ONLY via authorize())
//   - GET  /api/v1/surgery/ots/:id/turnaround      (STAFF-ONLY via authorize())
//
// The OT-level analytics (utilization/turnaround) aren't patient-self
// surfaces — they aggregate cases across every patient that used the
// theatre. The fix is `authorize(ADMIN, DOCTOR, NURSE, RECEPTION)`,
// matching the existing /ots/:id/schedule gate. PATIENT must hit 403.
//
// The two patient-scoped sub-resources (anesthesia-record, observations)
// queried child rows by `surgeryId` without ever loading the parent
// Surgery — verdict A3 in the medcore-bola-sweep skill. The fix loads
// the parent surgery to obtain `patientId`, then defers to
// `assertPatientOwnsResource` so PATIENT sees their own and 403s
// everyone else's.
//
// Why a separate file
// -------------------
// `cross-patient-rbac.test.ts` is the canonical IDOR/BOLA suite but the
// 2026-05-04 #511 multi-route fan-out has 5 agents touching it
// concurrently. Per-route file = no merge race.
//
// GET /api/v1/surgery/:id itself is already gated by the post-#474
// `assertPatientOwnsResource` call inside the handler — that test lives
// in `cross-patient-rbac.test.ts` and is not duplicated here.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createDoctorFixture,
  createOperatingTheaterFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientAId: string;
let patientBId: string;
let surgeryAId: string;
let surgeryBId: string;
let otId: string;

async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_surg_${label}_${Date.now()}_${Math.random()
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
      mrNumber: `MR-SURG-${label}-${Date.now()}`,
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

async function createSurgeryRow(args: {
  patientId: string;
  surgeonId: string;
  otId: string;
}): Promise<string> {
  const prisma = await getPrisma();
  const caseNumber = `SUR${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const surgery = await prisma.surgery.create({
    data: {
      caseNumber,
      patientId: args.patientId,
      surgeonId: args.surgeonId,
      otId: args.otId,
      procedure: "Appendectomy",
      scheduledAt: new Date(Date.now() + 3600_000),
      status: "SCHEDULED",
    },
  });
  return surgery.id;
}

describeIfDB(
  "Cross-patient BOLA — surgery sub-resources (issue #511)",
  () => {
    beforeAll(async () => {
      await resetDB();
      doctorToken = await getAuthToken("DOCTOR");

      const a = await createPatientWithToken("A");
      const b = await createPatientWithToken("B");
      patientAToken = a.token;
      patientAId = a.patientId;
      patientBId = b.patientId;

      const surgeon = await createDoctorFixture();
      const ot = await createOperatingTheaterFixture();
      otId = ot.id;

      surgeryAId = await createSurgeryRow({
        patientId: patientAId,
        surgeonId: surgeon.id,
        otId: ot.id,
      });
      surgeryBId = await createSurgeryRow({
        patientId: patientBId,
        surgeonId: surgeon.id,
        otId: ot.id,
      });

      const mod = await import("../../app");
      app = mod.app;
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/anesthesia-record — PATCHED via assertPatientOwnsResource
    // ───────────────────────────────────────────────────────

    it("anesthesia-record: PATIENT-A cannot GET PATIENT-B's record (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/surgery/${surgeryBId}/anesthesia-record`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("anesthesia-record: PATIENT-A CAN GET own surgery's record (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/surgery/${surgeryAId}/anesthesia-record`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("anesthesia-record: DOCTOR can GET any record (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/surgery/${surgeryBId}/anesthesia-record`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /:id/observations — PATCHED via assertPatientOwnsResource
    // ───────────────────────────────────────────────────────

    it("observations: PATIENT-A cannot GET PATIENT-B's PACU log (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/surgery/${surgeryBId}/observations`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("observations: PATIENT-A CAN GET own PACU log (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/surgery/${surgeryAId}/observations`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
    });

    it("observations: DOCTOR can GET any PACU log (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/surgery/${surgeryBId}/observations`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /ots/:id/utilization — STAFF-ONLY via authorize()
    // ───────────────────────────────────────────────────────

    it("ot utilization: PATIENT cannot GET aggregate (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/surgery/ots/${otId}/utilization`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("ot utilization: DOCTOR can GET aggregate (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/surgery/ots/${otId}/utilization`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ───────────────────────────────────────────────────────
    // GET /ots/:id/turnaround — STAFF-ONLY via authorize()
    // ───────────────────────────────────────────────────────

    it("ot turnaround: PATIENT cannot GET timeline (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/surgery/ots/${otId}/turnaround`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("ot turnaround: DOCTOR can GET timeline (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/surgery/ots/${otId}/turnaround`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });
  }
);
