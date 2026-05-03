// Unit-style tests for the /api/v1/ai/pharmacy router.
//
// The Holt-Winters forecasting engine has its own dedicated tests at
// services/ai/ml/holt-winters.test.ts and services/ai/pharmacy-forecast.test.ts;
// this file pins the route layer's contract: RBAC, query-param parsing, the
// urgency filter + sort order, the empty-history graceful fallback, the
// not-found 404 for a missing inventory item, and the dynamic stock-movement
// fetch on the single-item endpoint.
//
// Honorable mention #11 from the 2026-05-03 test gaps audit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const {
  forecastInventoryMock,
  forecastSingleItemMock,
  getAIInsightsMock,
  prismaMock,
} = vi.hoisted(() => ({
  forecastInventoryMock: vi.fn(),
  forecastSingleItemMock: vi.fn(),
  getAIInsightsMock: vi.fn(),
  prismaMock: {
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    stockMovement: { findMany: vi.fn(async () => []) },
    inventoryItem: { findUnique: vi.fn() },
  } as any,
}));

vi.mock("../services/ai/pharmacy-forecast", () => ({
  forecastInventory: forecastInventoryMock,
  forecastSingleItem: forecastSingleItemMock,
  getAIInsights: getAIInsightsMock,
}));

// The single-item route does a `await import("@medcore/db")` to fetch
// the 90-day movement history. That dynamic import resolves through this
// mock just like any static import would.
vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import { aiPharmacyRouter } from "./ai-pharmacy";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  process.env.NODE_ENV = "test";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ai/pharmacy", aiPharmacyRouter);
  return app;
}

function tokenFor(role: string): string {
  return jwt.sign({ userId: `u-${role}`, email: `${role}@t.local`, role }, "test-secret");
}

function makeForecast(
  overrides: Partial<{
    inventoryItemId: string;
    medicineName: string;
    urgency: "OK" | "LOW" | "CRITICAL";
    daysOfStockLeft: number;
  }> = {}
) {
  return {
    inventoryItemId: overrides.inventoryItemId ?? "item-1",
    medicineName: overrides.medicineName ?? "Paracetamol 500mg",
    currentStock: 100,
    avgDailyConsumption: 5,
    predictedConsumption7d: 35,
    predictedConsumption30d: 150,
    predictedConsumption60d: 300,
    predictedConsumption90d: 450,
    predictedConsumption30dUpper: 180,
    daysOfStockLeft: overrides.daysOfStockLeft ?? 20,
    reorderRecommended: false,
    suggestedReorderQty: 0,
    urgency: overrides.urgency ?? "OK",
    stockoutRisk: false,
    deadStock: false,
    method: "holt-winters" as const,
  };
}

