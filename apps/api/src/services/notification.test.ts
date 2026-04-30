// Unit tests for the notification dispatcher (issue #180).
//
// Verifies that `sendNotification` honours per-user NotificationPreference
// rows: an explicitly-disabled channel must not produce a `notifications`
// row, an enabled (or absent) channel must, and the `bypassPreferences`
// flag overrides everything for safety-critical paths.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationChannel, NotificationType } from "@medcore/shared";

const { prismaMock } = vi.hoisted(() => ({
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
  },
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

// Channel adapters are stubbed at the module level so the dispatcher's
// `sendOnce` switch can resolve without hitting any real provider.
vi.mock("./channels/whatsapp", () => ({ sendWhatsApp: vi.fn(async () => ({ ok: true, messageId: "wa-1" })) }));
vi.mock("./channels/sms", () => ({ sendSMS: vi.fn(async () => ({ ok: true, messageId: "sms-1" })) }));
vi.mock("./channels/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: "em-1" })) }));
vi.mock("./channels/push", () => ({ sendPush: vi.fn(async () => ({ ok: true, messageId: "ps-1" })) }));

import { sendNotification } from "./notification";

function resetMocks() {
  prismaMock.user.findUnique.mockReset();
  prismaMock.notificationPreference.findMany.mockReset();
  prismaMock.notificationSchedule.findUnique.mockReset();
  prismaMock.notification.create.mockReset();
  prismaMock.notification.update.mockReset();

  // Sensible defaults for every test
  prismaMock.user.findUnique.mockResolvedValue({
    id: "u1",
    email: "u1@example.com",
    phone: "+911111111111",
    name: "Test User",
  });
  prismaMock.notificationSchedule.findUnique.mockResolvedValue(null);
  prismaMock.notification.create.mockImplementation(async (args: any) => ({
    id: "n-" + args.data.channel,
    ...args.data,
  }));
  prismaMock.notification.update.mockResolvedValue({});
}

const baseParams = {
  userId: "u1",
  type: NotificationType.SCHEDULE_SUMMARY,
  title: "Hello",
  message: "World",
};

function channelsCreated(): string[] {
  return prismaMock.notification.create.mock.calls.map(
    (c: any[]) => (c[0] as any).data.channel as string
  );
}

describe("sendNotification — channel preferences (issue #180)", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("creates rows on all 4 channels when the user has no preferences", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([]);

    await sendNotification(baseParams);

    expect(prismaMock.notification.create).toHaveBeenCalledTimes(4);
    expect(channelsCreated().sort()).toEqual(
      [
        NotificationChannel.EMAIL,
        NotificationChannel.PUSH,
        NotificationChannel.SMS,
        NotificationChannel.WHATSAPP,
      ].sort()
    );
  });

  it("skips a channel that is explicitly disabled (email:false) and keeps the other 3", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([
      { userId: "u1", channel: NotificationChannel.EMAIL, enabled: false },
    ]);

    await sendNotification(baseParams);

    const created = channelsCreated();
    expect(created).toHaveLength(3);
    expect(created).not.toContain(NotificationChannel.EMAIL);
    expect(created).toContain(NotificationChannel.PUSH);
    expect(created).toContain(NotificationChannel.SMS);
    expect(created).toContain(NotificationChannel.WHATSAPP);
  });

  it("treats channels with no preference row as enabled (partial prefs)", async () => {
    // User saved only WHATSAPP=false; the other 3 have no row at all and
    // should default to enabled.
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([
      { userId: "u1", channel: NotificationChannel.WHATSAPP, enabled: false },
    ]);

    await sendNotification(baseParams);

    const created = channelsCreated();
    expect(created).toHaveLength(3);
    expect(created).not.toContain(NotificationChannel.WHATSAPP);
  });

  it("logs notification_channel_skipped { reason: 'pref_off' } for each muted channel", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([
      { userId: "u1", channel: NotificationChannel.SMS, enabled: false },
    ]);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await sendNotification(baseParams);

    const skipCalls = infoSpy.mock.calls.filter(
      (c) => String(c[0]) === "notification_channel_skipped"
    );
    expect(skipCalls).toHaveLength(1);
    const payload = JSON.parse(String(skipCalls[0][1]));
    expect(payload).toMatchObject({
      userId: "u1",
      channel: NotificationChannel.SMS,
      reason: "pref_off",
    });
    infoSpy.mockRestore();
  });

  it("bypassPreferences=true delivers on all 4 channels even when prefs disable some", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([
      { userId: "u1", channel: NotificationChannel.EMAIL, enabled: false },
      { userId: "u1", channel: NotificationChannel.SMS, enabled: false },
    ]);

    await sendNotification({ ...baseParams, bypassPreferences: true });

    expect(prismaMock.notification.create).toHaveBeenCalledTimes(4);
    // And — critical — the dispatcher must not even bother reading prefs in
    // bypass mode (avoids a needless DB round-trip on the safety path).
    expect(prismaMock.notificationPreference.findMany).not.toHaveBeenCalled();
  });

  it("still creates 4 rows when user has all channels explicitly enabled", async () => {
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([
      { userId: "u1", channel: NotificationChannel.EMAIL, enabled: true },
      { userId: "u1", channel: NotificationChannel.PUSH, enabled: true },
      { userId: "u1", channel: NotificationChannel.SMS, enabled: true },
      { userId: "u1", channel: NotificationChannel.WHATSAPP, enabled: true },
    ]);

    await sendNotification(baseParams);

    expect(prismaMock.notification.create).toHaveBeenCalledTimes(4);
  });
});
