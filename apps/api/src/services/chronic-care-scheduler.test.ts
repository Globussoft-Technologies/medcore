/**
 * Unit tests for the chronic-care scheduler. Three concerns:
 *   - `evaluateThresholds` — pure threshold-vs-observation comparison.
 *   - `isCheckInDue` — pure time-since-last-check-in math.
 *   - `runChronicCareReminders` — per-tick fan-out: pulls active plans,
 *     skips ones not yet due, sends one reminder per due plan, isolates
 *     per-plan errors so the run keeps going.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, sendNotificationMock } = vi.hoisted(() => ({
  prismaMock: {
    chronicCarePlan: { findMany: vi.fn() },
    chronicCareCheckIn: { findFirst: vi.fn() },
    patient: { findUnique: vi.fn() },
  },
  sendNotificationMock: vi.fn(),
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("./notification", () => ({ sendNotification: sendNotificationMock }));

import {
  evaluateThresholds,
  isCheckInDue,
  runChronicCareReminders,
} from "./chronic-care-scheduler";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  sendNotificationMock.mockResolvedValue(undefined);
});

describe("evaluateThresholds", () => {
  it("returns null when nothing breaches", () => {
    const out = evaluateThresholds(
      { bpSystolic: 140, bgFasting: 126 },
      { bpSystolic: 130, bgFasting: 100 },
    );
    expect(out).toBeNull();
  });

  it("flags the breached key with observed value", () => {
    const out = evaluateThresholds(
      { bpSystolic: 140 },
      { bpSystolic: 165 },
    );
    expect(out).toEqual([{ key: "bpSystolic", observed: 165, threshold: 140 }]);
  });

  it("treats observed === threshold as a breach (>= cutoff)", () => {
    const out = evaluateThresholds({ bpSystolic: 140 }, { bpSystolic: 140 });
    expect(out).toEqual([{ key: "bpSystolic", observed: 140, threshold: 140 }]);
  });

  it("flags multiple breached keys at once", () => {
    const out = evaluateThresholds(
      { bpSystolic: 140, bgFasting: 126 },
      { bpSystolic: 165, bgFasting: 200 },
    );
    expect(out).toEqual([
      { key: "bpSystolic", observed: 165, threshold: 140 },
      { key: "bgFasting", observed: 200, threshold: 126 },
    ]);
  });

  it("coerces numeric strings ('165' → 165) before comparing", () => {
    const out = evaluateThresholds(
      { bpSystolic: 140 },
      { bpSystolic: "165" },
    );
    expect(out).toEqual([{ key: "bpSystolic", observed: 165, threshold: 140 }]);
  });

  it("ignores non-numeric responses (NaN-finite skip)", () => {
    const out = evaluateThresholds(
      { bpSystolic: 140 },
      { bpSystolic: "not a number" },
    );
    expect(out).toBeNull();
  });

  it("ignores keys not present in responses", () => {
    const out = evaluateThresholds(
      { bpSystolic: 140, pefr: 200 },
      { bpSystolic: 130 }, // pefr missing
    );
    expect(out).toBeNull();
  });
});

describe("isCheckInDue", () => {
  it("returns true when patient has never checked in", () => {
    expect(isCheckInDue(7, null)).toBe(true);
  });

  it("returns true when last check-in is older than the frequency window", () => {
    const now = new Date("2026-05-02T12:00:00Z");
    const eightDaysAgo = new Date("2026-04-24T12:00:00Z");
    expect(isCheckInDue(7, eightDaysAgo, now)).toBe(true);
  });

  it("returns false when last check-in is within the frequency window", () => {
    const now = new Date("2026-05-02T12:00:00Z");
    const threeDaysAgo = new Date("2026-04-29T12:00:00Z");
    expect(isCheckInDue(7, threeDaysAgo, now)).toBe(false);
  });

  it("returns true at exactly the frequency boundary (>=)", () => {
    const now = new Date("2026-05-02T12:00:00Z");
    const exactlyOneDayAgo = new Date("2026-05-01T12:00:00Z");
    expect(isCheckInDue(1, exactlyOneDayAgo, now)).toBe(true);
  });

  it("treats freqDays=0 as always-due", () => {
    expect(isCheckInDue(0, new Date(), new Date())).toBe(true);
  });
});

describe("runChronicCareReminders — happy path", () => {
  it("sends one reminder per active plan whose check-in is due", async () => {
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      {
        id: "plan-1",
        patientId: "p-1",
        condition: "DIABETES",
        checkInFrequencyDays: 7,
      },
    ]);
    prismaMock.chronicCareCheckIn.findFirst.mockResolvedValue({
      loggedAt: new Date(Date.now() - 8 * 24 * 36e5),
    });
    prismaMock.patient.findUnique.mockResolvedValue({
      userId: "u-1",
      user: { name: "Alice" },
    });

    const result = await runChronicCareReminders();
    expect(result).toEqual({ sent: 1, errors: 0 });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock.mock.calls[0][0]).toMatchObject({
      userId: "u-1",
      title: "Check-in reminder",
      data: { chronicCarePlanId: "plan-1", condition: "DIABETES" },
    });
    expect(sendNotificationMock.mock.calls[0][0].message).toContain("Alice");
    expect(sendNotificationMock.mock.calls[0][0].message).toContain("diabetes");
  });

  it("falls back to 'there' when patient.user.name is missing", async () => {
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      {
        id: "plan-1",
        patientId: "p-1",
        condition: "HYPERTENSION",
        checkInFrequencyDays: 7,
      },
    ]);
    prismaMock.chronicCareCheckIn.findFirst.mockResolvedValue(null);
    prismaMock.patient.findUnique.mockResolvedValue({
      userId: "u-1",
      user: null,
    });
    await runChronicCareReminders();
    expect(sendNotificationMock.mock.calls[0][0].message).toContain("Hi there");
  });
});

describe("runChronicCareReminders — skips", () => {
  it("skips plans whose check-in is not yet due", async () => {
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      {
        id: "plan-1",
        patientId: "p-1",
        condition: "DIABETES",
        checkInFrequencyDays: 7,
      },
    ]);
    // Last check-in 1 hour ago — well within the 7-day window.
    prismaMock.chronicCareCheckIn.findFirst.mockResolvedValue({
      loggedAt: new Date(Date.now() - 36e5),
    });
    const result = await runChronicCareReminders();
    expect(result).toEqual({ sent: 0, errors: 0 });
    expect(prismaMock.patient.findUnique).not.toHaveBeenCalled();
  });

  it("skips plans whose patient has no userId", async () => {
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      {
        id: "plan-1",
        patientId: "p-1",
        condition: "DIABETES",
        checkInFrequencyDays: 7,
      },
    ]);
    prismaMock.chronicCareCheckIn.findFirst.mockResolvedValue(null);
    prismaMock.patient.findUnique.mockResolvedValue({ userId: null, user: null });
    const result = await runChronicCareReminders();
    expect(result).toEqual({ sent: 0, errors: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("returns zero counts when there are no active plans", async () => {
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([]);
    const result = await runChronicCareReminders();
    expect(result).toEqual({ sent: 0, errors: 0 });
  });
});

describe("runChronicCareReminders — error isolation", () => {
  it("counts errors per failing plan but keeps processing the rest", async () => {
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      { id: "p1", patientId: "p-1", condition: "DIABETES", checkInFrequencyDays: 7 },
      { id: "p2", patientId: "p-2", condition: "HYPERTENSION", checkInFrequencyDays: 7 },
    ]);
    prismaMock.chronicCareCheckIn.findFirst
      .mockRejectedValueOnce(new Error("db fault"))
      .mockResolvedValueOnce(null);
    prismaMock.patient.findUnique.mockResolvedValue({
      userId: "u-2",
      user: { name: "Bob" },
    });
    const result = await runChronicCareReminders();
    expect(result).toEqual({ sent: 1, errors: 1 });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });
});
