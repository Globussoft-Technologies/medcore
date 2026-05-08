// Integration test for issue #602 hardening — per-meeting JWT room admission.
//
// Modules covered:
//   - apps/api/src/routes/telemedicine.ts (GET /:id, GET /)
//   - apps/api/src/services/jitsi.ts (signedJitsiRoomUrl + JWT claims)
//
// Why: the original #602 fix (1dd2095) gated list/detail by role and
// scrubbed `meetingId` from non-participant responses. A determined
// attacker who learned the bare meetingId via another channel could still
// construct `https://meet.jit.si/medcore-<meetingId>` and walk in. This
// hardening removes meetingId/meetingUrl from EVERY response and replaces
// it with a freshly-minted, per-user, 30-minute-TTL JWT URL on each
// GET /:id call. These tests pin all four contracts:
//   1. List response never contains meetingId or meetingUrl.
//   2. Detail response never contains meetingId or meetingUrl.
//   3. Detail response carries a signedRoomUrl for participants.
//   4. The JWT inside that URL has correct aud / iss / room / exp / context.user.
import { it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import { createPatientFixture, createDoctorFixture } from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let nurseToken: string;

describeIfDB("Telemedicine signed-URL hardening (#602 follow-up)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  // The signing helper is a no-op when JITSI_APP_ID / JITSI_APP_SECRET are
  // unset — for these tests we install deterministic test creds for the
  // duration of the suite so the JWT-decoding assertions are meaningful.
  // We restore whatever was set on the host afterwards.
  const TEST_APP_ID = "medcore-test-app";
  const TEST_APP_SECRET = "medcore-test-secret-do-not-use-in-prod";
  let savedAppId: string | undefined;
  let savedAppSecret: string | undefined;

  beforeAll(() => {
    savedAppId = process.env.JITSI_APP_ID;
    savedAppSecret = process.env.JITSI_APP_SECRET;
    process.env.JITSI_APP_ID = TEST_APP_ID;
    process.env.JITSI_APP_SECRET = TEST_APP_SECRET;
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
        chiefComplaint: "Routine consult",
        fee: 500,
      });
    return { patient, doctor, session: res.body.data };
  }

  beforeEach(() => {
    // Just re-affirm test creds in case some other parallel suite mutates them.
    process.env.JITSI_APP_ID = TEST_APP_ID;
    process.env.JITSI_APP_SECRET = TEST_APP_SECRET;
  });

  it("GET /:id response does NOT contain raw meetingId or meetingUrl", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .get(`/api/v1/telemedicine/${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Belt + suspenders: the field may either be absent OR explicitly null.
    // Reject anything that would re-enable the bare-URL join shortcut.
    expect(res.body.data?.meetingId == null || res.body.data?.meetingId === undefined).toBe(true);
    expect(res.body.data?.meetingUrl == null || res.body.data?.meetingUrl === undefined).toBe(true);
    expect(res.body.data?.meetingId).toBeFalsy();
    expect(res.body.data?.meetingUrl).toBeFalsy();
  });

  it("GET /:id response DOES contain signedRoomUrl for ADMIN (break-glass moderator)", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .get(`/api/v1/telemedicine/${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.signedRoomUrl).toBe("string");
    expect(res.body.data.signedRoomUrl).toContain("jwt=");
    expect(res.body.data.signedRoomUrl).toMatch(/^https:\/\/[^/]+\/medcore-/);
  });

  it("Each GET /:id mints a fresh signedRoomUrl (rotation on every fetch)", async () => {
    const { session } = await setupSession();
    const first = await request(app)
      .get(`/api/v1/telemedicine/${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    // Wait at least 1s so JWT iat differs (HS256 over deterministic payload
    // would otherwise produce identical JWTs).
    await new Promise((r) => setTimeout(r, 1100));
    const second = await request(app)
      .get(`/api/v1/telemedicine/${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(first.body.data.signedRoomUrl).not.toBe(second.body.data.signedRoomUrl);
  });

  it("JWT inside signedRoomUrl has correct aud, iss, room, exp, context.user", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .get(`/api/v1/telemedicine/${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const url: string = res.body.data.signedRoomUrl;
    const tokenMatch = url.match(/[?&]jwt=([^&]+)/);
    expect(tokenMatch).toBeTruthy();
    const token = tokenMatch![1];
    const decoded: any = jwt.verify(token, TEST_APP_SECRET);
    expect(decoded.aud).toBe("jitsi");
    expect(decoded.iss).toBe(TEST_APP_ID);
    expect(decoded.room).toMatch(/^medcore-/);
    expect(typeof decoded.exp).toBe("number");
    // 30-minute TTL: exp - iat should be ~1800. Allow ±60s slack.
    expect(decoded.exp - decoded.iat).toBeGreaterThanOrEqual(1800 - 60);
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(1800 + 60);
    expect(decoded.context?.user).toBeTruthy();
    expect(typeof decoded.context.user.id).toBe("string");
    expect(typeof decoded.context.user.name).toBe("string");
    // ADMIN gets moderator role
    expect(decoded.context.user.moderator).toBe("true");
  });

  it("PATIENT participant gets signedRoomUrl with their own user identity", async () => {
    // Provision a fresh patient + their JWT, then schedule a session for
    // them. Use the per-suite shared seed PATIENT for simplicity.
    const patientToken = await getAuthToken("PATIENT");
    // Find that patient's row and seed a session pointing at it.
    const { getPrisma } = await import("../setup");
    const prisma = await getPrisma();
    const patientUser = await prisma.user.findUnique({
      where: { email: "patient@test.local" },
    });
    expect(patientUser).toBeTruthy();
    const patient = await prisma.patient.findFirst({
      where: { userId: patientUser.id },
    });
    expect(patient).toBeTruthy();
    const doctor = await createDoctorFixture();
    const created = await request(app)
      .post("/api/v1/telemedicine")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      });
    expect([200, 201]).toContain(created.status);
    const sessionId = created.body.data.id;

    const res = await request(app)
      .get(`/api/v1/telemedicine/${sessionId}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.signedRoomUrl).toBe("string");

    const tokenMatch = res.body.data.signedRoomUrl.match(/[?&]jwt=([^&]+)/);
    const decoded: any = jwt.verify(tokenMatch![1], TEST_APP_SECRET);
    // PATIENT gets participant role, not moderator
    expect(decoded.context.user.moderator).toBe("false");
    expect(decoded.context.user.id).toBe(patientUser.id);
  });

  it("NURSE (non-participant role allowlisted for list) gets signedRoomUrl: null on detail", async () => {
    const { session } = await setupSession();
    const res = await request(app)
      .get(`/api/v1/telemedicine/${session.id}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    // NURSE can read the schedule but cannot join the room.
    expect(res.body.data?.signedRoomUrl).toBeNull();
    // And critically, no raw join primitive smuggled in.
    expect(res.body.data?.meetingId).toBeFalsy();
    expect(res.body.data?.meetingUrl).toBeFalsy();
  });

  it("DOCTOR who isn't the assigned clinician gets signedRoomUrl: null", async () => {
    const { session } = await setupSession();
    // doctorToken is the shared seed doctor — NOT the doctor on the session
    // (which was minted via createDoctorFixture). So this DOCTOR is a
    // bystander w.r.t. this specific session.
    const res = await request(app)
      .get(`/api/v1/telemedicine/${session.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.signedRoomUrl).toBeNull();
    expect(res.body.data?.meetingId).toBeFalsy();
    expect(res.body.data?.meetingUrl).toBeFalsy();
  });

  it("GET / (list) never returns meetingId or meetingUrl on any row", async () => {
    await setupSession();
    await setupSession();
    const res = await request(app)
      .get("/api/v1/telemedicine?limit=10")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    for (const row of res.body.data) {
      expect(row.meetingId).toBeFalsy();
      expect(row.meetingUrl).toBeFalsy();
    }
  });

  // Restore the host's original JITSI_APP_ID / JITSI_APP_SECRET so subsequent
  // suites running in the same fork see the original env. Vitest runs files
  // in the same fork under singleFork:true so leakage matters — see CLAUDE.md
  // gotcha #2 ("module-scope state under singleFork:true").
  afterAll(() => {
    if (savedAppId === undefined) delete process.env.JITSI_APP_ID;
    else process.env.JITSI_APP_ID = savedAppId;
    if (savedAppSecret === undefined) delete process.env.JITSI_APP_SECRET;
    else process.env.JITSI_APP_SECRET = savedAppSecret;
  });
});
