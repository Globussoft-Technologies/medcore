import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sendNotification, prismaMock } = vi.hoisted(() => {
  const base: any = {
    systemConfig: { findUnique: vi.fn(), upsert: vi.fn(async () => ({})) },
    appointment: { findMany: vi.fn(async () => []) },
    invoice: { findMany: vi.fn(async () => []) },
    patient: { findMany: vi.fn(async () => []) },
    bloodUnit: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    // Issue #734: scheduler also runs `auto_checkout_stale_visitors`, which
    // queries the visitor delegate and updates rows. Stub both so the tick
    // doesn't surface a "Cannot read properties of undefined" stderr.
    visitor: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async (args: any) => ({ id: "v-1", ...args.data })),
    },
    user: { findMany: vi.fn(async () => []) },
    staffShift: { findMany: vi.fn(async () => []) },
    inventoryItem: { findMany: vi.fn(async () => []) },
    supplier: { findMany: vi.fn(async () => []) },
    purchaseOrder: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({ id: "po-1", ...args.data })),
    },
    patientDocument: {
      findMany: vi.fn(async () => []),
    },
    // Issue #160 / #161 — auto_cancel_missed_surgeries and
    // auto_assign_overdue_complaints tasks need delegate stubs and a
    // $transaction stub.
    surgery: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async (args: any) => ({ id: "s-1", ...args.data })),
    },
    complaint: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async (args: any) => ({ id: "c-1", ...args.data })),
      groupBy: vi.fn(async () => []),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: "a-1" })),
    },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
    // `tenantScopedPrisma` calls `$extends` at module load. Without this shim
    // any module that transitively imports `services/tenant-prisma` (e.g.
    // routes/ai-fraud.ts used by this scheduler) crashes at import time.
    // Returning the same mock keeps callers using the underlying delegates
    // directly — the scheduler itself goes through the un-scoped `prisma`
    // singleton, so no query-level transformation is exercised here.
    $extends(_config: unknown) {
      return base;
    },
  };
  return {
    sendNotification: vi.fn(async () => {}),
    prismaMock: base,
  };
});

vi.mock("./notification", () => ({
  sendNotification,
  // `scheduled-tasks.ts` also imports `drainScheduled` for the
  // `notification_drain_queued` task. Provide a no-op so the tick doesn't
  // throw a "No export defined" error inside the scheduler.
  drainScheduled: vi.fn(async () => {}),
}));
vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import {
  registerScheduledTasks,
  stopScheduledTasks,
} from "./scheduled-tasks";

describe("scheduled-tasks scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Reset all prisma mocks to default resolved values
    prismaMock.appointment.findMany.mockResolvedValue([]);
    prismaMock.invoice.findMany.mockResolvedValue([]);
    prismaMock.patient.findMany.mockResolvedValue([]);
    prismaMock.bloodUnit.findMany.mockResolvedValue([]);
    prismaMock.bloodUnit.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.visitor.findMany.mockResolvedValue([]);
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.staffShift.findMany.mockResolvedValue([]);
    prismaMock.inventoryItem.findMany.mockResolvedValue([]);
    prismaMock.supplier.findMany.mockResolvedValue([]);
    prismaMock.purchaseOrder.findFirst.mockResolvedValue(null);
    prismaMock.systemConfig.findUnique.mockResolvedValue(null);
    prismaMock.systemConfig.upsert.mockResolvedValue({});
  });

  afterEach(() => {
    stopScheduledTasks();
    vi.useRealTimers();
  });

  it("registerScheduledTasks only attaches a single interval handler", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    registerScheduledTasks();
    registerScheduledTasks(); // second call is a no-op
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("initial tick runs after grace period", async () => {
    registerScheduledTasks();
    expect(prismaMock.systemConfig.upsert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11_000); // >10s grace
    // At least one task attempted to persist last-run
    expect(prismaMock.systemConfig.upsert).toHaveBeenCalled();
  });

  it("stopScheduledTasks clears the interval so no further ticks fire", async () => {
    registerScheduledTasks();
    await vi.advanceTimersByTimeAsync(11_000);
    prismaMock.systemConfig.upsert.mockClear();
    stopScheduledTasks();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(prismaMock.systemConfig.upsert).not.toHaveBeenCalled();
  });

  it("appointment reminders query is issued with status=BOOKED", async () => {
    registerScheduledTasks();
    await vi.advanceTimersByTimeAsync(11_000);
    const calls = prismaMock.appointment.findMany.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const statusArg = calls[0][0].where.status;
    // Either exact "BOOKED" or a where-clause referencing BOOKED
    expect(String(JSON.stringify(statusArg))).toContain("BOOKED");
  });

  it("overdue invoice reminders filter by paymentStatus PENDING/PARTIAL", async () => {
    // Force overdue task to run by clearing its last-run
    prismaMock.systemConfig.findUnique.mockResolvedValue(null);
    registerScheduledTasks();
    await vi.advanceTimersByTimeAsync(11_000);
    const calls = prismaMock.invoice.findMany.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const where = calls[0][0].where;
    expect(JSON.stringify(where.paymentStatus)).toContain("PENDING");
    expect(JSON.stringify(where.paymentStatus)).toContain("PARTIAL");
  });

  it("auto-PO threshold reads system_config for override", async () => {
    prismaMock.systemConfig.findUnique.mockImplementation(async (args: any) => {
      if (args.where.key === "auto_po_threshold") {
        return { key: "auto_po_threshold", value: "75" };
      }
      return null;
    });
    registerScheduledTasks();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(prismaMock.systemConfig.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ key: "auto_po_threshold" }),
      })
    );
  });

  it("persists last-run with system_config upsert using the registry prefix", async () => {
    registerScheduledTasks();
    await vi.advanceTimersByTimeAsync(11_000);
    const calls = prismaMock.systemConfig.upsert.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0][0];
    expect(firstCall.where.key.startsWith("medcore_task_registry:")).toBe(true);
  });
});

