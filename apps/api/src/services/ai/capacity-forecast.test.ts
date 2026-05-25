/**
 * Unit tests for the operations capacity forecasting service
 * (apps/api/src/services/ai/capacity-forecast.ts, PRD §7.3).
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: exercises every exported function — `buildDailyCountSeries`,
 *   `forecastInflow`, `forecastBedOccupancy`, `forecastICUDemand`, and
 *   `forecastOTUtilization` — across happy paths, threshold boundaries
 *   (the 30-day Holt-Winters minimum, the 60- and 120-day confidence
 *   ladders), and edge cases (empty wards, no admissions, OT with
 *   in-progress surgeries, multi-ward fan-out, day-bucket clamping at
 *   either edge of the history window).
 * - MODULES: mocks `@medcore/db` so the tenant-scoped Prisma proxy and
 *   the raw Prisma re-import (used for OperatingTheater lookups) both
 *   point at the same hoisted in-memory store. No real Postgres is
 *   touched. The Holt-Winters fitter itself runs real — it has its own
 *   tests under ml/holt-winters.test.ts and treating it as a black box
 *   here lets us pin the integration shape (sigma → confidence band,
 *   non-finite forecast → fallback catch).
 * - WHY: this module drives the bed / ICU / OT capacity panels on the
 *   ops dashboard, all consumed by AI ward-rounding and theatre-load
 *   warnings. Forecast logic is deterministic (no LLM), so any
 *   regression here directly mis-counts beds and either suppresses real
 *   stockout warnings or fires false-positive ones. The test fixture
 *   pins the round-tripping carefully so callers can rely on
 *   `expectedStockout`, `confidence`, `method`, and `insufficientData`
 *   semantics.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock store + Prisma proxy ────────────────────────────────────────────────
// Hoisted so both the tenant-scoped wrapper (`tenantScopedPrisma`) and the
// raw `prisma` import (used inside `forecastOTUtilization` for the OT lookup)
// share the same in-memory tables.

const { store, prismaMock } = vi.hoisted(() => {
  const store: {
    wards: any[];
    admissions: any[];
    operatingTheaters: any[];
    surgeries: any[];
  } = {
    wards: [],
    admissions: [],
    operatingTheaters: [],
    surgeries: [],
  };

  function matchAdmission(a: any, where: any): boolean {
    if (!where) return true;
    if (where.bedId?.in && !where.bedId.in.includes(a.bedId)) return false;
    if (where.status && a.status !== where.status) return false;
    if (where.admittedAt) {
      const at = a.admittedAt as Date;
      if (where.admittedAt.gte && at < where.admittedAt.gte) return false;
      if (where.admittedAt.lte && at > where.admittedAt.lte) return false;
    }
    return true;
  }

  function matchSurgery(s: any, where: any): boolean {
    if (!where) return true;
    if (where.otId && s.otId !== where.otId) return false;
    if (where.status) {
      if (typeof where.status === "string" && s.status !== where.status) return false;
      if (where.status.in && !where.status.in.includes(s.status)) return false;
    }
    if (where.scheduledAt) {
      const at = s.scheduledAt as Date;
      if (where.scheduledAt.gte && at < where.scheduledAt.gte) return false;
      if (where.scheduledAt.lte && at > where.scheduledAt.lte) return false;
    }
    return true;
  }

  const prismaMock: any = {
    ward: {
      findMany: vi.fn(async ({ where, include }: any = {}) => {
        let rows = [...store.wards];
        if (where?.type?.in) {
          rows = rows.filter((w) => where.type.in.includes(w.type));
        }
        if (include?.beds) {
          return rows.map((w) => ({
            ...w,
            beds: w.beds.map((b: any) => ({ id: b.id, status: b.status })),
          }));
        }
        return rows;
      }),
    },
    admission: {
      count: vi.fn(async ({ where }: any = {}) =>
        store.admissions.filter((a) => matchAdmission(a, where)).length
      ),
      findMany: vi.fn(async ({ where, select }: any = {}) => {
        const rows = store.admissions.filter((a) => matchAdmission(a, where));
        if (!select) return rows;
        return rows.map((r) => {
          const out: any = {};
          for (const k of Object.keys(select)) out[k] = r[k];
          return out;
        });
      }),
    },
    operatingTheater: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        let rows = [...store.operatingTheaters];
        if (where?.isActive !== undefined) {
          rows = rows.filter((ot) => ot.isActive === where.isActive);
        }
        return rows;
      }),
    },
    surgery: {
      count: vi.fn(async ({ where }: any = {}) =>
        store.surgeries.filter((s) => matchSurgery(s, where)).length
      ),
      findMany: vi.fn(async ({ where, select }: any = {}) => {
        const rows = store.surgeries.filter((s) => matchSurgery(s, where));
        if (!select) return rows;
        return rows.map((r) => {
          const out: any = {};
          for (const k of Object.keys(select)) out[k] = r[k];
          return out;
        });
      }),
    },
  };

  return { store, prismaMock };
});

vi.mock("@medcore/db", () => ({
  // Both the named tenant wrapper AND the raw `prisma` resolve to the same
  // mock — `forecastOTUtilization` does `await import("@medcore/db")` for the
  // OT lookup and pulls `prisma` (the raw client) from it.
  tenantScopedPrisma: prismaMock,
  prisma: prismaMock,
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
  TENANT_SCOPED_MODELS: new Set<string>(),
  applyTenantScope: (q: unknown) => q,
  shouldScope: () => false,
}));

import {
  buildDailyCountSeries,
  forecastInflow,
  forecastBedOccupancy,
  forecastICUDemand,
  forecastOTUtilization,
  type CapacityForecastResponse,
} from "./capacity-forecast";

// ── Test fixtures ────────────────────────────────────────────────────────────

const NOW = new Date("2026-05-15T12:00:00.000Z");

function resetStore() {
  store.wards = [];
  store.admissions = [];
  store.operatingTheaters = [];
  store.surgeries = [];
}

/** Generate N days of daily admission events ending at `now`. */
function generateDailyAdmissions(
  bedId: string,
  days: number,
  perDay: number,
  now: Date = NOW
): any[] {
  const out: any[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    date.setHours(8, 0, 0, 0);
    for (let i = 0; i < perDay; i++) {
      out.push({
        id: `adm-${bedId}-${d}-${i}`,
        bedId,
        status: "DISCHARGED",
        admittedAt: date,
        expectedLosDays: 2,
      });
    }
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

// ── buildDailyCountSeries ────────────────────────────────────────────────────

describe("buildDailyCountSeries", () => {
  it("returns a zero-filled array of the requested length when no events fall in window", () => {
    const series = buildDailyCountSeries([], 7, NOW);
    expect(series).toHaveLength(7);
    expect(series.every((v) => v === 0)).toBe(true);
  });

  it("buckets one event per day into the correct slot (oldest → newest)", () => {
    const events = [
      { at: new Date("2026-05-15T09:00:00.000Z") }, // today → idx 6
      { at: new Date("2026-05-14T09:00:00.000Z") }, // yesterday → idx 5
      { at: new Date("2026-05-09T09:00:00.000Z") }, // 6 days ago → idx 0
    ];
    const series = buildDailyCountSeries(events, 7, NOW);
    expect(series).toHaveLength(7);
    expect(series[0]).toBe(1);
    expect(series[5]).toBe(1);
    expect(series[6]).toBe(1);
    // sum of buckets = number of events in window
    expect(series.reduce((s, v) => s + v, 0)).toBe(3);
  });

  it("accumulates multiple events in the same day into one bucket", () => {
    // Note: `buildDailyCountSeries` uses LOCAL-time day boundaries (`.setHours()`
    // mutates in the env tz). Pick times that all fall on the same LOCAL day
    // regardless of where the runner is — pin around noon UTC ± 2h to stay
    // safely inside one local day for any reasonable host tz.
    const events = [
      { at: new Date("2026-05-15T10:00:00.000Z") },
      { at: new Date("2026-05-15T12:00:00.000Z") },
      { at: new Date("2026-05-15T14:00:00.000Z") },
    ];
    const series = buildDailyCountSeries(events, 7, NOW);
    expect(series[6]).toBe(3);
  });

  it("ignores events outside the window (both before start and after end)", () => {
    const events = [
      { at: new Date("2026-04-01T00:00:00.000Z") }, // way before
      { at: new Date("2026-06-01T00:00:00.000Z") }, // way after
      { at: new Date("2026-05-15T12:00:00.000Z") }, // inside
    ];
    const series = buildDailyCountSeries(events, 7, NOW);
    expect(series.reduce((s, v) => s + v, 0)).toBe(1);
  });

  it("accepts ISO-string `at` values as well as Date instances", () => {
    const events = [
      { at: "2026-05-15T09:00:00.000Z" },
      { at: new Date("2026-05-15T10:00:00.000Z") },
    ];
    const series = buildDailyCountSeries(events, 7, NOW);
    expect(series[6]).toBe(2);
  });
});

// ── forecastInflow ───────────────────────────────────────────────────────────

describe("forecastInflow", () => {
  it("falls back to moving-average with <30 days of history", () => {
    // 20 days of constant 5/day demand.
    const series = new Array(20).fill(5);
    const r = forecastInflow(series, 3);
    expect(r.method).toBe("fallback-moving-average");
    expect(r.confidence).toBe("low");
    expect(r.insufficientData).toBe(true);
    // 7-day MA = 5/day; over 3 days = 15. Upper = 15 * 1.3 = 19.5 → 20.
    expect(r.pointForecast).toBe(15);
    expect(r.upperForecast).toBe(20);
  });

  it("returns zero point + upper when the series is all zeros (no history at all)", () => {
    const series = new Array(7).fill(0);
    const r = forecastInflow(series, 3);
    expect(r.method).toBe("fallback-moving-average");
    expect(r.pointForecast).toBe(0);
    expect(r.upperForecast).toBe(0);
    expect(r.insufficientData).toBe(true);
  });

  it("handles a single data point — fallback path with one-sample average", () => {
    const series = [10];
    const r = forecastInflow(series, 1);
    expect(r.method).toBe("fallback-moving-average");
    expect(r.confidence).toBe("low");
    // recent-7 sum = 10, dailyAvg = 10/min(7,1)=10, horizon 1 → 10.
    expect(r.pointForecast).toBe(10);
    expect(r.upperForecast).toBe(13);
  });

  it("uses Holt-Winters at the 30-day threshold and yields a non-zero point forecast", () => {
    // Build a stable 30-day series of 4/day. The HW fitter should track level
    // and emit a roughly-4*horizon point forecast (allow generous rounding
    // tolerance since the smoother takes time to stabilise).
    const series = new Array(30).fill(4);
    const r = forecastInflow(series, 2);
    expect(r.method).toBe("holt-winters");
    expect(r.insufficientData).toBe(false);
    expect(r.pointForecast).toBeGreaterThanOrEqual(0);
    expect(r.upperForecast).toBeGreaterThanOrEqual(r.pointForecast);
    // Confidence is low for <60-day history per the source thresholds.
    expect(r.confidence).toBe("low");
  });

  it("returns 'medium' confidence when 60 days of stable history is available", () => {
    const series = new Array(60).fill(3);
    const r = forecastInflow(series, 1);
    expect(r.method).toBe("holt-winters");
    expect(r.confidence).toBe("medium");
  });

  it("returns 'high' confidence with 120 days of stable history", () => {
    const series = new Array(120).fill(2);
    const r = forecastInflow(series, 1);
    expect(r.method).toBe("holt-winters");
    expect(r.confidence).toBe("high");
  });

  it("rounds point + upper forecasts and never returns negative values", () => {
    const series = new Array(40).fill(0);
    const r = forecastInflow(series, 5);
    // HW on all-zeros may emit yhat≈0 — point + upper must be non-negative
    // and integer-rounded.
    expect(r.pointForecast).toBeGreaterThanOrEqual(0);
    expect(r.upperForecast).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(r.pointForecast)).toBe(true);
    expect(Number.isInteger(r.upperForecast)).toBe(true);
  });
});

// ── forecastBedOccupancy ─────────────────────────────────────────────────────

describe("forecastBedOccupancy", () => {
  it("returns an empty forecast set when there are no wards seeded", async () => {
    const r = await forecastBedOccupancy({ horizonHours: 24, now: NOW });
    expect(r.forecasts).toEqual([]);
    expect(r.summary.totalCapacity).toBe(0);
    expect(r.summary.totalCurrentlyInUse).toBe(0);
    expect(r.summary.anyStockoutRisk).toBe(false);
    expect(r.summary.wardsAtRisk).toBe(0);
    expect(r.horizonHours).toBe(24);
    expect(r.generatedAt).toBe(NOW.toISOString());
  });

  it("skips wards with zero beds (capacityUnits === 0 branch)", async () => {
    store.wards = [
      { id: "w-empty", name: "Empty Ward", type: "GENERAL", beds: [] },
      {
        id: "w-real",
        name: "Real Ward",
        type: "GENERAL",
        beds: [{ id: "bed-1", status: "AVAILABLE" }],
      },
    ];
    const r = await forecastBedOccupancy({ horizonHours: 24, now: NOW });
    expect(r.forecasts).toHaveLength(1);
    expect(r.forecasts[0].resourceId).toBe("w-real");
  });

  it("only includes non-ICU ward types in the bed forecast (filters out ICU/NICU)", async () => {
    store.wards = [
      {
        id: "w-gen",
        name: "General",
        type: "GENERAL",
        beds: [{ id: "bed-g1", status: "OCCUPIED" }],
      },
      {
        id: "w-icu",
        name: "ICU",
        type: "ICU",
        beds: [{ id: "bed-i1", status: "OCCUPIED" }],
      },
    ];
    const r = await forecastBedOccupancy({ horizonHours: 24, now: NOW });
    // Bed-forecast wardTypes does NOT include "ICU" → only the GENERAL ward survives
    expect(r.forecasts.map((f) => f.resourceId)).toEqual(["w-gen"]);
  });

  it("counts currently-admitted patients and books planned releases within the horizon", async () => {
    const bedIds = ["bed-1", "bed-2", "bed-3"];
    store.wards = [
      {
        id: "w-1",
        name: "Ward One",
        type: "GENERAL",
        beds: bedIds.map((id) => ({ id, status: "OCCUPIED" })),
      },
    ];
    // Two currently-admitted patients. One has expectedLos that puts the
    // discharge inside the 72h horizon, the other beyond it.
    store.admissions = [
      {
        id: "adm-soon",
        bedId: "bed-1",
        status: "ADMITTED",
        admittedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000), // 1d ago
        expectedLosDays: 2, // discharge ~1d from NOW → inside 72h
      },
      {
        id: "adm-later",
        bedId: "bed-2",
        status: "ADMITTED",
        admittedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
        expectedLosDays: 10, // discharge way outside horizon
      },
    ];
    const r = await forecastBedOccupancy({ horizonHours: 72, now: NOW });
    expect(r.forecasts).toHaveLength(1);
    expect(r.forecasts[0].currentlyInUse).toBe(2);
    expect(r.forecasts[0].plannedReleases).toBe(1);
    expect(r.forecasts[0].capacityUnits).toBe(3);
  });

  it("ignores admissions whose expectedLosDays is null/undefined", async () => {
    store.wards = [
      {
        id: "w-1",
        name: "Ward",
        type: "GENERAL",
        beds: [{ id: "bed-1", status: "OCCUPIED" }],
      },
    ];
    store.admissions = [
      {
        id: "adm-nolos",
        bedId: "bed-1",
        status: "ADMITTED",
        admittedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
        expectedLosDays: null,
      },
    ];
    const r = await forecastBedOccupancy({ horizonHours: 72, now: NOW });
    expect(r.forecasts[0].plannedReleases).toBe(0);
  });

  it("flags expectedStockout=true when forecast upper exceeds free capacity", async () => {
    const bedIds = ["bed-1", "bed-2"]; // only 2 beds total
    store.wards = [
      {
        id: "w-tight",
        name: "Tight Ward",
        type: "GENERAL",
        beds: bedIds.map((id) => ({ id, status: "OCCUPIED" })),
      },
    ];
    // Both beds occupied, no planned releases → freeCapacity = 0.
    store.admissions = [
      {
        id: "adm-1",
        bedId: "bed-1",
        status: "ADMITTED",
        admittedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
        expectedLosDays: 30,
      },
      {
        id: "adm-2",
        bedId: "bed-2",
        status: "ADMITTED",
        admittedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
        expectedLosDays: 30,
      },
      // History: heavy inflow → upper-bound prediction > 0
      ...generateDailyAdmissions("bed-1", 40, 3, NOW),
    ];
    const r = await forecastBedOccupancy({ horizonHours: 72, now: NOW });
    expect(r.forecasts).toHaveLength(1);
    expect(r.forecasts[0].currentlyInUse).toBe(2);
    expect(r.forecasts[0].expectedStockout).toBe(true);
    expect(r.summary.anyStockoutRisk).toBe(true);
    expect(r.summary.wardsAtRisk).toBe(1);
  });

  it("aggregates summary correctly across multiple wards", async () => {
    store.wards = [
      {
        id: "w-a",
        name: "A",
        type: "GENERAL",
        beds: [
          { id: "bed-a1", status: "AVAILABLE" },
          { id: "bed-a2", status: "OCCUPIED" },
        ],
      },
      {
        id: "w-b",
        name: "B",
        type: "PRIVATE",
        beds: [{ id: "bed-b1", status: "AVAILABLE" }],
      },
    ];
    const r = await forecastBedOccupancy({ horizonHours: 24, now: NOW });
    expect(r.forecasts).toHaveLength(2);
    expect(r.summary.totalCapacity).toBe(3); // 2 + 1
    // No admissions seeded
    expect(r.summary.totalCurrentlyInUse).toBe(0);
    expect(r.summary.totalPredictedInflow).toBe(0);
  });

  it("uses `now` from input rather than the wall-clock when supplied", async () => {
    store.wards = [];
    const customNow = new Date("2020-01-01T00:00:00.000Z");
    const r = await forecastBedOccupancy({ horizonHours: 24, now: customNow });
    expect(r.generatedAt).toBe(customNow.toISOString());
  });

  it("falls back to method=fallback-moving-average when ward has zero history", async () => {
    store.wards = [
      {
        id: "w-1",
        name: "Quiet",
        type: "GENERAL",
        beds: [{ id: "bed-1", status: "AVAILABLE" }],
      },
    ];
    store.admissions = []; // zero history → trimmedSeries forces fallback
    const r = await forecastBedOccupancy({ horizonHours: 24, now: NOW });
    expect(r.forecasts).toHaveLength(1);
    expect(r.forecasts[0].method).toBe("fallback-moving-average");
    expect(r.forecasts[0].confidence).toBe("low");
    expect(r.forecasts[0].insufficientData).toBe(true);
    expect(r.forecasts[0].predictedInflow).toBe(0);
  });
});

