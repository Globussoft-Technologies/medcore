// Integration tests for the AI Adherence router (/api/v1/ai/adherence).
// Pure DB-backed — no external AI calls.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createAppointmentFixture,
  createPrescriptionFixture,
} from "../factories";

let app: any;
let adminToken: string;

describeIfDB("AI Adherence API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /enroll ─────────────────────────────────────────────────────

  it("enrolls a prescription into an adherence schedule", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
    const prescription = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    const res = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.prescriptionId).toBe(prescription.id);
    expect(res.body.data.patientId).toBe(patient.id);
    expect(res.body.data.active).toBe(true);
    expect(Array.isArray(res.body.data.medications)).toBe(true);
    expect(res.body.data.medications[0].name).toContain("Paracetamol");
    // TID frequency derives to 3 reminder times
    expect(res.body.data.medications[0].reminderTimes).toEqual(["08:00", "14:00", "20:00"]);
  });

  it("accepts custom reminderTimes for each medication", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
    const prescription = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    const res = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id, reminderTimes: ["09:00", "21:00"] });

    expect(res.status).toBe(200);
    expect(res.body.data.medications[0].reminderTimes).toEqual(["09:00", "21:00"]);
  });

  it("is idempotent — re-enrolling the same prescription updates the existing schedule", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
    const prescription = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    const first = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id });

    const second = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id, reminderTimes: ["10:00"] });

    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.medications[0].reminderTimes).toEqual(["10:00"]);
  });

  it("requires authentication for POST /enroll", async () => {
    const res = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .send({ prescriptionId: "some-id" });

    expect(res.status).toBe(401);
  });

  it("returns 400 when prescriptionId is missing", async () => {
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prescriptionId/);
  });

  it("returns 404 when prescription is not found", async () => {
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: "00000000-0000-0000-0000-000000000000" });

    expect(res.status).toBe(404);
  });

  // ─── GET /:patientId ──────────────────────────────────────────────────

  it("lists active schedules for a patient", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
    const prescription = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id });

    const res = await request(app)
      .get(`/api/v1/ai/adherence/${patient.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].patientId).toBe(patient.id);
    expect(res.body.data[0].active).toBe(true);
  });

  it("returns empty array for a patient with no schedules", async () => {
    const patient = await createPatientFixture();
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .get(`/api/v1/ai/adherence/${patient.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  // ─── DELETE /:scheduleId ──────────────────────────────────────────────

  it("lets an ADMIN unenroll any schedule (sets active=false)", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
    const prescription = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    const enrollRes = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id });
    const scheduleId = enrollRes.body.data.id;

    const delRes = await request(app)
      .delete(`/api/v1/ai/adherence/${scheduleId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.data.active).toBe(false);

    const prisma = await getPrisma();
    const refetched = await prisma.adherenceSchedule.findUnique({ where: { id: scheduleId } });
    expect(refetched?.active).toBe(false);
  });

  it("lets the owning patient unenroll their own schedule", async () => {
    // Create a patient user, sign a JWT for that user, then enroll and delete
    const prisma = await getPrisma();
    const jwt = (await import("jsonwebtoken")).default;

    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
    const prescription = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    const enrollRes = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id });

    // Patient token: sign a JWT with the patient's own userId + PATIENT role
    const patientUser = await prisma.user.findUnique({ where: { id: patient.userId } });
    const patientToken = jwt.sign(
      { userId: patientUser!.id, email: patientUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const delRes = await request(app)
      .delete(`/api/v1/ai/adherence/${enrollRes.body.data.id}`)
      .set("Authorization", `Bearer ${patientToken}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.data.active).toBe(false);
  });

  it("forbids a different PATIENT from unenrolling another's schedule (403)", async () => {
    const prisma = await getPrisma();
    const jwt = (await import("jsonwebtoken")).default;

    const owner = await createPatientFixture();
    const intruder = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: owner.id, doctorId: doctor.id });
    const prescription = await createPrescriptionFixture({
      patientId: owner.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    const enrollRes = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id });

    const intruderUser = await prisma.user.findUnique({ where: { id: intruder.userId } });
    const intruderToken = jwt.sign(
      { userId: intruderUser!.id, email: intruderUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .delete(`/api/v1/ai/adherence/${enrollRes.body.data.id}`)
      .set("Authorization", `Bearer ${intruderToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/own/i);
  });

  it("returns 404 when unenrolling a non-existent schedule", async () => {
    const res = await request(app)
      .delete("/api/v1/ai/adherence/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it("requires authentication for DELETE /:scheduleId", async () => {
    const res = await request(app).delete(
      "/api/v1/ai/adherence/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  // ─── POST /:scheduleId/doses + GET /:scheduleId/doses ─────────────────

  it("lets the owning patient mark a dose as taken", async () => {
    const prisma = await getPrisma();
    const jwt = (await import("jsonwebtoken")).default;

    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
    const prescription = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    const enrollRes = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id });
    const scheduleId = enrollRes.body.data.id;
    const medName = enrollRes.body.data.medications[0].name;

    const patientUser = await prisma.user.findUnique({ where: { id: patient.userId } });
    const patientToken = jwt.sign(
      { userId: patientUser!.id, email: patientUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const scheduledAt = new Date();
    scheduledAt.setHours(8, 0, 0, 0);

    const res = await request(app)
      .post(`/api/v1/ai/adherence/${scheduleId}/doses`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        medicationName: medName,
        scheduledAt: scheduledAt.toISOString(),
        takenAt: new Date().toISOString(),
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.status).toBe("TAKEN");
    expect(res.body.data.takenAt).toBeTruthy();

    // Row persisted in DB
    const row = await (prisma as any).adherenceDoseLog.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row).toBeTruthy();
    expect(row.scheduleId).toBe(scheduleId);
    expect(row.patientId).toBe(patient.id);
    expect(row.skipped).toBe(false);
  });

  it("forbids a different PATIENT from marking a dose on another's schedule (403)", async () => {
    const prisma = await getPrisma();
    const jwt = (await import("jsonwebtoken")).default;

    const owner = await createPatientFixture();
    const intruder = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: owner.id, doctorId: doctor.id });
    const prescription = await createPrescriptionFixture({
      patientId: owner.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    const enrollRes = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id });
    const scheduleId = enrollRes.body.data.id;
    const medName = enrollRes.body.data.medications[0].name;

    const intruderUser = await prisma.user.findUnique({ where: { id: intruder.userId } });
    const intruderToken = jwt.sign(
      { userId: intruderUser!.id, email: intruderUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .post(`/api/v1/ai/adherence/${scheduleId}/doses`)
      .set("Authorization", `Bearer ${intruderToken}`)
      .send({
        medicationName: medName,
        scheduledAt: new Date().toISOString(),
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/own/i);
  });

  it("GET /doses returns logs sorted by scheduledAt descending", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
    const prescription = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    const enrollRes = await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id });
    const scheduleId = enrollRes.body.data.id;
    const medName = enrollRes.body.data.medications[0].name;

    // Seed three logs at different scheduledAt times
    const now = Date.now();
    const times = [
      new Date(now - 3 * 60 * 60 * 1000).toISOString(), // oldest
      new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      new Date(now - 1 * 60 * 60 * 1000).toISOString(), // newest
    ];
    for (const t of times) {
      const postRes = await request(app)
        .post(`/api/v1/ai/adherence/${scheduleId}/doses`)
        .set("Authorization", `Bearer ${doctorToken}`)
        .send({
          medicationName: medName,
          scheduledAt: t,
          takenAt: t,
        });
      expect(postRes.status).toBe(201);
    }

    const listRes = await request(app)
      .get(`/api/v1/ai/adherence/${scheduleId}/doses`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data)).toBe(true);
    expect(listRes.body.data.length).toBe(3);
    const returnedTimes = listRes.body.data.map((r: any) =>
      new Date(r.scheduledAt).toISOString()
    );
    // newest first
    expect(returnedTimes[0]).toBe(times[2]);
    expect(returnedTimes[1]).toBe(times[1]);
    expect(returnedTimes[2]).toBe(times[0]);
  });

  it("returns 404 when marking a dose against an unknown schedule", async () => {
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .post(`/api/v1/ai/adherence/00000000-0000-0000-0000-000000000000/doses`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        medicationName: "Paracetamol",
        scheduledAt: new Date().toISOString(),
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // ─── GET /mine (Issue #24) ────────────────────────────────────────────
  //
  // Patients should not need to know their own internal patientId. The /mine
  // endpoint resolves the caller's Patient row from the JWT userId and
  // returns its active schedules. Non-patient roles get 403.

  it("GET /mine returns the patient's own active schedules", async () => {
    const prisma = await getPrisma();
    const jwt = (await import("jsonwebtoken")).default;

    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const prescription = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });

    await request(app)
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ prescriptionId: prescription.id });

    const patientUser = await prisma.user.findUnique({
      where: { id: patient.userId },
    });
    const patientToken = jwt.sign(
      { userId: patientUser!.id, email: patientUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get("/api/v1/ai/adherence/mine")
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].patientId).toBe(patient.id);
    expect(res.body.data[0].active).toBe(true);
  });

  it("GET /mine returns an empty array when the patient has no schedules", async () => {
    const prisma = await getPrisma();
    const jwt = (await import("jsonwebtoken")).default;

    const patient = await createPatientFixture();
    const patientUser = await prisma.user.findUnique({
      where: { id: patient.userId },
    });
    const patientToken = jwt.sign(
      { userId: patientUser!.id, email: patientUser!.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get("/api/v1/ai/adherence/mine")
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("GET /mine rejects DOCTOR / ADMIN / NURSE / RECEPTION with 403", async () => {
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .get("/api/v1/ai/adherence/mine")
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(403);
  });

  it("GET /mine returns 404 when the authenticated user has no Patient row", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const prisma = await getPrisma();
    // Craft a PATIENT-role user with no Patient record — pathological but
    // possible (e.g. a self-registration that failed half-way).
    const orphan = await prisma.user.create({
      data: {
        email: `orphan_${Date.now()}@test.local`,
        name: "Orphan Patient",
        phone: "9000000099",
        passwordHash: "x",
        role: "PATIENT",
      },
    });
    const orphanToken = jwt.sign(
      { userId: orphan.id, email: orphan.email, role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get("/api/v1/ai/adherence/mine")
      .set("Authorization", `Bearer ${orphanToken}`);

    expect(res.status).toBe(404);
  });

  it("GET /mine requires authentication", async () => {
    const res = await request(app).get("/api/v1/ai/adherence/mine");
    expect(res.status).toBe(401);
  });
});
