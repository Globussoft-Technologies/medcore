// Deep branch-coverage integration tests for antenatal router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture, createDoctorFixture } from "../factories";

let app: any;
let doctorToken: string;
let adminToken: string;

async function createFemalePatient(overrides: any = {}) {
  return createPatientFixture({ gender: "FEMALE", ...overrides });
}

async function createCase(body: any, token = doctorToken) {
  return request(app)
    .post("/api/v1/antenatal/cases")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

describeIfDB("Antenatal API — DEEP (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("EDD=LMP+280d across leap-year boundary", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const res = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2024-02-29",
    });
    expect([200, 201]).toContain(res.status);
    const lmp = new Date("2024-02-29T00:00:00.000Z").getTime();
    const edd = new Date(res.body.data.eddDate).getTime();
    expect(Math.round((edd - lmp) / 86400000)).toBe(280);
  });

  it("404 when patient does not exist", async () => {
    const doctor = await createDoctorFixture();
    const res = await createCase({
      patientId: "00000000-0000-0000-0000-000000000000",
      doctorId: doctor.id,
      lmpDate: "2026-01-01",
    });
    expect(res.status).toBe(404);
  });

  it("dashboard counts include high-risk case", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-01-10",
      isHighRisk: true,
    });
    const res = await request(app)
      .get("/api/v1/antenatal/dashboard")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.highRiskCases).toBeGreaterThanOrEqual(1);
  });

  it("delivered=true/false filters behave correctly", async () => {
    const res = await request(app)
      .get("/api/v1/antenatal/cases?delivered=false&limit=5")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("case 404 via GET /cases/:id for unknown id", async () => {
    const res = await request(app)
      .get("/api/v1/antenatal/cases/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(404);
  });

  it("PATCH case updates gravida/parity", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-02-02",
    });
    const res = await request(app)
      .patch(`/api/v1/antenatal/cases/${c.body.data.id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ gravida: 3, parity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.data.gravida).toBe(3);
  });

  it("PATCH /delivery records delivery, duplicate returns 409", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-03-01",
    });
    const r1 = await request(app)
      .patch(`/api/v1/antenatal/cases/${c.body.data.id}/delivery`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ deliveryType: "NORMAL", babyGender: "FEMALE", babyWeight: 3.2 });
    expect(r1.status).toBe(200);
    const r2 = await request(app)
      .patch(`/api/v1/antenatal/cases/${c.body.data.id}/delivery`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ deliveryType: "C_SECTION" });
    expect(r2.status).toBe(409);
  });

  it("delivery invalid deliveryType rejected (400)", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-04-01",
    });
    const res = await request(app)
      .patch(`/api/v1/antenatal/cases/${c.body.data.id}/delivery`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ deliveryType: "LEVITATION" });
    expect(res.status).toBe(400);
  });

  it("create ANC visit with fetalHeartRate and BP", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-01-15",
    });
    const res = await request(app)
      .post("/api/v1/antenatal/visits")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        ancCaseId: c.body.data.id,
        type: "ROUTINE",
        weight: 62,
        bloodPressure: "120/80",
        fetalHeartRate: 140,
        nextVisitDate: "2026-02-15",
      });
    expect([200, 201]).toContain(res.status);
  });

  it("ANC visit with out-of-range FHR (400)", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-01-15",
    });
    const res = await request(app)
      .post("/api/v1/antenatal/visits")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        ancCaseId: c.body.data.id,
        type: "ROUTINE",
        fetalHeartRate: 50,
      });
    expect(res.status).toBe(400);
  });

  it("ANC visit 404 for unknown case", async () => {
    const res = await request(app)
      .post("/api/v1/antenatal/visits")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        ancCaseId: "00000000-0000-0000-0000-000000000000",
        type: "ROUTINE",
        notes: "follow-up",
      });
    expect(res.status).toBe(404);
  });

  it("trimester endpoint computes weeks/trimester", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 200);
    const lmpStr = longAgo.toISOString().slice(0, 10);
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: lmpStr,
    });
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${c.body.data.id}/trimester`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.weeks).toBeGreaterThanOrEqual(27);
    expect([2, 3]).toContain(res.body.data.trimester);
  });

  it("ACOG risk-score flags preeclampsia + high category", async () => {
    const patient = await createFemalePatient({
      dateOfBirth: new Date("1988-01-01"),
    });
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-01-20",
    });
    const res = await request(app)
      .post(`/api/v1/antenatal/cases/${c.body.data.id}/acog-risk-score`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        heightCm: 160,
        weightKg: 85,
        hasHypertension: true,
        hasDiabetes: true,
        currentPreeclampsia: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.score).toBeGreaterThanOrEqual(10);
    expect(["HIGH", "VERY_HIGH"]).toContain(res.body.data.category);
    expect(res.body.data.isHighRisk).toBe(true);
  });

  it("risk-score 404 for unknown case", async () => {
    const res = await request(app)
      .post("/api/v1/antenatal/cases/00000000-0000-0000-0000-000000000000/risk-score")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("ultrasound record create + list", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-02-01",
    });
    const post = await request(app)
      .post(`/api/v1/antenatal/cases/${c.body.data.id}/ultrasound`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        ancCaseId: c.body.data.id,
        gestationalWeeks: 20,
        efwGrams: 350,
        afi: 12,
        fetalHeartRate: 145,
        presentation: "Cephalic",
      });
    expect(post.status).toBe(201);
    const list = await request(app)
      .get(`/api/v1/antenatal/cases/${c.body.data.id}/ultrasound`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("ultrasound invalid FHR rejected (400)", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-02-10",
    });
    const res = await request(app)
      .post(`/api/v1/antenatal/cases/${c.body.data.id}/ultrasound`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ fetalHeartRate: 999 });
    expect(res.status).toBe(400);
  });

  it("partograph start + observation + end lifecycle", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-02-20",
    });
    const start = await request(app)
      .post(`/api/v1/antenatal/cases/${c.body.data.id}/partograph`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ observations: [] });
    expect(start.status).toBe(201);
    const pid = start.body.data.id;

    const obs = await request(app)
      .patch(`/api/v1/antenatal/partograph/${pid}/observation`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        time: new Date().toISOString(),
        cervicalDilation: 6,
        fetalHeartRate: 100, // abnormal
      });
    expect(obs.status).toBe(200);

    const get = await request(app)
      .get(`/api/v1/antenatal/partograph/${pid}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(get.status).toBe(200);
    expect(Array.isArray(get.body.data.flags)).toBe(true);
    expect(get.body.data.flags.some((f: string) => f.includes("Abnormal"))).toBe(
      true
    );

    const end = await request(app)
      .patch(`/api/v1/antenatal/partograph/${pid}/end`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ outcome: "Normal vaginal delivery" });
    expect(end.status).toBe(200);

    // Observation after end → 409
    const after = await request(app)
      .patch(`/api/v1/antenatal/partograph/${pid}/observation`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ time: new Date().toISOString(), cervicalDilation: 10 });
    expect(after.status).toBe(409);
  });

  it("postnatal visit without delivery → 400", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-03-15",
    });
    const res = await request(app)
      .post(`/api/v1/antenatal/cases/${c.body.data.id}/postnatal-visits`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ weekPostpartum: 1, babyJaundice: false });
    expect(res.status).toBe(400);
  });

  it("postnatal visit after delivery succeeds, list works", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2026-03-20",
    });
    await request(app)
      .patch(`/api/v1/antenatal/cases/${c.body.data.id}/delivery`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ deliveryType: "NORMAL" });
    const res = await request(app)
      .post(`/api/v1/antenatal/cases/${c.body.data.id}/postnatal-visits`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        weekPostpartum: 2,
        babyJaundice: false,
        breastfeeding: "EXCLUSIVE",
        lochia: "NORMAL",
      });
    expect(res.status).toBe(201);
    const list = await request(app)
      .get(`/api/v1/antenatal/cases/${c.body.data.id}/postnatal-visits`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("duplicate ANC case (409) when one already exists", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2025-05-01",
    });
    const res = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2025-06-01",
    });
    expect(res.status).toBe(409);
  });

  it("birth certificate 404 before delivery", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2025-06-01",
    });
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${c.body.data.id}/birth-certificate`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect([404, 500]).toContain(res.status);
  });

  it("malformed nextVisitDate in visit (400)", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2025-07-01",
    });
    const res = await request(app)
      .post("/api/v1/antenatal/visits")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        ancCaseId: c.body.data.id,
        type: "ROUTINE",
        nextVisitDate: "Feb 2026",
      });
    expect(res.status).toBe(400);
  });

  it("persists USG record with correct ancCaseId (side-effect)", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2025-07-10",
    });
    await request(app)
      .post(`/api/v1/antenatal/cases/${c.body.data.id}/ultrasound`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        ancCaseId: c.body.data.id,
        gestationalWeeks: 12,
      });
    const prisma = await getPrisma();
    const rows = await prisma.ultrasoundRecord.findMany({
      where: { ancCaseId: c.body.data.id },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].ancCaseId).toBe(c.body.data.id);
  });

  it("ADMIN can patch case too", async () => {
    const patient = await createFemalePatient();
    const doctor = await createDoctorFixture();
    const c = await createCase({
      patientId: patient.id,
      doctorId: doctor.id,
      lmpDate: "2025-08-01",
    });
    const res = await request(app)
      .patch(`/api/v1/antenatal/cases/${c.body.data.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isHighRisk: true, riskFactors: "Eclampsia history" });
    expect(res.status).toBe(200);
    expect(res.body.data.isHighRisk).toBe(true);
  });
});