// ── Issue #160 — auto-cancel stale SCHEDULED surgeries ─────────
import { autoCancelStaleScheduledSurgeries, autoAssignOverdueComplaints } from "./scheduled-tasks";

describe("autoCancelStaleScheduledSurgeries (Issue #160)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.surgery.findMany.mockResolvedValue([]);
    prismaMock.surgery.update.mockResolvedValue({ id: "s-1", status: "CANCELLED" });
    prismaMock.auditLog.create.mockResolvedValue({ id: "a-1" });
  });

  it("returns 0 when no stale rows match", async () => {
    prismaMock.surgery.findMany.mockResolvedValue([]);
    const r = await autoCancelStaleScheduledSurgeries();
    expect(r.cancelled).toBe(0);
    expect(prismaMock.surgery.update).not.toHaveBeenCalled();
  });

  it("queries SCHEDULED rows older than 7 days", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    await autoCancelStaleScheduledSurgeries(now);
    const where = prismaMock.surgery.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("SCHEDULED");
    expect(where.scheduledAt.lt).toBeInstanceOf(Date);
    const cutoff = where.scheduledAt.lt as Date;
    const ageDays = (now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeCloseTo(7, 0);
  });

  it("transitions matching rows to CANCELLED and writes audit log", async () => {
    prismaMock.surgery.findMany.mockResolvedValue([
      {
        id: "s-1",
        caseNumber: "SRG000001",
        scheduledAt: new Date("2026-04-15T08:00:00.000Z"),
        surgeonId: "doc-1",
      },
      {
        id: "s-2",
        caseNumber: "SRG000002",
        scheduledAt: new Date("2026-04-10T08:00:00.000Z"),
        surgeonId: "doc-2",
      },
    ]);
    const result = await autoCancelStaleScheduledSurgeries(
      new Date("2026-04-26T12:00:00.000Z")
    );
    expect(result.cancelled).toBe(2);
    expect(result.ids).toEqual(["s-1", "s-2"]);
    // Both went through update + auditLog.create
    expect(prismaMock.surgery.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(2);
    const auditArgs = prismaMock.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe("SURGERY_AUTO_CANCELLED_STALE");
    expect(auditArgs.data.entity).toBe("surgery");
  });

  it("continues processing if a single row's transaction throws", async () => {
    prismaMock.surgery.findMany.mockResolvedValue([
      { id: "s-1", caseNumber: "X", scheduledAt: new Date("2026-04-10T00:00:00Z") },
      { id: "s-2", caseNumber: "Y", scheduledAt: new Date("2026-04-10T00:00:00Z") },
    ]);
    let call = 0;
    prismaMock.$transaction.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error("DB blip");
      return [];
    });
    // Suppress the expected error log so the suite output stays readable.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await autoCancelStaleScheduledSurgeries();
    expect(r.cancelled).toBe(1); // only the second row succeeded
    errSpy.mockRestore();
  });
});

// ── Issue #161 — auto-assign overdue OPEN complaints ──────────

