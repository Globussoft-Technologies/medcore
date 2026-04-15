// Deep branch-coverage tests for pediatric growth router (/api/v1/growth).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let doctorToken: string;
let nurseToken: string;
let adminToken: string;

function dobYearsAgo(years: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

function dobMonthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

describeIfDB("Pediatric/Growth API — DEEP (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  async function createRec(patientId: string, body: any, tok = doctorToken) {
    return request(app)
      .post("/api/v1/growth")
      .set("Authorization", `Bearer ${tok}`)
      .send({ patientId, ...body });
  }

  it("computes BMI for overweight child (>18.5)", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(4) });
    const r = await createRec(p.id, {
      ageMonths: 48,
      weightKg: 25,
      heightCm: 100,
    });
    expect([200, 201]).toContain(r.status);
    expect(r.body.data.bmi).toBeGreaterThan(18.5);
  });

  it("rejects ageMonths > 240 (400)", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(1) });
    const r = await createRec(p.id, { ageMonths: 241, weightKg: 10 });
    expect(r.status).toBe(400);
  });

  it("NURSE can create growth record", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(1) });
    const r = await createRec(p.id, { ageMonths: 6, weightKg: 7 }, nurseToken);
    expect([200, 201]).toContain(r.status);
  });

  it("growth record with only height (no weight) has null BMI", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(3) });
    const r = await createRec(p.id, { ageMonths: 36, heightCm: 90 });
    expect([200, 201]).toContain(r.status);
    expect(r.body.data.bmi).toBeNull();
  });

  it("head-circumference persisted for <2yo", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobMonthsAgo(12) });
    const r = await createRec(p.id, {
      ageMonths: 12,
      weightKg: 9,
      heightCm: 74,
      headCircumference: 45,
    });
    expect([200, 201]).toContain(r.status);
    expect(r.body.data.headCircumference).toBe(45);
  });

  it("PATCH recomputes BMI after weight change", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(5) });
    const c = await createRec(p.id, {
      ageMonths: 60,
      weightKg: 18,
      heightCm: 110,
    });
    const id = c.body.data.id;
    const patch = await request(app)
      .patch(`/api/v1/growth/${id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ weightKg: 22 });
    expect(patch.status).toBe(200);
    expect(patch.body.data.bmi).toBeCloseTo(22 / Math.pow(1.1, 2), 0);
  });

  it("PATCH 404 for unknown record", async () => {
    const r = await request(app)
      .patch("/api/v1/growth/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ weightKg: 5 });
    expect(r.status).toBe(404);
  });

  it("DELETE 404 for unknown, then successful delete", async () => {
    const r1 = await request(app)
      .delete("/api/v1/growth/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r1.status).toBe(404);
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(2) });
    const c = await createRec(p.id, { ageMonths: 24, weightKg: 12 });
    const del = await request(app)
      .delete(`/api/v1/growth/${c.body.data.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(del.status).toBe(200);
  });

  it("NURSE cannot delete (403)", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(2) });
    const c = await createRec(p.id, { ageMonths: 24, weightKg: 12 });
    const del = await request(app)
      .delete(`/api/v1/growth/${c.body.data.id}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(del.status).toBe(403);
  });

  it("milestones: NO records → checklist with no achieved", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(1) });
    const r = await request(app)
      .get(`/api/v1/growth/patient/${p.id}/milestones`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(200);
    expect(r.body.data.achieved).toBe(0);
    expect(r.body.data.total).toBeGreaterThan(5);
  });

  it("milestones: 404 unknown patient", async () => {
    const r = await request(app)
      .get("/api/v1/growth/patient/00000000-0000-0000-0000-000000000000/milestones")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(404);
  });

  it("immunization-compliance schedule aligned to India UIP + includes BCG/OPV/Penta", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobMonthsAgo(9) });
    const prisma = await getPrisma();
    await prisma.immunization.create({
      data: { patientId: p.id, vaccine: "BCG", dateGiven: new Date() },
    });
    await prisma.immunization.create({
      data: { patientId: p.id, vaccine: "Pentavalent-1", dateGiven: new Date() },
    });
    const r = await request(app)
      .get(`/api/v1/growth/patient/${p.id}/immunization-compliance`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(200);
    const vaccines = r.body.data.schedule.map((s: any) => s.vaccine);
    expect(vaccines).toContain("BCG");
    expect(vaccines).toContain("OPV-1");
    expect(vaccines).toContain("Pentavalent-1");
    expect(vaccines).toContain("Measles-Rubella-1");
    expect(r.body.data.givenCount).toBeGreaterThanOrEqual(2);
  });

  it("immunization-compliance: overdue detection for older child", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(3) });
    const r = await request(app)
      .get(`/api/v1/growth/patient/${p.id}/immunization-compliance`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(200);
    expect(r.body.data.overdueCount).toBeGreaterThanOrEqual(5);
  });

  it("velocity: <2 records → avgGainPerMonth null", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(1) });
    await createRec(p.id, { ageMonths: 6, weightKg: 7 });
    const r = await request(app)
      .get(`/api/v1/growth/patient/${p.id}/velocity`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(200);
    expect(r.body.data.summary.avgGainPerMonth).toBeNull();
  });

  it("velocity: two records → kg/month computed", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(1) });
    await createRec(p.id, { ageMonths: 6, weightKg: 7 });
    await createRec(p.id, { ageMonths: 12, weightKg: 9.4 });
    const r = await request(app)
      .get(`/api/v1/growth/patient/${p.id}/velocity`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(200);
    expect(r.body.data.velocity.length).toBe(1);
    expect(r.body.data.velocity[0].gainKgPerMonth).toBeCloseTo(0.4, 1);
  });

  it("ftt-check: no records → safe default", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(1) });
    const r = await request(app)
      .get(`/api/v1/growth/patient/${p.id}/ftt-check`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(200);
    expect(r.body.data.isFTT).toBe(false);
    expect(Array.isArray(r.body.data.suggestions)).toBe(true);
  });

  it("ftt-check: two records with velocity computed", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(1) });
    await createRec(p.id, { ageMonths: 6, weightKg: 7 });
    await createRec(p.id, { ageMonths: 12, weightKg: 7.2 });
    const r = await request(app)
      .get(`/api/v1/growth/patient/${p.id}/ftt-check`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(200);
    expect(r.body.data.velocityKgPerMonth).not.toBeNull();
  });

  it("chart returns empty arrays when no records", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(1) });
    const r = await request(app)
      .get(`/api/v1/growth/patient/${p.id}/chart`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(200);
    expect(r.body.data.weight.length).toBe(0);
  });

  it("list ordered by ageMonths asc", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(2) });
    await createRec(p.id, { ageMonths: 12, weightKg: 10 });
    await createRec(p.id, { ageMonths: 6, weightKg: 7 });
    await createRec(p.id, { ageMonths: 24, weightKg: 12 });
    const r = await request(app)
      .get(`/api/v1/growth/patient/${p.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(200);
    const ages = r.body.data.map((x: any) => x.ageMonths);
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
  });

  it("weightPercentile > 0 when weight is given", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(1) });
    const r = await createRec(p.id, { ageMonths: 12, weightKg: 9.5 });
    expect([200, 201]).toContain(r.status);
    expect(r.body.data.weightPercentile).toBeGreaterThan(0);
  });

  it("ADMIN can delete", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(2) });
    const c = await createRec(p.id, { ageMonths: 24, weightKg: 12 });
    const del = await request(app)
      .delete(`/api/v1/growth/${c.body.data.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
  });

  it("persisted BMI matches computed (side-effect)", async () => {
    const p = await createPatientFixture({ dateOfBirth: dobYearsAgo(3) });
    await createRec(p.id, { ageMonths: 36, weightKg: 15, heightCm: 95 });
    const prisma = await getPrisma();
    const rec = await prisma.growthRecord.findFirst({
      where: { patientId: p.id, ageMonths: 36 },
    });
    expect(rec!.bmi).toBeCloseTo(15 / Math.pow(0.95, 2), 0);
  });
});
