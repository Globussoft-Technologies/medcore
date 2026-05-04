// Cross-patient RBAC regression suite for coordinated-visits routes (#511).
//
// What this file covers
// ---------------------
// Issue #511 (long-tail BOLA closure following #474) flagged this file under
// the EXPANDED audit criterion (handlers with Role.PATIENT in the authorize()
// list AND no per-row ownership check).
//
//   - GET    /api/v1/coordinated-visits/:id        — patched (no PATIENT row check pre-#511)
//   - PATCH  /api/v1/coordinated-visits/:id/cancel — verified-safe, refactored to canonical helper
//
// Decision: strict patient-self semantics (NOT membership-of-group).
// CoordinatedVisit has a single owning `patientId` — one patient seeing
// multiple doctors back-to-back, NOT multiple co-member patients sharing a
// group. The appointments.ts /group/:groupId precedent (95cdc13) which used a
// membership gate does not apply here because that surface aggregates many
// member rows, while CoordinatedVisit is a single-owner row.
//
// Per cited handler we assert up to three cases:
//   1. PATIENT-A's token GETs/PATCHes PATIENT-B's row → 403  (the bug)
//   2. PATIENT-A's token does the same on their own row → 200  (positive control)
//   3. DOCTOR's token always wins (200) — staff RBAC unbroken.
// Self-skip via describeIfDB so the suite is a no-op without DATABASE_URL_TEST;
// CI runs it with the real Postgres test database.
//
// Why this lives in a per-route file (not appended to cross-patient-rbac.test.ts)
// -----------------------------------------------------------------------------
// The /medcore-bola-sweep skill is fanned out — each agent owns a unique route
// file AND a unique test file so concurrent commits don't race. cross-patient-
// rbac.test.ts (#474 origin) stays frozen as the canonical reference.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createDoctorFixture } from "../factories";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientAId: string;
let patientBId: string;
let doctorId: string;

// Mint a PATIENT user + linked Patient row + JWT. We need TWO patients to
// assert the cross-patient case; the shared getAuthToken("PATIENT") only
// returns one canonical patient.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_${label}_${Date.now()}_${Math.random()
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
      mrNumber: `MR-${label}-${Date.now()}`,
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

// Helper: create a CoordinatedVisit row directly via Prisma. The route POST
// handler chains a transaction with computeAvailableSlots that requires
// pre-seeded DoctorSchedule rows; for the BOLA matrix we just need a row
// with a known patientId, so we bypass the booking flow.
async function createCoordinatedVisitFixture(args: {
  patientId: string;
  createdBy: string;
}) {
  const prisma = await getPrisma();
  return prisma.coordinatedVisit.create({
    data: {
      patientId: args.patientId,
      name: "Multi-specialty review",
      visitDate: new Date(),
      createdBy: args.createdBy,
    },
  });
}

describeIfDB("Cross-patient RBAC: coordinated-visits (#511)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("A");
    const b = await createPatientWithToken("B");
    patientAToken = a.token;
    patientAId = a.patientId;
    patientBId = b.patientId;

    const doctor = await createDoctorFixture();
    doctorId = doctor.id;
    void doctorId; // referenced via fixture chain only

    const mod = await import("../../app");
    app = mod.app;
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/coordinated-visits/:id
  // ───────────────────────────────────────────────────────

  it("GET /coordinated-visits/:id — PATIENT-A cannot read PATIENT-B's visit (403)", async () => {
    const prisma = await getPrisma();
    const staff = await prisma.user.findFirst({ where: { role: "DOCTOR" as any } });
    const visit = await createCoordinatedVisitFixture({
      patientId: patientBId,
      createdBy: staff!.id,
    });
    const res = await request(app)
      .get(`/api/v1/coordinated-visits/${visit.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /coordinated-visits/:id — PATIENT-A CAN read own visit (200)", async () => {
    const prisma = await getPrisma();
    const staff = await prisma.user.findFirst({ where: { role: "DOCTOR" as any } });
    const visit = await createCoordinatedVisitFixture({
      patientId: patientAId,
      createdBy: staff!.id,
    });
    const res = await request(app)
      .get(`/api/v1/coordinated-visits/${visit.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(visit.id);
  });

  it("GET /coordinated-visits/:id — DOCTOR can read any visit (200)", async () => {
    const prisma = await getPrisma();
    const staff = await prisma.user.findFirst({ where: { role: "DOCTOR" as any } });
    const visit = await createCoordinatedVisitFixture({
      patientId: patientBId,
      createdBy: staff!.id,
    });
    const res = await request(app)
      .get(`/api/v1/coordinated-visits/${visit.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // PATCH /api/v1/coordinated-visits/:id/cancel
  //   (PATIENT is in authorize() — pre-#511 used inline check; refactored
  //    to canonical assertPatientOwnsResource helper for drift prevention)
  // ───────────────────────────────────────────────────────

  it("PATCH /coordinated-visits/:id/cancel — PATIENT-A cannot cancel PATIENT-B's visit (403)", async () => {
    const prisma = await getPrisma();
    const staff = await prisma.user.findFirst({ where: { role: "DOCTOR" as any } });
    const visit = await createCoordinatedVisitFixture({
      patientId: patientBId,
      createdBy: staff!.id,
    });
    const res = await request(app)
      .patch(`/api/v1/coordinated-visits/${visit.id}/cancel`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("PATCH /coordinated-visits/:id/cancel — PATIENT-A CAN cancel own visit (200)", async () => {
    const prisma = await getPrisma();
    const staff = await prisma.user.findFirst({ where: { role: "DOCTOR" as any } });
    const visit = await createCoordinatedVisitFixture({
      patientId: patientAId,
      createdBy: staff!.id,
    });
    const res = await request(app)
      .patch(`/api/v1/coordinated-visits/${visit.id}/cancel`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
  });

  it("PATCH /coordinated-visits/:id/cancel — DOCTOR can cancel any visit (200)", async () => {
    const prisma = await getPrisma();
    const staff = await prisma.user.findFirst({ where: { role: "DOCTOR" as any } });
    const visit = await createCoordinatedVisitFixture({
      patientId: patientBId,
      createdBy: staff!.id,
    });
    const res = await request(app)
      .patch(`/api/v1/coordinated-visits/${visit.id}/cancel`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });
});