describe("autoAssignOverdueComplaints (Issue #161)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.complaint.findMany.mockResolvedValue([]);
    prismaMock.complaint.update.mockResolvedValue({ id: "c-1" });
    prismaMock.complaint.groupBy.mockResolvedValue([]);
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.auditLog.create.mockResolvedValue({ id: "a-1" });
    prismaMock.$transaction.mockImplementation(async (ops: any[]) =>
      Promise.all(ops)
    );
  });

  it("returns 0 when there are no overdue complaints", async () => {
    const r = await autoAssignOverdueComplaints();
    expect(r.assigned).toBe(0);
  });

  it("queries OPEN complaints unassigned and older than 48h", async () => {
    const now = new Date("2026-04-26T12:00:00.000Z");
    prismaMock.complaint.findMany.mockResolvedValue([
      {
        id: "c-1",
        ticketNumber: "T-1",
        category: "BILLING",
        createdAt: new Date("2026-04-20T00:00:00Z"),
      },
    ]);
    prismaMock.user.findMany.mockResolvedValue([
      { id: "admin-1", name: "Admin One" },
    ]);
    await autoAssignOverdueComplaints(now);
    const where = prismaMock.complaint.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("OPEN");
    expect(where.assignedTo).toBeNull();
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    const cutoff = where.createdAt.lt as Date;
    const ageHours = (now.getTime() - cutoff.getTime()) / 3600000;
    expect(ageHours).toBeCloseTo(48, 0);
  });

  it("does not assign when no admins are active", async () => {
    prismaMock.complaint.findMany.mockResolvedValue([
      { id: "c-1", ticketNumber: "T-1", category: "X", createdAt: new Date(0) },
    ]);
    prismaMock.user.findMany.mockResolvedValue([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await autoAssignOverdueComplaints();
    expect(r.assigned).toBe(0);
    warnSpy.mockRestore();
  });

  it("routes each complaint to the admin with the lowest current load", async () => {
    prismaMock.complaint.findMany.mockResolvedValue([
      { id: "c-1", ticketNumber: "T-1", category: "X", createdAt: new Date("2026-04-20T00:00:00Z") },
      { id: "c-2", ticketNumber: "T-2", category: "Y", createdAt: new Date("2026-04-20T00:00:00Z") },
      { id: "c-3", ticketNumber: "T-3", category: "Z", createdAt: new Date("2026-04-20T00:00:00Z") },
    ]);
    prismaMock.user.findMany.mockResolvedValue([
      { id: "admin-1", name: "Admin One" },
      { id: "admin-2", name: "Admin Two" },
    ]);
    // Admin-1 currently has 5 OPEN; admin-2 has 1.
    prismaMock.complaint.groupBy.mockResolvedValue([
      { assignedTo: "admin-1", _count: { _all: 5 } },
      { assignedTo: "admin-2", _count: { _all: 1 } },
    ]);
    const r = await autoAssignOverdueComplaints();
    expect(r.assigned).toBe(3);
    // First two complaints should both go to admin-2 (load 1, then 2),
    // the third splits to admin-1 (load 5) vs admin-2 (load 3) → admin-2.
    const updates = prismaMock.complaint.update.mock.calls.map(
      (c: any[]) => c[0].data.assignedTo
    );
    expect(updates).toEqual(["admin-2", "admin-2", "admin-2"]);
  });

  it("emits a notification for each assignee", async () => {
    prismaMock.complaint.findMany.mockResolvedValue([
      { id: "c-1", ticketNumber: "T-1", category: "X", createdAt: new Date("2026-04-20T00:00:00Z") },
    ]);
    prismaMock.user.findMany.mockResolvedValue([
      { id: "admin-1", name: "Admin One" },
    ]);
    await autoAssignOverdueComplaints();
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        title: expect.stringMatching(/auto-assigned/i),
      })
    );
  });

  it("writes COMPLAINT_AUTO_ASSIGNED_OVERDUE audit log", async () => {
    prismaMock.complaint.findMany.mockResolvedValue([
      { id: "c-1", ticketNumber: "T-1", category: "X", createdAt: new Date("2026-04-20T00:00:00Z") },
    ]);
    prismaMock.user.findMany.mockResolvedValue([
      { id: "admin-1", name: "Admin One" },
    ]);
    await autoAssignOverdueComplaints();
    const auditArgs = prismaMock.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe("COMPLAINT_AUTO_ASSIGNED_OVERDUE");
    expect(auditArgs.data.entity).toBe("complaint");
  });
});
