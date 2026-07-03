/**
 * ABHA Milestone-1 (V3) Aadhaar enrolment + login — AUTHENTICATED routes on
 * apps/api/src/routes/abdm.ts:
 *   POST /abha/enrol/request-otp   POST /abha/enrol/verify-otp
 *   POST /abha/login/request-otp   POST /abha/login/verify-otp
 *   GET  /abha/enrol/profile       GET  /abha/enrol/card
 *
 * The enrolment SERVICE (services/abdm/abha-enrolment.ts) is mocked so these
 * tests exercise auth + validation + response wiring only (the service's crypto
 * and gateway calls are covered by abha-enrolment.test.ts). @medcore/db is
 * mocked so auditLog writes need no real DB. JWTs are minted with jsonwebtoken.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    patient: { findFirst: vi.fn(async () => null) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", async () => {
  const actual = await vi.importActual<any>("@medcore/db");
  return { ...actual, prisma: prismaMock, tenantScopedPrisma: prismaMock };
});

const serviceMock = vi.hoisted(() => ({
  requestAadhaarOtp: vi.fn(),
  verifyAadhaarOtp: vi.fn(),
  loginWithAadhaar: vi.fn(),
  verifyLoginOtp: vi.fn(),
  getPatientProfile: vi.fn(),
  downloadAbhaCard: vi.fn(),
  putAbhaSession: vi.fn(() => "sess-1"),
  getAbhaXToken: vi.fn(),
  // Other exports abdm.ts might touch on import — harmless stubs.
  generateAccessToken: vi.fn(),
}));

vi.mock("../services/abdm/abha-enrolment", () => serviceMock);

let app: express.Express;
let resetOtpLimiter: () => void;

const SAMPLE_PROFILE = {
  abhaNumber: "91-1234-5678-9012",
  abhaAddress: "rahul@sbx",
  name: "Rahul Kumar",
  gender: "M",
  dateOfBirth: "1990-01-01",
  mobile: "9876543210",
  email: null,
  address: null,
  pincode: null,
  stateName: null,
  districtName: null,
  photoBase64: null,
};

function tokenFor(role: string) {
  return jwt.sign(
    { userId: `u-${role}`, email: `${role}@test.local`, role },
    "test-secret",
  );
}

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret";
  // Keep the per-IP OTP cooldown BYPASSED (default test behaviour) so repeated
  // request-otp calls across tests don't 429. singleFork shares module state,
  // so another file may have flipped this on — force it off here.
  process.env.ENABLE_ABDM_OTP_RATELIMIT_IN_TESTS = "false";

  const mod = await import("./abdm");
  const errMod = await import("../middleware/error");
  resetOtpLimiter = mod.__resetAbdmOtpLimiterForTests;

  app = express();
  app.use(express.json());
  app.use("/api/v1/abdm", mod.abdmRouter);
  app.use(errMod.errorHandler);
});

beforeEach(() => {
  vi.clearAllMocks();
  serviceMock.putAbhaSession.mockReturnValue("sess-1");
  resetOtpLimiter();
});

const ADMIN = () => tokenFor("ADMIN");

describe("POST /abdm/abha/enrol/request-otp", () => {
  it("401 without a token", async () => {
    const res = await request(app)
      .post("/api/v1/abdm/abha/enrol/request-otp")
      .send({ aadhaar: "123456789012" });
    expect(res.status).toBe(401);
    expect(serviceMock.requestAadhaarOtp).not.toHaveBeenCalled();
  });

  it("403 for a role outside the ABHA set (NURSE)", async () => {
    const res = await request(app)
      .post("/api/v1/abdm/abha/enrol/request-otp")
      .set("Authorization", `Bearer ${tokenFor("NURSE")}`)
      .send({ aadhaar: "123456789012" });
    expect(res.status).toBe(403);
    expect(serviceMock.requestAadhaarOtp).not.toHaveBeenCalled();
  });

  it("400 on a malformed Aadhaar before calling the gateway", async () => {
    const res = await request(app)
      .post("/api/v1/abdm/abha/enrol/request-otp")
      .set("Authorization", `Bearer ${ADMIN()}`)
      .send({ aadhaar: "123" });
    expect(res.status).toBe(400);
    expect(serviceMock.requestAadhaarOtp).not.toHaveBeenCalled();
  });

  it("200 returns the txnId for an allowed role", async () => {
    serviceMock.requestAadhaarOtp.mockResolvedValue({ txnId: "txn-1", raw: {} });
    const res = await request(app)
      .post("/api/v1/abdm/abha/enrol/request-otp")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`)
      .send({ aadhaar: "123456789012" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { txnId: "txn-1" } });
    expect(serviceMock.requestAadhaarOtp).toHaveBeenCalledWith("123456789012");
  });
});

describe("POST /abdm/abha/enrol/verify-otp", () => {
  it("returns profile + opaque sessionId and never leaks the X-Token", async () => {
    serviceMock.verifyAadhaarOtp.mockResolvedValue({
      profile: SAMPLE_PROFILE,
      xToken: "x-token-secret",
      txnId: "txn-1",
      raw: {},
    });
    const res = await request(app)
      .post("/api/v1/abdm/abha/enrol/verify-otp")
      .set("Authorization", `Bearer ${ADMIN()}`)
      .send({ txnId: "txn-1", otp: "123456", mobile: "9876543210" });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.abhaNumber).toBe("91-1234-5678-9012");
    expect(res.body.data.sessionId).toBe("sess-1");
    expect(JSON.stringify(res.body)).not.toContain("x-token-secret");
  });

  it("400 on a malformed OTP", async () => {
    const res = await request(app)
      .post("/api/v1/abdm/abha/enrol/verify-otp")
      .set("Authorization", `Bearer ${ADMIN()}`)
      .send({ txnId: "txn-1", otp: "xx", mobile: "9876543210" });
    expect(res.status).toBe(400);
    expect(serviceMock.verifyAadhaarOtp).not.toHaveBeenCalled();
  });
});

describe("POST /abdm/abha/login/request-otp + verify-otp", () => {
  it("login request returns a txnId", async () => {
    serviceMock.loginWithAadhaar.mockResolvedValue({ txnId: "txn-login", raw: {} });
    const res = await request(app)
      .post("/api/v1/abdm/abha/login/request-otp")
      .set("Authorization", `Bearer ${ADMIN()}`)
      .send({ aadhaar: "123456789012" });
    expect(res.status).toBe(200);
    expect(res.body.data.txnId).toBe("txn-login");
  });

  it("login verify returns profile + sessionId (fetching profile when absent)", async () => {
    serviceMock.verifyLoginOtp.mockResolvedValue({
      xToken: "x-token-secret",
      profile: null,
      raw: {},
    });
    serviceMock.getPatientProfile.mockResolvedValue(SAMPLE_PROFILE);
    const res = await request(app)
      .post("/api/v1/abdm/abha/login/verify-otp")
      .set("Authorization", `Bearer ${ADMIN()}`)
      .send({ txnId: "txn-login", otp: "123456" });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.name).toBe("Rahul Kumar");
    expect(res.body.data.sessionId).toBe("sess-1");
    expect(serviceMock.getPatientProfile).toHaveBeenCalledWith("x-token-secret");
    expect(JSON.stringify(res.body)).not.toContain("x-token-secret");
  });
});

describe("GET /abdm/abha/enrol/profile", () => {
  it("400 when sessionId is missing", async () => {
    const res = await request(app)
      .get("/api/v1/abdm/abha/enrol/profile")
      .set("Authorization", `Bearer ${ADMIN()}`);
    expect(res.status).toBe(400);
  });

  it("401 when the session is unknown/expired", async () => {
    serviceMock.getAbhaXToken.mockReturnValue(null);
    const res = await request(app)
      .get("/api/v1/abdm/abha/enrol/profile")
      .query({ sessionId: "sess-unknown-123" })
      .set("Authorization", `Bearer ${ADMIN()}`);
    expect(res.status).toBe(401);
    expect(serviceMock.getPatientProfile).not.toHaveBeenCalled();
  });

  it("200 returns the profile for a valid session", async () => {
    serviceMock.getAbhaXToken.mockReturnValue("x-token-secret");
    serviceMock.getPatientProfile.mockResolvedValue(SAMPLE_PROFILE);
    const res = await request(app)
      .get("/api/v1/abdm/abha/enrol/profile")
      .query({ sessionId: "sess-valid-123" })
      .set("Authorization", `Bearer ${ADMIN()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.profile.name).toBe("Rahul Kumar");
  });
});

describe("GET /abdm/abha/enrol/card", () => {
  it("streams the ABHA card PDF for a valid session", async () => {
    serviceMock.getAbhaXToken.mockReturnValue("x-token-secret");
    serviceMock.downloadAbhaCard.mockResolvedValue({
      buffer: Buffer.from("%PDF-1.4 fake"),
      contentType: "application/pdf",
    });
    const res = await request(app)
      .get("/api/v1/abdm/abha/enrol/card")
      .query({ sessionId: "sess-valid-123" })
      .set("Authorization", `Bearer ${ADMIN()}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(serviceMock.downloadAbhaCard).toHaveBeenCalledWith("x-token-secret");
  });

  it("401 when the session is unknown/expired", async () => {
    serviceMock.getAbhaXToken.mockReturnValue(null);
    const res = await request(app)
      .get("/api/v1/abdm/abha/enrol/card")
      .query({ sessionId: "sess-unknown-123" })
      .set("Authorization", `Bearer ${ADMIN()}`);
    expect(res.status).toBe(401);
    expect(serviceMock.downloadAbhaCard).not.toHaveBeenCalled();
  });
});
