/**
 * Billing report RBAC (2026-07) — RECEPTION can see the front-desk collection
 * tiles.
 *
 * What / which / why:
 *   - Pins the role gate on the two billing-report endpoints that feed the
 *     `/dashboard/billing` KPI tiles: `/reports/daily` (Today's Collection) and
 *     `/reports/revenue` (This Month's Revenue).
 *   - Bug: a receptionist recorded a Rs. 77 payment but the "Today's Collection"
 *     tile stayed Rs. 0.00 — the endpoint was ADMIN-only (issue #90), so the
 *     RECEPTION call 403'd and the tile fell back to zero. Reception collects
 *     payments at the desk, so they now get these two tiles.
 *   - Also guards against over-widening: purely clinical roles (NURSE/DOCTOR)
 *     and PATIENT must still be denied these financial endpoints.
 *   - Mocked Prisma (no DB), same hoisted-mock style as
 *     billing-list-filters.test.ts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    invoice: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    payment: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(base)),
    $extends() {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
  // billing.ts patches Decimal.prototype.toJSON at module load and reads
  // Prisma.Decimal.prototype to do it — stub a Decimal-shaped class so the
  // patch doesn't NPE (mirrors billing-list-filters.test.ts).
  Prisma: { Decimal: class { toNumber() { return 0; } } },
}));
vi.mock("../services/notification", () => ({
  onInvoiceCreated: vi.fn(),
  onPaymentReceived: vi.fn(),
  sendSMS: vi.fn(),
  sendWhatsApp: vi.fn(),
}));

import { billingRouter } from "./billing";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  // Emulate the tenant middleware: a normal tenant user carries a tenantId, so
  // resolveBillingReportScope short-circuits without touching the raw client.
  app.use((req: any, _res, next) => {
    req.tenantId = "t-1";
    next();
  });
  app.use("/api/v1/billing", billingRouter);
  app.use(errorHandler);
  return app;
}

// Tokens carry a tenantId claim so the caller is a normal tenant user (not a
// tenant-less super-admin), keeping the report scope resolver on its fast path.
function tokenFor(role: string) {
  return jwt.sign(
    { userId: "u-1", email: `${role.toLowerCase()}@test.local`, role, tenantId: "t-1" },
    "test-secret",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.invoice.count.mockResolvedValue(0);
  prismaMock.payment.findMany.mockResolvedValue([]);
});

describe("Billing report RBAC — Today's Collection (/reports/daily)", () => {
  it("RECEPTION can read the daily collection report (200)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/billing/reports/daily")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("totalCollection");
  });

  it("ADMIN can read the daily collection report (200)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/billing/reports/daily")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
  });

  it("NURSE cannot read the daily collection report (403)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/billing/reports/daily")
      .set("Authorization", `Bearer ${tokenFor("NURSE")}`);
    expect(res.status).toBe(403);
  });

  it("PATIENT cannot read the daily collection report (403)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/billing/reports/daily")
      .set("Authorization", `Bearer ${tokenFor("PATIENT")}`);
    expect(res.status).toBe(403);
  });
});

describe("Billing report RBAC — Month revenue (/reports/revenue)", () => {
  it("RECEPTION can read the revenue report (200)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/billing/reports/revenue")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("groupBy");
  });

  it("ADMIN can read the revenue report (200)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/billing/reports/revenue")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
  });

  it("DOCTOR cannot read the revenue report (403)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/billing/reports/revenue")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(403);
  });
});
