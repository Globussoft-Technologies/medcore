/**
 * Issue #728 — Same payment plan rendered as Active AND Overdue
 * simultaneously. The dashboard's Overdue tab is fed by
 * /payment-plans/overdue (any installment past due, plan not
 * COMPLETED). The Active tab calls GET /payment-plans?status=ACTIVE
 * which previously returned every plan with status='ACTIVE' —
 * including those with past-due installments. Result: the same plan
 * appeared in both tabs.
 *
 * The fix narrows the WHERE for status=ACTIVE to exclude any plan
 * where `installmentRecords.some(status IN [PENDING, OVERDUE] AND
 * dueDate < today)`. Other status filters are untouched.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    paymentPlan: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    paymentPlanInstallment: {
      findMany: vi.fn(),
    },
    patient: { findFirst: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

// `apps/api/src/services/tenant-prisma.ts` re-exports `tenantScopedPrisma`
// from this package; payment-plans.ts uses both `prisma` and the tenant-
// scoped wrapper. The shim points at the same mock so the same
// findMany/findUnique/etc. calls land on a single object the test can
// drive. (Same pattern as the admissions-concurrency test.)
vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); },
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
}));

import { paymentPlansRouter } from "./payment-plans";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/payment-plans", paymentPlansRouter);
  app.use(errorHandler);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
}

describe("Issue #728 — Active list excludes plans with past-due installments", () => {
  beforeEach(() => {
    prismaMock.paymentPlan.findMany.mockReset();
  });

  it("when ?status=ACTIVE is requested, the WHERE clause includes a `installmentRecords.none` overdue exclusion", async () => {
    prismaMock.paymentPlan.findMany.mockResolvedValueOnce([]);

    const res = await request(buildApp())
      .get("/api/v1/payment-plans?status=ACTIVE")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(prismaMock.paymentPlan.findMany).toHaveBeenCalledTimes(1);
    const callArg = prismaMock.paymentPlan.findMany.mock.calls[0][0];
    expect(callArg.where.status).toBe("ACTIVE");
    // The exclusion is the load-bearing assertion.
    expect(callArg.where.installmentRecords).toMatchObject({
      none: {
        status: { in: ["PENDING", "OVERDUE"] },
        dueDate: { lt: expect.any(Date) },
      },
    });
  });

  it("does not add the overdue exclusion for non-ACTIVE filters (e.g. status=COMPLETED stays untouched)", async () => {
    prismaMock.paymentPlan.findMany.mockResolvedValueOnce([]);

    const res = await request(buildApp())
      .get("/api/v1/payment-plans?status=COMPLETED")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const callArg = prismaMock.paymentPlan.findMany.mock.calls[0][0];
    expect(callArg.where.status).toBe("COMPLETED");
    expect(callArg.where.installmentRecords).toBeUndefined();
  });
});
