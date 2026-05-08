/**
 * Issue #741 — ABDM OTP send must enforce a 30-second per-(key, IP)
 * server-side cooldown so a misbehaving / malicious client cannot blast
 * the upstream ABDM gateway with OTP requests.
 *
 * Modules under test:
 *   - apps/api/src/routes/abdm.ts (POST /api/v1/abdm/abha/otp/send)
 *
 * Test infra (per CLAUDE.md gotcha #2): NODE_ENV=test bypasses the
 * cooldown by default to keep the rest of the suite deterministic. This
 * file flips ENABLE_ABDM_OTP_RATELIMIT_IN_TESTS=true BEFORE importing
 * the router and calls __resetAbdmOtpLimiterForTests() in beforeAll to
 * clear any module-scope state from prior files (singleFork: true).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", async () => {
  const actual = await vi.importActual<any>("@medcore/db");
  return {
    ...actual,
    prisma: prismaMock,
    tenantScopedPrisma: prismaMock,
  };
});

let app: express.Express;
let adminTokenStr: string;
let resetOtpLimiter: () => void;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret";
  process.env.ENABLE_ABDM_OTP_RATELIMIT_IN_TESTS = "true";

  const mod = await import("./abdm");
  const errMod = await import("../middleware/error");
  resetOtpLimiter = mod.__resetAbdmOtpLimiterForTests;

  app = express();
  app.use(express.json());
  app.use("/api/v1/abdm", mod.abdmRouter);
  app.use(errMod.errorHandler);

  adminTokenStr = jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
});

beforeEach(() => {
  resetOtpLimiter();
});

describe("Issue #741 — POST /abdm/abha/otp/send 30s cooldown", () => {
  it("returns 202 on the first request and 429 with Retry-After on an immediate resend for the same mobile", async () => {
    const first = await request(app)
      .post("/api/v1/abdm/abha/otp/send")
      .set("Authorization", `Bearer ${adminTokenStr}`)
      .set("Content-Type", "application/json")
      .send({ mobile: "9876543210" });

    expect(first.status).toBe(202);
    expect(first.body.success).toBe(true);
    expect(first.body.data?.sent).toBe(true);

    const second = await request(app)
      .post("/api/v1/abdm/abha/otp/send")
      .set("Authorization", `Bearer ${adminTokenStr}`)
      .set("Content-Type", "application/json")
      .send({ mobile: "9876543210" });

    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    const retryAfter = Number(second.headers["retry-after"]);
    // Cooldown is 30s — first resend must report a positive remaining
    // window strictly within (0, 30].
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30);
    expect(second.body.retryAfter).toBe(retryAfter);
  });

  it("does NOT collide with a different mobile from the same IP", async () => {
    const a = await request(app)
      .post("/api/v1/abdm/abha/otp/send")
      .set("Authorization", `Bearer ${adminTokenStr}`)
      .send({ mobile: "9876543210" });
    expect(a.status).toBe(202);

    const b = await request(app)
      .post("/api/v1/abdm/abha/otp/send")
      .set("Authorization", `Bearer ${adminTokenStr}`)
      .send({ mobile: "9999999999" });
    // Different bucket — must be 202, not 429.
    expect(b.status).toBe(202);
  });

  it("rejects requests missing both mobile and aadhaar with 400 (zod validate)", async () => {
    const res = await request(app)
      .post("/api/v1/abdm/abha/otp/send")
      .set("Authorization", `Bearer ${adminTokenStr}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
