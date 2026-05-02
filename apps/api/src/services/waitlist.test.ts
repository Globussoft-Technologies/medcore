/**
 * Unit tests for `notifyNextInWaitlist`. Hits four cases:
 *   - WAITING entry exists → entry advances to NOTIFIED + notification sent
 *     to the patient with doctor + waitlistEntryId in the data payload.
 *   - No WAITING entry → no-op (no update, no notification).
 *   - Notification ordering — DB transition happens BEFORE the notification
 *     fires so that a duplicate-fire on retry skips the already-notified
 *     entry.
 *   - Patient-side data shape — message includes patient name and doctor name.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, sendNotificationMock } = vi.hoisted(() => ({
  prismaMock: {
    waitlistEntry: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
  sendNotificationMock: vi.fn(),
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("./notification", () => ({ sendNotification: sendNotificationMock }));

import { notifyNextInWaitlist } from "./waitlist";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.waitlistEntry.update.mockResolvedValue({});
  sendNotificationMock.mockResolvedValue(undefined);
});

describe("notifyNextInWaitlist — happy path", () => {
  it("transitions WAITING → NOTIFIED and sends a notification to the patient", async () => {
    prismaMock.waitlistEntry.findFirst.mockResolvedValue({
      id: "wl-1",
      doctorId: "d-1",
      patient: { user: { id: "u-patient", name: "Alice" } },
      doctor: { user: { name: "Bose" } },
    });

    await notifyNextInWaitlist("d-1");

    expect(prismaMock.waitlistEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { doctorId: "d-1", status: "WAITING" },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(prismaMock.waitlistEntry.update).toHaveBeenCalledWith({
      where: { id: "wl-1" },
      data: expect.objectContaining({
        status: "NOTIFIED",
        notifiedAt: expect.any(Date),
      }),
    });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock.mock.calls[0][0]).toMatchObject({
      userId: "u-patient",
      title: "A slot has opened up",
      data: { waitlistEntryId: "wl-1", doctorId: "d-1" },
    });
    expect(sendNotificationMock.mock.calls[0][0].message).toContain("Alice");
    expect(sendNotificationMock.mock.calls[0][0].message).toContain("Bose");
  });

  it("orders persistence BEFORE notification (so duplicate fires are de-duped)", async () => {
    prismaMock.waitlistEntry.findFirst.mockResolvedValue({
      id: "wl-1",
      doctorId: "d-1",
      patient: { user: { id: "u-patient", name: "Alice" } },
      doctor: { user: { name: "Bose" } },
    });
    const order: string[] = [];
    prismaMock.waitlistEntry.update.mockImplementation(async () => {
      order.push("update");
      return {};
    });
    sendNotificationMock.mockImplementation(async () => {
      order.push("notify");
    });

    await notifyNextInWaitlist("d-1");
    expect(order).toEqual(["update", "notify"]);
  });
});

describe("notifyNextInWaitlist — empty queue", () => {
  it("does nothing when there is no WAITING entry", async () => {
    prismaMock.waitlistEntry.findFirst.mockResolvedValue(null);
    await notifyNextInWaitlist("d-1");
    expect(prismaMock.waitlistEntry.update).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});
