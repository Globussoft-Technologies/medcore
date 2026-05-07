/**
 * Issue #734 — Zombie ACTIVE visitor auto-checkout regression tests.
 *
 * The scheduler task `auto_checkout_stale_visitors` runs every 30 min,
 * picks up any Visitor row with `checkOutAt = null` whose `checkInAt`
 * is older than `MAX_VISIT_DURATION_HOURS` (default 12, env-overridable),
 * sets `checkOutAt = now`, appends an "Auto-checked-out" marker to the
 * `notes` column, and emits a single batch audit row.
 *
 * The exported `autoCheckoutStaleVisitors(now)` helper is invoked
 * directly here — same pattern as `autoCancelStaleScheduledSurgeries`
 * and `autoAssignOverdueComplaints` are tested. We mock @medcore/db so
 * no real Postgres is required.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    visitor: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("./notification", () => ({
  sendNotification: vi.fn(async () => {}),
  drainScheduled: vi.fn(async () => 0),
}));

import { autoCheckoutStaleVisitors } from "./scheduled-tasks";

describe("autoCheckoutStaleVisitors — Issue #734", () => {
  beforeEach(() => {
    prismaMock.visitor.findMany.mockReset();
    prismaMock.visitor.update.mockReset();
    prismaMock.auditLog.create.mockReset();
    delete process.env.MAX_VISIT_DURATION_HOURS;
  });

  afterEach(() => {
    delete process.env.MAX_VISIT_DURATION_HOURS;
  });

  it("flips a 13-hour-old ACTIVE visitor to checked-out with the marker note", async () => {
    const now = new Date("2026-05-08T12:00:00.000Z");
    const thirteenHoursAgo = new Date(now.getTime() - 13 * 60 * 60 * 1000);

    prismaMock.visitor.findMany.mockResolvedValueOnce([
      {
        id: "v-1",
        passNumber: "VIS000001-20260508",
        notes: null,
      },
    ]);
    prismaMock.visitor.update.mockResolvedValueOnce({});
    prismaMock.auditLog.create.mockResolvedValueOnce({ id: "al-1" });

    const result = await autoCheckoutStaleVisitors(now);

    expect(result.checkedOut).toBe(1);
    expect(result.ids).toEqual(["v-1"]);

    // Critical assertion: the where-clause uses `lt: cutoff` where cutoff
    // = now - 12h. Visitors checked in MORE than 12h ago are picked up.
    const findManyArgs = prismaMock.visitor.findMany.mock.calls[0][0];
    expect(findManyArgs.where.checkOutAt).toBe(null);
    expect(findManyArgs.where.checkInAt).toEqual({ lt: expect.any(Date) });
    const cutoff: Date = findManyArgs.where.checkInAt.lt;
    expect(cutoff.getTime()).toBe(now.getTime() - 12 * 60 * 60 * 1000);

    // The 13h-old visitor IS strictly before the 12h cutoff.
    expect(thirteenHoursAgo.getTime()).toBeLessThan(cutoff.getTime());

    // Update payload sets checkOutAt to `now` and stamps the marker.
    const updateArgs = prismaMock.visitor.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "v-1" });
    expect(updateArgs.data.checkOutAt).toEqual(now);
    expect(updateArgs.data.notes).toMatch(/Auto-checked-out: 12h limit/);

    // Single batch audit row.
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = prismaMock.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe("VISITOR_AUTO_CHECK_OUT");
    expect(auditArgs.data.entity).toBe("visitor");
    expect(auditArgs.data.details.count).toBe(1);
    expect(auditArgs.data.details.ceilingHours).toBe(12);
  });

  it("does nothing when no visitors are stale", async () => {
    const now = new Date("2026-05-08T12:00:00.000Z");
    prismaMock.visitor.findMany.mockResolvedValueOnce([]);

    const result = await autoCheckoutStaleVisitors(now);

    expect(result.checkedOut).toBe(0);
    expect(result.ids).toEqual([]);
    expect(prismaMock.visitor.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("respects MAX_VISIT_DURATION_HOURS env override", async () => {
    process.env.MAX_VISIT_DURATION_HOURS = "6";
    const now = new Date("2026-05-08T12:00:00.000Z");

    prismaMock.visitor.findMany.mockResolvedValueOnce([]);

    await autoCheckoutStaleVisitors(now);

    const findManyArgs = prismaMock.visitor.findMany.mock.calls[0][0];
    const cutoff: Date = findManyArgs.where.checkInAt.lt;
    expect(cutoff.getTime()).toBe(now.getTime() - 6 * 60 * 60 * 1000);
  });

  it("preserves existing notes by appending the marker on a new line", async () => {
    const now = new Date("2026-05-08T12:00:00.000Z");
    prismaMock.visitor.findMany.mockResolvedValueOnce([
      {
        id: "v-1",
        passNumber: "VIS000001-20260508",
        notes: "Brought medical records",
      },
    ]);
    prismaMock.visitor.update.mockResolvedValueOnce({});
    prismaMock.auditLog.create.mockResolvedValueOnce({ id: "al-1" });

    await autoCheckoutStaleVisitors(now);

    const updateArgs = prismaMock.visitor.update.mock.calls[0][0];
    expect(updateArgs.data.notes).toBe(
      "Brought medical records\nAuto-checked-out: 12h limit"
    );
  });
});
