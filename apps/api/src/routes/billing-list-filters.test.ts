/**
 * Issue #597 — patient billing list page rendered a flat unfiltered list.
 * Add `dateFrom` / `dateTo` query filters on `Invoice.createdAt` so the
 * `/dashboard/billing` page can narrow large invoice lists by issue date.
 *
 * Pins:
 *   - The new filters are wired into the Prisma `where` clause.
 *   - Inverted ranges return a structured 400 (so the form can render
 *     an inline error rather than silently returning [], which was the
 *     pre-fix behaviour reported in the bug body).
 *   - Unparseable dates return 400, not 500.
 *   - Existing behaviour (no filters → all rows) is unchanged.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    invoice: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    patient: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    payment: { create: vi.fn() },
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
  requireTenantId: () => { throw new Error("tenant ctx required"); },
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
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
  app.use("/api/v1/billing", billingRouter);
  app.use(errorHandler);
  return app;
}

function adminToken() {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /billing/invoices — Issue #597 dateFrom / dateTo filters", () => {
  it("passes parsed Date range into Prisma where.createdAt", async () => {
    await request(buildApp())
      .get("/api/v1/billing/invoices?dateFrom=2026-04-01&dateTo=2026-04-30")
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    const callArgs = (prismaMock.invoice.findMany as any).mock.calls[0][0];
    expect(callArgs.where.createdAt).toBeDefined();
    expect(callArgs.where.createdAt.gte).toBeInstanceOf(Date);
    expect(callArgs.where.createdAt.lte).toBeInstanceOf(Date);
    expect(callArgs.where.createdAt.gte.toISOString()).toContain("2026-04-01");
    expect(callArgs.where.createdAt.lte.toISOString()).toContain("2026-04-30");
  });

  it("rejects an inverted range with a 400 + structured field error", async () => {
    const res = await request(buildApp())
      .get("/api/v1/billing/invoices?dateFrom=2026-04-30&dateTo=2026-04-01")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dateFrom must be on or before dateTo/i);
    expect(res.body.details?.[0]?.field).toBe("dateTo");
    expect(prismaMock.invoice.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unparseable dateFrom with a 400 (not a 500)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/billing/invoices?dateFrom=not-a-date")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.details?.[0]?.field).toBe("dateFrom");
  });

  it("preserves existing behaviour when neither date filter is supplied", async () => {
    await request(buildApp())
      .get("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${adminToken()}`)
      .expect(200);

    const callArgs = (prismaMock.invoice.findMany as any).mock.calls[0][0];
    expect(callArgs.where.createdAt).toBeUndefined();
  });
});