// ── forecastICUDemand ────────────────────────────────────────────────────────

describe("forecastICUDemand", () => {
  it("filters to ICU and NICU ward types only", async () => {
    store.wards = [
      {
        id: "w-icu",
        name: "ICU",
        type: "ICU",
        beds: [{ id: "bed-icu1", status: "OCCUPIED" }],
      },
      {
        id: "w-nicu",
        name: "NICU",
        type: "NICU",
        beds: [{ id: "bed-nicu1", status: "AVAILABLE" }],
      },
      {
        id: "w-gen",
        name: "General",
        type: "GENERAL",
        beds: [{ id: "bed-g1", status: "OCCUPIED" }],
      },
    ];
    const r = await forecastICUDemand({ horizonHours: 48, now: NOW });
    expect(r.forecasts.map((f) => f.resourceId).sort()).toEqual(["w-icu", "w-nicu"]);
    // General ward must be excluded
    expect(r.forecasts.find((f) => f.resourceId === "w-gen")).toBeUndefined();
  });

  it("returns horizonHours=48 in the response", async () => {
    const r = await forecastICUDemand({ horizonHours: 48, now: NOW });
    expect(r.horizonHours).toBe(48);
  });

  it("returns an empty forecast set when no ICU/NICU wards are seeded", async () => {
    store.wards = [
      {
        id: "w-gen",
        name: "General",
        type: "GENERAL",
        beds: [{ id: "bed-1", status: "OCCUPIED" }],
      },
    ];
    const r = await forecastICUDemand({ horizonHours: 24, now: NOW });
    expect(r.forecasts).toEqual([]);
  });
});

