// Integration tests for the coordinated-visits router. The router books a
// CoordinatedVisit + back-to-back appointments by reading each doctor's
// DoctorSchedule, so each test that exercises the happy path must seed a
// schedule for every doctor it uses. notification-triggers fire & forget so
// they're harmless; we still mock them to avoid network hits during CI.
//
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
} from "../factories";

vi.mock("../../services/notification-triggers", () => ({
  onAppointmentBooked: vi.fn().mockResolvedValue(undefined),
  onAppointmentCancelled: vi.fn().mockResolvedValue(undefined),
}));

let app: any;
let adminToken: string;
let receptionToken: string;
let doctorToken: string;
let patientToken: string;
let nurseToken: string;

async function seedDoctorWithSchedule() {
  const prisma = await getPrisma();
  const doctor = await createDoctorFixture();
  // Seed a wide-open schedule for every weekday so any visitDate within the
  // current week resolves to bookable slots without time-zone surprises.
  for (let dow = 0; dow <= 6; dow++) {
    await prisma.doctorSchedule.create({
      data: {
        doctorId: doctor.id,
        dayOfWeek: dow,
        startTime: "09:00",
        endTime: "17:00",
        slotDurationMinutes: 30,
        bufferMinutes: 0,
      },
    });
  }
  return doctor;
}

function tomorrowYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

