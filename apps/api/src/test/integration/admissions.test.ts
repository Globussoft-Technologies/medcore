// Integration tests for admissions router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
} from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;

async function setupAdmission() {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const ward = await createWardFixture();
  const bed = await createBedFixture({ wardId: ward.id });
  return { patient, doctor, ward, bed };
}

describeIfDB("Admissions API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("admits a patient (creates admission, occupies bed)", async () => {
    const { patient, doctor, bed } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        bedId: bed.id,
        reason: "Fever",
        diagnosis: "Viral illness",
        admissionType: "ELECTIVE",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("ADMITTED");
    expect(res.body.data?.admissionNumber).toBeTruthy();

    const prisma = await getPrisma();
    const refreshedBed = await prisma.bed.findUnique({ where: { id: bed.id } });
    expect(refreshedBed?.status).toBe("OCCUPIED");
  });

  it("rejects admission to a non-AVAILABLE bed (409)", async () => {
    const { patient, doctor, bed } = await setupAdmission();
    const prisma = await getPrisma();
    await prisma.bed.update({
      where: { id: bed.id },
      data: { status: "OCCUPIED" },
    });
    const res = await request(app)
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        bedId: bed.id,
        reason: "Pain",
      });
    expect(res.status).toBe(409);
  });

  it("checks discharge readiness", async () => {
    const { patient, doctor, bed } = await setupAdmission();
    const admission = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });
    const res = await request(app)
      .get(`/api/v1/admissions/${admission.id}/discharge-readiness`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.ready).toBe("boolean");
  });

  it("force-discharges an admission (frees bed)", async () => {
    const { patient, doctor, bed } = await setupAdmission();
    const admission = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });
    const res = await request(app)
      .patch(`/api/v1/admissions/${admission.id}/discharge`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        dischargeSummary: "Patient stable, recovered.",
        forceDischarge: true,
        conditionAtDischarge: "STABLE",
        followUpInstructions: "Return in 7 days",
        dischargeMedications: "Paracetamol 500mg TID",
      });
    expect([200, 201]).toContain(res.status);

    const prisma = await getPrisma();
    const bedRefreshed = await prisma.bed.findUnique({
      where: { id: bed.id },
    });
    expect(bedRefreshed?.status).not.toBe("OCCUPIED");
  });

  it("transfers an admission to a different bed", async () => {
    const { patient, doctor, bed, ward } = await setupAdmission();
    const admission = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });
    const newBed = await createBedFixture({ wardId: ward.id });
    const res = await request(app)
      .patch(`/api/v1/admissions/${admission.id}/transfer`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ newBedId: newBed.id, reason: "Moved to ICU" });
    expect([200, 201]).toContain(res.status);
  });

  it("records IPD vitals", async () => {
    const { patient, doctor, bed } = await setupAdmission();
    const admission = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });
    const res = await request(app)
      .post(`/api/v1/admissions/${admission.id}/vitals`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        admissionId: admission.id,
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 80,
        temperature: 98.6,
        pulseRate: 72,
        spO2: 98,
      });
    expect([200, 201]).toContain(res.status);
  });

  it("records intake/output", async () => {
    const { patient, doctor, bed } = await setupAdmission();
    const admission = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });
    const res = await request(app)
      .post(`/api/v1/admissions/${admission.id}/intake-output`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        admissionId: admission.id,
        type: "INTAKE_ORAL",
        amountMl: 250,
        description: "Water",
      });
    expect([200, 201]).toContain(res.status);
  });

  it("returns daily census", async () => {
    const res = await request(app)
      .get("/api/v1/admissions/census/daily")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTruthy();
  });

  it("returns LOS prediction", async () => {
    const { patient, doctor, bed } = await setupAdmission();
    const admission = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });
    const res = await request(app)
      .get(`/api/v1/admissions/${admission.id}/los-prediction`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects admission with invalid payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).post("/api/v1/admissions").send({});
    expect(res.status).toBe(401);
  });
});