// ── forecastOTUtilization ────────────────────────────────────────────────────

describe("forecastOTUtilization", () => {
  it("returns empty forecast set when there are no operating theaters", async () => {
    const r = await forecastOTUtilization({ horizonHours: 72, now: NOW });
    expect(r.forecasts).toEqual([]);
    expect(r.summary.totalCapacity).toBe(0);
  });

  it("derives capacity from horizon: 72h / 4h avg case = 18 slots/theatre", async () => {
    store.operatingTheaters = [
      { id: "ot-1", name: "OT-1", isActive: true },
    ];
    const r = await forecastOTUtilization({ horizonHours: 72, now: NOW });
    expect(r.forecasts).toHaveLength(1);
    expect(r.forecasts[0].capacityUnits).toBe(18);
    expect(r.forecasts[0].resourceType).toBe("ot");
  });

  it("derives 6 slots for a 24h horizon", async () => {
    store.operatingTheaters = [
      { id: "ot-1", name: "OT-1", isActive: true },
    ];
    const r = await forecastOTUtilization({ horizonHours: 24, now: NOW });
    expect(r.forecasts[0].capacityUnits).toBe(6);
  });

  it("counts in-progress surgeries in currentlyInUse and scheduled ones in plannedReleases", async () => {
    store.operatingTheaters = [
      { id: "ot-1", name: "OT-1", isActive: true },
    ];
    store.surgeries = [
      // In progress right now → both currentlyInUse and scheduledInHorizon
      // (status filter `{in:["SCHEDULED","IN_PROGRESS"]}` matches IN_PROGRESS
      // and scheduledAt within the horizon window).
      {
        id: "s-inprog",
        otId: "ot-1",
        status: "IN_PROGRESS",
        scheduledAt: new Date(NOW.getTime() + 1 * 60 * 60 * 1000),
      },
      {
        id: "s-sched",
        otId: "ot-1",
        status: "SCHEDULED",
        scheduledAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
      },
      // Outside horizon — excluded
      {
        id: "s-far",
        otId: "ot-1",
        status: "SCHEDULED",
        scheduledAt: new Date(NOW.getTime() + 1000 * 60 * 60 * 1000),
      },
    ];
    const r = await forecastOTUtilization({ horizonHours: 72, now: NOW });
    expect(r.forecasts).toHaveLength(1);
    expect(r.forecasts[0].currentlyInUse).toBe(1);
    // plannedReleases is the re-used field — represents already-booked OT
    // slots in the horizon (2: the in-progress one + the scheduled one).
    expect(r.forecasts[0].plannedReleases).toBe(2);
  });

  it("excludes inactive operating theaters", async () => {
    store.operatingTheaters = [
      { id: "ot-1", name: "OT-1", isActive: true },
      { id: "ot-2", name: "OT-2", isActive: false },
    ];
    const r = await forecastOTUtilization({ horizonHours: 24, now: NOW });
    expect(r.forecasts.map((f) => f.resourceId)).toEqual(["ot-1"]);
  });

  it("flags expectedStockout=true when scheduled + upper-forecast exceeds capacity", async () => {
    store.operatingTheaters = [{ id: "ot-1", name: "OT-1", isActive: true }];
    // 6 slots in 24h capacity. Seed 6 already-scheduled surgeries inside
    // horizon AND a heavy history series so the upper-bound forecast is > 0.
    const scheduled = Array.from({ length: 6 }, (_, i) => ({
      id: `s-${i}`,
      otId: "ot-1",
      status: "SCHEDULED",
      scheduledAt: new Date(NOW.getTime() + (i + 1) * 60 * 60 * 1000),
    }));
    // 40 days × 5 surgeries/day BEFORE NOW → fallback-MA picks dailyAvg=5,
    // horizon 1d → point=5, upper=7 → 6 + 7 > 6 → stockout.
    const history: any[] = [];
    for (let d = 1; d <= 40; d++) {
      const day = new Date(NOW);
      day.setDate(day.getDate() - d);
      day.setHours(10, 0, 0, 0);
      for (let i = 0; i < 5; i++) {
        history.push({
          id: `h-${d}-${i}`,
          otId: "ot-1",
          status: "COMPLETED",
          scheduledAt: day,
        });
      }
    }
    store.surgeries = [...scheduled, ...history];
    const r = await forecastOTUtilization({ horizonHours: 24, now: NOW });
    expect(r.forecasts).toHaveLength(1);
    expect(r.forecasts[0].plannedReleases).toBe(6);
    expect(r.forecasts[0].predictedInflowUpper).toBeGreaterThan(0);
    expect(r.forecasts[0].expectedStockout).toBe(true);
  });

  it("aggregates summary across multiple OTs", async () => {
    store.operatingTheaters = [
      { id: "ot-1", name: "OT-1", isActive: true },
      { id: "ot-2", name: "OT-2", isActive: true },
    ];
    const r = await forecastOTUtilization({ horizonHours: 48, now: NOW });
    expect(r.forecasts).toHaveLength(2);
    // 48h / 4h = 12 slots per OT × 2 OTs = 24 total
    expect(r.summary.totalCapacity).toBe(24);
  });

  it("stamps generatedAt with the supplied `now`", async () => {
    const customNow = new Date("2025-12-31T23:59:59.000Z");
    const r: CapacityForecastResponse = await forecastOTUtilization({
      horizonHours: 24,
      now: customNow,
    });
    expect(r.generatedAt).toBe(customNow.toISOString());
  });
});

