import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    systemConfig: { findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));
// Keep the heavy fraud/doc-qa/sentiment imports out of the scheduler module
// graph for this test — they're not needed here.
vi.mock("../routes/ai-fraud", () => ({ runDailyFraudScan: vi.fn() }));
vi.mock("../routes/ai-doc-qa", () => ({ runDailyDocQAScheduledTask: vi.fn() }));
vi.mock("../routes/ai-sentiment", () => ({ runDailyNpsDriverRollup: vi.fn() }));
vi.mock("../services/notification", () => ({
  sendNotification: vi.fn(async () => {}),
  drainScheduled: vi.fn(async () => 0),
}));

import { healthRouter, isRateLimitsEnabled } from "./health";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/health", healthRouter);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "admin@test.local", role: "ADMIN" },
    "test-secret"
  );
}

function patientToken(): string {
  return jwt.sign(
    { userId: "u-pat", email: "pat@test.local", role: "PATIENT" },
    "test-secret"
  );
}

describe("GET /api/health (shallow)", () => {
  beforeEach(() => {
    delete process.env.DISABLE_RATE_LIMITS;
  });
  afterEach(() => {
    delete process.env.DISABLE_RATE_LIMITS;
  });

  it("returns status ok, timestamp, and rateLimitsEnabled=true by default", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.timestamp).toBe("string");
    expect(res.body.rateLimitsEnabled).toBe(true);
  });

  it("reports rateLimitsEnabled=false when DISABLE_RATE_LIMITS=true", async () => {
    process.env.DISABLE_RATE_LIMITS = "true";
    const app = buildApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.rateLimitsEnabled).toBe(false);
  });

  it("isRateLimitsEnabled() is the single source of truth", () => {
    process.env.DISABLE_RATE_LIMITS = "true";
    expect(isRateLimitsEnabled()).toBe(false);
    process.env.DISABLE_RATE_LIMITS = "false";
    expect(isRateLimitsEnabled()).toBe(true);
    delete process.env.DISABLE_RATE_LIMITS;
    expect(isRateLimitsEnabled()).toBe(true);
  });
});

describe("GET /api/health/deep (ADMIN)", () => {
  beforeEach(() => {
    delete process.env.DISABLE_RATE_LIMITS;
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ "?column?": 1 }]);
    prismaMock.systemConfig.findUnique.mockResolvedValue(null);
  });

  it("401s without a token", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/health/deep");
    expect(res.status).toBe(401);
  });

  it("403s for non-admin roles", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/health/deep")
      .set("Authorization", `Bearer ${patientToken()}`);
    expect(res.status).toBe(403);
  });

  it("returns rate-limits, DB health, and scheduler array for ADMIN", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/health/deep")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.rateLimitsEnabled).toBe(true);
    expect(res.body.database.reachable).toBe(true);
    expect(typeof res.body.database.latencyMs).toBe("number");
    expect(Array.isArray(res.body.schedulers)).toBe(true);
    // The scheduler list must include the Gap 1 + Gap 3 tasks.
    const names = (res.body.schedulers as Array<{ name: string }>).map(
      (s) => s.name
    );
    expect(names).toContain("audit_log_archival");
    expect(names).toContain("rate_limit_bypass_check");
    expect(res.body.promptRegistry).toBeDefined();
  });

  it("reports status=degraded when DB probe fails", async () => {
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error("pg down"));
    const app = buildApp();
    const res = await request(app)
      .get("/api/health/deep")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.database.reachable).toBe(false);
  });
});
