import { prisma } from "@medcore/db";
import {
  NotificationType as PrismaNotificationType,
  Role as PrismaRole,
} from "@prisma/client";
import { NotificationType, NotificationChannel } from "@medcore/shared";
import { sendWhatsApp } from "./channels/whatsapp";
import { sendSMS } from "./channels/sms";
import { sendEmail } from "./channels/email";
import { sendPush } from "./channels/push";
import type { ChannelResult } from "./channels/whatsapp";
import { isWithinQuietHours } from "./ops-helpers";

// Re-export channel senders so existing call sites keep working.
export { sendWhatsApp, sendSMS, sendEmail, sendPush };

// Issue #759 — patient-copy notification types must NEVER land in a
// non-PATIENT inbox. The seed code was tagged with audience scoping by
// #272, but a runtime caller can still construct a sendNotification({
// userId: <a staff userId>, type: NotificationType.DISCHARGE }) call —
// nothing in the type system stops it. This set is the runtime guard:
// if a caller targets one of these types AND the recipient User.role
// is anything other than PATIENT, we drop the send and emit an audit
// row so ops can investigate. Keep this list in sync with
// apps/api/src/test/integration/notification-audience-272.test.ts.
//
// Source-of-truth is the Prisma enum (`@prisma/client`); the
// `@medcore/shared` enum is a narrower subset that pre-dates the
// admission/discharge work.
const PATIENT_ONLY_NOTIFICATION_TYPES = new Set<string>([
  PrismaNotificationType.DISCHARGE,
  PrismaNotificationType.ADMISSION,
  PrismaNotificationType.PRESCRIPTION_READY,
  PrismaNotificationType.BILL_GENERATED,
  PrismaNotificationType.PAYMENT_RECEIVED,
  PrismaNotificationType.LAB_RESULT_READY,
  PrismaNotificationType.MEDICATION_DUE,
  PrismaNotificationType.APPOINTMENT_BOOKED,
  PrismaNotificationType.APPOINTMENT_REMINDER,
  PrismaNotificationType.APPOINTMENT_CANCELLED,
  PrismaNotificationType.TOKEN_CALLED,
]);

interface SendNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  /**
   * When true, deliver on every channel regardless of the user's
   * NotificationPreference rows. Reserved for safety-critical paths
   * (e.g. CRITICAL lab values, drug-interaction alerts) where we
   * cannot let a muted channel silence the alert. Defaults to false.
   */
  bypassPreferences?: boolean;
}

const RETRY_DELAY_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatchToChannel(
  channel: NotificationChannel,
  user: { id: string; email: string | null; phone: string }
): Promise<ChannelResult> {
  // Note: text is supplied to channel from the caller via closure (see below)
  // — kept here for typing only; real call site below.
  void channel;
  void user;
  return { ok: false, error: "not implemented" };
}
void dispatchToChannel;

async function sendOnce(
  channel: NotificationChannel,
  user: { id: string; email: string | null; phone: string },
  title: string,
  message: string
): Promise<ChannelResult> {
  switch (channel) {
    case NotificationChannel.WHATSAPP:
      return sendWhatsApp(user.phone, message);
    case NotificationChannel.SMS:
      return sendSMS(user.phone, message);
    case NotificationChannel.EMAIL:
      // #891: a User with no email on file (schema is `email String?`)
      // cannot receive the EMAIL channel. Skip cleanly and record a
      // structured ops line so dashboards can count the gap; do NOT
      // mint a placeholder or pass an empty string through to the
      // provider (which would either bounce or, worse, be silently
      // accepted by some transports). The notification row is still
      // written by the caller and ends up in FAILED state with this
      // error string — surfaces correctly in /dashboard/notifications.
      if (!user.email) {
        console.info(
          "notification_email_skipped_no_address",
          JSON.stringify({ userId: user.id, reason: "user_has_no_email" })
        );
        return { ok: false, error: "User has no email on file" };
      }
      return sendEmail(user.email, title, message);
    case NotificationChannel.PUSH: {
      const pushUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { pushToken: true },
      });
      const tokens = pushUser?.pushToken ? [pushUser.pushToken] : [];
      return sendPush(tokens, title, message);
    }
    default:
      return { ok: false, error: "unknown channel" };
  }
}

async function sendWithRetry(
  channel: NotificationChannel,
  user: { id: string; email: string | null; phone: string },
  title: string,
  message: string
): Promise<ChannelResult> {
  const first = await sendOnce(channel, user, title, message);
  if (first.ok) return first;
  await delay(RETRY_DELAY_MS);
  const second = await sendOnce(channel, user, title, message);
  return second;
}

/**
 * Compute scheduledFor based on user's NotificationSchedule. Returns null if
 * the notification can be sent immediately, or a future Date when the user is
 * currently in quiet hours / DND.
 */
