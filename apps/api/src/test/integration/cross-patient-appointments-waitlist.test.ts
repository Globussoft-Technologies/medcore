// Cross-patient RBAC regression suite for appointments + waitlist routes (#511).
//
// What this file covers
// ---------------------
// Issue #511 (long-tail BOLA closure following #474) flagged:
//   - GET    /api/v1/appointments/:id              — generic detail
//   - GET    /api/v1/appointments/:id/calendar.ics — publicly-shareable
//   - GET    /api/v1/appointments/group/:groupId   — coordinated visits
//   - PATCH  /api/v1/appointments/:id/reschedule   — PATIENT in authorize() but no row check
//   - POST   /api/v1/waitlist                       — body's patientId
//   - PATCH  /api/v1/waitlist/:id/cancel            — by entry id
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
import {
  createDoctorFixture,
  createAppointmentFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientBToken: string;
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

describeIfDB("Cross-patient RBAC: appointments + waitlist (#511)", () => {
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

    const mod = await import("../../app");
    app = mod.app;
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/appointments/:id
  // ───────────────────────────────────────────────────────

  it("GET /appointments/:id — PATIENT-A cannot read PATIENT-B's appointment (403)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const res = await request(app)
      .get(`/api/v1/appointments/${apt.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /appointments/:id — PATIENT-A CAN read own appointment (200)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientAId, doctorId });
    const res = await request(app)
      .get(`/api/v1/appointments/${apt.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(apt.id);
  });

  it("GET /appointments/:id — DOCTOR can read any appointment (200)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const res = await request(app)
      .get(`/api/v1/appointments/${apt.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/appointments/:id/calendar.ics
  // ───────────────────────────────────────────────────────

  it("GET /appointments/:id/calendar.ics — PATIENT-A cannot download PATIENT-B's .ics (403)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const res = await request(app)
      .get(`/api/v1/appointments/${apt.id}/calendar.ics`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /appointments/:id/calendar.ics — PATIENT-A CAN download own .ics (200)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientAId, doctorId });
    const res = await request(app)
      .get(`/api/v1/appointments/${apt.id}/calendar.ics`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
  });

  it("GET /appointments/:id/calendar.ics — DOCTOR can download any .ics (200)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const res = await request(app)
      .get(`/api/v1/appointments/${apt.id}/calendar.ics`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /api/v1/appointments/group/:groupId
  // ───────────────────────────────────────────────────────

  it("GET /appointments/group/:groupId — PATIENT-A cannot read group containing only PATIENT-B (403)", async () => {
    const prisma = await getPrisma();
    const groupId = `GRP-XPB-${Date.now()}`;
    await prisma.appointment.create({
      data: {
        patientId: patientBId,
        doctorId,
        date: new Date(),
        tokenNumber: 9001,
        type: "SCHEDULED",
        status: "BOOKED",
        groupId,
      },
    });
    const res = await request(app)
      .get(`/api/v1/appointments/group/${groupId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /appointments/group/:groupId — PATIENT-A CAN read group they're a member of (200)", async () => {
    const prisma = await getPrisma();
    const groupId = `GRP-XPA-${Date.now()}`;
    await prisma.appointment.create({
      data: {
        patientId: patientAId,
        doctorId,
        date: new Date(),
        tokenNumber: 9002,
        type: "SCHEDULED",
        status: "BOOKED",
        groupId,
      },
    });
    await prisma.appointment.create({
      data: {
        patientId: patientBId,
        doctorId,
        date: new Date(),
        tokenNumber: 9003,
        type: "SCHEDULED",
        status: "BOOKED",
        groupId,
      },
    });
    const res = await request(app)
      .get(`/api/v1/appointments/group/${groupId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.members?.length).toBe(2);
  });

  it("GET /appointments/group/:groupId — DOCTOR can read any group (200)", async () => {
    const prisma = await getPrisma();
    const groupId = `GRP-DOC-${Date.now()}`;
    await prisma.appointment.create({
      data: {
        patientId: patientBId,
        doctorId,
        date: new Date(),
        tokenNumber: 9004,
        type: "SCHEDULED",
        status: "BOOKED",
        groupId,
      },
    });
    const res = await request(app)
      .get(`/api/v1/appointments/group/${groupId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // PATCH /api/v1/appointments/:id/reschedule
  //   (PATIENT is in authorize() but pre-#511 there was no row check)
  // ───────────────────────────────────────────────────────

  it("PATCH /appointments/:id/reschedule — PATIENT-A cannot reschedule PATIENT-B's appointment (403)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const future = new Date();
    future.setDate(future.getDate() + 7);
    const res = await request(app)
      .patch(`/api/v1/appointments/${apt.id}/reschedule`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({
        date: future.toISOString().split("T")[0],
        slotStart: "10:00",
      });
    expect(res.status).toBe(403);
  });

  it("PATCH /appointments/:id/reschedule — DOCTOR can reschedule any appointment", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const future = new Date();
    future.setDate(future.getDate() + 14);
    const res = await request(app)
      .patch(`/api/v1/appointments/${apt.id}/reschedule`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        date: future.toISOString().split("T")[0],
        slotStart: "11:00",
      });
    // Accept 200 (rescheduled). Validation/conflict failures would surface as 4xx
    // and indicate a real bug — keep this strict.
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // POST /api/v1/waitlist
  // ───────────────────────────────────────────────────────

  it("POST /waitlist — PATIENT-A cannot enqueue PATIENT-B (403)", async () => {
    const res = await request(app)
      .post(`/api/v1/waitlist`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({
        patientId: patientBId,
        doctorId,
      });
    expect(res.status).toBe(403);
  });

  it("POST /waitlist — PATIENT-A CAN enqueue self (201)", async () => {
    const res = await request(app)
      .post(`/api/v1/waitlist`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({
        patientId: patientAId,
        doctorId,
      });
    expect(res.status).toBe(201);
  });

  // ───────────────────────────────────────────────────────
  // PATCH /api/v1/waitlist/:id/cancel
  // ───────────────────────────────────────────────────────

  it("PATCH /waitlist/:id/cancel — PATIENT-A cannot cancel PATIENT-B's entry (403)", async () => {
    const prisma = await getPrisma();
    const entry = await prisma.waitlistEntry.create({
      data: {
        patientId: patientBId,
        doctorId,
      },
    });
    const res = await request(app)
      .patch(`/api/v1/waitlist/${entry.id}/cancel`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("PATCH /waitlist/:id/cancel — DOCTOR can cancel any entry (200)", async () => {
    const prisma = await getPrisma();
    const entry = await prisma.waitlistEntry.create({
      data: {
        patientId: patientBId,
        doctorId,
      },
    });
    const res = await request(app)
      .patch(`/api/v1/waitlist/${entry.id}/cancel`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });
});
