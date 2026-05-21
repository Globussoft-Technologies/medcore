// Integration tests for Pearl ERP Stage 1 §3.2 booking-policy enforcement
// (gap-item #1, piece 1 of 3). The schema + branching-by-appointmentMode +
// per-mode tokenNumber/arrivalSeq/slotStart wiring is covered by the
// existing CALLING / SLOT cases in appointments.test.ts. This file covers
// the THREE booking-policy knobs layered on top in 2026-05-21:
//
//   - dailyAppointmentLimit  → 409 once N same-day non-cancelled rows exist
//   - lastHourPolicy=BLOCK_NEW → 409 when slotId falls in [endTime-60, endTime)
//   - tokenPrefix             → displayToken = "<prefix><n>" in the response
//
// All three use the seeded RECEPTION user; doctor + patient are minted via
// the standard fixtures and the per-doctor knobs are written directly via
// prisma (the PATCH /doctors/:id/appointment-mode surface is exercised in
// doctors.test.ts).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture, createDoctorFixture } from "../factories";

let app: any;
let token: string;

describeIfDB("Doctor appointment-mode booking policies (Pearl §3.2 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    token = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("dailyAppointmentLimit: 3rd booking returns 409 once cap of 2 is reached", async () => {
    const prisma = await getPrisma();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { dailyAppointmentLimit: 2 },
    });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    // Each booking is for a distinct patient so the doctor row isn't double-
    // booking the same MR. Use staggered slot times to dodge the slot
    // @@unique constraint independently of the cap check.
    const p1 = await createPatientFixture();
    const r1 = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: p1.id, doctorId: doctor.id, date: tomorrow, slotId: "11:00" });
    expect([200, 201]).toContain(r1.status);

    const p2 = await createPatientFixture();
    const r2 = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: p2.id, doctorId: doctor.id, date: tomorrow, slotId: "11:15" });
    expect([200, 201]).toContain(r2.status);

    const p3 = await createPatientFixture();
    const r3 = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: p3.id, doctorId: doctor.id, date: tomorrow, slotId: "11:30" });
    expect(r3.status).toBe(409);
    expect(typeof r3.body.error).toBe("string");
    expect(r3.body.error).toMatch(/daily appointment limit/i);
    expect(r3.body.error).toContain("2");
  });

  it("lastHourPolicy=BLOCK_NEW: rejects a slot in the last 60 min of the working day", async () => {
    const prisma = await getPrisma();
    const doctor = await createDoctorFixture();
    // Schedule end at 17:00 → last-hour window is [16:00, 17:00). 16:30
    // must be rejected; 15:00 (outside the window) must still book.
    // dayOfWeek must match the booking date's UTC day-of-week to mirror
    // the handler's lookup.
    const tomorrowDate = new Date(Date.now() + 86_400_000);
    const tomorrow = tomorrowDate.toISOString().slice(0, 10);
    const dayOfWeek = tomorrowDate.getUTCDay();
    await prisma.doctorSchedule.create({
      data: {
        doctorId: doctor.id,
        dayOfWeek,
        startTime: "09:00",
        endTime: "17:00",
        slotDurationMinutes: 15,
      },
    });
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { lastHourPolicy: "BLOCK_NEW" },
    });

    const inWindow = await createPatientFixture();
    const blocked = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: inWindow.id, doctorId: doctor.id, date: tomorrow, slotId: "16:30" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/last-hour/i);

    const outsideWindow = await createPatientFixture();
    const ok = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: outsideWindow.id, doctorId: doctor.id, date: tomorrow, slotId: "15:00" });
    expect([200, 201]).toContain(ok.status);
  });

  it("tokenPrefix: response.displayToken is '<prefix><n>' for TOKEN-mode doctors", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    await prisma.doctor.update({
      where: { id: doctor.id },
      data: { tokenPrefix: "A" },
    });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({ patientId: patient.id, doctorId: doctor.id, date: tomorrow, slotId: "09:45" });
    expect([200, 201]).toContain(res.status);
    expect(typeof res.body.data.tokenNumber).toBe("number");
    expect(res.body.data.displayToken).toBe(`A${res.body.data.tokenNumber}`);
  });
});