async function computeScheduledFor(userId: string): Promise<Date | null> {
  const sched = await prisma.notificationSchedule.findUnique({ where: { userId } });
  if (!sched) return null;
  const now = new Date();

  if (sched.dndUntil && sched.dndUntil > now) return sched.dndUntil;

  if (
    sched.quietHoursStart &&
    sched.quietHoursEnd &&
    isWithinQuietHours(now, sched.quietHoursStart, sched.quietHoursEnd)
  ) {
    const [h, m] = sched.quietHoursEnd.split(":").map((n) => parseInt(n, 10));
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  return null;
}

export async function sendNotification(params: SendNotificationParams): Promise<void> {
  const { userId, type, title, message, data, bypassPreferences = false } = params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, phone: true, name: true, role: true },
  });
  if (!user) {
    console.warn(`[Notification] User not found: ${userId}`);
    return;
  }

  // Issue #759: hard-reject patient-copy notification types when the
  // recipient's role is not PATIENT. The seed templates were already
  // tagged audience=[PATIENT] by #272, but a stray runtime caller can
  // still pass a staff userId — this is the defense-in-depth gate so
  // the routing bug can't re-surface. Drop the send (no row written,
  // no channel dispatch) and emit an audit row so ops can find the
  // offending caller.
  if (
    PATIENT_ONLY_NOTIFICATION_TYPES.has(type as unknown as string) &&
    user.role !== PrismaRole.PATIENT
  ) {
    console.warn(
      "[Notification] Patient-copy notification rejected — wrong recipient role",
      JSON.stringify({ userId, role: user.role, type })
    );
    try {
      await prisma.auditLog.create({
        data: {
          action: "NOTIFICATION_AUDIENCE_REJECTED",
          entity: "notification",
          entityId: userId,
          details: {
            severity: "WARNING",
            recipientUserId: userId,
            recipientRole: user.role,
            type,
            title,
            reason: "patient-copy notification type targeted at non-PATIENT recipient",
          } as any,
        } as any,
      });
    } catch (auditErr) {
      console.error("[Notification] failed to write audit row for rejected send", auditErr);
    }
    return;
  }

  // Compute the channel set. Default behaviour: a channel is enabled unless
  // the user has an explicit NotificationPreference row with enabled=false
  // for it. This means:
  //   - User has no rows at all  →  all 4 channels (preserve legacy default).
  //   - User saved {EMAIL:false} only  →  PUSH/SMS/WHATSAPP still fire,
  //     EMAIL is suppressed (issue #180).
  //   - bypassPreferences=true  →  every channel fires regardless of rows
  //     (safety-critical path).
  const allChannels = Object.values(NotificationChannel) as NotificationChannel[];
  let enabledChannels: NotificationChannel[];
  if (bypassPreferences) {
    enabledChannels = allChannels;
  } else {
    const preferences = await prisma.notificationPreference.findMany({ where: { userId } });
    const explicitlyDisabled = new Set<NotificationChannel>(
      preferences.filter((p) => !p.enabled).map((p) => p.channel as NotificationChannel)
    );
    enabledChannels = allChannels.filter((ch) => {
      if (!explicitlyDisabled.has(ch)) return true;
      // Structured audit line so ops can verify the gate is working.
      console.info(
        "notification_channel_skipped",
        JSON.stringify({ userId, channel: ch, reason: "pref_off", type })
      );
      return false;
    });
  }

  const scheduledFor = await computeScheduledFor(userId);

  for (const channel of enabledChannels) {
    // Always create the row first so we have a notification id to track.
    const row = await prisma.notification.create({
      data: {
        userId,
        type: type as any,
        channel: channel as any,
        title,
        message,
        data: (data as any) ?? undefined,
        deliveryStatus: scheduledFor ? "QUEUED" : "QUEUED",
        scheduledFor,
      },
    });

    if (scheduledFor) {
      // Defer until the scheduled time — the queue runner will dispatch later.
      continue;
    }

    try {
      const result = await sendWithRetry(channel, user, title, message);
      if (result.ok) {
        await prisma.notification.update({
          where: { id: row.id },
          data: {
            deliveryStatus: "SENT",
            sentAt: new Date(),
            failureReason: null,
          },
        });
      } else {
        await prisma.notification.update({
          where: { id: row.id },
          data: {
            deliveryStatus: "FAILED",
            failureReason: result.error || "Unknown error",
          },
        });
      }
    } catch (err) {
      console.error(`[Notification] dispatch failed via ${channel}:`, err);
      await prisma.notification
        .update({
          where: { id: row.id },
          data: { deliveryStatus: "FAILED", failureReason: String(err) },
        })
        .catch(console.error);
    }
  }
}

/**
 * Retry a previously FAILED notification (admin/manual trigger).
 */
export async function retryNotification(notificationId: string): Promise<ChannelResult> {
  const n = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!n) return { ok: false, error: "Notification not found" };
  const user = await prisma.user.findUnique({
    where: { id: n.userId },
    select: { id: true, email: true, phone: true },
  });
  if (!user) return { ok: false, error: "User not found" };

  const result = await sendWithRetry(
    n.channel as NotificationChannel,
    user,
    n.title,
    n.message
  );
  await prisma.notification.update({
    where: { id: n.id },
    data: result.ok
      ? { deliveryStatus: "SENT", sentAt: new Date(), failureReason: null }
      : { deliveryStatus: "FAILED", failureReason: result.error || "Unknown error" },
  });
  return result;
}

/**
 * Drain queued notifications whose scheduledFor has elapsed. Intended to be
 * invoked by a periodic job (cron / setInterval).
 */
export async function drainScheduled(): Promise<number> {
  const due = await prisma.notification.findMany({
    where: {
      deliveryStatus: "QUEUED",
      OR: [
        { scheduledFor: null },
        { scheduledFor: { lte: new Date() } },
      ],
    },
    take: 100,
  });
  let processed = 0;
  for (const n of due) {
    const user = await prisma.user.findUnique({
      where: { id: n.userId },
      select: { id: true, email: true, phone: true },
    });
    if (!user) continue;
    const result = await sendWithRetry(
      n.channel as NotificationChannel,
      user,
      n.title,
      n.message
    );
    await prisma.notification.update({
      where: { id: n.id },
      data: result.ok
        ? { deliveryStatus: "SENT", sentAt: new Date(), failureReason: null }
        : { deliveryStatus: "FAILED", failureReason: result.error || "Unknown error" },
    });
    processed++;
  }
  return processed;
}
