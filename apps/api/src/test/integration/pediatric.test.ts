// Integration tests for pediatric growth router (/api/v1/growth).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let doctorToken: string;
let patientToken: string;

function childDob(yearsAgo: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - yearsAgo);
  return d;
}

describeIfDB("Pediatric/Growth API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("401 without token on GET chart", async () => {
    const patient = await createPatientFixture({ dateOfBirth: childDob(2) });
    const res = await request(app).get(
      `/api/v1/growth/patient/${patient.id}/chart`
    );
    expect(res.status).toBe(401);
  });

  it("creates a growth record (DOCTOR) with computed BMI + percentiles", async () => {
    const patient = await createPatientFixture({ dateOfBirth: childDob(1) });
    const res = await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 12,
        weightKg: 9.6,
        heightCm: 75.7,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.bmi).toBeGreaterThan(0);
    expect(res.body.data?.weightPercentile).toBeGreaterThan(0);
  });

  it("rejects malformed payload (400)", async () => {
    const patient = await createPatientFixture({ dateOfBirth: childDob(1) });
    const res = await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        ageMonths: -5,
        weightKg: -1,
      });
    expect(res.status).toBe(400);
  });

  it("returns 404 when patient not found", async () => {
    const res = await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: "550e8400-e29b-41d4-a716-446655440000",
        ageMonths: 6,
        weightKg: 7.5,
      });
    expect(res.status).toBe(404);
  });

  it("rejects PATIENT from creating growth record (403)", async () => {
    const patient = await createPatientFixture({ dateOfBirth: childDob(1) });
    const res = await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 6,
        weightKg: 7.5,
      });
    expect(res.status).toBe(403);
  });

  it("lists growth records for a patient", async () => {
    const patient = await createPatientFixture({ dateOfBirth: childDob(1) });
    await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ patientId: patient.id, ageMonths: 6, weightKg: 7.9, heightCm: 67.6 });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("chart endpoint returns weight/height/headCircumference arrays", async () => {
    const patient = await createPatientFixture({ dateOfBirth: childDob(2) });
    await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ patientId: patient.id, ageMonths: 12, weightKg: 9.6, heightCm: 75.7 });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/chart`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.weight)).toBe(true);
    expect(Array.isArray(res.body.data?.height)).toBe(true);
    expect(Array.isArray(res.body.data?.headCircumference)).toBe(true);
  });

  it("milestones checklist computed from notes", async () => {
    const patient = await createPatientFixture({ dateOfBirth: childDob(2) });
    await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 12,
        milestoneNotes: "Stands with support; says mama/dada confidently",
      });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/milestones`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.total).toBe("number");
    expect(res.body.data?.achieved).toBeGreaterThanOrEqual(1);
  });

  it("immunization-compliance reports schedule + status", async () => {
    const patient = await createPatientFixture({ dateOfBirth: childDob(2) });
    const prisma = await getPrisma();
    await prisma.immunization.create({
      data: {
        patientId: patient.id,
        vaccine: "BCG",
        dateGiven: new Date(),
      },
    });
    const res = await request(app)
      .get(`/api/v1/growth/patient/${patient.id}/immunization-compliance`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data?.schedule)).toBe(true);
    expect(res.body.data?.givenCount).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.data?.compliancePct).toBe("number");
  });

  it("growth record persisted with correct BMI (side-effect)", async () => {
    const patient = await createPatientFixture({ dateOfBirth: childDob(2) });
    await request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        ageMonths: 24,
        weightKg: 12,
        heightCm: 87,
      });
    const prisma = await getPrisma();
    const rows = await prisma.growthRecord.findMany({
      where: { patientId: patient.id, ageMonths: 24 },
    });
    expect(rows.length).toBeGreaterThan(0);
    // BMI = 12 / (0.87^2) ≈ 15.9
    expect(rows[0].bmi).toBeCloseTo(15.9, 0);
  });
});
