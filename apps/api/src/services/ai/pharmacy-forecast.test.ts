import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    inventoryItem: { findMany: vi.fn() },
    stockMovement: { findMany: vi.fn() },
  } as any,
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

// The pharmacy forecast module imports StockMovementType from @prisma/client;
// mock it here to avoid needing the generated client in unit tests.
vi.mock("@prisma/client", () => ({
  StockMovementType: {
    PURCHASE: "PURCHASE",
    DISPENSED: "DISPENSED",
    RETURNED: "RETURNED",
    EXPIRED: "EXPIRED",
    ADJUSTMENT: "ADJUSTMENT",
    DAMAGED: "DAMAGED",
  },
}));

import {
  forecastInventory,
  buildDailySeries,
  forecastSeries,
} from "./pharmacy-forecast";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.inventoryItem.findMany.mockReset();
  prismaMock.stockMovement.findMany.mockReset();
});

describe("buildDailySeries", () => {
  it("aggregates outflow movements into daily buckets", () => {
    const now = new Date("2026-04-20T12:00:00Z");
    const movements = [
      { createdAt: new Date("2026-04-20T09:00:00Z"), quantity: 3, type: "DISPENSED" as const },
      { createdAt: new Date("2026-04-20T15:00:00Z"), quantity: 2, type: "DISPENSED" as const },
      { createdAt: new Date("2026-04-19T10:00:00Z"), quantity: 5, type: "DISPENSED" as const },
    ];
    const series = buildDailySeries(movements, 30, now);
    expect(series.length).toBe(30);
    // Most recent day (index 29) should hold 3 + 2 = 5; previous day (28) = 5
    expect(series[29]).toBe(5);
    expect(series[28]).toBe(5);
    // All earlier days are zero
    for (let i = 0; i < 28; i++) expect(series[i]).toBe(0);
  });

  it("treats negative quantities as outflow regardless of type", () => {
    const now = new Date("2026-04-20T12:00:00Z");
    const movements = [
      {
        createdAt: new Date("2026-04-20T08:00:00Z"),
        quantity: -4,
        type: "ADJUSTMENT" as const,
      },
      {
        createdAt: new Date("2026-04-20T10:00:00Z"),
        quantity: 10,
        type: "PURCHASE" as const, // inflow — should be ignored
      },
    ];
    const series = buildDailySeries(movements, 7, now);
    expect(series[6]).toBe(4);
  });
});

describe("forecastSeries", () => {
  it("uses the Holt-Winters path when there is enough history", () => {
    const series: number[] = [];
    for (let i = 0; i < 60; i++) {
      series.push(10 + 0.2 * i + 3 * Math.sin((2 * Math.PI * i) / 7));
    }
    const { result, method } = forecastSeries(series, 14, true);
    expect(method).toBe("holt-winters");
    expect(result!.forecast.length).toBe(14);
    for (const p of result!.forecast) {
      expect(Number.isFinite(p.yhat)).toBe(true);
    }
  });

  it("falls back to a mean forecast when the series is all zero", () => {
    const series = new Array(30).fill(0);
    const { result, method } = forecastSeries(series, 7, true);
    expect(method).toBe("fallback-mean");
    for (const p of result!.forecast) expect(p.yhat).toBe(0);
  });
});

describe("forecastInventory", () => {
  it("flags items with no recent consumption and high stock as dead stock", async () => {
    prismaMock.inventoryItem.findMany.mockResolvedValueOnce([
      {
        id: "it-dead",
        quantity: 500,
        medicine: { name: "ObscureDrug" },
      },
    ]);
    prismaMock.stockMovement.findMany.mockResolvedValueOnce([]); // no movements

    const out = await forecastInventory(30);
    expect(out.length).toBe(1);
    expect(out[0].medicineName).toBe("ObscureDrug");
    expect(out[0].deadStock).toBe(true);
    expect(out[0].urgency).toBe("OK");
  });

  it("flags stockout risk when forecasted demand exceeds current stock", async () => {
    prismaMock.inventoryItem.findMany.mockResolvedValueOnce([
      {
        id: "it-risky",
        quantity: 10,
        medicine: { name: "HighDemandDrug" },
      },
    ]);
    // Simulate ~5 units/day for the last 180 days
    const movements: any[] = [];
    const now = new Date();
    for (let d = 0; d < 180; d++) {
      const when = new Date(now);
      when.setDate(when.getDate() - d);
      movements.push({
        createdAt: when,
        quantity: 5,
        type: "DISPENSED",
      });
    }
    prismaMock.stockMovement.findMany.mockResolvedValueOnce(movements);

    const out = await forecastInventory(30);
    expect(out.length).toBe(1);
    const it = out[0];
    expect(it.stockoutRisk).toBe(true);
    expect(it.reorderRecommended).toBe(true);
    expect(["CRITICAL", "LOW"]).toContain(it.urgency);
    expect(it.suggestedReorderQty).toBeGreaterThan(0);
    expect(it.predictedConsumption7d).toBeGreaterThan(0);
    expect(it.predictedConsumption30d).toBeGreaterThan(it.predictedConsumption7d);
    expect(it.predictedConsumption90d).toBeGreaterThanOrEqual(it.predictedConsumption60d);
  });

  it("skips items with zero stock and zero consumption", async () => {
    prismaMock.inventoryItem.findMany.mockResolvedValueOnce([
      { id: "it-skip", quantity: 0, medicine: { name: "Gone" } },
      { id: "it-keep", quantity: 20, medicine: { name: "Stocked" } },
    ]);
    prismaMock.stockMovement.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const out = await forecastInventory(30);
    expect(out.length).toBe(1);
    expect(out[0].inventoryItemId).toBe("it-keep");
  });

  it("reports the method used for the forecast", async () => {
    prismaMock.inventoryItem.findMany.mockResolvedValueOnce([
      { id: "it-1", quantity: 100, medicine: { name: "TestDrug" } },
    ]);
    prismaMock.stockMovement.findMany.mockResolvedValueOnce([]);

    const out = await forecastInventory(30);
    expect(out[0].method).toBe("fallback-mean");
  });
});
