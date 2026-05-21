// Patient phone-OTP login integration tests (Pearl §5.3 / §6.1 — gap #5 piece 2 of 4).
//
// Covers the two-endpoint flow shipped in apps/api/src/routes/patient-auth.ts:
//   - POST /api/v1/patient-auth/otp-request — anti-enumeration shape, real
//     challenge persistence, per-phone rate-limiting (opt-in via env flag).
//   - POST /api/v1/patient-auth/otp-verify — happy path mints JWT + cookies,
//     wrong-code path increments attempts, after 5 wrong attempts the route
//     returns 429, expired challenge returns 401.
//
// Notes on infra:
//   - The SMS adapter (apps/api/src/services/channels/sms.ts) falls back to
//     stub-mode when SMS_API_KEY/SMS_API_URL are unset — that's the path
//     these tests exercise. No HTTP traffic leaves the test process.
//   - We seed Patients via direct prisma writes (NOT getAuthToken('PATIENT'))
//     because the whole point is to test OTP login, not to short-circuit it.
//   - The per-phone rate-limit test sets ENABLE_PATIENT_OTP_RATELIMIT_IN_TESTS
//     to assert that the throttle fires after the 4th request. Cleanup hook
//     `__resetPatientOtpLimiterForTests` keeps the bucket from poisoning
//     sibling test files (singleFork: true contract — CLAUDE.md gotcha #2).

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";

let app: any;
let resetPatientOtpLimiter: () => void;

const PHONE_REGISTERED = "9876500001";
const PHONE_UNKNOWN = "9876500999";

