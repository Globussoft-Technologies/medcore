// Unit tests for the notification dispatcher (issue #180).
//
// Verifies that `sendNotification` honours per-user NotificationPreference
// rows: an explicitly-disabled channel must not produce a `notifications`
// row, an enabled (or absent) channel must, and the `bypassPreferences`
// flag overrides everything for safety-critical paths.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationChannel, NotificationType } from "@medcore/shared";
import { NotificationType as PrismaNotificationType } from "@prisma/client";

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
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
  },
}));

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));

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
    role: "PATIENT",
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

// ─────────────────────────────────────────────────────────────────
// Issue #759 — patient-copy notification types must NEVER reach a
// non-PATIENT inbox. The seed code was already audience-tagged by
// #272, but a runtime sendNotification() call with a patient-only
// type and a staff userId is a routing bug. The dispatcher rejects
// the send (no row, no channel dispatch) and emits an audit row.
// ─────────────────────────────────────────────────────────────────
describe("sendNotification — patient-copy audience guard (issue #759)", () => {
  beforeEach(() => {
    resetMocks();
    prismaMock.auditLog.create.mockReset();
    prismaMock.auditLog.create.mockResolvedValue({ id: "al-1" });
  });

  it("rejects DISCHARGE notifications addressed to a RECEPTION user", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "u-reception",
      email: "rec@test.local",
      phone: "+910000000000",
      name: "Reception Staff",
      role: "RECEPTION",
    });

    await sendNotification({
      userId: "u-reception",
      type: PrismaNotificationType.DISCHARGE as any,
      title: "Discharge Summary",
      message: "Your discharge has been processed. Summary available in the app.",
    });

    // Critical assertion: zero notification rows written for a misrouted
    // patient-copy send.
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    // And we don't even read the user's channel preferences when the
    // audience gate fails — short-circuit before the prefs lookup.
    expect(prismaMock.notificationPreference.findMany).not.toHaveBeenCalled();

    // An audit row must be emitted so ops can find the offending caller.
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = (prismaMock.auditLog.create.mock.calls[0] as any[])[0];
    expect(auditArgs.data.action).toBe("NOTIFICATION_AUDIENCE_REJECTED");
    expect(auditArgs.data.entity).toBe("notification");
    expect(auditArgs.data.entityId).toBe("u-reception");
    expect(auditArgs.data.details.recipientRole).toBe("RECEPTION");
    expect(auditArgs.data.details.type).toBe(PrismaNotificationType.DISCHARGE);
  });

  it("rejects PRESCRIPTION_READY addressed to a DOCTOR user", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "u-doctor",
      email: "doc@test.local",
      phone: "+910000000001",
      name: "Dr. Test",
      role: "DOCTOR",
    });

    await sendNotification({
      userId: "u-doctor",
      type: PrismaNotificationType.PRESCRIPTION_READY as any,
      title: "Prescription Ready",
      message: "Your prescription is ready.",
    });

    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("ALLOWS DISCHARGE notifications addressed to a PATIENT user (the happy path)", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "u-patient",
      email: "pat@test.local",
      phone: "+910000000002",
      name: "Test Patient",
      role: "PATIENT",
    });
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([]);

    await sendNotification({
      userId: "u-patient",
      type: PrismaNotificationType.DISCHARGE as any,
      title: "Discharge Summary",
      message: "Your discharge has been processed.",
    });

    // 4 channel rows written — same as a normal patient-copy send.
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(4);
    // No audience-rejected audit row.
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("ALLOWS staff-targeted types (e.g. SCHEDULE_SUMMARY) to reach a non-PATIENT user", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "u-doctor-2",
      email: "doc2@test.local",
      phone: "+910000000003",
      name: "Dr. Test 2",
      role: "DOCTOR",
    });
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([]);

    await sendNotification({
      userId: "u-doctor-2",
      type: NotificationType.SCHEDULE_SUMMARY,
      title: "Your schedule",
      message: "You have 5 appointments today.",
    });

    expect(prismaMock.notification.create).toHaveBeenCalledTimes(4);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// Issue #891 — User.email is now nullable. When a walk-in patient
// was registered without an email, the row's email is `null` and
// the EMAIL channel must skip cleanly — no placeholder fabricated,
// no provider call, and the notification row ends up FAILED with a
// human-readable failureReason so the failure surfaces in the ops
// dashboard. The other 3 channels (PUSH/SMS/WHATSAPP) still fire
// because the user has a phone on file.
// ─────────────────────────────────────────────────────────────────
describe("sendNotification — EMAIL channel skip when User.email is null (issue #891)", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("skips the EMAIL dispatch (no provider call) and writes a FAILED row when user.email is null", async () => {
    // Walk-in patient registered without an email — schema is now
    // `email String?`, so the row has email: null.
    prismaMock.user.findUnique.mockReset();
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u-walkin",
      email: null,
      phone: "+919000000099",
      name: "Walk-in Patient",
      role: "PATIENT",
    });
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([]);

    const emailMod = await import("./channels/email");
    (emailMod.sendEmail as any).mockClear();

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await sendNotification(baseParams);

    // Rows created for ALL 4 channels — the EMAIL row exists, it just
    // gets marked FAILED rather than not written at all (so ops can
    // see the missing-email gap in /dashboard/notifications).
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(4);

    // CRITICAL: the email provider was NEVER called with null/empty.
    expect(emailMod.sendEmail).not.toHaveBeenCalled();

    // The EMAIL row should have been UPDATEd to FAILED with the
    // human-readable reason. Find it among the update calls.
    const failedUpdates = prismaMock.notification.update.mock.calls.filter(
      (c: any[]) => (c[0] as any).data?.failureReason === "User has no email on file"
    );
    expect(failedUpdates.length).toBeGreaterThanOrEqual(1);
    expect((failedUpdates[0][0] as any).data.deliveryStatus).toBe("FAILED");

    // Structured ops line emitted so dashboards can count the gap.
    const skipCalls = infoSpy.mock.calls.filter(
      (c) => String(c[0]) === "notification_email_skipped_no_address"
    );
    expect(skipCalls.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(String(skipCalls[0][1]));
    expect(payload).toMatchObject({
      userId: "u-walkin",
      reason: "user_has_no_email",
    });

    infoSpy.mockRestore();
  });

  it("still dispatches PUSH/SMS/WHATSAPP for a null-email user (other channels unaffected)", async () => {
    prismaMock.user.findUnique.mockReset();
    prismaMock.user.findUnique.mockResolvedValue({
      id: "u-walkin-2",
      email: null,
      phone: "+919000000088",
      name: "Walk-in 2",
      role: "PATIENT",
    });
    prismaMock.notificationPreference.findMany.mockResolvedValueOnce([]);

    const whatsappMod = await import("./channels/whatsapp");
    const smsMod = await import("./channels/sms");
    (whatsappMod.sendWhatsApp as any).mockClear();
    (smsMod.sendSMS as any).mockClear();

    await sendNotification(baseParams);

    // The non-EMAIL providers were invoked with the user's phone.
    expect(whatsappMod.sendWhatsApp).toHaveBeenCalled();
    expect(smsMod.sendSMS).toHaveBeenCalled();
  });
});
