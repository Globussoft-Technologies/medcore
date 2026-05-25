/**
 * Pearl ERP Stage 1 §8.3 (gap row 214 closure, 2026-05-24) — per-tenant
 * daily usage collector tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression suite around `collectYesterdayUsage` — confirms
 *   the UTC date-window math, the channel→counter folding, and the
 *   per-(tenantId, date) upsert behaviour that makes the cron
 *   idempotent.
 * - MODULES: mocks `@medcore/db` (no real Postgres) and the
 *   `Notification.groupBy` + `TenantUsageDaily.upsert` Prisma calls;
 *   exercises the pure aggregation logic.
 * - WHY: this is the billing-data source — wrong counts mean wrong
 *   invoices. The "today's notification doesn't bleed into yesterday's
 *   row" boundary case is the load-bearing assertion.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// We mock @medcore/db at the package level so the collector picks up
// our prismaMock + the NotificationDeliveryStatus enum stub. The real
// enum is Prisma-generated; we mirror just the members the collector
// references so the where-clause comparison works in the assertion.
vi.mock("@medcore/db", () => ({
  NotificationDeliveryStatus: {
    QUEUED: "QUEUED",
    SENT: "SENT",
    DELIVERED: "DELIVERED",
    READ: "READ",
    FAILED: "FAILED",
  },
}));

import {
  collectYesterdayUsage,
  computeYesterdayUtcWindow,
} from "./tenant-usage-collector";

function buildPrismaMock(groupByRows: any[]): {
  prismaMock: any;
  upsert: any;
  groupBy: any;
} {
  const upsert: any = vi.fn(async () => ({ id: "row-1" }));
  const groupBy: any = vi.fn(async () => groupByRows);
  const prismaMock: any = {
    notification: { groupBy },
    tenantUsageDaily: { upsert },
  };
  return { prismaMock, upsert, groupBy };
}

describe("computeYesterdayUtcWindow", () => {
  it("returns midnight-UTC bounds for the prior calendar day", () => {
    const now = new Date("2026-05-24T05:23:11.500Z");
    const { startOfYesterday, startOfToday } = computeYesterdayUtcWindow(now);

    // Today bound = 00:00 UTC on 2026-05-24
    expect(startOfToday.toISOString()).toBe("2026-05-24T00:00:00.000Z");
    // Yesterday bound = 00:00 UTC on 2026-05-23
    expect(startOfYesterday.toISOString()).toBe("2026-05-23T00:00:00.000Z");
  });

  it("handles a now that is itself midnight-UTC without bleeding back two days", () => {
    const now = new Date("2026-05-24T00:00:00.000Z");
    const { startOfYesterday, startOfToday } = computeYesterdayUtcWindow(now);
    expect(startOfToday.toISOString()).toBe("2026-05-24T00:00:00.000Z");
    expect(startOfYesterday.toISOString()).toBe("2026-05-23T00:00:00.000Z");
  });
});

describe("collectYesterdayUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("groups yesterday's notifications by channel and upserts one row per tenant", async () => {
    const now = new Date("2026-05-24T10:00:00.000Z");
    // Yesterday for tenant A: 3 WHATSAPP + 2 SMS.
    // Email today (NOT counted because outside window) won't appear in
    // groupBy's result-set — Prisma already filtered it. The mock
    // returns only what `where: { createdAt: ... }` would have returned.
    const { prismaMock, upsert, groupBy } = buildPrismaMock([
      { tenantId: "A", channel: "WHATSAPP", _count: { _all: 3 } },
      { tenantId: "A", channel: "SMS", _count: { _all: 2 } },
    ]);

    const result = await collectYesterdayUsage(prismaMock, { now });

    expect(result.tenantsProcessed).toBe(1);
    expect(result.totalRowsWritten).toBe(1);
    expect(result.date).toBe("2026-05-23");

    // groupBy was called with the right window + status filter.
    const whereClause = groupBy.mock.calls[0][0].where;
    expect(whereClause.createdAt.gte.toISOString()).toBe(
      "2026-05-23T00:00:00.000Z"
    );
    expect(whereClause.createdAt.lt.toISOString()).toBe(
      "2026-05-24T00:00:00.000Z"
    );
    expect(whereClause.deliveryStatus.in).toEqual([
      "SENT",
      "DELIVERED",
      "READ",
    ]);
    expect(whereClause.tenantId).toEqual({ not: null });

    // Upsert was called once for tenant A with the exact per-channel
    // counters folded out of the groupBy rows.
    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({
      tenantId_date: {
        tenantId: "A",
        date: new Date("2026-05-23T00:00:00.000Z"),
      },
    });
    expect(upsertArgs.create).toEqual({
      tenantId: "A",
      date: new Date("2026-05-23T00:00:00.000Z"),
      whatsappCount: 3,
      smsCount: 2,
      emailCount: 0,
      pushCount: 0,
    });
    expect(upsertArgs.update).toEqual({
      whatsappCount: 3,
      smsCount: 2,
      emailCount: 0,
      pushCount: 0,
    });
  });

  it("is idempotent — a second call for the same day re-issues upsert (not insert)", async () => {
    const now = new Date("2026-05-24T10:00:00.000Z");
    const { prismaMock, upsert } = buildPrismaMock([
      { tenantId: "A", channel: "WHATSAPP", _count: { _all: 3 } },
    ]);

    await collectYesterdayUsage(prismaMock, { now });
    await collectYesterdayUsage(prismaMock, { now });

    // Both passes go through `upsert` (not `create`) so the
    // `@@unique([tenantId, date])` constraint is honoured. Two
    // upsert calls with the same `where.tenantId_date` payload.
    expect(upsert).toHaveBeenCalledTimes(2);
    const firstCallWhere = upsert.mock.calls[0][0].where;
    const secondCallWhere = upsert.mock.calls[1][0].where;
    expect(firstCallWhere).toEqual(secondCallWhere);
  });

  it("writes nothing when there were no qualifying notifications yesterday", async () => {
    const now = new Date("2026-05-24T10:00:00.000Z");
    const { prismaMock, upsert } = buildPrismaMock([]);

    const result = await collectYesterdayUsage(prismaMock, { now });

    expect(result.tenantsProcessed).toBe(0);
    expect(result.totalRowsWritten).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rolls up multiple tenants in one pass, one upsert per tenant", async () => {
    const now = new Date("2026-05-24T10:00:00.000Z");
    const { prismaMock, upsert } = buildPrismaMock([
      { tenantId: "A", channel: "WHATSAPP", _count: { _all: 5 } },
      { tenantId: "A", channel: "EMAIL", _count: { _all: 1 } },
      { tenantId: "B", channel: "PUSH", _count: { _all: 7 } },
      { tenantId: "B", channel: "SMS", _count: { _all: 4 } },
    ]);

    const result = await collectYesterdayUsage(prismaMock, { now });

    expect(result.tenantsProcessed).toBe(2);
    expect(result.totalRowsWritten).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);

    const calls: any[] = upsert.mock.calls.map((c: any) => c[0]);
    const tenantA = calls.find(
      (c: any) => c.where.tenantId_date.tenantId === "A"
    );
    const tenantB = calls.find(
      (c: any) => c.where.tenantId_date.tenantId === "B"
    );
    expect(tenantA?.create).toMatchObject({
      whatsappCount: 5,
      smsCount: 0,
      emailCount: 1,
      pushCount: 0,
    });
    expect(tenantB?.create).toMatchObject({
      whatsappCount: 0,
      smsCount: 4,
      emailCount: 0,
      pushCount: 7,
    });
  });
});
