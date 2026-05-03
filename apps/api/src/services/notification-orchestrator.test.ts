// Multi-channel orchestration tests for sendNotification.
//
// notification.test.ts covers the preferences gate (issue #180). This file
// covers the rest of the dispatcher's contract that the existing suite
// stops short of:
//
//   - Best-effort fanout: a single channel adapter failure does NOT
//     prevent the other channels from being attempted; each channel
//     gets its own deliveryStatus row reflecting the per-channel
//     outcome.
//   - sendWithRetry: a transient first-call failure followed by a second
//     success records SENT (single retry, then give up).
//   - Quiet-hours defer: when the user is currently in quiet hours,
//     all rows are created with deliveryStatus QUEUED + scheduledFor
//     set, and NO channel adapter is invoked.
//   - DND defer: dndUntil > now produces the same defer behaviour.
//   - PUSH adapter integration: looks up the user's pushToken and
//     forwards the [token] array to sendPush.
//   - User-not-found: the dispatcher logs and returns without creating
//     any notification rows.
//
// Honorable mention #14 from the 2026-05-03 test gaps audit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NotificationChannel, NotificationType } from "@medcore/shared";

const { prismaMock, sendWhatsAppMock, sendSMSMock, sendEmailMock, sendPushMock } =
  vi.hoisted(() => ({
    prismaMock: {
      user: { findUnique: vi.fn() },
      notificationPreference: { findMany: vi.fn() },
      notificationSchedule: { findUnique: vi.fn() },
      notification: {
        create: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
    } as any,
    sendWhatsAppMock: vi.fn(),
    sendSMSMock: vi.fn(),
    sendEmailMock: vi.fn(),
    sendPushMock: vi.fn(),
  }));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("./channels/whatsapp", () => ({ sendWhatsApp: sendWhatsAppMock }));
vi.mock("./channels/sms", () => ({ sendSMS: sendSMSMock }));
vi.mock("./channels/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("./channels/push", () => ({ sendPush: sendPushMock }));

import { sendNotification } from "./notification";

function resetMocks() {
  prismaMock.user.findUnique.mockReset();
  prismaMock.notificationPreference.findMany.mockReset();
  prismaMock.notificationSchedule.findUnique.mockReset();
  prismaMock.notification.create.mockReset();
  prismaMock.notification.update.mockReset();
  sendWhatsAppMock.mockReset();
  sendSMSMock.mockReset();
  sendEmailMock.mockReset();
  sendPushMock.mockReset();

  prismaMock.user.findUnique.mockResolvedValue({
    id: "u1",
    email: "u1@example.com",
    phone: "+911111111111",
    name: "Test User",
  });
  prismaMock.notificationPreference.findMany.mockResolvedValue([]);
  prismaMock.notificationSchedule.findUnique.mockResolvedValue(null);
  prismaMock.notification.create.mockImplementation(async (args: any) => ({
    id: "n-" + args.data.channel,
    ...args.data,
  }));
  prismaMock.notification.update.mockResolvedValue({});
  // Default channel adapter behaviour: success.
  sendWhatsAppMock.mockResolvedValue({ ok: true, messageId: "wa-1" });
  sendSMSMock.mockResolvedValue({ ok: true, messageId: "sms-1" });
  sendEmailMock.mockResolvedValue({ ok: true, messageId: "em-1" });
  sendPushMock.mockResolvedValue({ ok: true, messageId: "ps-1" });
}

const baseParams = {
  userId: "u1",
  type: NotificationType.SCHEDULE_SUMMARY,
  title: "Hello",
  message: "World",
};

function updateCalls(): Array<{ id: string; status: string; reason?: string | null }> {
  return prismaMock.notification.update.mock.calls.map((c: any[]) => ({
    id: (c[0] as any).where.id as string,
    status: (c[0] as any).data.deliveryStatus as string,
    reason: (c[0] as any).data.failureReason ?? null,
  }));
}

describe("sendNotification — multi-channel orchestration (honorable mention #14)", () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("best-effort fanout: one channel failure does not block the other 3", async () => {
    // EMAIL fails on both attempts; the other 3 succeed. The dispatcher must
    // still attempt + record all 4 rows.
    sendEmailMock.mockResolvedValue({ ok: false, error: "smtp connect timeout" });

    vi.useFakeTimers();
    const promise = sendNotification(baseParams);
    // sendWithRetry sleeps 5s after first failure; advance through it.
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(prismaMock.notification.create).toHaveBeenCalledTimes(4);
    expect(sendEmailMock).toHaveBeenCalledTimes(2); // first + retry
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(sendSMSMock).toHaveBeenCalledTimes(1);
    expect(sendPushMock).toHaveBeenCalledTimes(1);

    const updates = updateCalls();
    const failed = updates.filter((u) => u.status === "FAILED");
    const sent = updates.filter((u) => u.status === "SENT");
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatch(/smtp connect timeout/);
    expect(sent).toHaveLength(3);
  });

  it("sendWithRetry: first attempt fails, retry succeeds → row marked SENT", async () => {
    sendSMSMock
      .mockResolvedValueOnce({ ok: false, error: "transient" })
      .mockResolvedValueOnce({ ok: true, messageId: "sms-retry-ok" });

    vi.useFakeTimers();
    const promise = sendNotification(baseParams);
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(sendSMSMock).toHaveBeenCalledTimes(2);
    const smsUpdate = updateCalls().find((u) => u.id === "n-" + NotificationChannel.SMS);
    expect(smsUpdate?.status).toBe("SENT");
    expect(smsUpdate?.reason).toBeNull();
  });

  it("a thrown channel-adapter error is caught: row marked FAILED with the error string, fanout continues", async () => {
    sendWhatsAppMock.mockRejectedValue(new Error("provider 503"));

    vi.useFakeTimers();
    const promise = sendNotification(baseParams);
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(prismaMock.notification.create).toHaveBeenCalledTimes(4);
    const waUpdate = updateCalls().find(
      (u) => u.id === "n-" + NotificationChannel.WHATSAPP
    );
    expect(waUpdate?.status).toBe("FAILED");
    expect(waUpdate?.reason).toMatch(/provider 503/);
    // Other channels still attempted + sent.
    expect(updateCalls().filter((u) => u.status === "SENT")).toHaveLength(3);
  });

  it("quiet-hours defer: no adapter is invoked, every row is QUEUED with scheduledFor set", async () => {
    // Pin "now" to 23:30 so the 22:00→07:00 overnight quiet window matches.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T18:00:00Z")); // 23:30 IST is 18:00 UTC; ops-helpers reads getHours() in local TZ — keep it simple by pinning local time directly.
    const localNow = new Date(2026, 5, 1, 23, 30, 0); // 23:30 local
    vi.setSystemTime(localNow);

    prismaMock.notificationSchedule.findUnique.mockResolvedValueOnce({
      userId: "u1",
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      dndUntil: null,
    });

    await sendNotification(baseParams);

    // All 4 rows created, all with scheduledFor set, none of the adapters
    // were invoked (the dispatcher continues past the channel send).
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(4);
    for (const call of prismaMock.notification.create.mock.calls) {
      const data = (call[0] as any).data;
      expect(data.deliveryStatus).toBe("QUEUED");
      expect(data.scheduledFor).toBeInstanceOf(Date);
      // scheduledFor is the next 07:00.
      expect(data.scheduledFor.getHours()).toBe(7);
    }
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
    expect(sendSMSMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(sendPushMock).not.toHaveBeenCalled();
    // No update either — rows stay QUEUED until the drainer picks them up.
    expect(prismaMock.notification.update).not.toHaveBeenCalled();
  });

  it("DND defer: dndUntil in the future short-circuits dispatch the same way as quiet hours", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000); // 1h from now
    prismaMock.notificationSchedule.findUnique.mockResolvedValueOnce({
      userId: "u1",
      quietHoursStart: null,
      quietHoursEnd: null,
      dndUntil: future,
    });

    await sendNotification(baseParams);

    expect(prismaMock.notification.create).toHaveBeenCalledTimes(4);
    for (const call of prismaMock.notification.create.mock.calls) {
      const data = (call[0] as any).data;
      expect(data.deliveryStatus).toBe("QUEUED");
      // scheduledFor is exactly the dndUntil instant.
      expect(data.scheduledFor.getTime()).toBe(future.getTime());
    }
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
    expect(sendSMSMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(sendPushMock).not.toHaveBeenCalled();
  });

  it("PUSH adapter: looks up the user's pushToken and forwards an array to sendPush", async () => {
    prismaMock.user.findUnique
      // First call inside sendNotification (basic user)
      .mockResolvedValueOnce({
        id: "u1",
        email: "u1@example.com",
        phone: "+911111111111",
        name: "Test User",
      })
      // Second call: PUSH adapter resolves the pushToken row.
      .mockResolvedValueOnce({ pushToken: "expo-push-token-abc" });
    // Disable the other 3 channels so we isolate PUSH cleanly.
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([
      { userId: "u1", channel: NotificationChannel.EMAIL, enabled: false },
      { userId: "u1", channel: NotificationChannel.SMS, enabled: false },
      { userId: "u1", channel: NotificationChannel.WHATSAPP, enabled: false },
    ]);

    await sendNotification(baseParams);

    expect(sendPushMock).toHaveBeenCalledTimes(1);
    const [tokens, title, message] = sendPushMock.mock.calls[0];
    expect(tokens).toEqual(["expo-push-token-abc"]);
    expect(title).toBe("Hello");
    expect(message).toBe("World");
  });

  it("user-not-found: returns silently with no rows created and no adapter calls", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendNotification({ ...baseParams, userId: "missing-user" });

    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(prismaMock.notificationPreference.findMany).not.toHaveBeenCalled();
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
    expect(sendSMSMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(sendPushMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/User not found.*missing-user/)
    );
    warnSpy.mockRestore();
  });
});
