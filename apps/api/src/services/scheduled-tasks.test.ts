import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sendNotification, prismaMock } = vi.hoisted(() => ({
  sendNotification: vi.fn(async () => {}),
  prismaMock: {
    systemConfig: { findUnique: vi.fn(), upsert: vi.fn(async () => ({})) },
    appointment: { findMany: vi.fn(async () => []) },
    invoice: { findMany: vi.fn(async () => []) },
    patient: { findMany: vi.fn(async () => []) },
    bloodUnit: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    staffShift: { findMany: vi.fn(async () => []) },
    inventoryItem: { findMany: vi.fn(async () => []) },
    supplier: { findMany: vi.fn(async () => []) },
    purchaseOrder: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({ id: "po-1", ...args.data })),
    },
  } as any,
}));

vi.mock("./notification", () => ({ sendNotification }));
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
