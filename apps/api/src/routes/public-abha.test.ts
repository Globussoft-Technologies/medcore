// Route tests for the PUBLIC ABHA (ABDM M1 V3) router.
//   • validation rejects a malformed Aadhaar (400) before any gateway call
//   • request-otp / verify-otp return the {success,data,error} envelope
//   • the ABDM X-Token is NEVER returned to the client (only the opaque
//     sessionId + normalised profile)
//   • profile with a missing/expired session → 401
//
// The enrolment SERVICE is mocked so these tests exercise routing/validation
// only (the service itself is covered by abha-enrolment.test.ts). Audit is
// stubbed so no DB is required.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const serviceMock = vi.hoisted(() => ({
  requestAadhaarOtp: vi.fn(),
  verifyAadhaarOtp: vi.fn(),
  loginWithAadhaar: vi.fn(),
  verifyLoginOtp: vi.fn(),
  getPatientProfile: vi.fn(),
  downloadAbhaCard: vi.fn(),
  putAbhaSession: vi.fn(() => "sess-1"),
  getAbhaXToken: vi.fn(),
}));

vi.mock("../services/abdm/abha-enrolment", () => serviceMock);
vi.mock("../middleware/audit", () => ({ auditLog: vi.fn(async () => {}) }));

import { publicAbhaRouter } from "./public-abha";
import { errorHandler } from "../middleware/error";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/public/abha", publicAbhaRouter);
  // The router's scoped handler passes ZodErrors through to the global
  // errorHandler, which maps them to 400 (same as the mounted app).
  app.use(errorHandler);
  return app;
}

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

beforeEach(() => {
  vi.clearAllMocks();
  serviceMock.putAbhaSession.mockReturnValue("sess-1");
});

describe("POST /public/abha/request-otp", () => {
  it("rejects a malformed Aadhaar with 400 before calling the gateway", async () => {
    const res = await request(buildApp())
      .post("/api/v1/public/abha/request-otp")
      .send({ aadhaar: "123" });
    expect(res.status).toBe(400);
    expect(serviceMock.requestAadhaarOtp).not.toHaveBeenCalled();
  });

  it("returns the txnId in the success envelope", async () => {
    serviceMock.requestAadhaarOtp.mockResolvedValue({ txnId: "txn-1", raw: {} });
    const res = await request(buildApp())
      .post("/api/v1/public/abha/request-otp")
      .send({ aadhaar: "123456789012" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { txnId: "txn-1" } });
  });
});

describe("POST /public/abha/verify-otp", () => {
  it("returns the profile + opaque sessionId and NEVER the X-Token", async () => {
    serviceMock.verifyAadhaarOtp.mockResolvedValue({
      profile: SAMPLE_PROFILE,
      xToken: "x-token-secret",
      txnId: "txn-1",
      raw: {},
    });
    const res = await request(buildApp())
      .post("/api/v1/public/abha/verify-otp")
      .send({ txnId: "txn-1", otp: "123456", mobile: "9876543210" });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.abhaNumber).toBe("91-1234-5678-9012");
    expect(res.body.data.sessionId).toBe("sess-1");
    // The raw ABDM token must not leak to the client anywhere in the body.
    expect(JSON.stringify(res.body)).not.toContain("x-token-secret");
  });

  it("rejects a bad OTP shape with 400", async () => {
    const res = await request(buildApp())
      .post("/api/v1/public/abha/verify-otp")
      .send({ txnId: "txn-1", otp: "abc", mobile: "9876543210" });
    expect(res.status).toBe(400);
    expect(serviceMock.verifyAadhaarOtp).not.toHaveBeenCalled();
  });
});

describe("GET /public/abha/profile", () => {
  it("400 when sessionId is missing", async () => {
    const res = await request(buildApp()).get("/api/v1/public/abha/profile");
    expect(res.status).toBe(400);
  });

  it("401 when the session has expired / is unknown", async () => {
    serviceMock.getAbhaXToken.mockReturnValue(null);
    const res = await request(buildApp())
      .get("/api/v1/public/abha/profile")
      .query({ sessionId: "sess-unknown-123" });
    expect(res.status).toBe(401);
    expect(serviceMock.getPatientProfile).not.toHaveBeenCalled();
  });

  it("200 with the profile when the session is valid", async () => {
    serviceMock.getAbhaXToken.mockReturnValue("x-token-secret");
    serviceMock.getPatientProfile.mockResolvedValue(SAMPLE_PROFILE);
    const res = await request(buildApp())
      .get("/api/v1/public/abha/profile")
      .query({ sessionId: "sess-valid-123" });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.name).toBe("Rahul Kumar");
  });
});
