/**
 * Unit tests for the adherence scheduler. Covers:
 *   - `deriveReminderType` — pure mapping from hour-of-day to reminder slot.
 *   - `runAdherenceReminders` — happy-path send, no-due-meds skip, missing
 *     patient skip, error tolerance (one schedule failure does not abort the
 *     run), counter increment on `AdherenceSchedule`.
 *
 * `prisma`, `getMedicationsDueNow`, `generateReminderMessage`, and
 * `sendNotification` are all mocked so the tests run with no DB or LLM.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  prismaMock,
  getMedicationsDueNowMock,
  generateReminderMessageMock,
  sendNotificationMock,
} = vi.hoisted(() => {
  return {
    prismaMock: {
      adherenceSchedule: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
      patient: {
        findUnique: vi.fn(),
      },
    },
    getMedicationsDueNowMock: vi.fn(),
    generateReminderMessageMock: vi.fn(),
    sendNotificationMock: vi.fn(),
  };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("./ai/adherence-bot", () => ({
  getMedicationsDueNow: getMedicationsDueNowMock,
  generateReminderMessage: generateReminderMessageMock,
}));
vi.mock("./notification", () => ({ sendNotification: sendNotificationMock }));

import {
  deriveReminderType,
  runAdherenceReminders,
} from "./adherence-scheduler";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  prismaMock.adherenceSchedule.update.mockResolvedValue({});
  generateReminderMessageMock.mockResolvedValue("Time for your medication");
  sendNotificationMock.mockResolvedValue(undefined);
});

describe("deriveReminderType", () => {
  it("returns 'morning' for hours 5-11", () => {
    expect(deriveReminderType(5)).toBe("morning");
    expect(deriveReminderType(11)).toBe("morning");
  });

  it("returns 'afternoon' for hours 12-16", () => {
    expect(deriveReminderType(12)).toBe("afternoon");
    expect(deriveReminderType(16)).toBe("afternoon");
  });

  it("returns 'evening' for hours 17-20", () => {
    expect(deriveReminderType(17)).toBe("evening");
    expect(deriveReminderType(20)).toBe("evening");
  });

  it("returns 'night' for hours 21-23 and 0-4", () => {
    expect(deriveReminderType(0)).toBe("night");
    expect(deriveReminderType(4)).toBe("night");
    expect(deriveReminderType(21)).toBe("night");
    expect(deriveReminderType(23)).toBe("night");
  });

  it("uses the current hour by default", () => {
    // We cannot assert a specific bucket without freezing time, but we can
    // confirm the function returns a known label.
    expect(["morning", "afternoon", "evening", "night"]).toContain(
      deriveReminderType(),
    );
  });
});

describe("runAdherenceReminders — happy path", () => {
  function setupOneActiveSchedule() {
    prismaMock.adherenceSchedule.findMany.mockResolvedValue([
      {
        id: "sched-1",
        patientId: "p-1",
        medications: [{ name: "Metformin", dosage: "500mg", frequency: "BID", reminderTimes: ["08:00"] }],
        remindersSent: 3,
      },
    ]);
    getMedicationsDueNowMock.mockReturnValue([
      { name: "Metformin", dosage: "500mg", frequency: "BID" },
    ]);
    prismaMock.patient.findUnique.mockResolvedValue({
      userId: "u-1",
      preferredLanguage: "en",
      user: { name: "Alice" },
    });
  }

  it("sends one notification per due-now schedule and bumps the counter", async () => {
    setupOneActiveSchedule();
    const result = await runAdherenceReminders();
    expect(result).toEqual({ sent: 1, errors: 0 });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock.mock.calls[0][0]).toMatchObject({
      userId: "u-1",
      title: "Medication Reminder",
      data: { scheduleId: "sched-1" },
    });
    expect(prismaMock.adherenceSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sched-1" },
        data: expect.objectContaining({ remindersSent: 4 }),
      }),
    );
  });

  it("uses Hindi for patients with preferredLanguage='hi'", async () => {
    setupOneActiveSchedule();
    prismaMock.patient.findUnique.mockResolvedValue({
      userId: "u-1",
      preferredLanguage: "hi",
      user: { name: "Alice" },
    });
    await runAdherenceReminders();
    expect(generateReminderMessageMock.mock.calls[0][0].language).toBe("hi");
  });

  it("falls back to English for any non-'hi' language code", async () => {
    setupOneActiveSchedule();
    prismaMock.patient.findUnique.mockResolvedValue({
      userId: "u-1",
      preferredLanguage: "ta",
      user: { name: "Alice" },
    });
    await runAdherenceReminders();
    expect(generateReminderMessageMock.mock.calls[0][0].language).toBe("en");
  });
});

describe("runAdherenceReminders — skips", () => {
  it("skips schedule when no medications are due", async () => {
    prismaMock.adherenceSchedule.findMany.mockResolvedValue([
      { id: "s-1", patientId: "p-1", medications: [], remindersSent: 0 },
    ]);
    getMedicationsDueNowMock.mockReturnValue([]);
    const result = await runAdherenceReminders();
    expect(result).toEqual({ sent: 0, errors: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(prismaMock.patient.findUnique).not.toHaveBeenCalled();
  });

  it("skips schedule when patient is missing", async () => {
    prismaMock.adherenceSchedule.findMany.mockResolvedValue([
      { id: "s-1", patientId: "p-missing", medications: [], remindersSent: 0 },
    ]);
    getMedicationsDueNowMock.mockReturnValue([{ name: "X", dosage: "1", frequency: "QD" }]);
    prismaMock.patient.findUnique.mockResolvedValue(null);
    const result = await runAdherenceReminders();
    expect(result).toEqual({ sent: 0, errors: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("skips schedule when patient has no userId (anonymous patient)", async () => {
    prismaMock.adherenceSchedule.findMany.mockResolvedValue([
      { id: "s-1", patientId: "p-1", medications: [], remindersSent: 0 },
    ]);
    getMedicationsDueNowMock.mockReturnValue([{ name: "X", dosage: "1", frequency: "QD" }]);
    prismaMock.patient.findUnique.mockResolvedValue({
      userId: null,
      preferredLanguage: "en",
      user: { name: "Alice" },
    });
    const result = await runAdherenceReminders();
    expect(result).toEqual({ sent: 0, errors: 0 });
  });

  it("returns zero counts when there are no active schedules at all", async () => {
    prismaMock.adherenceSchedule.findMany.mockResolvedValue([]);
    const result = await runAdherenceReminders();
    expect(result).toEqual({ sent: 0, errors: 0 });
    expect(getMedicationsDueNowMock).not.toHaveBeenCalled();
  });
});

describe("runAdherenceReminders — error isolation", () => {
  it("counts an error on one schedule but continues processing the rest", async () => {
    prismaMock.adherenceSchedule.findMany.mockResolvedValue([
      { id: "s-bad", patientId: "p-1", medications: [], remindersSent: 0 },
      { id: "s-good", patientId: "p-2", medications: [], remindersSent: 5 },
    ]);
    getMedicationsDueNowMock.mockReturnValue([
      { name: "Med", dosage: "1", frequency: "QD" },
    ]);
    prismaMock.patient.findUnique
      .mockRejectedValueOnce(new Error("db fault"))
      .mockResolvedValueOnce({
        userId: "u-2",
        preferredLanguage: "en",
        user: { name: "Bob" },
      });

    const result = await runAdherenceReminders();
    expect(result).toEqual({ sent: 1, errors: 1 });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });
});
