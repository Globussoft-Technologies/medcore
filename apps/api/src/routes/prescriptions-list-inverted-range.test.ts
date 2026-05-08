/**
 * Issue #588 (May 2026) — Pin the inverted-date-range guard for
 * GET /api/v1/prescriptions.
 *
 * The patient prescriptions list page (`/dashboard/prescriptions`)
 * exposes From/To date pickers that previously accepted an inverted
 * range (e.g. From=31-12-2099, To=01-01-1900) and silently rendered
 * `0 of 14 shown` with no explanation. The frontend was filtering
 * purely in-memory; the API never even saw the params. This test
 * locks down the new server-side contract — the API now rejects an
 * inverted range up-front and (when the range is valid) actually
 * narrows the query. Mirrors commit abae2f0 (#690 audit-log fix).
 *
 * Tests use a hoisted Prisma mock (no live DB), aligned with the
 * audit.test.ts setup that exposes both `prisma` and
 * `tenantScopedPrisma` to satisfy the A10 wrapper-lift import graph.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    prescription: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-x" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
}));

// prescriptions.ts pulls in @sendgrid/mail (transitively, via the share
// endpoint) which isn't installed in the test env. Stub the surface so the
// import graph resolves; the share-prescription endpoint isn't exercised by
// this test file anyway.
vi.mock("@sendgrid/mail", () => ({
  default: { setApiKey: vi.fn(), send: vi.fn(async () => [{ statusCode: 202 }]) },
}));

import { prescriptionRouter } from "./prescriptions";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/prescriptions", prescriptionRouter);
  app.use(errorHandler);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
}

describe("Issue #588 — GET /prescriptions inverted-range guard", () => {
  beforeEach(() => {
    prismaMock.prescription.findMany.mockReset();
    prismaMock.prescription.count.mockReset();
    prismaMock.prescription.findMany.mockResolvedValue([]);
    prismaMock.prescription.count.mockResolvedValue(0);
  });

  it("returns 400 when from > to (transposed pickers, e.g. 2099 → 1900)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/prescriptions?from=2099-12-31&to=1900-01-01")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/from.*before.*to/i);
    // Prisma was never reached — the guard short-circuits before the query.
    expect(prismaMock.prescription.findMany).not.toHaveBeenCalled();
    expect(prismaMock.prescription.count).not.toHaveBeenCalled();
  });

  it("accepts equal from/to (single-day window)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/prescriptions?from=2026-05-08&to=2026-05-08")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(prismaMock.prescription.findMany).toHaveBeenCalledOnce();
  });
});
