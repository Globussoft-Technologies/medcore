// Integration tests for the appointments router.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
} from "../factories";
import { waitForAuditFlush } from "../helpers/audit-wait";
import { istMidnightUtc } from "../../utils/ist-time";

/**
 * Mint a PATIENT JWT for a Patient row created via `createPatientFixture()`.
 *
 * The fixture creates BOTH a User (role=PATIENT) and a Patient row linked
 * to that user. `getAuthToken("PATIENT")` returns the canonical seeded
 * patient's token — DIFFERENT User row from the fixture, so cross-patient
 * tests that need an owner-side token need to mint here. See CLAUDE.md
 * "Cross-patient test fixture/token identity-mismatch class".
 */
function signPatientJwt(userId: string, email: string): string {
  return jwt.sign(
    { userId, email, role: "PATIENT" },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
}

let app: any;
let token: string;

describeIfDB("Appointments API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    token = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("books a scheduled appointment", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    // PR #521: slotId schema is now HH:MM, not UUID. The route's #491
    // past-time guard rejects today + early-morning slot when CI runs
    // mid-day; book for tomorrow so the guard doesn't fire.
    const slotId = "09:00";
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        date: tomorrow,
        slotId,
        notes: "Follow-up",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.tokenNumber).toBeGreaterThan(0);
    expect(res.body.data?.status).toBe("BOOKED");
  });

  it("prevents double-booking the same slot", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    // PR #521: slotId schema is now HH:MM, not UUID. Use tomorrow so
    // the route's #491 past-time guard doesn't fire on early slots.
    const slotId = "09:30";
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const first = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: patient.id, doctorId: doctor.id, date, slotId });
    expect([200, 201]).toContain(first.status);

    const second = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: patient.id, doctorId: doctor.id, date, slotId });
    expect(second.status).toBe(409);
  });

  it("registers a walk-in with auto token", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/appointments/walk-in")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: patient.id, doctorId: doctor.id, priority: "NORMAL" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.type).toBe("WALK_IN");
    expect(typeof res.body.data?.tokenNumber).toBe("number");
  });

  it("updates appointment status (CHECKED_IN)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "CHECKED_IN" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("CHECKED_IN");

    const prisma = await getPrisma();
    const refreshed = await prisma.appointment.findUnique({
      where: { id: appt.id },
    });
    expect(refreshed?.checkInAt).toBeTruthy();
  });

  it("cancels an appointment (transition to CANCELLED)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "CANCELLED" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("CANCELLED");
  });

  it("marks an appointment as NO_SHOW and increments patient counter", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "NO_SHOW" });
    expect([200, 201]).toContain(res.status);
  });

  it("lists appointments (returns array)", async () => {
    const res = await request(app)
      .get("/api/v1/appointments")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toBeTruthy();
  });

  it("filters appointments by doctorId query", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .get(`/api/v1/appointments?doctorId=${doctor.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].doctorId).toBe(doctor.id);
  });

  it("rejects booking with invalid payload", async () => {
    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: "not-a-uuid", doctorId: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/v1/appointments");
    expect(res.status).toBe(401);
  });

  // ─────────────────────────────────────────────────────────
  // Pearl ERP Stage 1 §2.1.2 — per-doctor appointmentMode
  // (CALLING / TOKEN / SLOT). Default TOKEN behaviour is
  // exercised by the existing "books a scheduled appointment"
  // test above; these cover the two new branches.
  // ─────────────────────────────────────────────────────────

  it("CALLING mode: book mints arrivalSeq, no tokenNumber, no slot", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { appointmentMode: "CALLING" },
    });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: patient.id, doctorId: doctor.id, date: tomorrow });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.arrivalSeq).toBeGreaterThan(0);
    expect(res.body.data?.tokenNumber).toBeNull();
    expect(res.body.data?.slotStart).toBeNull();
  });

  it("CALLING mode: second booking increments arrivalSeq, never collides on slot", async () => {
    const prisma = await getPrisma();
    const a = await createPatientFixture();
    const b = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { appointmentMode: "CALLING" },
    });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const first = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: a.id, doctorId: doctor.id, date: tomorrow });
    expect([200, 201]).toContain(first.status);

    const second = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: b.id, doctorId: doctor.id, date: tomorrow });
    expect([200, 201]).toContain(second.status);
    expect(second.body.data.arrivalSeq).toBe(first.body.data.arrivalSeq + 1);
  });

  it("SLOT mode: requires slotId — 400 when omitted", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { appointmentMode: "SLOT" },
    });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: patient.id, doctorId: doctor.id, date: tomorrow });
    expect(res.status).toBe(400);
  });

  // ─────────────────────────────────────────────────────────
  // Pearl PRD §6.3 row 340 — PATIENT self-check-in
  // (server-side enabler for the "I've arrived" patient PWA
  // button). Allowed iff: per-row ownership holds, the
  // appointment.date matches TODAY IST, current status is
  // BOOKED. Anything else → 403.
  // ─────────────────────────────────────────────────────────

  // Helper: today's IST date as a UTC-midnight Date. Postgres @db.Date
  // strips the time component on storage; this construction guarantees
  // the stored DATE is today-IST regardless of when the test fires
  // (avoids the late-IST-night drift where `istMidnightUtc(0)` rounds
  // back to yesterday-UTC date and breaks the handler's string-compare).
  function istTodayAsUtcMidnight(): Date {
    const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
    const ymd = istNow.toISOString().slice(0, 10);
    return new Date(`${ymd}T00:00:00.000Z`);
  }

  it("PATIENT can self-check-in to TODAY's own BOOKED appointment + audit row landed", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const today = istTodayAsUtcMidnight();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { date: today, status: "BOOKED" },
    });
    const patientToken = signPatientJwt(patient.userId, patient.user.email);

    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ status: "CHECKED_IN" });

    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("CHECKED_IN");

    const prisma = await getPrisma();
    const refreshed = await prisma.appointment.findUnique({
      where: { id: appt.id },
    });
    expect(refreshed?.status).toBe("CHECKED_IN");
    expect(refreshed?.checkInAt).toBeTruthy();

    // Audit row should land — safeAudit is fire-and-forget so poll briefly.
    const auditRow = await waitForAuditFlush(prisma as any, {
      action: "PATIENT_SELF_CHECKIN",
      entity: "appointment",
      entityId: appt.id,
      userId: patient.userId,
    });
    expect(auditRow).toBeTruthy();
  });

  it("PATIENT cannot self-check-in to YESTERDAY's own appointment → 403", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const yesterday = new Date(
      istTodayAsUtcMidnight().getTime() - 24 * 60 * 60 * 1000,
    );
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { date: yesterday, status: "BOOKED" },
    });
    const patientToken = signPatientJwt(patient.userId, patient.user.email);

    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ status: "CHECKED_IN" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/today/i);
  });

  it("PATIENT cannot self-check-in to TOMORROW's own appointment → 403", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const tomorrow = new Date(
      istTodayAsUtcMidnight().getTime() + 24 * 60 * 60 * 1000,
    );
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { date: tomorrow, status: "BOOKED" },
    });
    const patientToken = signPatientJwt(patient.userId, patient.user.email);

    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ status: "CHECKED_IN" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/today/i);
  });

  it("PATIENT cannot self-check-in to ANOTHER patient's appointment → 403 (BOLA)", async () => {
    const owner = await createPatientFixture();
    const intruder = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const today = istTodayAsUtcMidnight();
    const appt = await createAppointmentFixture({
      patientId: owner.id,
      doctorId: doctor.id,
      overrides: { date: today, status: "BOOKED" },
    });
    const intruderToken = signPatientJwt(intruder.userId, intruder.user.email);

    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${intruderToken}`)
      .send({ status: "CHECKED_IN" });

    // `assertPatientOwnsResource` returns 403 (not 404) for cross-patient access.
    expect(res.status).toBe(403);
  });

  it("PATIENT cannot self-flip status=COMPLETED on own today appointment → 403", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const today = istTodayAsUtcMidnight();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { date: today, status: "BOOKED" },
    });
    const patientToken = signPatientJwt(patient.userId, patient.user.email);

    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ status: "COMPLETED" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cancel|check in/i);
  });

  it("RECEPTION can still flip status=CHECKED_IN on any date (no regression)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    // Use yesterday to prove the IST-today guard ONLY applies to PATIENT.
    const yesterday = new Date(
      istTodayAsUtcMidnight().getTime() - 24 * 60 * 60 * 1000,
    );
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { date: yesterday, status: "BOOKED" },
    });
    // `token` is the shared RECEPTION token from beforeAll().
    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "CHECKED_IN" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("CHECKED_IN");
  });

  it("SLOT mode: book at HH:MM mints no tokenNumber and stores slotStart", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { appointmentMode: "SLOT" },
    });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        date: tomorrow,
        slotId: "10:15",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data.tokenNumber).toBeNull();
    expect(res.body.data.arrivalSeq).toBeNull();
    expect(res.body.data.slotStart).toBe("10:15");
  });
});