describe("GET /api/v1/ai/pharmacy/forecast (honorable mention #11)", () => {
  beforeEach(() => {
    forecastInventoryMock.mockReset();
    forecastSingleItemMock.mockReset();
    getAIInsightsMock.mockReset();
    prismaMock.stockMovement.findMany.mockReset();
    prismaMock.stockMovement.findMany.mockResolvedValue([]);
    prismaMock.auditLog.create.mockClear();
  });

  it("returns 401 with no auth header", async () => {
    const res = await request(buildApp()).get("/api/v1/ai/pharmacy/forecast");
    expect(res.status).toBe(401);
    expect(forecastInventoryMock).not.toHaveBeenCalled();
  });

  it("rejects DOCTOR with 403 (RBAC: ADMIN + PHARMACIST only)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/ai/pharmacy/forecast")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(403);
  });

  it("rejects RECEPTION with 403", async () => {
    const res = await request(buildApp())
      .get("/api/v1/ai/pharmacy/forecast")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`);
    expect(res.status).toBe(403);
  });

  it("PHARMACIST: happy-path 30-day forecast returns sorted results with insights when requested", async () => {
    forecastInventoryMock.mockResolvedValueOnce([
      makeForecast({ inventoryItemId: "ok-1", urgency: "OK", daysOfStockLeft: 50 }),
      makeForecast({ inventoryItemId: "crit-1", urgency: "CRITICAL", daysOfStockLeft: 2 }),
      makeForecast({ inventoryItemId: "low-1", urgency: "LOW", daysOfStockLeft: 12 }),
    ]);
    getAIInsightsMock.mockResolvedValueOnce("• Reorder Paracetamol now");

    const res = await request(buildApp())
      .get("/api/v1/ai/pharmacy/forecast?days=30&insights=true")
      .set("Authorization", `Bearer ${tokenFor("PHARMACIST")}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Sort order: CRITICAL → LOW → OK
    expect(res.body.data.forecast.map((f: any) => f.urgency)).toEqual([
      "CRITICAL",
      "LOW",
      "OK",
    ]);
    expect(res.body.data.insights).toBe("• Reorder Paracetamol now");
    expect(res.body.data.generatedAt).toBeDefined();
    expect(forecastInventoryMock).toHaveBeenCalledWith(30);
  });

  it("ADMIN can fetch and the urgency filter narrows results to a single bucket", async () => {
    forecastInventoryMock.mockResolvedValueOnce([
      makeForecast({ inventoryItemId: "ok-1", urgency: "OK", daysOfStockLeft: 50 }),
      makeForecast({ inventoryItemId: "crit-1", urgency: "CRITICAL", daysOfStockLeft: 2 }),
      makeForecast({ inventoryItemId: "low-1", urgency: "LOW", daysOfStockLeft: 12 }),
    ]);

    const res = await request(buildApp())
      .get("/api/v1/ai/pharmacy/forecast?urgency=CRITICAL")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.data.forecast).toHaveLength(1);
    expect(res.body.data.forecast[0].urgency).toBe("CRITICAL");
    // No `insights` key when ?insights=true is not requested.
    expect(res.body.data.insights).toBeUndefined();
    expect(getAIInsightsMock).not.toHaveBeenCalled();
  });

  it("graceful fallback: empty history returns an empty forecast array (NOT 500)", async () => {
    forecastInventoryMock.mockResolvedValueOnce([]);

    const res = await request(buildApp())
      .get("/api/v1/ai/pharmacy/forecast")
      .set("Authorization", `Bearer ${tokenFor("PHARMACIST")}`);

    expect(res.status).toBe(200);
    expect(res.body.data.forecast).toEqual([]);
  });

  it("ignores an unknown urgency filter value (returns the full unfiltered set)", async () => {
    forecastInventoryMock.mockResolvedValueOnce([
      makeForecast({ inventoryItemId: "a", urgency: "OK" }),
      makeForecast({ inventoryItemId: "b", urgency: "CRITICAL" }),
    ]);

    const res = await request(buildApp())
      .get("/api/v1/ai/pharmacy/forecast?urgency=BOGUS")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    expect(res.status).toBe(200);
    expect(res.body.data.forecast).toHaveLength(2);
  });

  it("days param defaults to 30 when missing or NaN", async () => {
    forecastInventoryMock.mockResolvedValueOnce([]);

    await request(buildApp())
      .get("/api/v1/ai/pharmacy/forecast?days=not-a-number")
      .set("Authorization", `Bearer ${tokenFor("PHARMACIST")}`);

    expect(forecastInventoryMock).toHaveBeenCalledWith(30);
  });
});

describe("GET /api/v1/ai/pharmacy/forecast/:inventoryItemId (honorable mention #11)", () => {
  beforeEach(() => {
    forecastSingleItemMock.mockReset();
    prismaMock.stockMovement.findMany.mockReset();
    prismaMock.stockMovement.findMany.mockResolvedValue([]);
    prismaMock.auditLog.create.mockClear();
  });

  it("rejects a non-UUID :inventoryItemId with 400 (validateUuidParams)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/ai/pharmacy/forecast/not-a-uuid")
      .set("Authorization", `Bearer ${tokenFor("PHARMACIST")}`);
    expect(res.status).toBe(400);
    expect(forecastSingleItemMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the item is not found / has no history", async () => {
    forecastSingleItemMock.mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .get("/api/v1/ai/pharmacy/forecast/00000000-0000-0000-0000-000000000001")
      .set("Authorization", `Bearer ${tokenFor("PHARMACIST")}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/not found|no stock/i);
  });

  it("happy path: returns forecast plus 90-day movement history", async () => {
    const itemId = "00000000-0000-0000-0000-000000000abc";
    forecastSingleItemMock.mockResolvedValueOnce(
      makeForecast({ inventoryItemId: itemId, urgency: "LOW" })
    );
    prismaMock.stockMovement.findMany.mockResolvedValueOnce([
      { id: "m1", type: "DISPENSED", quantity: -5, reason: null, createdAt: new Date() },
      { id: "m2", type: "RECEIVED", quantity: 100, reason: "PO #42", createdAt: new Date() },
    ]);

    const res = await request(buildApp())
      .get(`/api/v1/ai/pharmacy/forecast/${itemId}`)
      .set("Authorization", `Bearer ${tokenFor("PHARMACIST")}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.forecast.inventoryItemId).toBe(itemId);
    expect(res.body.data.movements).toHaveLength(2);
    expect(res.body.data.generatedAt).toBeDefined();
    // The route asks for 30-day forecast on the single-item endpoint.
    expect(forecastSingleItemMock).toHaveBeenCalledWith(itemId, 30);
    // The movement scan is scoped to ~90 days ago.
    const findArgs = prismaMock.stockMovement.findMany.mock.calls[0][0];
    expect(findArgs.where.inventoryItemId).toBe(itemId);
    expect(findArgs.where.createdAt.gte).toBeInstanceOf(Date);
    const cutoff: Date = findArgs.where.createdAt.gte;
    const ageDays = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeGreaterThan(89);
    expect(ageDays).toBeLessThan(91);
  });
});
