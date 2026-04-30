// Integration tests for the nurse-rounds router.
// Skipped unless DATABASE_URL_TEST is set.
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
let nurseToken: string;
let doctorToken: string;
let receptionToken: string;
let patientToken: string;

async function setupAdmission() {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const ward = await createWardFixture();
  const bed = await createBedFixture({ wardId: ward.id });
  const admission = await createAdmissionFixture({
    patientId: patient.id,
    doctorId: doctor.id,
    bedId: bed.id,
  });
  return { patient, doctor, admission };
}

describeIfDB("Nurse-Rounds API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    nurseToken = await getAuthToken("NURSE");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /nurse-rounds ───────────────────────────────────

  it("records a nurse round (201) with notes + nurse identity", async () => {
    const { admission } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ admissionId: admission.id, notes: "BP stable, patient resting" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.admissionId).toBe(admission.id);
    expect(res.body.data?.notes).toMatch(/BP stable/);
    expect(res.body.data?.nurse?.name).toBeTruthy();

    const prisma = await getPrisma();
    const stored = await prisma.nurseRound.findUnique({
      where: { id: res.body.data.id },
    });
    expect(stored).toBeTruthy();
  });

  it("rejects POST when admission does not exist (404)", async () => {
    const res = await request(app)
      .post("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        admissionId: "00000000-0000-0000-0000-000000000404",
        notes: "phantom round",
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("rejects POST with invalid payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ admissionId: "not-a-uuid", notes: "" });
    expect(res.status).toBe(400);
  });

  it("rejects POST from RECEPTION (403)", async () => {
    const { admission } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ admissionId: admission.id, notes: "round" });
    expect(res.status).toBe(403);
  });

  it("rejects POST from PATIENT (403)", async () => {
    const { admission } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ admissionId: admission.id, notes: "round" });
    expect(res.status).toBe(403);
  });

  it("rejects POST without auth (401)", async () => {
    const res = await request(app)
      .post("/api/v1/nurse-rounds")
      .send({
        admissionId: "00000000-0000-0000-0000-000000000000",
        notes: "x",
      });
    expect(res.status).toBe(401);
  });

  it("allows DOCTOR to record a round", async () => {
    const { admission } = await setupAdmission();
    const res = await request(app)
      .post("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ admissionId: admission.id, notes: "Doctor walk-around" });
    expect([200, 201]).toContain(res.status);
  });

  // ─── GET /nurse-rounds ────────────────────────────────────

  it("lists rounds for an admission (200, sorted desc)", async () => {
    const { admission } = await setupAdmission();
    await request(app)
      .post("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ admissionId: admission.id, notes: "first round" });
    await request(app)
      .post("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ admissionId: admission.id, notes: "second round" });

    const res = await request(app)
      .get(`/api/v1/nurse-rounds?admissionId=${admission.id}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    // shape guard
    expect(res.body.data[0].nurse).toBeTruthy();
    expect(typeof res.body.data[0].nurse.name).toBe("string");
  });

  it("returns 400 when admissionId query is missing", async () => {
    const res = await request(app)
      .get("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/admissionId/i);
  });

  it("rejects GET without auth (401)", async () => {
    const res = await request(app).get(
      "/api/v1/nurse-rounds?admissionId=00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });
});