describeIfDB("Coordinated Visits API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /coordinated-visits ────────────────────────────────────────
  it("POST / creates a coordinated visit + back-to-back appointments (201)", async () => {
    const patient = await createPatientFixture();
    const d1 = await seedDoctorWithSchedule();
    const d2 = await seedDoctorWithSchedule();
    const res = await request(app)
      .post("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        name: "Multi-specialty review",
        visitDate: tomorrowYmd(),
        doctorIds: [d1.id, d2.id],
      });
    expect(res.status).toBe(201);
    expect(res.body.data?.visit?.id).toBeTruthy();
    expect(Array.isArray(res.body.data?.appointments)).toBe(true);
    expect(res.body.data.appointments).toHaveLength(2);
    // Back-to-back: appt #2 starts at-or-after appt #1's end.
    const a = res.body.data.appointments[0];
    const b = res.body.data.appointments[1];
    expect(b.slotStart >= a.slotEnd).toBe(true);
  });

  it("POST / 401 without auth", async () => {
    const res = await request(app)
      .post("/api/v1/coordinated-visits")
      .send({ patientId: "x", name: "y", visitDate: "2026-05-01", doctorIds: [] });
    expect(res.status).toBe(401);
  });

  it("POST / 403 for PATIENT", async () => {
    const patient = await createPatientFixture();
    const d1 = await seedDoctorWithSchedule();
    const res = await request(app)
      .post("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        patientId: patient.id,
        name: "x",
        visitDate: tomorrowYmd(),
        doctorIds: [d1.id],
      });
    expect(res.status).toBe(403);
  });

  it("POST / 403 for NURSE (only ADMIN+RECEPTION+DOCTOR)", async () => {
    const patient = await createPatientFixture();
    const d1 = await seedDoctorWithSchedule();
    const res = await request(app)
      .post("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        name: "x",
        visitDate: tomorrowYmd(),
        doctorIds: [d1.id],
      });
    expect(res.status).toBe(403);
  });

  it("POST / 400 on invalid payload (no doctorIds)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        name: "x",
        visitDate: tomorrowYmd(),
        doctorIds: [],
      });
    expect(res.status).toBe(400);
  });

  it("POST / 409 when a doctor has no schedule (no available slots)", async () => {
    const patient = await createPatientFixture();
    const d1 = await seedDoctorWithSchedule();
    // d2 has NO schedule rows — computeAvailableSlots returns []
    const d2 = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        name: "x",
        visitDate: tomorrowYmd(),
        doctorIds: [d1.id, d2.id],
      });
    expect(res.status).toBe(409);
  });

  // ─── GET /coordinated-visits ─────────────────────────────────────────
  it("GET / lists coordinated visits", async () => {
    const res = await request(app)
      .get("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET / 401 without auth", async () => {
    const res = await request(app).get("/api/v1/coordinated-visits");
    expect(res.status).toBe(401);
  });

  it("GET / scopes PATIENT to own visits only", async () => {
    // Create a visit for some random patient
    const otherPatient = await createPatientFixture();
    const d1 = await seedDoctorWithSchedule();
    await request(app)
      .post("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: otherPatient.id,
        name: "Some other visit",
        visitDate: tomorrowYmd(),
        doctorIds: [d1.id],
      });
    // The PATIENT token's linked patient row has no visits. The handler
    // overrides patientId with the patient's own id, so the result must
    // exclude `otherPatient`'s visit.
    const res = await request(app)
      .get("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    expect(
      (res.body.data as any[]).every((v) => v.patientId !== otherPatient.id)
    ).toBe(true);
  });

  // ─── GET /coordinated-visits/:id ─────────────────────────────────────
  it("GET /:id 200 for known visit", async () => {
    const patient = await createPatientFixture();
    const d1 = await seedDoctorWithSchedule();
    const created = await request(app)
      .post("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        name: "Detail test",
        visitDate: tomorrowYmd(),
        doctorIds: [d1.id],
      });
    expect(created.status).toBe(201);
    const visitId = created.body.data.visit.id;
    const res = await request(app)
      .get(`/api/v1/coordinated-visits/${visitId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(visitId);
    expect(Array.isArray(res.body.data?.appointments)).toBe(true);
  });

  it("GET /:id 404 for unknown id", async () => {
    const res = await request(app)
      .get("/api/v1/coordinated-visits/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("GET /:id 401 without auth", async () => {
    const res = await request(app).get(
      "/api/v1/coordinated-visits/00000000-0000-4000-8000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  // ─── PATCH /coordinated-visits/:id/cancel ────────────────────────────
  it("PATCH /:id/cancel cancels member appointments (200)", async () => {
    const patient = await createPatientFixture();
    const d1 = await seedDoctorWithSchedule();
    const d2 = await seedDoctorWithSchedule();
    const created = await request(app)
      .post("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        name: "Will cancel",
        visitDate: tomorrowYmd(),
        doctorIds: [d1.id, d2.id],
      });
    expect(created.status).toBe(201);
    const visitId = created.body.data.visit.id;

    const res = await request(app)
      .patch(`/api/v1/coordinated-visits/${visitId}/cancel`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.cancelled).toBe(2);

    // Verify side-effect: each member appt is now CANCELLED.
    const prisma = await getPrisma();
    const appts = await prisma.appointment.findMany({
      where: { coordinatedVisitId: visitId },
    });
    expect(appts.every((a: { status: string }) => a.status === "CANCELLED")).toBe(true);
  });

  it("PATCH /:id/cancel 404 for unknown visit", async () => {
    const res = await request(app)
      .patch(
        "/api/v1/coordinated-visits/00000000-0000-4000-8000-000000000000/cancel"
      )
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(404);
  });

  it("PATCH /:id/cancel 401 without auth", async () => {
    const res = await request(app).patch(
      "/api/v1/coordinated-visits/00000000-0000-4000-8000-000000000000/cancel"
    );
    expect(res.status).toBe(401);
  });

  it("PATCH /:id/cancel 403 for NURSE (not in allowlist)", async () => {
    const res = await request(app)
      .patch(
        "/api/v1/coordinated-visits/00000000-0000-4000-8000-000000000000/cancel"
      )
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("PATCH /:id/cancel 403 when PATIENT tries to cancel another patient's visit", async () => {
    const otherPatient = await createPatientFixture();
    const d1 = await seedDoctorWithSchedule();
    const created = await request(app)
      .post("/api/v1/coordinated-visits")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: otherPatient.id,
        name: "Not yours",
        visitDate: tomorrowYmd(),
        doctorIds: [d1.id],
      });
    expect(created.status).toBe(201);
    const visitId = created.body.data.visit.id;

    const res = await request(app)
      .patch(`/api/v1/coordinated-visits/${visitId}/cancel`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });
});
