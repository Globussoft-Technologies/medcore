import { prisma } from "@medcore/db";
import { NotificationType, NotificationChannel } from "@medcore/shared";

// ─── Channel Stubs ─────────────────────────────────────
// These are stubs that log the message. Replace with real API integrations later.

export async function sendWhatsApp(phone: string, message: string): Promise<void> {
  console.log(`[WhatsApp] To: ${phone} | Message: ${message}`);
  // TODO: Integrate WhatsApp Business API (Twilio / Meta Cloud API)
}

export async function sendSMS(phone: string, message: string): Promise<void> {
  console.log(`[SMS] To: ${phone} | Message: ${message}`);
  // TODO: Integrate SMS gateway (Twilio / MSG91)
}

export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  console.log(`[Email] To: ${to} | Subject: ${subject} | Body: ${body}`);
  // TODO: Integrate email provider (SendGrid / SES / Nodemailer)
}

export async function sendPush(userId: string, title: string, body: string): Promise<void> {
  console.log(`[Push] UserId: ${userId} | Title: ${title} | Body: ${body}`);
  // TODO: Integrate push notification service (FCM / OneSignal)
}

// ─── Main Notification Service ─────────────────────────

interface SendNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

export async function sendNotification(params: SendNotificationParams): Promise<void> {
  const { userId, type, title, message, data } = params;

  // Look up user for contact details
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, phone: true, name: true },
  });

  if (!user) {
    console.warn(`[Notification] User not found: ${userId}`);
    return;
  }

  // Get user's notification preferences
  const preferences = await prisma.notificationPreference.findMany({
    where: { userId },
  });

  // Build a set of enabled channels. If no preferences exist, default to all channels enabled.
  const enabledChannels = new Set<NotificationChannel>();
  if (preferences.length === 0) {
    Object.values(NotificationChannel).forEach((ch) => enabledChannels.add(ch));
  } else {
    preferences
      .filter((p) => p.enabled)
      .forEach((p) => enabledChannels.add(p.channel as NotificationChannel));
  }

  // Dispatch to each enabled channel and log to DB
  const channelDispatchers: Record<
    NotificationChannel,
    () => Promise<void>
  > = {
    [NotificationChannel.WHATSAPP]: () => sendWhatsApp(user.phone, message),
    [NotificationChannel.SMS]: () => sendSMS(user.phone, message),
    [NotificationChannel.EMAIL]: () => sendEmail(user.email, title, message),
    [NotificationChannel.PUSH]: () => sendPush(userId, title, message),
  };

  for (const channel of enabledChannels) {
    try {
      await channelDispatchers[channel]();

      // Log notification to DB
      await prisma.notification.create({
        data: {
          userId,
          type: type as any,
          channel: channel as any,
          title,
          message,
          data: (data as any) ?? undefined,
          sentAt: new Date(),
        },
      });
    } catch (err) {
      console.error(`[Notification] Failed to send via ${channel} to user ${userId}:`, err);

      // Still log the failed attempt
      await prisma.notification.create({
        data: {
          userId,
          type: type as any,
          channel: channel as any,
          title,
          message,
          data: (data as any) ?? undefined,
          sentAt: null, // null indicates it was not sent successfully
        },
      }).catch(console.error);
    }
  }
}
