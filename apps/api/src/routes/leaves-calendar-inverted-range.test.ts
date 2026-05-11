/**
 * Issue #579 (May 2026) — Pin the inverted-date-range guard for
 * GET /api/v1/leaves/calendar.
 *
 * The Request Leave modal already refuses fromDate > toDate at the
 * createLeaveRequestSchema layer (see hr-and-phase4.test.ts). The
 * companion gap was on the read side: the schedule calendar accepts a
 * `?from=<later>&to=<earlier>` window, silently passes it through to
 * Prisma's `findMany`, and returns an empty list with no signal that
 * the pickers were transposed. Mirrors the audit-log fix in commit
 * abae2f0 (#690).
 *
 * Tests use a hoisted Prisma mock (no live DB), aligned with the rest
 * of the leaves-* test surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    leaveRequest: {
      findMany: vi.fn(async () => []),
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
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); },
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
}));

import { leaveRouter } from "./leaves";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/leaves", leaveRouter);
  app.use(errorHandler);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
}

describe("Issue #579 — GET /leaves/calendar inverted-range guard", () => {
  beforeEach(() => {
    prismaMock.leaveRequest.findMany.mockReset();
    prismaMock.leaveRequest.findMany.mockResolvedValue([]);
  });

  it("returns 400 when from > to (transposed pickers)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/leaves/calendar?from=2026-05-31&to=2026-05-01")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/from.*before.*to/i);
    // Prisma was never reached — the guard short-circuits before the query.
    expect(prismaMock.leaveRequest.findMany).not.toHaveBeenCalled();
  });

  it("accepts equal from/to (single-day window)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/leaves/calendar?from=2026-05-08&to=2026-05-08")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(prismaMock.leaveRequest.findMany).toHaveBeenCalledOnce();
  });
});
