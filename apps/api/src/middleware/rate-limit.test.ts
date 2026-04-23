// security(2026-04-23-med): tests for the per-route rate limits introduced
// to protect paid Sarvam paths and FHIR Bundle ingest.
//
// The integration tests in `src/test/integration/*` run with NODE_ENV=test,
// and the `rateLimit` middleware is gated off in that mode (see app.ts and
// each route file). To still guarantee the (count, windowMs) configuration
// works, we exercise the middleware directly against a minimal Express app
// here.
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { rateLimit } from "./rate-limit";

function makeApp(limit: number, windowMs: number) {
  const app = express();
  app.use(rateLimit(limit, windowMs));
  app.get("/probe", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("rateLimit middleware — per-route caps", () => {
  it("allows 30 requests/min and rejects the 31st with 429 (ai-chart-search, ai-transcribe)", async () => {
    const app = makeApp(30, 60_000);
    // Use a stable X-Forwarded-For so all 31 requests share the same bucket.
    const ip = "10.0.0.1";

    for (let i = 0; i < 30; i++) {
      const res = await request(app).get("/probe").set("X-Forwarded-For", ip);
      expect(res.status, `request #${i + 1} should succeed`).toBe(200);
    }

    const tooMany = await request(app).get("/probe").set("X-Forwarded-For", ip);
    expect(tooMany.status).toBe(429);
    expect(tooMany.body.error).toMatch(/too many/i);
  });

  it("allows 20 requests/min and rejects the 21st with 429 (ai-reports/explain, ai-letters)", async () => {
    const app = makeApp(20, 60_000);
    const ip = "10.0.0.2";

    for (let i = 0; i < 20; i++) {
      const res = await request(app).get("/probe").set("X-Forwarded-For", ip);
      expect(res.status, `request #${i + 1} should succeed`).toBe(200);
    }

    const tooMany = await request(app).get("/probe").set("X-Forwarded-For", ip);
    expect(tooMany.status).toBe(429);
  });

  it("allows 10 requests/min and rejects the 11th with 429 (fhir/Bundle, abdm/abha verify+link)", async () => {
    const app = makeApp(10, 60_000);
    const ip = "10.0.0.3";

    for (let i = 0; i < 10; i++) {
      const res = await request(app).get("/probe").set("X-Forwarded-For", ip);
      expect(res.status, `request #${i + 1} should succeed`).toBe(200);
    }

    const tooMany = await request(app).get("/probe").set("X-Forwarded-For", ip);
    expect(tooMany.status).toBe(429);
  });

  it("isolates buckets per IP (two IPs can each make the full quota)", async () => {
    const app = makeApp(10, 60_000);
    const ipA = "10.0.0.10";
    const ipB = "10.0.0.11";

    for (let i = 0; i < 10; i++) {
      await request(app).get("/probe").set("X-Forwarded-For", ipA).expect(200);
      await request(app).get("/probe").set("X-Forwarded-For", ipB).expect(200);
    }

    const aDenied = await request(app).get("/probe").set("X-Forwarded-For", ipA);
    const bDenied = await request(app).get("/probe").set("X-Forwarded-For", ipB);
    expect(aDenied.status).toBe(429);
    expect(bDenied.status).toBe(429);
  });
});
