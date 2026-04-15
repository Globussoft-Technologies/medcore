// Deep / edge-case integration tests for the surgery router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createOperatingTheaterFixture,
} from "../factories";

let app: any;
let admin: string;
let doctor: string;
let nurse: string;

async function mkSurgery(overrides: Partial<any> = {}) {
  const prisma = await getPrisma();
  const patient = await createPatientFixture();
  const surgeon = await createDoctorFixture();
  const ot = await createOperatingTheaterFixture();
  const caseNumber = `SUR${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const scheduledAt = new Date(Date.now() + 3600_000);
  const surgery = await prisma.surgery.create({
    data: {
      caseNumber,
      patientId: patient.id,
      surgeonId: surgeon.id,
      otId: ot.id,
      procedure: "Appendectomy",
      scheduledAt,
      status: "SCHEDULED",
      ...overrides,
    },
  });
  return { patient, surgeon, ot, surgery };
}

describeIfDB("Surgery API — deep edges", () => {
  beforeAll(async () => {
    await resetDB();
    admin = await getAuthToken("ADMIN");
    doctor = await getAuthToken("DOCTOR");
    nurse = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Schedule ──────────────────────────────────────────────
  it("schedule on unknown OT returns 404", async () => {
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/surgery")
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        patientId: patient.id,
        surgeonId: surgeon.id,
        otId: "00000000-0000-0000-0000-000000000000",
        procedure: "x",
        scheduledAt: new Date().toISOString(),
      });
    expect(res.status).toBe(404);
  });

  it("schedule on inactive OT returns 409", async () => {
    const patient = await createPatientFixture();
    const surgeon = await createDoctorFixture();
    const ot = await createOperatingTheaterFixture({ isActive: false });
    const res = await request(app)
      .post("/api/v1/surgery")
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        patientId: patient.id,
        surgeonId: surgeon.id,
        otId: ot.id,
        procedure: "bypass",
        scheduledAt: new Date().toISOString(),
      });
    expect(res.status).toBe(409);
  });

  // ─── Start (pre-op checklist) ──────────────────────────────
  it("start fails with 400 when pre-op checklist incomplete", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/start`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.missing?.length).toBeGreaterThan(0);
  });

  it("start with overrideChecklist=true succeeds despite missing items", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/start`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ overrideChecklist: true });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("IN_PROGRESS");
  });

  it("start unknown surgery returns 404", async () => {
    const res = await request(app)
      .patch(`/api/v1/surgery/00000000-0000-0000-0000-000000000000/start`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ overrideChecklist: true });
    expect(res.status).toBe(404);
  });

  it("complete pre-op checklist then start succeeds without override", async () => {
    const { surgery } = await mkSurgery();
    const preop = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/preop`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        consentSigned: true,
        npoSince: new Date().toISOString(),
        allergiesVerified: true,
        siteMarked: true,
      });
    expect(preop.status).toBe(200);
    const start = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/start`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({});
    expect(start.status).toBe(200);
  });

  // ─── Complete ──────────────────────────────────────────────
  it("complete fails without postOpNotes (400)", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/complete`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("complete with blank postOpNotes is rejected", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/complete`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ postOpNotes: "   " });
    expect(res.status).toBe(400);
  });

  it("complete with valid postOpNotes sets status COMPLETED", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/complete`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        postOpNotes: "uncomplicated closure, patient stable",
        spongeCountCorrect: true,
        instrumentCountCorrect: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("COMPLETED");
  });

  // ─── Cancel ────────────────────────────────────────────────
  it("cancel requires reason (400)", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/cancel`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("cancel with reason persists [CANCELLED] note", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/cancel`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ reason: "patient refused" });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("CANCELLED");
    expect(res.body.data?.postOpNotes).toContain("[CANCELLED]");
  });

  it("cancel unknown surgery → 404", async () => {
    const res = await request(app)
      .patch(`/api/v1/surgery/00000000-0000-0000-0000-000000000000/cancel`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ reason: "x" });
    expect(res.status).toBe(404);
  });

  // ─── Pre-op checklist patch ────────────────────────────────
  it("preop checklist stamps consentSignedAt when consent true", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/preop`)
      .set("Authorization", `Bearer ${nurse}`)
      .send({ consentSigned: true });
    expect(res.status).toBe(200);
    expect(res.body.data?.consentSignedAt).toBeTruthy();
  });

  it("preop sets antibioticsAt when antibioticsGiven=true", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/preop`)
      .set("Authorization", `Bearer ${nurse}`)
      .send({ antibioticsGiven: true });
    expect(res.status).toBe(200);
    expect(res.body.data?.antibioticsAt).toBeTruthy();
  });

  // ─── Intra-op timings ──────────────────────────────────────
  it("intraop updates anesthesia + incision timestamps", async () => {
    const { surgery } = await mkSurgery();
    const now = new Date().toISOString();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/intraop`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ anesthesiaStartAt: now, incisionAt: now });
    expect(res.status).toBe(200);
  });

  // ─── Complications ─────────────────────────────────────────
  it("complications recorded with severity", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/complications`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        complications: "minor bleeding",
        complicationSeverity: "MILD",
        bloodLossMl: 150,
      });
    expect(res.status).toBe(200);
  });

  it("complications without text returns 400", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/complications`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ complicationSeverity: "MILD" });
    expect(res.status).toBe(400);
  });

  // ─── Blood requirement ─────────────────────────────────────
  it("blood requirement returns shortfall when no units available", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .post(`/api/v1/surgery/${surgery.id}/blood-requirement`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ units: 2, component: "WHOLE_BLOOD", autoReserve: false });
    expect(res.status).toBe(200);
    expect(res.body.data?.unitsAvailable).toBe(0);
    expect(res.body.data?.shortfall).toBe(2);
    expect(res.body.data?.canProceed).toBe(false);
  });

  it("blood requirement 404 on unknown surgery", async () => {
    const res = await request(app)
      .post(`/api/v1/surgery/00000000-0000-0000-0000-000000000000/blood-requirement`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ units: 1, component: "WHOLE_BLOOD" });
    expect(res.status).toBe(404);
  });

  // ─── Post-op observations ──────────────────────────────────
  it("record + list post-op observations", async () => {
    const { surgery } = await mkSurgery();
    const add = await request(app)
      .post(`/api/v1/surgery/${surgery.id}/observations`)
      .set("Authorization", `Bearer ${nurse}`)
      .send({
        bpSystolic: 120,
        bpDiastolic: 80,
        pulse: 78,
        spO2: 98,
        painScore: 2,
        consciousness: "ALERT",
      });
    expect([200, 201]).toContain(add.status);
    const list = await request(app)
      .get(`/api/v1/surgery/${surgery.id}/observations`)
      .set("Authorization", `Bearer ${nurse}`);
    expect(list.status).toBe(200);
    expect(list.body.data?.length).toBeGreaterThanOrEqual(1);
  });

  it("observations on unknown surgery returns 404", async () => {
    const res = await request(app)
      .post(`/api/v1/surgery/00000000-0000-0000-0000-000000000000/observations`)
      .set("Authorization", `Bearer ${nurse}`)
      .send({ pulse: 80 });
    expect(res.status).toBe(404);
  });

  // ─── SSI ───────────────────────────────────────────────────
  it("SSI report records SSI type", async () => {
    const { surgery } = await mkSurgery();
    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/ssi-report`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        ssiType: "SUPERFICIAL",
        detectedDate: new Date().toISOString(),
        treatment: "antibiotics",
      });
    expect(res.status).toBe(200);
  });

  it("SSI rate analytics returns summary", async () => {
    const res = await request(app)
      .get("/api/v1/surgery/analytics/ssi-rate")
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.byType).toBeDefined();
  });

  // ─── Get ───────────────────────────────────────────────────
  it("GET /:id 404 unknown", async () => {
    const res = await request(app)
      .get("/api/v1/surgery/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(404);
  });

  it("list surgeries 200", async () => {
    const res = await request(app)
      .get("/api/v1/surgery")
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(200);
  });

  it("unauthenticated list 401", async () => {
    const res = await request(app).get("/api/v1/surgery");
    expect(res.status).toBe(401);
  });
});