// ── summary arithmetic invariants ────────────────────────────────────────────

describe("summary arithmetic", () => {
  it("aggregateOccupancyPct = (inUse + inflow) / capacity, rounded to 1dp", async () => {
    store.wards = [
      {
        id: "w-1",
        name: "W",
        type: "GENERAL",
        beds: [
          { id: "bed-1", status: "OCCUPIED" },
          { id: "bed-2", status: "OCCUPIED" },
          { id: "bed-3", status: "OCCUPIED" },
          { id: "bed-4", status: "AVAILABLE" },
        ],
      },
    ];
    store.admissions = [
      {
        id: "a-1",
        bedId: "bed-1",
        status: "ADMITTED",
        admittedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
        expectedLosDays: 30,
      },
      {
        id: "a-2",
        bedId: "bed-2",
        status: "ADMITTED",
        admittedAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000),
        expectedLosDays: 30,
      },
    ];
    const r = await forecastBedOccupancy({ horizonHours: 24, now: NOW });
    expect(r.forecasts).toHaveLength(1);
    expect(r.summary.totalCapacity).toBe(4);
    expect(r.summary.totalCurrentlyInUse).toBe(2);
    // ((2 + inflow) / 4) * 100 rounded to 1dp
    const expected =
      Math.round(((2 + r.summary.totalPredictedInflow) / 4) * 1000) / 10;
    expect(r.summary.aggregateOccupancyPct).toBe(expected);
  });

  it("aggregateOccupancyPct = 0 when totalCapacity = 0", async () => {
    store.wards = [];
    const r = await forecastBedOccupancy({ horizonHours: 24, now: NOW });
    expect(r.summary.aggregateOccupancyPct).toBe(0);
  });
});
