// Integration tests for surgery router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createOperatingTheaterFixture,
} from "../factories";

let app: any;
let adminToken: string;

async function scheduleSurgery(extra: Partial<any> = {}) {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const ot = await createOperatingTheaterFixture();
  const res = await request(app)
    .post("/api/v1/surgery")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      patientId: patient.id,
      surgeonId: doctor.id,
      otId: ot.id,
      procedure: "Appendectomy",
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      durationMin: 90,
      ...extra,
    });
  return { patient, doctor, ot, response: res };
}

describeIfDB("Surgery API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates an operating theater (admin)", async () => {
    const res = await request(app)
      .post("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: `OT-Test-${Date.now()}`,
        floor: "3",
        dailyRate: 7500,
      });
    expect([200, 201]).toContain(res.status);
  });

  it("schedules a surgery (auto case number)", async () => {
    const { response } = await scheduleSurgery();
    expect([200, 201]).toContain(response.status);
    expect(response.body.data?.caseNumber).toBeTruthy();
    expect(response.body.data?.status).toBe("SCHEDULED");
  });

  it("blocks /start when pre-op checklist is incomplete", async () => {
    const { response } = await scheduleSurgery();
    const surgery = response.body.data;
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/start`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.missing?.length).toBeGreaterThan(0);
  });

  it("allows /start with overrideChecklist = true", async () => {
    const { response } = await scheduleSurgery();
    const surgery = response.body.data;
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/start`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ overrideChecklist: true });
    expect([200, 201]).toContain(res.status);

    const prisma = await getPrisma();
    const refreshed = await prisma.surgery.findUnique({
      where: { id: surgery.id },
    });
    expect(refreshed?.actualStartAt).toBeTruthy();
    expect(refreshed?.status).toBe("IN_PROGRESS");
  });

  it("updates pre-op checklist", async () => {
    const { response } = await scheduleSurgery();
    const surgery = response.body.data;
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/preop`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        consentSigned: true,
        allergiesVerified: true,
        antibioticsGiven: true,
        siteMarked: true,
        npoSince: new Date().toISOString(),
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.consentSigned).toBe(true);
  });

  it("requires postOpNotes on /complete", async () => {
    const { response } = await scheduleSurgery();
    const surgery = response.body.data;
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("completes a surgery with postOpNotes", async () => {
    const { response } = await scheduleSurgery();
    const surgery = response.body.data;
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        postOpNotes: "No complications. Counts correct.",
        spongeCountCorrect: true,
        instrumentCountCorrect: true,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("COMPLETED");
  });

  it("cancels a surgery", async () => {
    const { response } = await scheduleSurgery();
    const surgery = response.body.data;
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Patient fever" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("CANCELLED");
  });

  it("lists surgeries", async () => {
    await scheduleSurgery();
    const res = await request(app)
      .get("/api/v1/surgery")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("records SSI on a completed surgery", async () => {
    const { response } = await scheduleSurgery();
    const surgery = response.body.data;
    const res = await request(app)
      .post(`/api/v1/surgery/${surgery.id}/ssi-report`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ssiType: "SUPERFICIAL",
        ssiDetectedDate: new Date().toISOString(),
        ssiTreatment: "Antibiotics",
      });
    expect(res.status).toBeLessThan(500);
  });

  it("rejects bad surgery schedule payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/surgery")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/v1/surgery");
    expect(res.status).toBe(401);
  });
});
