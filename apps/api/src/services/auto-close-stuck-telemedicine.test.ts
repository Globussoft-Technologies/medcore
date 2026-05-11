/**
 * Issue #743 — Stuck IN_PROGRESS telemedicine session auto-close tests.
 *
 * The scheduler task `auto_close_stuck_telemedicine_sessions` runs every
 * 30 min, picks up any TelemedicineSession row whose `status` is
 * IN_PROGRESS and whose `startedAt` is older than
 * `MAX_TELEMED_DURATION_HOURS` (default 2, env-overridable), transitions
 * the row to status=COMPLETED with `endedAt = now`, appends an
 * "Auto-closed" marker to `doctorNotes`, and emits a single batch audit
 * row tagged `TELEMEDICINE_AUTO_CLOSED_STUCK`.
 *
 * The exported `autoCloseStuckTelemedicineSessions(now)` helper is
 * invoked directly here — same pattern as `autoCheckoutStaleVisitors`,
 * `autoFlagExpiredBloodUnits`, and `autoCancelStaleScheduledSurgeries`
 * are tested. We mock @medcore/db so no real Postgres is required.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    telemedicineSession: {
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

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));
vi.mock("./notification", () => ({
  sendNotification: vi.fn(async () => {}),
  drainScheduled: vi.fn(async () => 0),
}));

import { autoCloseStuckTelemedicineSessions } from "./scheduled-tasks";

describe("autoCloseStuckTelemedicineSessions — Issue #743", () => {
  beforeEach(() => {
    prismaMock.telemedicineSession.findMany.mockReset();
    prismaMock.telemedicineSession.update.mockReset();
    prismaMock.auditLog.create.mockReset();
    delete process.env.MAX_TELEMED_DURATION_HOURS;
  });

  afterEach(() => {
    delete process.env.MAX_TELEMED_DURATION_HOURS;
  });

  it("flips a 3-hour-old IN_PROGRESS session to COMPLETED with endedAt and the marker note", async () => {
    const now = new Date("2026-05-08T12:00:00.000Z");
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

    prismaMock.telemedicineSession.findMany.mockResolvedValueOnce([
      {
        id: "tm-1",
        sessionNumber: "TM-2026-001",
        doctorNotes: null,
      },
    ]);
    prismaMock.telemedicineSession.update.mockResolvedValueOnce({});
    prismaMock.auditLog.create.mockResolvedValueOnce({ id: "al-1" });

    const result = await autoCloseStuckTelemedicineSessions(now);

    expect(result.closed).toBe(1);
    expect(result.ids).toEqual(["tm-1"]);

    // Critical assertion: the where-clause picks up only IN_PROGRESS rows
    // whose startedAt is strictly less than the 2h cutoff.
    const findManyArgs = prismaMock.telemedicineSession.findMany.mock.calls[0][0];
    expect(findManyArgs.where.status).toBe("IN_PROGRESS");
    expect(findManyArgs.where.startedAt).toEqual({ lt: expect.any(Date) });
    const cutoff: Date = findManyArgs.where.startedAt.lt;
    expect(cutoff.getTime()).toBe(now.getTime() - 2 * 60 * 60 * 1000);

    // The 3h-old session IS strictly before the 2h cutoff.
    expect(threeHoursAgo.getTime()).toBeLessThan(cutoff.getTime());

    // Update payload sets status=COMPLETED, endedAt=now, marker on doctorNotes.
    const updateArgs = prismaMock.telemedicineSession.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "tm-1" });
    expect(updateArgs.data.status).toBe("COMPLETED");
    expect(updateArgs.data.endedAt).toEqual(now);
    expect(updateArgs.data.doctorNotes).toMatch(/Auto-closed: 2h limit/);

    // Single batch audit row.
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = prismaMock.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe("TELEMEDICINE_AUTO_CLOSED_STUCK");
    expect(auditArgs.data.entity).toBe("telemedicine_session");
    expect(auditArgs.data.details.count).toBe(1);
    expect(auditArgs.data.details.ceilingHours).toBe(2);
    expect(auditArgs.data.details.sessionNumbers).toEqual(["TM-2026-001"]);
  });

  it("does nothing when no sessions are stuck", async () => {
    const now = new Date("2026-05-08T12:00:00.000Z");
    prismaMock.telemedicineSession.findMany.mockResolvedValueOnce([]);

    const result = await autoCloseStuckTelemedicineSessions(now);

    expect(result.closed).toBe(0);
    expect(result.ids).toEqual([]);
    expect(prismaMock.telemedicineSession.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("respects MAX_TELEMED_DURATION_HOURS env override", async () => {
    process.env.MAX_TELEMED_DURATION_HOURS = "4";
    const now = new Date("2026-05-08T12:00:00.000Z");

    prismaMock.telemedicineSession.findMany.mockResolvedValueOnce([]);

    await autoCloseStuckTelemedicineSessions(now);

    const findManyArgs = prismaMock.telemedicineSession.findMany.mock.calls[0][0];
    const cutoff: Date = findManyArgs.where.startedAt.lt;
    expect(cutoff.getTime()).toBe(now.getTime() - 4 * 60 * 60 * 1000);
  });

  it("preserves existing doctorNotes by appending the marker on a new line", async () => {
    const now = new Date("2026-05-08T12:00:00.000Z");
    prismaMock.telemedicineSession.findMany.mockResolvedValueOnce([
      {
        id: "tm-1",
        sessionNumber: "TM-2026-001",
        doctorNotes: "Patient reports persistent cough",
      },
    ]);
    prismaMock.telemedicineSession.update.mockResolvedValueOnce({});
    prismaMock.auditLog.create.mockResolvedValueOnce({ id: "al-1" });

    await autoCloseStuckTelemedicineSessions(now);

    const updateArgs = prismaMock.telemedicineSession.update.mock.calls[0][0];
    expect(updateArgs.data.doctorNotes).toBe(
      "Patient reports persistent cough\nAuto-closed: 2h limit"
    );
  });
});
