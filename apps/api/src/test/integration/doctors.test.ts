// Integration tests for the doctors router (schedules, slots, overrides).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createDoctorFixture } from "../factories";

let app: any;
let adminToken: string;
let patientToken: string;

describeIfDB("Doctors API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("401 without token on list doctors", async () => {
    const res = await request(app).get("/api/v1/doctors");
    expect(res.status).toBe(401);
  });

  it("lists doctors with schedule relation", async () => {
    await createDoctorFixture();
    const res = await request(app)
      .get("/api/v1/doctors")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("creates a schedule (happy path)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post(`/api/v1/doctors/${doctor.id}/schedule`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorId: doctor.id,
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "13:00",
        slotDurationMinutes: 15,
        bufferMinutes: 0,
      });
    expect([200, 201]).toContain(res.status);
    const prisma = await getPrisma();
    const rows = await prisma.doctorSchedule.findMany({
      where: { doctorId: doctor.id },
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("rejects malformed schedule payload (400)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post(`/api/v1/doctors/${doctor.id}/schedule`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorId: doctor.id,
        dayOfWeek: 9, // invalid
        startTime: "9am",
        endTime: "13:00",
        slotDurationMinutes: 15,
      });
    expect(res.status).toBe(400);
  });

  it("rejects schedule POST from PATIENT (403)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post(`/api/v1/doctors/${doctor.id}/schedule`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        doctorId: doctor.id,
        dayOfWeek: 2,
        startTime: "10:00",
        endTime: "12:00",
        slotDurationMinutes: 20,
      });
    expect(res.status).toBe(403);
  });

  it("generates slots for configured day", async () => {
    const doctor = await createDoctorFixture();
    // Pick a date that is a Monday (dayOfWeek 1)
    const d = new Date();
    d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7));
    const dateStr = d.toISOString().slice(0, 10);
    await request(app)
      .post(`/api/v1/doctors/${doctor.id}/schedule`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorId: doctor.id,
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "10:00",
        slotDurationMinutes: 15,
        bufferMinutes: 0,
      });
    const res = await request(app)
      .get(`/api/v1/doctors/${doctor.id}/slots?date=${dateStr}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.slots?.length).toBeGreaterThanOrEqual(4);
    expect(res.body.data?.blocked).toBe(false);
  });

  it("returns 400 when /slots called without date", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .get(`/api/v1/doctors/${doctor.id}/slots`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("blocks a date via override and slots returns blocked=true", async () => {
    const doctor = await createDoctorFixture();
    const dateStr = "2099-12-25";
    const ov = await request(app)
      .post(`/api/v1/doctors/${doctor.id}/override`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorId: doctor.id,
        date: dateStr,
        isBlocked: true,
        reason: "Holiday",
      });
    expect([200, 201]).toContain(ov.status);
    const res = await request(app)
      .get(`/api/v1/doctors/${doctor.id}/slots?date=${dateStr}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.blocked).toBe(true);
  });

  it("upserts schedule on duplicate (dayOfWeek, startTime) — endTime updates", async () => {
    const doctor = await createDoctorFixture();
    await request(app)
      .post(`/api/v1/doctors/${doctor.id}/schedule`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorId: doctor.id,
        dayOfWeek: 3,
        startTime: "09:00",
        endTime: "11:00",
        slotDurationMinutes: 15,
      });
    const res = await request(app)
      .post(`/api/v1/doctors/${doctor.id}/schedule`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorId: doctor.id,
        dayOfWeek: 3,
        startTime: "09:00",
        endTime: "14:00",
        slotDurationMinutes: 15,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.endTime).toBe("14:00");
  });

  // Issue #56 / #77 — the Schedule Management page hits these endpoints; if
  // they 404 the grid silently shows "No slots". Cover GET schedule,
  // GET overrides, ADMIN authorize on POST schedule, and Sunday support.
  it("GET /:id/schedule returns rows shaped for the page (Issue #56)", async () => {
    const doctor = await createDoctorFixture();
    await request(app)
      .post(`/api/v1/doctors/${doctor.id}/schedule`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorId: doctor.id,
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "13:00",
        slotDurationMinutes: 15,
      });
    const res = await request(app)
      .get(`/api/v1/doctors/${doctor.id}/schedule`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).toMatchObject({
      dayOfWeek: "MONDAY",
      startTime: "09:00",
      endTime: "13:00",
      slotDuration: 15,
    });
  });

  it("GET /:id/overrides returns array (Issue #56)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .get(`/api/v1/doctors/${doctor.id}/overrides`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("POST /:id/schedule authorizes ADMIN (Issue #77)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post(`/api/v1/doctors/${doctor.id}/schedule`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorId: doctor.id,
        dayOfWeek: 0, // Sunday — explicitly allowed (Issue #77)
        startTime: "10:00",
        endTime: "14:00",
        slotDurationMinutes: 15,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("POST /:id/schedule accepts day-name strings (Issue #77)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post(`/api/v1/doctors/${doctor.id}/schedule`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        doctorId: doctor.id,
        dayOfWeek: "SUNDAY",
        startTime: "11:00",
        endTime: "15:00",
        slotDurationMinutes: 30,
      });
    expect([200, 201]).toContain(res.status);
  });

  // ─────────────────────────────────────────────────────────
  // PATCH /api/v1/doctors/:id/appointment-mode
  // Pearl ERP Stage 1 §2.1.2 / §3.2 — per-doctor mode + knobs.
  // ─────────────────────────────────────────────────────────

  it("PATCH appointment-mode: ADMIN can set CALLING mode + knobs", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .patch(`/api/v1/doctors/${doctor.id}/appointment-mode`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        appointmentMode: "CALLING",
        tokenPrefix: "C",
        tokenStartNumber: 1,
        nearTurnAlertThreshold: 3,
        lastHourPolicy: "BLOCK_NEW",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.appointmentMode).toBe("CALLING");
    expect(res.body.data.tokenPrefix).toBe("C");
    expect(res.body.data.nearTurnAlertThreshold).toBe(3);
    expect(res.body.data.lastHourPolicy).toBe("BLOCK_NEW");
  });

  it("PATCH appointment-mode: PATCH semantics — undefined fields are untouched", async () => {
    const doctor = await createDoctorFixture();
    const prisma = await getPrisma();

    // First set tokenPrefix + appointmentMode
    await request(app)
      .patch(`/api/v1/doctors/${doctor.id}/appointment-mode`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ appointmentMode: "SLOT", tokenPrefix: "S" })
      .expect(200);

    // Then update only dailyAppointmentLimit — tokenPrefix must stay "S"
    await request(app)
      .patch(`/api/v1/doctors/${doctor.id}/appointment-mode`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ dailyAppointmentLimit: 40 })
      .expect(200);

    const after = await prisma.doctor.findUnique({
      where: { id: doctor.id },
      select: {
        appointmentMode: true,
        tokenPrefix: true,
        dailyAppointmentLimit: true,
      },
    });
    expect(after?.appointmentMode).toBe("SLOT");
    expect(after?.tokenPrefix).toBe("S");
    expect(after?.dailyAppointmentLimit).toBe(40);
  });

  it("PATCH appointment-mode: null clears a knob", async () => {
    const doctor = await createDoctorFixture();
    const prisma = await getPrisma();

    await request(app)
      .patch(`/api/v1/doctors/${doctor.id}/appointment-mode`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ tokenPrefix: "T", dailyAppointmentLimit: 50 })
      .expect(200);

    await request(app)
      .patch(`/api/v1/doctors/${doctor.id}/appointment-mode`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ tokenPrefix: null })
      .expect(200);

    const after = await prisma.doctor.findUnique({
      where: { id: doctor.id },
      select: { tokenPrefix: true, dailyAppointmentLimit: true },
    });
    expect(after?.tokenPrefix).toBeNull();
    expect(after?.dailyAppointmentLimit).toBe(50); // unchanged
  });

  it("PATCH appointment-mode: rejects invalid enum value (400)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .patch(`/api/v1/doctors/${doctor.id}/appointment-mode`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ appointmentMode: "BANANA" });
    expect(res.status).toBe(400);
  });

  it("PATCH appointment-mode: PATIENT role is forbidden (403)", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .patch(`/api/v1/doctors/${doctor.id}/appointment-mode`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ appointmentMode: "TOKEN" });
    expect(res.status).toBe(403);
  });

  it("PATCH appointment-mode: persists NMC reg number (Pearl §2.1.4)", async () => {
    const doctor = await createDoctorFixture();
    const prisma = await getPrisma();

    await request(app)
      .patch(`/api/v1/doctors/${doctor.id}/appointment-mode`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ nmcRegNumber: "NMC/2024/12345" })
      .expect(200);

    const after = await prisma.doctor.findUnique({
      where: { id: doctor.id },
      select: { nmcRegNumber: true },
    });
    expect(after?.nmcRegNumber).toBe("NMC/2024/12345");

    // Empty string in body clears the field.
    await request(app)
      .patch(`/api/v1/doctors/${doctor.id}/appointment-mode`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ nmcRegNumber: null })
      .expect(200);

    const cleared = await prisma.doctor.findUnique({
      where: { id: doctor.id },
      select: { nmcRegNumber: true },
    });
    expect(cleared?.nmcRegNumber).toBeNull();
  });

  it("PATCH appointment-mode: writes an audit log entry", async () => {
    const doctor = await createDoctorFixture();
    const prisma = await getPrisma();
    const before = await prisma.auditLog.count({
      where: { entity: "doctor", entityId: doctor.id, action: "DOCTOR_APPOINTMENT_MODE_UPDATE" },
    });
    await request(app)
      .patch(`/api/v1/doctors/${doctor.id}/appointment-mode`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ appointmentMode: "SLOT" })
      .expect(200);
    // auditLog is fire-and-forget; allow a brief window for the insert.
    await new Promise((r) => setTimeout(r, 50));
    const after = await prisma.auditLog.count({
      where: { entity: "doctor", entityId: doctor.id, action: "DOCTOR_APPOINTMENT_MODE_UPDATE" },
    });
    expect(after).toBeGreaterThan(before);
  });
});
