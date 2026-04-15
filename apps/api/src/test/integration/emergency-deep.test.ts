// Deep / edge-case integration tests for the emergency router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createWardFixture,
  createBedFixture,
} from "../factories";

let app: any;
let admin: string;
let doctor: string;
let nurse: string;

async function mkCase(patientId?: string) {
  const prisma = await getPrisma();
  const patient = patientId
    ? { id: patientId }
    : await createPatientFixture();
  const caseNumber = `ER${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const ec = await prisma.emergencyCase.create({
    data: {
      caseNumber,
      patientId: patient.id,
      arrivalMode: "WALK_IN",
      chiefComplaint: "chest pain",
      arrivedAt: new Date(),
      status: "WAITING",
    },
  });
  return { patient, ec };
}

describeIfDB("Emergency API — deep edges", () => {
  beforeAll(async () => {
    await resetDB();
    admin = await getAuthToken("ADMIN");
    doctor = await getAuthToken("DOCTOR");
    nurse = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Case creation ─────────────────────────────────────────
  it("creates case for known patient", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${nurse}`)
      .send({
        patientId: patient.id,
        chiefComplaint: "trauma",
        arrivalMode: "AMBULANCE",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("WAITING");
  });

  it("creates case for unknown patient with unknownName", async () => {
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${nurse}`)
      .send({
        unknownName: "UNK-001",
        unknownAge: 40,
        chiefComplaint: "unconscious",
      });
    expect([200, 201]).toContain(res.status);
  });

  it("missing patientId AND unknownName returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${nurse}`)
      .send({ chiefComplaint: "bleeding" });
    expect(res.status).toBe(400);
  });

  it("creating case with unknown patientId returns 404", async () => {
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${nurse}`)
      .send({
        patientId: "00000000-0000-0000-0000-000000000000",
        chiefComplaint: "x",
      });
    expect(res.status).toBe(404);
  });

  it("second case within 72h flags isRepeatVisit", async () => {
    const patient = await createPatientFixture();
    await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${nurse}`)
      .send({ patientId: patient.id, chiefComplaint: "first" });
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${nurse}`)
      .send({ patientId: patient.id, chiefComplaint: "second" });
    expect(res.body.data?.isRepeatVisit).toBe(true);
  });

  // ─── Triage ───────────────────────────────────────────────
  it.each([
    "RESUSCITATION",
    "EMERGENT",
    "URGENT",
    "LESS_URGENT",
    "NON_URGENT",
  ])("triage level %s accepted", async (lvl) => {
    const { ec } = await mkCase();
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/triage`)
      .set("Authorization", `Bearer ${nurse}`)
      .send({ triageLevel: lvl, glasgowComa: 15 });
    expect(res.status).toBe(200);
    expect(res.body.data?.triageLevel).toBe(lvl);
  });

  it("triage invalid level returns 400", async () => {
    const { ec } = await mkCase();
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/triage`)
      .set("Authorization", `Bearer ${nurse}`)
      .send({ triageLevel: "BLUE" });
    expect(res.status).toBe(400);
  });

  it("triage unknown case returns 404", async () => {
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/00000000-0000-0000-0000-000000000000/triage`)
      .set("Authorization", `Bearer ${nurse}`)
      .send({ triageLevel: "URGENT" });
    expect(res.status).toBe(404);
  });

  it("triage de-escalation from RESUSCITATION → URGENT allowed", async () => {
    const { ec } = await mkCase();
    await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/triage`)
      .set("Authorization", `Bearer ${nurse}`)
      .send({ triageLevel: "RESUSCITATION" });
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/triage`)
      .set("Authorization", `Bearer ${nurse}`)
      .send({ triageLevel: "URGENT" });
    expect(res.status).toBe(200);
    expect(res.body.data?.triageLevel).toBe("URGENT");
  });

  // ─── Assign / seenAt ──────────────────────────────────────
  it("assign doctor updates status + seenAt", async () => {
    const { ec } = await mkCase();
    const doc = await createDoctorFixture();
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/assign`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ attendingDoctorId: doc.id });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("IN_TREATMENT");
    expect(res.body.data?.seenAt).toBeTruthy();
  });

  it("assign unknown doctor returns 404", async () => {
    const { ec } = await mkCase();
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/assign`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ attendingDoctorId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("assign with missing body returns 400", async () => {
    const { ec } = await mkCase();
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/assign`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({});
    expect(res.status).toBe(400);
  });

  // ─── Close / outcomes ─────────────────────────────────────
  it.each([
    "DISCHARGED",
    "ADMITTED",
    "TRANSFERRED",
    "LEFT_WITHOUT_BEING_SEEN",
    "DECEASED",
  ])("close with terminal status %s works", async (status) => {
    const { ec } = await mkCase();
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/close`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ status, disposition: status });
    expect(res.status).toBe(200);
    expect(res.body.data?.closedAt).toBeTruthy();
  });

  it("close with non-terminal status returns 400", async () => {
    const { ec } = await mkCase();
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/close`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ status: "WAITING" });
    expect(res.status).toBe(400);
  });

  it("close unknown case → 404", async () => {
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/00000000-0000-0000-0000-000000000000/close`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ status: "DISCHARGED" });
    expect(res.status).toBe(404);
  });

  // ─── MLC ──────────────────────────────────────────────────
  it("mark MLC sets isMLC=true", async () => {
    const { ec } = await mkCase();
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/mlc`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        isMLC: true,
        mlcNumber: "MLC-2026-01",
        mlcPoliceStation: "Central",
      });
    expect(res.status).toBe(200);
    expect(res.body.data?.isMLC).toBe(true);
  });

  it("mlc on unknown case → 404", async () => {
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/00000000-0000-0000-0000-000000000000/mlc`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ isMLC: true });
    expect(res.status).toBe(404);
  });

  // ─── Orders ───────────────────────────────────────────────
  it("save treatment orders array", async () => {
    const { ec } = await mkCase();
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/orders`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        orders: [
          { type: "MEDICATION", name: "Paracetamol", dose: "1g", route: "IV" },
          { type: "INVESTIGATION", name: "ECG" },
        ],
      });
    expect(res.status).toBe(200);
  });

  it("orders validation failure (400)", async () => {
    const { ec } = await mkCase();
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${ec.id}/orders`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ orders: [{ type: "BOGUS", name: "x" }] });
    expect(res.status).toBe(400);
  });

  // ─── Admit (ER → IPD) ─────────────────────────────────────
  it("admit ER case with known patient + available bed succeeds", async () => {
    const patient = await createPatientFixture();
    const { ec } = await mkCase(patient.id);
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const doc = await createDoctorFixture();
    const res = await request(app)
      .post(`/api/v1/emergency/cases/${ec.id}/admit`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({
        doctorId: doc.id,
        bedId: bed.id,
        reason: "observation",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.admission?.status).toBe("ADMITTED");
  });

  it("admit fails when bed unavailable (409)", async () => {
    const patient = await createPatientFixture();
    const { ec } = await mkCase(patient.id);
    const ward = await createWardFixture();
    const bed = await createBedFixture({
      wardId: ward.id,
      overrides: { status: "OCCUPIED" },
    });
    const doc = await createDoctorFixture();
    const res = await request(app)
      .post(`/api/v1/emergency/cases/${ec.id}/admit`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ doctorId: doc.id, bedId: bed.id, reason: "x" });
    expect(res.status).toBe(409);
  });

  it("admit fails for unknown (unregistered) patient (400)", async () => {
    // Case with no patientId
    const prisma = await getPrisma();
    const caseNumber = `ER${Date.now()}U`;
    const ec = await prisma.emergencyCase.create({
      data: {
        caseNumber,
        unknownName: "John Doe",
        chiefComplaint: "trauma",
        arrivedAt: new Date(),
        status: "WAITING",
      },
    });
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const doc = await createDoctorFixture();
    const res = await request(app)
      .post(`/api/v1/emergency/cases/${ec.id}/admit`)
      .set("Authorization", `Bearer ${doctor}`)
      .send({ doctorId: doc.id, bedId: bed.id, reason: "x" });
    expect(res.status).toBe(400);
  });

  // ─── Stats + lists ────────────────────────────────────────
  it("stats endpoint returns structured summary", async () => {
    const res = await request(app)
      .get("/api/v1/emergency/stats")
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.byTriage).toBeDefined();
    expect(res.body.data?.availableBeds).toBeGreaterThanOrEqual(0);
  });

  it("active cases list returns 200", async () => {
    const res = await request(app)
      .get("/api/v1/emergency/cases/active")
      .set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
  });

  // ─── Mass casualty ────────────────────────────────────────
  it("mass-casualty creates N cases", async () => {
    const res = await request(app)
      .post("/api/v1/emergency/mass-casualty")
      .set("Authorization", `Bearer ${doctor}`)
      .send({ count: 5, incidentNote: "bus accident" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.created).toBe(5);
  });

  it("mass-casualty rejects count > 50", async () => {
    const res = await request(app)
      .post("/api/v1/emergency/mass-casualty")
      .set("Authorization", `Bearer ${doctor}`)
      .send({ count: 500 });
    expect(res.status).toBe(400);
  });

  // ─── Get ──────────────────────────────────────────────────
  it("get unknown case 404", async () => {
    const res = await request(app)
      .get(`/api/v1/emergency/cases/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${doctor}`);
    expect(res.status).toBe(404);
  });

  it("unauthenticated list 401", async () => {
    const res = await request(app).get("/api/v1/emergency/cases");
    expect(res.status).toBe(401);
  });
});
