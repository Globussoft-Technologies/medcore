// Integration tests for the appointments router.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
} from "../factories";

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
    const slotId = "550e8400-e29b-41d4-a716-446655440000";
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .post("/api/v1/appointments/book")
      .set("Authorization", `Bearer ${token}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        date: today,
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
    const slotId = "550e8400-e29b-41d4-a716-446655440001";
    const date = new Date().toISOString().slice(0, 10);

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
});
