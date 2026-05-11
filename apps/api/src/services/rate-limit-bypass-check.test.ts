import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    systemConfig: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: "al-1" })),
    },
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
      create: vi.fn(async () => ({})),
    },
    patientDocument: { findMany: vi.fn(async () => []) },
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
vi.mock("../routes/ai-fraud", () => ({ runDailyFraudScan: vi.fn() }));
vi.mock("../routes/ai-doc-qa", () => ({ runDailyDocQAScheduledTask: vi.fn() }));
vi.mock("../routes/ai-sentiment", () => ({ runDailyNpsDriverRollup: vi.fn() }));

import {
  _resetRateLimitAlarmForTests,
  _peekRateLimitAlarmStateForTests,
  _runSchedulerTickForTests,
  registerScheduledTasks,
  stopScheduledTasks,
} from "./scheduled-tasks";

describe("rate_limit_bypass_check task (Gap 3 alarm)", () => {
  beforeEach(() => {
    _resetRateLimitAlarmForTests();
    prismaMock.auditLog.create.mockClear();
    prismaMock.systemConfig.findUnique.mockReset();
    // Default: never-run (so every tick triggers the check)
    prismaMock.systemConfig.findUnique.mockResolvedValue(null);
    prismaMock.systemConfig.upsert.mockResolvedValue({});
    delete process.env.DISABLE_RATE_LIMITS;
  });

  afterEach(() => {
    stopScheduledTasks();
    delete process.env.DISABLE_RATE_LIMITS;
  });

  it("no alarm when DISABLE_RATE_LIMITS is not set — counter stays at 0", async () => {
    registerScheduledTasks();
    await _runSchedulerTickForTests();
    await _runSchedulerTickForTests();
    await _runSchedulerTickForTests();
    const state = _peekRateLimitAlarmStateForTests();
    expect(state.count).toBe(0);
    expect(state.firedAt).toBeNull();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("counter resets the moment DISABLE_RATE_LIMITS flips back off", async () => {
    registerScheduledTasks();
    process.env.DISABLE_RATE_LIMITS = "true";
    await _runSchedulerTickForTests();
    await _runSchedulerTickForTests();
    expect(_peekRateLimitAlarmStateForTests().count).toBe(2);
    // Flip back off — next check must zero the counter.
    delete process.env.DISABLE_RATE_LIMITS;
    await _runSchedulerTickForTests();
    expect(_peekRateLimitAlarmStateForTests().count).toBe(0);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("fires RATE_LIMITS_DISABLED_EXTENDED with severity=WARNING after 3 consecutive checks", async () => {
    registerScheduledTasks();
    process.env.DISABLE_RATE_LIMITS = "true";

    // Each _runSchedulerTickForTests re-runs the full task list. Because we
    // reset getLastRun to null above, every task is eligible every tick —
    // including rate_limit_bypass_check. Three ticks → counter=3 → alarm.
    await _runSchedulerTickForTests();
    await _runSchedulerTickForTests();
    await _runSchedulerTickForTests();

    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    const call = prismaMock.auditLog.create.mock.calls[0][0];
    expect(call.data.action).toBe("RATE_LIMITS_DISABLED_EXTENDED");
    expect(call.data.entity).toBe("system");
    expect(call.data.details.severity).toBe("WARNING");
    expect(call.data.details.consecutiveChecks).toBeGreaterThanOrEqual(3);
    expect(_peekRateLimitAlarmStateForTests().firedAt).toBeInstanceOf(Date);
  });

  it("does not spam the audit log — second consecutive trigger within 6h is a no-op", async () => {
    registerScheduledTasks();
    process.env.DISABLE_RATE_LIMITS = "true";

    await _runSchedulerTickForTests();
    await _runSchedulerTickForTests();
    await _runSchedulerTickForTests();
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    // Four more ticks — alarm must NOT fire again (rate-limited to every 6h).
    await _runSchedulerTickForTests();
    await _runSchedulerTickForTests();
    await _runSchedulerTickForTests();
    await _runSchedulerTickForTests();
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
