// Integration tests for vitals recording under /api/v1/patients/:id/vitals.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
} from "../factories";

let app: any;
let nurseToken: string;
let patientToken: string;

async function setupContext() {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  return { patient, doctor, appt };
}

describeIfDB("Vitals API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    nurseToken = await getAuthToken("NURSE");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("401 without token", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("records normal vitals (happy path)", async () => {
    const { patient, appt } = await setupContext();
    const res = await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        appointmentId: appt.id,
        bloodPressureSystolic: 118,
        bloodPressureDiastolic: 78,
        pulseRate: 72,
        spO2: 98,
        temperature: 98.6,
        temperatureUnit: "F",
        weight: 70,
        height: 175,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.isAbnormal).toBe(false);
    expect(res.body.data?.bmi).toBeGreaterThan(0);
  });

  it("flags abnormal on high BP", async () => {
    const { patient, appt } = await setupContext();
    const res = await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        appointmentId: appt.id,
        bloodPressureSystolic: 200,
        bloodPressureDiastolic: 120,
        pulseRate: 72,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.isAbnormal).toBe(true);
    expect(res.body.data?.abnormalFlags).toBeTruthy();
  });

  it("flags abnormal on low SpO2", async () => {
    const { patient, appt } = await setupContext();
    const res = await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        appointmentId: appt.id,
        spO2: 85,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.isAbnormal).toBe(true);
  });

  it("rejects out-of-range systolic (400)", async () => {
    const { patient, appt } = await setupContext();
    const res = await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        appointmentId: appt.id,
        bloodPressureSystolic: 500,
      });
    expect(res.status).toBe(400);
  });

  it("rejects pain scale > 10 (400)", async () => {
    const { patient, appt } = await setupContext();
    const res = await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        appointmentId: appt.id,
        painScale: 50,
      });
    expect(res.status).toBe(400);
  });

  it("rejects PATIENT role (403)", async () => {
    const { patient, appt } = await setupContext();
    const res = await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        patientId: patient.id,
        appointmentId: appt.id,
        pulseRate: 70,
      });
    expect(res.status).toBe(403);
  });

  it("persists vitals to DB (side-effect check)", async () => {
    const { patient, appt } = await setupContext();
    await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        appointmentId: appt.id,
        pulseRate: 65,
      });
    const prisma = await getPrisma();
    const rows = await prisma.vitals.findMany({
      where: { patientId: patient.id },
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("returns vitals-baseline for patient", async () => {
    const { patient } = await setupContext();
    const res = await request(app)
      .get(`/api/v1/patients/${patient.id}/vitals-baseline`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
  });

  it("GET /vitals lists recorded vitals and respects ?limit", async () => {
    const { patient, doctor, appt } = await setupContext();
    // Vitals.appointmentId is @unique (one snapshot per appointment), so two
    // separate readings need two separate appointments to land as two rows.
    const appt2 = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ patientId: patient.id, appointmentId: appt.id, pulseRate: 60 });
    await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ patientId: patient.id, appointmentId: appt2.id, pulseRate: 80 });

    const all = await request(app)
      .get(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body.data)).toBe(true);
    expect(all.body.data.length).toBeGreaterThanOrEqual(2);

    const limited = await request(app)
      .get(`/api/v1/patients/${patient.id}/vitals?limit=1`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(limited.status).toBe(200);
    expect(limited.body.data).toHaveLength(1);
  });

  it("GET /vitals returns an empty list for a patient with no vitals", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("re-recording for the same appointment UPDATES (no P2002 duplicate)", async () => {
    const { patient, appt } = await setupContext();
    const first = await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        appointmentId: appt.id,
        pulseRate: 70,
        spO2: 98,
      });
    expect([200, 201]).toContain(first.status);

    // Second save for the SAME appointment — Vitals.appointmentId is @unique,
    // so this must update the existing row, not 400 with a unique violation.
    const second = await request(app)
      .post(`/api/v1/patients/${patient.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        appointmentId: appt.id,
        pulseRate: 88,
        spO2: 99,
      });
    expect([200, 201]).toContain(second.status);
    expect(second.body.data?.pulseRate).toBe(88);

    // Exactly one vitals row for this appointment.
    const prisma = await getPrisma();
    const rows = await prisma.vitals.findMany({
      where: { appointmentId: appt.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].pulseRate).toBe(88);
  });

  it("GET /vitals 401 without token", async () => {
    const patient = await createPatientFixture();
    const res = await request(app).get(`/api/v1/patients/${patient.id}/vitals`);
    expect(res.status).toBe(401);
  });
});
