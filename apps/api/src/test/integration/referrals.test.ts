// Integration tests for the referrals router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
} from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let receptionToken: string;

describeIfDB("Referrals API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  async function createReferral(overrides: Partial<any> = {}) {
    const patient = overrides.patient || (await createPatientFixture());
    const fromDoctor = overrides.fromDoctor || (await createDoctorFixture());
    const toDoctor = overrides.toDoctor || (await createDoctorFixture());
    const res = await request(app)
      .post("/api/v1/referrals")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        fromDoctorId: fromDoctor.id,
        toDoctorId: toDoctor.id,
        specialty: "Cardiology",
        reason: overrides.reason || "Suspected CAD",
        notes: overrides.notes,
      });
    return { patient, fromDoctor, toDoctor, res };
  }

  it("creates an internal referral with auto referralNumber", async () => {
    const { res } = await createReferral();
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.referralNumber).toMatch(/^REF\d+/);
    expect(res.body.data?.status).toBe("PENDING");
  });

  it("creates an external referral (no toDoctorId)", async () => {
    const patient = await createPatientFixture();
    const fromDoctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/referrals")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        fromDoctorId: fromDoctor.id,
        externalProvider: "City Hospital",
        specialty: "Oncology",
        reason: "Tertiary care needed",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.externalProvider).toBe("City Hospital");
  });

  it("lists referrals (admin)", async () => {
    await createReferral();
    const res = await request(app)
      .get("/api/v1/referrals")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("requires auth (401)", async () => {
    const res = await request(app).get("/api/v1/referrals");
    expect(res.status).toBe(401);
  });

  it("reception cannot create referrals (403)", async () => {
    const patient = await createPatientFixture();
    const fromDoctor = await createDoctorFixture();
    const toDoctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/referrals")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        fromDoctorId: fromDoctor.id,
        toDoctorId: toDoctor.id,
        reason: "x",
      });
    expect(res.status).toBe(403);
  });

  it("rejects malformed payload (400: no destination)", async () => {
    const patient = await createPatientFixture();
    const fromDoctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/referrals")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        fromDoctorId: fromDoctor.id,
        reason: "missing dest",
      });
    expect(res.status).toBe(400);
  });

  // ─── Issue #10: empty reason rejected server-side ───────────────────
  it("rejects empty reason (400, issue #10)", async () => {
    const patient = await createPatientFixture();
    const fromDoctor = await createDoctorFixture();
    const toDoctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/referrals")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        fromDoctorId: fromDoctor.id,
        toDoctorId: toDoctor.id,
        reason: "",
      });
    expect(res.status).toBe(400);
  });

  it("inbox requires doctorId query param (400)", async () => {
    const res = await request(app)
      .get("/api/v1/referrals/inbox")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("inbox returns referrals for a given doctor", async () => {
    const { toDoctor } = await createReferral();
    const res = await request(app)
      .get(`/api/v1/referrals/inbox?doctorId=${toDoctor.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("update status ACCEPTED stamps respondedAt (side-effect)", async () => {
    const { res: create } = await createReferral();
    const id = create.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/referrals/${id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ status: "ACCEPTED" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("ACCEPTED");
    expect(res.body.data?.respondedAt).toBeTruthy();

    const prisma = await getPrisma();
    const refreshed = await prisma.referral.findUnique({ where: { id } });
    expect(refreshed?.respondedAt).toBeTruthy();
  });

  it("returns 404 for unknown referral", async () => {
    const res = await request(app)
      .get("/api/v1/referrals/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
