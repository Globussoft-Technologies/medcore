// Integration tests for the antenatal router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let patientToken: string;

async function createFemalePatient() {
  return createPatientFixture({ gender: "FEMALE" });
}

describeIfDB("Antenatal API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("401 without token", async () => {
    const res = await request(app).get("/api/v1/antenatal/cases");
    expect(res.status).toBe(401);
  });

  it("creates ANC case for female patient (DOCTOR)", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/antenatal/cases")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        lmpDate: "2026-01-01",
        gravida: 1,
        parity: 0,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.caseNumber).toMatch(/^ANC/);
    // EDD should be ~280 days after LMP (Oct 8, 2026)
    const edd = new Date(res.body.data.eddDate);
    expect(edd.getUTCFullYear()).toBe(2026);
    expect(edd.getUTCMonth()).toBe(9); // October (0-indexed)
  });

  it("rejects ANC case for male patient (400)", async () => {
    const patient = await createPatientFixture({ gender: "MALE" });
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/antenatal/cases")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        lmpDate: "2026-01-01",
      });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate ANC case for same patient (409)", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    await request(app)
      .post("/api/v1/antenatal/cases")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        lmpDate: "2026-02-01",
      });
    const res = await request(app)
      .post("/api/v1/antenatal/cases")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        lmpDate: "2026-03-01",
      });
    expect(res.status).toBe(409);
  });

  it("rejects malformed lmpDate (400)", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/antenatal/cases")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        lmpDate: "Jan 1",
      });
    expect(res.status).toBe(400);
  });

  it("rejects PATIENT role on case creation (403)", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/antenatal/cases")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        lmpDate: "2026-01-01",
      });
    expect(res.status).toBe(403);
  });

  it("lists ANC cases with pagination", async () => {
    const res = await request(app)
      .get("/api/v1/antenatal/cases?page=1&limit=20")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("dashboard endpoint returns counts", async () => {
    const res = await request(app)
      .get("/api/v1/antenatal/dashboard")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.activeCases).toBe("number");
    expect(typeof res.body.data?.highRiskCases).toBe("number");
  });

  it("ANC case persisted with EDD=LMP+280d (side-effect)", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/antenatal/cases")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        lmpDate: "2025-05-01",
      });
    expect([200, 201]).toContain(res.status);
    const prisma = await getPrisma();
    const row = await prisma.antenatalCase.findUnique({
      where: { id: res.body.data.id },
    });
    const lmp = new Date("2025-05-01T00:00:00.000Z").getTime();
    const edd = row ? new Date(row.eddDate).getTime() : 0;
    const diffDays = (edd - lmp) / (1000 * 60 * 60 * 24);
    expect(Math.round(diffDays)).toBe(280);
  });

  it("high-risk flag is persisted when passed", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/antenatal/cases")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        lmpDate: "2025-06-01",
        isHighRisk: true,
        riskFactors: "Previous C-section",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.isHighRisk).toBe(true);
  });
});
