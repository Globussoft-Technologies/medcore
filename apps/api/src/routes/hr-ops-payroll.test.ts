/**
 * Unit tests for the payroll calculate handler.
 *
 * Modules under test:
 *   - apps/api/src/routes/hr-ops.ts   (POST /api/v1/hr-ops/payroll)
 *   - apps/api/src/services/payroll.ts (computePayroll, daysInMonth)
 *
 * Why these tests exist:
 *   Issue #721 — "Calculate Payroll" button used to be silent (no progress
 *   toast, no result, no error). Issue #701/#702 — Net Pay used to come
 *   out to ~88 % of Basic regardless of Days Worked because PF was
 *   applied on full Basic and absentPenalty was 0 when no shifts existed.
 *   The fixes wire pro-rated Basic via daysInMonth, and these tests
 *   pin the new contract end-to-end at the route handler so a future
 *   regression cannot silently re-introduce either bug.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    staffShift: { findMany: vi.fn() },
    overtimeRecord: { findMany: vi.fn() },
    holiday: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    user: { findUnique: vi.fn() },
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
vi.mock("../services/pdf", () => ({ generatePaySlipHTML: vi.fn() }));

import { hrOpsRouter } from "./hr-ops";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/hr-ops", hrOpsRouter);
  app.use(errorHandler);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
}

describe("POST /api/v1/hr-ops/payroll — issue #701/#702 pro-rated Basic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 Net Pay when 0 days worked (NOT 88 % of Basic)", async () => {
    // 30 ABSENT shifts in a 30-day month → workedDays = 0 → proRatedBasic = 0
    // Old behaviour produced net = basic - PF = 88 % of basic. New
    // behaviour produces net = 0 (no allowances/OT in this fixture).
    prismaMock.staffShift.findMany.mockResolvedValueOnce(
      Array.from({ length: 30 }, () => ({ status: "ABSENT", type: null }))
    );
    prismaMock.overtimeRecord.findMany.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        userId: "11111111-1111-1111-1111-111111111111",
        year: 2026,
        month: 4, // April = 30 days
        basicSalary: 50000,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.workedDays).toBe(0);
    expect(res.body.data.proRatedBasic).toBe(0);
    expect(res.body.data.gross).toBe(0);
    expect(res.body.data.pf).toBe(0);
    expect(res.body.data.net).toBe(0);
    // The legacy absent-penalty line is gone (already in pro-rating).
    expect(res.body.data.absentPenalty).toBe(0);
  });

  it("ESI applies only when gross ≤ ₹21,000 (issue #702)", async () => {
    // Full month worked at basic 21,001 → gross 21,001 → ESI must be 0.
    prismaMock.staffShift.findMany.mockResolvedValueOnce(
      Array.from({ length: 30 }, () => ({ status: "PRESENT", type: null }))
    );
    prismaMock.overtimeRecord.findMany.mockResolvedValueOnce([]);

    const app = buildApp();
    const above = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        userId: "11111111-1111-1111-1111-111111111111",
        year: 2026,
        month: 4,
        basicSalary: 21001,
      });
    expect(above.status).toBe(200);
    expect(above.body.data.esiApplicable).toBe(false);
    expect(above.body.data.esi).toBe(0);

    // At ₹21,000 boundary → ESI applies.
    prismaMock.staffShift.findMany.mockResolvedValueOnce(
      Array.from({ length: 30 }, () => ({ status: "PRESENT", type: null }))
    );
    prismaMock.overtimeRecord.findMany.mockResolvedValueOnce([]);
    const at = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        userId: "11111111-1111-1111-1111-111111111111",
        year: 2026,
        month: 4,
        basicSalary: 21000,
      });
    expect(at.status).toBe(200);
    expect(at.body.data.esiApplicable).toBe(true);
    expect(at.body.data.esi).toBe(Math.round(21000 * 0.0075));
  });

  it("partial-month: 15/30 days worked yields half Basic", async () => {
    prismaMock.staffShift.findMany.mockResolvedValueOnce([
      ...Array.from({ length: 15 }, () => ({ status: "PRESENT", type: null })),
      ...Array.from({ length: 15 }, () => ({ status: "ABSENT", type: null })),
    ]);
    prismaMock.overtimeRecord.findMany.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        userId: "11111111-1111-1111-1111-111111111111",
        year: 2026,
        month: 4, // 30 days
        basicSalary: 60000,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.workedDays).toBe(15);
    expect(res.body.data.proRatedBasic).toBe(30000);
    expect(res.body.data.gross).toBe(30000);
    expect(res.body.data.pf).toBe(3600); // 12 % of 30000
    expect(res.body.data.absentPenalty).toBe(0);
    expect(res.body.data.net).toBe(26400); // 30000 - 3600
  });

  it("rejects non-ADMIN with 403 (button is admin-only)", async () => {
    const nurseToken = jwt.sign(
      { userId: "u-nurse", email: "n@test.local", role: "NURSE" },
      "test-secret"
    );
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/hr-ops/payroll")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        userId: "11111111-1111-1111-1111-111111111111",
        year: 2026,
        month: 4,
        basicSalary: 30000,
      });
    expect(res.status).toBe(403);
  });
});
