// Integration tests for the queue router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
} from "../factories";

let app: any;
let adminToken: string;
let patientToken: string;

describeIfDB("Queue API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("lists doctor queue (public — no auth required)", async () => {
    const doctor = await createDoctorFixture();
    const patient = await createPatientFixture();
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app).get(`/api/v1/queue/${doctor.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.queue?.length).toBeGreaterThan(0);
  });

  it("returns currentToken null when nobody in consultation", async () => {
    const doctor = await createDoctorFixture();
    const res = await request(app).get(`/api/v1/queue/${doctor.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.currentToken).toBeNull();
  });

  it("queue orders by token and status (tokenNumber set, priority normal)", async () => {
    const doctor = await createDoctorFixture();
    // Fix age + gender so both patients have identical vulnerability rank
    // (the queue route re-sorts by vulnerability flags after the DB orderBy).
    const p1 = await createPatientFixture({ age: 30, gender: "MALE" });
    const p2 = await createPatientFixture({ age: 30, gender: "MALE" });
    await createAppointmentFixture({
      patientId: p1.id,
      doctorId: doctor.id,
      overrides: { tokenNumber: 1 },
    });
    await createAppointmentFixture({
      patientId: p2.id,
      doctorId: doctor.id,
      overrides: { tokenNumber: 2 },
    });
    const res = await request(app).get(`/api/v1/queue/${doctor.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.queue[0].tokenNumber).toBe(1);
    expect(res.body.data.queue[1].tokenNumber).toBe(2);
  });

  it("EMERGENCY priority bumps ahead of NORMAL", async () => {
    const doctor = await createDoctorFixture();
    const pNormal = await createPatientFixture();
    const pEmerg = await createPatientFixture();
    await createAppointmentFixture({
      patientId: pNormal.id,
      doctorId: doctor.id,
      overrides: { tokenNumber: 1, priority: "NORMAL" },
    });
    await createAppointmentFixture({
      patientId: pEmerg.id,
      doctorId: doctor.id,
      overrides: { tokenNumber: 2, priority: "EMERGENCY" },
    });
    const res = await request(app).get(`/api/v1/queue/${doctor.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.queue[0].priority).toBe("EMERGENCY");
  });

  it("totalInQueue counts only waiting/in-consult statuses", async () => {
    const doctor = await createDoctorFixture();
    const p1 = await createPatientFixture();
    await createAppointmentFixture({
      patientId: p1.id,
      doctorId: doctor.id,
      overrides: { status: "BOOKED" },
    });
    const res = await request(app).get(`/api/v1/queue/${doctor.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalInQueue).toBe(1);
  });

  it("estimatedWaitMinutes is a non-negative number", async () => {
    const doctor = await createDoctorFixture();
    const patient = await createPatientFixture();
    await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const res = await request(app).get(`/api/v1/queue/${doctor.id}`);
    expect(res.status).toBe(200);
    const item = res.body.data.queue[0];
    expect(item.estimatedWaitMinutes).toBeGreaterThanOrEqual(0);
  });

  it("display board lists all doctors", async () => {
    await createDoctorFixture();
    await createDoctorFixture();
    const res = await request(app).get("/api/v1/queue");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("notify-position requires auth (401)", async () => {
    const res = await request(app).post(
      "/api/v1/queue/notify-position/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  it("rejects PATIENT role from broadcast-positions (403)", async () => {
    const res = await request(app)
      .post("/api/v1/queue/broadcast-positions")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("ADMIN can call broadcast-positions", async () => {
    const res = await request(app)
      .post("/api/v1/queue/broadcast-positions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect([200, 201]).toContain(res.status);
  });
});
