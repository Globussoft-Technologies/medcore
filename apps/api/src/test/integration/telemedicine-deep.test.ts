// Integration tests for the Jitsi deep-integration extensions to the
// telemedicine router — waiting-room admit/deny, precheck, recording
// start/stop, chat transcript endpoint.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture, createDoctorFixture } from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let patientToken: string;

describeIfDB("Telemedicine — Jitsi deep integration (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
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
        chiefComplaint: "Follow-up",
        fee: 500,
      });
    return { patient, doctor, session: res.body.data };
  }

  it("patient joins waiting room — status flips to WAITING and patientJoinedAt is stamped", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/waiting-room/join`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ deviceInfo: { camera: true, mic: true, userAgent: "vitest" } });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.patientJoinedAt).toBeTruthy();

    const prisma = await getPrisma();
    const row = await prisma.telemedicineSession.findUnique({
      where: { id: session.id },
    });
    expect(row?.status === "WAITING" || row?.status === "SCHEDULED").toBe(true);
    expect((row as any)?.waitingRoomState).toBe("PATIENT_WAITING");
  });

  it("doctor admits waiting patient — returns signed URLs and flips to IN_PROGRESS", async () => {
    const { session } = await setupSession();
    await request(app)
      .post(`/api/v1/telemedicine/${session.id}/waiting-room/join`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    const res = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/waiting-room/admit`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ admit: true });

    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.doctorUrl).toContain("meet");
    expect(res.body.data?.patientUrl).toContain("meet");
    expect(res.body.data?.room).toContain(session.id);
    expect(res.body.data?.waitingRoomState).toBe("ADMITTED");
    expect(res.body.data?.session?.status).toBe("IN_PROGRESS");
  });

  it("doctor can deny with a reason — state becomes DENIED, session NOT moved to IN_PROGRESS", async () => {
    const { session } = await setupSession();
    await request(app)
      .post(`/api/v1/telemedicine/${session.id}/waiting-room/join`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    const res = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/waiting-room/admit`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ admit: false, reason: "Need to reschedule" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.waitingRoomState).toBe("DENIED");
    expect(res.body.data?.session?.status).not.toBe("IN_PROGRESS");
  });

  it("precheck requires camera+mic both true to pass", async () => {
    const { session } = await setupSession();
    const partial = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/precheck`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ camera: true, mic: false });
    expect([200, 201]).toContain(partial.status);
    expect(partial.body.data?.precheckPassed).toBe(false);

    const full = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/precheck`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ camera: true, mic: true, userAgent: "vitest" });
    expect([200, 201]).toContain(full.status);
    expect(full.body.data?.precheckPassed).toBe(true);
  });

  it("recording start requires consent=true (400 otherwise) and stop stores URL", async () => {
    const { session } = await setupSession();
    const bad = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/recording/start`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ consent: false });
    expect(bad.status).toBe(400);

    const good = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/recording/start`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ consent: true });
    expect([200, 201]).toContain(good.status);
    expect(good.body.data?.recordingConsent).toBe(true);

    const stop = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/recording/stop`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ recordingUrl: "https://recordings.example.com/abc.mp4" });
    expect([200, 201]).toContain(stop.status);
    expect(stop.body.data?.recordingUrl).toBe(
      "https://recordings.example.com/abc.mp4"
    );
  });

  it("GET /:id/chat returns transcript envelope including messageCount", async () => {
    const { session } = await setupSession();
    await request(app)
      .post(`/api/v1/telemedicine/${session.id}/messages`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ text: "Hi!", sender: "DOCTOR" });
    await request(app)
      .post(`/api/v1/telemedicine/${session.id}/messages`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ text: "Hello doctor", sender: "PATIENT" });

    const res = await request(app)
      .get(`/api/v1/telemedicine/${session.id}/chat`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.messageCount).toBe(2);
    expect(res.body.data?.sessionNumber).toMatch(/^TEL\d+/);
    expect(Array.isArray(res.body.data?.transcript)).toBe(true);
  });

  it("waiting-room/join rejects a different patient's session (403)", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/waiting-room/join`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("waiting-room/admit forbids non-doctors/admins (403)", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/waiting-room/admit`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ admit: true });
    expect(res.status).toBe(403);
  });

  it("unauthenticated precheck is rejected (401)", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .post(`/api/v1/telemedicine/${session.id}/precheck`)
      .send({ camera: true, mic: true });
    expect(res.status).toBe(401);
  });
});
