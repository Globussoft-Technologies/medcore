// Deep / edge-case integration tests for the appointments router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
} from "../factories";

let app: any;
let reception: string;
let admin: string;

// PR #521: slotId schema changed from UUID to HH:MM time-string format.
const SLOT_A = "10:00";
const SLOT_B = "10:30";
const SLOT_C = "11:00";
const SLOT_D = "11:30";
const SLOT_E = "12:00";

function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysFromNow(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

describeIfDB("Appointments API — deep edges", () => {
  beforeAll(async () => {
    await resetDB();
    reception = await getAuthToken("RECEPTION");
    admin = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Reschedule ────────────────────────────────────────────
  it("reschedule 404 on unknown appointment", async () => {
    const res = await request(app)
      .patch(`/api/v1/appointments/550e8400-e29b-41d4-a716-446655440000/reschedule`)
      .set("Authorization", `Bearer ${reception}`)
      .send({ date: daysFromNow(1), slotStart: "10:00" });
    expect(res.status).toBe(404);
  });

  it("reschedule of COMPLETED appointment returns 400", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { status: "COMPLETED" },
    });
    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/reschedule`)
      .set("Authorization", `Bearer ${reception}`)
      .send({ date: daysFromNow(1), slotStart: "11:00" });
    expect(res.status).toBe(400);
  });

  it("reschedule into an occupied slot returns 409", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const prisma = await getPrisma();
    const date = new Date(daysFromNow(2));
    // Seed a booking in slot 12:00
    await prisma.appointment.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        date,
        slotStart: "12:00",
        tokenNumber: 1,
        status: "BOOKED",
        type: "SCHEDULED",
      },
    });
    // create a second appointment to reschedule into 12:00
    const other = await prisma.appointment.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        date,
        slotStart: "13:00",
        tokenNumber: 2,
        status: "BOOKED",
        type: "SCHEDULED",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/appointments/${other.id}/reschedule`)
      .set("Authorization", `Bearer ${reception}`)
      .send({ date: daysFromNow(2), slotStart: "12:00" });
    expect(res.status).toBe(409);
  });

  // ─── Recurring ─────────────────────────────────────────────
  it("recurring creates N WEEKLY appointments", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/appointments/recurring")
      .set("Authorization", `Bearer ${reception}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        startDate: daysFromNow(7),
        slotStart: "09:00",
        frequency: "WEEKLY",
        occurrences: 4,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.length).toBe(4);
  });

  it("recurring DAILY detects conflict on one day", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const prisma = await getPrisma();
    const d = new Date(daysFromNow(10));
    d.setDate(d.getDate() + 1);
    await prisma.appointment.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        date: d,
        slotStart: "10:00",
        tokenNumber: 1,
        status: "BOOKED",
        type: "SCHEDULED",
      },
    });
    const res = await request(app)
      .post("/api/v1/appointments/recurring")
      .set("Authorization", `Bearer ${reception}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        startDate: daysFromNow(10),
        slotStart: "10:00",
        frequency: "DAILY",
        occurrences: 3,
      });
    expect(res.status).toBe(409);
  });

  it("recurring MONTHLY path succeeds", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/appointments/recurring")
      .set("Authorization", `Bearer ${reception}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        startDate: daysFromNow(14),
        slotStart: "15:00",
        frequency: "MONTHLY",
        occurrences: 3,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.length).toBe(3);
  });

  // ─── Group booking ─────────────────────────────────────────
  it("group booking creates N appointments with same groupId", async () => {
    const patients = await Promise.all([
      createPatientFixture(),
      createPatientFixture(),
      createPatientFixture(),
    ]);
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/appointments/group")
      .set("Authorization", `Bearer ${reception}`)
      .send({
        doctorId: doctor.id,
        date: daysFromNow(3),
        slotStart: "11:00",
        patientIds: patients.map((p) => p.id),
        notes: "yoga therapy",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.groupId).toMatch(/^GRP-/);
    expect(res.body.data?.appointments?.length).toBe(3);
  });

  it("group booking rejects empty patientIds", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/appointments/group")
      .set("Authorization", `Bearer ${reception}`)
      .send({ doctorId: doctor.id, date: daysFromNow(3), patientIds: [] });
    expect(res.status).toBe(400);
  });

  it("group listing returns members for a groupId", async () => {
    const patients = await Promise.all([createPatientFixture(), createPatientFixture()]);
    const doctor = await createDoctorFixture();
    const create = await request(app)
      .post("/api/v1/appointments/group")
      .set("Authorization", `Bearer ${reception}`)
      .send({
        doctorId: doctor.id,
        date: daysFromNow(4),
        slotStart: "14:00",
        patientIds: patients.map((p) => p.id),
      });
    const groupId = create.body.data.groupId;
    const list = await request(app)
      .get(`/api/v1/appointments/group/${groupId}`)
      .set("Authorization", `Bearer ${reception}`);
    expect(list.status).toBe(200);
    expect(list.body.data?.members?.length).toBe(2);
  });

  // ─── No-show policy ────────────────────────────────────────
  it("booking blocked for patient over no-show threshold", async () => {
    const patient = await createPatientFixture({ noShowCount: 99 });
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${reception}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        date: today(),
        slotId: SLOT_A,
      });
    expect(res.status).toBe(400);
  });

  it("no-show status increments patient counter", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { status: "BOOKED" },
    });
    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/status`)
      .set("Authorization", `Bearer ${reception}`)
      .send({ status: "NO_SHOW" });
    expect(res.status).toBe(200);
    const prisma = await getPrisma();
    const p = await prisma.patient.findUnique({ where: { id: patient.id } });
    expect(p?.noShowCount).toBeGreaterThanOrEqual(1);
  });

  // ─── LWBS ──────────────────────────────────────────────────
  it("mark-lwbs converts BOOKED to NO_SHOW with reason", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/mark-lwbs`)
      .set("Authorization", `Bearer ${reception}`)
      .send({ reason: "patient left after 2h wait" });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("NO_SHOW");
    expect(res.body.data?.lwbsReason).toContain("2h");
  });

  it("lwbs on completed appointment returns 409", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { status: "COMPLETED" },
    });
    const res = await request(app)
      .patch(`/api/v1/appointments/${appt.id}/lwbs`)
      .set("Authorization", `Bearer ${reception}`)
      .send({ reason: "x" });
    expect(res.status).toBe(409);
  });

  // ─── Double-booking prevention ─────────────────────────────
  it("double-booking the same slot returns 409", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res1 = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${reception}`)
      // PR #521: route's #491 past-time guard rejects today + early-AM
      // slot when CI runs after that wall-clock time; use tomorrow.
      .send({ patientId: patient.id, doctorId: doctor.id, date: daysFromNow(1), slotId: SLOT_B });
    expect([200, 201]).toContain(res1.status);
    const res2 = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${reception}`)
      // PR #521: route's #491 past-time guard rejects today + early-AM
      // slot when CI runs after that wall-clock time; use tomorrow.
      .send({ patientId: patient.id, doctorId: doctor.id, date: daysFromNow(1), slotId: SLOT_B });
    expect(res2.status).toBe(409);
  });

  // ─── Walk-in vs scheduled ──────────────────────────────────
  it("walk-in assigns token for today", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/appointments/walk-in")
      .set("Authorization", `Bearer ${reception}`)
      .send({ patientId: patient.id, doctorId: doctor.id, priority: "URGENT" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.type).toBe("WALK_IN");
    expect(res.body.data?.priority).toBe("URGENT");
  });

  // ─── Transfer ──────────────────────────────────────────────
  it("transfer to same doctor returns 400", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .post(`/api/v1/appointments/${appt.id}/transfer`)
      .set("Authorization", `Bearer ${reception}`)
      .send({ newDoctorId: doctor.id, reason: "none" });
    expect(res.status).toBe(400);
  });

  it("transfer to unknown doctor returns 404", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .post(`/api/v1/appointments/${appt.id}/transfer`)
      .set("Authorization", `Bearer ${reception}`)
      .send({
        newDoctorId: "550e8400-e29b-41d4-a716-446655440000",
        reason: "refer out",
      });
    expect(res.status).toBe(404);
  });

  it("transfer completed appointment returns 409", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const d2 = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { status: "COMPLETED" },
    });
    const res = await request(app)
      .post(`/api/v1/appointments/${appt.id}/transfer`)
      .set("Authorization", `Bearer ${reception}`)
      .send({ newDoctorId: d2.id, reason: "r" });
    expect(res.status).toBe(409);
  });

  // ─── Check conflict ────────────────────────────────────────
  it("check-conflict returns empty when no conflict", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(
        `/api/v1/appointments/check-conflict?patientId=${patient.id}&date=${daysFromNow(20)}&slotStart=09:00`
      )
      .set("Authorization", `Bearer ${reception}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.hasConflict).toBe(false);
  });

  it("check-conflict missing params returns 400", async () => {
    const res = await request(app)
      .get("/api/v1/appointments/check-conflict")
      .set("Authorization", `Bearer ${reception}`);
    expect(res.status).toBe(400);
  });

  // ─── Bulk-action ───────────────────────────────────────────
  it("bulk-action invalid action returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/appointments/bulk-action")
      .set("Authorization", `Bearer ${reception}`)
      .send({ appointmentIds: ["x"], action: "NUKE" });
    expect(res.status).toBe(400);
  });

  it("bulk-action CANCEL skips COMPLETED appointments", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const a1 = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { status: "COMPLETED" },
    });
    const a2 = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app)
      .post("/api/v1/appointments/bulk-action")
      .set("Authorization", `Bearer ${admin}`)
      .send({ appointmentIds: [a1.id, a2.id], action: "CANCEL" });
    expect(res.status).toBe(200);
    expect(res.body.data?.processed).toBe(1);
    expect(res.body.data?.skipped).toBe(1);
  });

  // ─── Stats / calendar / next-available ──────────────────────
  it("stats returns zeroed buckets when no appointments in range", async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/stats?from=${daysFromNow(100)}&to=${daysFromNow(101)}`)
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.totalCount).toBe(0);
  });

  it("calendar endpoint returns 200", async () => {
    const res = await request(app)
      .get("/api/v1/appointments/calendar")
      .set("Authorization", `Bearer ${reception}`);
    expect(res.status).toBe(200);
  });

  it("next-available slot endpoint returns 200", async () => {
    const res = await request(app)
      .get("/api/v1/appointments/next-available")
      .set("Authorization", `Bearer ${reception}`);
    expect(res.status).toBe(200);
  });

  // Issue #950 — round-trip regression. The /next-available suggestion
  // advertises a (doctorId, doctorName, date, startTime) tuple, and the
  // user is shown that doctor name on the confirm card. If we then POST
  // /book with that exact doctorId, the persisted appointment MUST be
  // assigned to the same doctor — anything else is a scheduling-integrity
  // bug (the user agreed to book Dr. A and ended up with Dr. B).
  // Pre-fix the web flow re-derived doctorId from React state after the
  // user re-picked the slot in the booking form, and form-state drift
  // (DoctorSelect re-render / channel auto-derivation / date input edit
  // between confirm-shown and confirm-clicked) could silently flip the
  // doctor. The fix locks the suggestion's doctorId into a separate
  // override that wins over form state until the booking completes.
  // This test pins the API contract that the post-fix client relies on.
  it(
    "Issue #950: next-available -> /book round-trip persists the suggested doctor",
    async () => {
      const prisma = await getPrisma();
      // Seed two doctors with identical Sunday-through-Saturday schedules
      // so /next-available has a deterministic pool to pick from.
      const drA = await createDoctorFixture();
      const drB = await createDoctorFixture();
      for (const docId of [drA.id, drB.id]) {
        for (let dow = 0; dow < 7; dow++) {
          await prisma.doctorSchedule.create({
            data: {
              doctorId: docId,
              dayOfWeek: dow,
              startTime: "09:00",
              endTime: "17:00",
              slotDurationMinutes: 30,
            },
          });
        }
      }
      const patient = await createPatientFixture();

      const suggest = await request(app)
        .get("/api/v1/appointments/next-available")
        .set("Authorization", `Bearer ${reception}`);
      expect(suggest.status).toBe(200);
      expect(suggest.body.data?.slot).toBeTruthy();
      const slot = suggest.body.data.slot as {
        doctorId: string;
        doctorName: string;
        date: string;
        startTime: string;
      };
      expect([drA.id, drB.id]).toContain(slot.doctorId);

      // The web client posts /book with the EXACT doctorId the
      // suggestion advertised. Verify the API persists that doctor.
      const book = await request(app)
        .post("/api/v1/appointments/book")
        .set("Authorization", `Bearer ${reception}`)
        .send({
          patientId: patient.id,
          doctorId: slot.doctorId,
          date: slot.date,
          slotId: slot.startTime,
        });
      expect(book.status).toBe(201);
      expect(book.body.data?.doctorId).toBe(slot.doctorId);

      // Re-read the row to defend against any post-create remapping.
      const persisted = await prisma.appointment.findUnique({
        where: { id: book.body.data.id },
        select: { doctorId: true },
      });
      expect(persisted?.doctorId).toBe(slot.doctorId);
    }
  );

  // ─── Calendar.ics ──────────────────────────────────────────
  it("calendar.ics returns iCalendar text", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      overrides: { slotStart: "10:00" },
    });
    const res = await request(app)
      .get(`/api/v1/appointments/${appt.id}/calendar.ics`)
      .set("Authorization", `Bearer ${reception}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");
    expect(res.text).toContain("BEGIN:VCALENDAR");
  });

  it("calendar.ics 404 on unknown id", async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/550e8400-e29b-41d4-a716-446655440000/calendar.ics`)
      .set("Authorization", `Bearer ${reception}`);
    expect(res.status).toBe(404);
  });

  // ─── Unknown get ───────────────────────────────────────────
  it("GET /:id 404 on unknown", async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/550e8400-e29b-41d4-a716-446655440000`)
      .set("Authorization", `Bearer ${reception}`);
    expect(res.status).toBe(404);
  });

  it("unauthenticated list returns 401", async () => {
    const res = await request(app).get("/api/v1/appointments");
    expect(res.status).toBe(401);
    expect(SLOT_C && SLOT_D && SLOT_E).toBeTruthy();
  });
});
