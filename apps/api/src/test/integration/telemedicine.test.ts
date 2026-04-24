// Integration tests for the telemedicine router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture, createDoctorFixture } from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let nurseToken: string;

describeIfDB("Telemedicine API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  async function setupSession() {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const scheduledAt = new Date(Date.now() + 3600_000).toISOString();
    const res = await request(app)
      .post("/api/v1/telemedicine")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        scheduledAt,
        chiefComplaint: "Fever",
        fee: 500,
      });
    return { patient, doctor, session: res.body.data, status: res.status };
  }

  it("schedules a new session with meeting URL + sessionNumber", async () => {
    const { session, status } = await setupSession();
    expect([200, 201]).toContain(status);
    expect(session?.sessionNumber).toMatch(/^TEL\d+/);
    expect(session?.meetingUrl).toContain("meet.jit.si");
    expect(session?.status).toBe("SCHEDULED");
  });

  it("lists sessions (admin, paginated)", async () => {
    await setupSession();
    const res = await request(app)
      .get("/api/v1/telemedicine")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta?.total).toBeGreaterThanOrEqual(1);
  });

  it("rejects unauthenticated requests (401)", async () => {
    const res = await request(app).get("/api/v1/telemedicine");
    expect(res.status).toBe(401);
  });

  it("starts a session — status becomes IN_PROGRESS, startedAt stamped", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .patch(`/api/v1/telemedicine/${session.id}/start`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("IN_PROGRESS");
    expect(res.body.data?.startedAt).toBeTruthy();
  });

  it("ends a session — computes durationMin, marks COMPLETED", async () => {
    const { session } = await setupSession();
    await request(app)
      .patch(`/api/v1/telemedicine/${session.id}/start`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    const res = await request(app)
      .patch(`/api/v1/telemedicine/${session.id}/end`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ doctorNotes: "Patient advised rest and fluids" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("COMPLETED");
    expect(res.body.data?.endedAt).toBeTruthy();
    expect(typeof res.body.data?.durationMin).toBe("number");
  });

  it("rejects rating before session is COMPLETED (409)", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .patch(`/api/v1/telemedicine/${session.id}/rating`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientRating: 5 });
    expect(res.status).toBe(409);
  });

  it("nurse cannot schedule sessions (403)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/telemedicine")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        scheduledAt: new Date().toISOString(),
      });
    expect(res.status).toBe(403);
  });

  it("rejects malformed schedule payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/telemedicine")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  // ─── Issues #18 / #27 (server defense-in-depth) ─────────────────────
  it("rejects negative fee (400, issue #18)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/telemedicine")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
        fee: -500,
      });
    expect(res.status).toBe(400);
  });

  it("rejects past scheduledAt (400, issue #18)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/telemedicine")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        scheduledAt: "2020-01-01T00:00:00.000Z",
        fee: 100,
      });
    expect(res.status).toBe(400);
  });

  it("cancels a session", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .patch(`/api/v1/telemedicine/${session.id}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("CANCELLED");
  });

  it("join marks waiting state + patientJoinedAt", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .patch(`/api/v1/telemedicine/${session.id}/join`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.patientJoinedAt).toBeTruthy();

    const prisma = await getPrisma();
    const refreshed = await prisma.telemedicineSession.findUnique({
      where: { id: session.id },
    });
    expect(refreshed?.status === "WAITING" || refreshed?.status === "SCHEDULED").toBe(
      true
    );
  });

  it("appends a chat message", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/messages`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ text: "Hello, how are you?", sender: "DOCTOR" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.message?.text).toBe("Hello, how are you?");
  });
});
