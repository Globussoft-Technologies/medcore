// security(2026-05-04-med): F-ABDM-1 regression test.
//
// `POST /api/v1/abdm/gateway/callback` is signed by the ABDM gateway via
// RS256 JWT and verified against the ABDM public JWKS. Defence-in-depth:
// a per-IP rate limiter (60/min) is mounted BEFORE the signature verifier
// so a compromised gateway key (or a sandbox ABDM_SKIP_VERIFY window) cannot
// flood the endpoint and exhaust the Prisma connection pool / AsyncLocalStorage.
//
// This test stands up a minimal Express app with just `abdmRouter` mounted
// — no DB required — and drives 61 callback POSTs from the same IP. The
// 61st must come back as 429 with a Retry-After header. The first 60 may be
// 202 (handler ACK) or 401 (signature missing) but MUST NOT be 429.
//
// We flip ENABLE_ABDM_RATELIMIT_IN_TESTS=true BEFORE importing the router
// so the lazy-constructed limiter picks up the opt-in flag (matches the
// auth.ts #478 pattern). Without that, NODE_ENV=test bypasses the limiter
// suite-wide.
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";

describe("ABDM gateway callback — per-IP rate limit (F-ABDM-1)", () => {
  let app: express.Express;

  beforeAll(async () => {
    process.env.ENABLE_ABDM_RATELIMIT_IN_TESTS = "true";
    // Force the dev escape hatch so verifyAbdmSignature waves through
    // unsigned requests (we're not testing the signature path here).
    process.env.ABDM_SKIP_VERIFY = "true";

    // Dynamic import so the env vars above are read when the router's
    // limiter is first constructed at request time.
    const mod = await import("./abdm");
    app = express();
    app.use(express.json());
    app.use("/api/v1/abdm", mod.abdmRouter);
  });

  it("returns 429 with Retry-After on the 61st request within 60s from the same IP", async () => {
    // Drive 61 POSTs against the callback. supertest sends from 127.0.0.1,
    // so all 61 share an IP and land in the same bucket.
    const responses: { status: number; retryAfter?: string }[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await request(app)
        .post("/api/v1/abdm/gateway/callback")
        .set("Content-Type", "application/json")
        .send({ requestId: `rl-${i}`, timestamp: new Date().toISOString() });
      responses.push({
        status: res.status,
        retryAfter: res.headers["retry-after"],
      });
    }

    // First 60 must NOT be 429 (could be 202 ACK or 401 signature, etc.).
    for (let i = 0; i < 60; i++) {
      expect(
        responses[i].status,
        `request ${i + 1} should not be 429 (got ${responses[i].status})`
      ).not.toBe(429);
    }

    // The 61st MUST be a 429 with Retry-After per RFC 9239.
    expect(responses[60].status).toBe(429);
    expect(responses[60].retryAfter).toBeDefined();
    expect(Number(responses[60].retryAfter)).toBeGreaterThan(0);
  });
});