async function seedPatient(prisma: any, phone: string) {
  const user = await prisma.user.create({
    data: {
      email: `patient-${phone}@test.local`,
      name: "OTP Patient",
      phone,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT",
      isActive: true,
    },
  });
  await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-OTP-${phone.slice(-4)}`,
      dateOfBirth: new Date("1990-01-01"),
      gender: "MALE" as any,
    },
  });
  return user;
}

describeIfDB("Patient phone-OTP login (Pearl gap #5 piece 2)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
    const routeMod = await import("../../routes/patient-auth");
    resetPatientOtpLimiter = routeMod.__resetPatientOtpLimiterForTests;

    const prisma = await getPrisma();
    await seedPatient(prisma, PHONE_REGISTERED);
  });

  afterAll(() => {
    // Pair with the limiter reset so any opt-in rate-limit case doesn't
    // leave a poisoned bucket for downstream files in the same worker.
    resetPatientOtpLimiter?.();
    delete process.env.ENABLE_PATIENT_OTP_RATELIMIT_IN_TESTS;
  });

  beforeEach(async () => {
    // Each case starts with no challenges for the registered phone so
    // verify-side tests can assert on a fresh row.
    const prisma = await getPrisma();
    await prisma.patientOtpChallenge.deleteMany({});
    resetPatientOtpLimiter?.();
  });

  it("POST /otp-request for an existing PATIENT phone returns 200 and persists a challenge", async () => {
    const res = await request(app)
      .post("/api/v1/patient-auth/otp-request")
      .send({ phone: PHONE_REGISTERED });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { sent: true },
      error: null,
    });

    const prisma = await getPrisma();
    const row = await prisma.patientOtpChallenge.findFirst({
      where: { phone: PHONE_REGISTERED },
    });
    expect(row).toBeTruthy();
    expect(row.consumed).toBe(false);
    expect(row.attempts).toBe(0);
    // bcrypt hash should NOT be the literal 6-digit code.
    expect(row.otpHash).not.toMatch(/^\d{6}$/);
    expect(row.otpHash.length).toBeGreaterThan(20);
  });

  it("POST /otp-request for an unknown phone returns 200 (no enumeration) and does NOT persist a challenge", async () => {
    const res = await request(app)
      .post("/api/v1/patient-auth/otp-request")
      .send({ phone: PHONE_UNKNOWN });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { sent: true },
      error: null,
    });

    const prisma = await getPrisma();
    const row = await prisma.patientOtpChallenge.findFirst({
      where: { phone: PHONE_UNKNOWN },
    });
    expect(row).toBeNull();
  });

  it("POST /otp-verify with the correct code returns 200, an accessToken, and sets the medcore_at cookie", async () => {
    // Mint a known-plaintext challenge directly so we don't have to
    // intercept the SMS adapter to learn the random code.
    const prisma = await getPrisma();
    const code = "424242";
    const otpHash = await bcrypt.hash(code, 4);
    await prisma.patientOtpChallenge.create({
      data: {
        phone: PHONE_REGISTERED,
        otpHash,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    const res = await request(app)
      .post("/api/v1/patient-auth/otp-verify")
      .send({ phone: PHONE_REGISTERED, otp: code });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.accessToken).toEqual(expect.any(String));
    expect(res.body.data?.user?.role).toBe("PATIENT");

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const cookieJoin = Array.isArray(setCookie) ? setCookie.join("\n") : String(setCookie);
    expect(cookieJoin).toMatch(/medcore_at=/);
    expect(cookieJoin).toMatch(/medcore_csrf=/);
  });

  it("POST /otp-verify with a wrong code returns 401 and increments attempts", async () => {
    const prisma = await getPrisma();
    const code = "111111";
    const otpHash = await bcrypt.hash(code, 4);
    const created = await prisma.patientOtpChallenge.create({
      data: {
        phone: PHONE_REGISTERED,
        otpHash,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    const res = await request(app)
      .post("/api/v1/patient-auth/otp-verify")
      .send({ phone: PHONE_REGISTERED, otp: "999999" });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);

    const after = await prisma.patientOtpChallenge.findUnique({
      where: { id: created.id },
    });
    expect(after.attempts).toBe(1);
    expect(after.consumed).toBe(false);
  });

  it("POST /otp-verify returns 429 once a challenge has 5 failed attempts on record", async () => {
    const prisma = await getPrisma();
    const otpHash = await bcrypt.hash("222222", 4);
    await prisma.patientOtpChallenge.create({
      data: {
        phone: PHONE_REGISTERED,
        otpHash,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        attempts: 5,
      },
    });

    const res = await request(app)
      .post("/api/v1/patient-auth/otp-verify")
      .send({ phone: PHONE_REGISTERED, otp: "000000" });
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/too many/i);
  });

  it("POST /otp-verify against an expired challenge returns 401", async () => {
    const prisma = await getPrisma();
    const code = "333333";
    const otpHash = await bcrypt.hash(code, 4);
    await prisma.patientOtpChallenge.create({
      data: {
        phone: PHONE_REGISTERED,
        otpHash,
        // 1 second in the past
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const res = await request(app)
      .post("/api/v1/patient-auth/otp-verify")
      .send({ phone: PHONE_REGISTERED, otp: code });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("POST /otp-request honours the per-phone rate limit when opted in (4th request in window returns 429)", async () => {
    // Opt-in: by default NODE_ENV=test bypasses the limiter so the rest of
    // the suite doesn't flake. We flip the flag, reset the bucket, fire 4
    // requests, then unflag in afterAll.
    process.env.ENABLE_PATIENT_OTP_RATELIMIT_IN_TESTS = "true";
    resetPatientOtpLimiter();

    const phone = "9876500002";
    const prisma = await getPrisma();
    await seedPatient(prisma, phone);

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/api/v1/patient-auth/otp-request")
        .send({ phone });
      expect(res.status).toBe(200);
    }

    const fourth = await request(app)
      .post("/api/v1/patient-auth/otp-request")
      .send({ phone });
    expect(fourth.status).toBe(429);
    expect(fourth.body.success).toBe(false);
    expect(fourth.body.retryAfterSeconds).toEqual(expect.any(Number));
  });
});
