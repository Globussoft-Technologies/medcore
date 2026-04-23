// Push channel adapter — Expo Push Service (handles FCM + APNs routing).
//
// Expo push tokens (ExponentPushToken[xxx]) are stored in User.pushTokens
// by the mobile app on first launch. No separate FCM/APNs credentials needed
// for basic delivery; Expo's gateway routes to both platforms automatically.
//
// Env vars (optional):
//   EXPO_ACCESS_TOKEN — Expo account token for enhanced throughput (recommended in prod)

import { Expo } from "expo-server-sdk";
import type { ChannelResult } from "./whatsapp";

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
});

export async function sendPush(
  pushTokens: string[],
  title: string,
  body: string
): Promise<ChannelResult> {
  const validTokens = pushTokens.filter((t) => Expo.isExpoPushToken(t as any));

  if (validTokens.length === 0) {
    console.log(`[Push stub] no valid Expo tokens — title="${title}"`);
    return { ok: true, messageId: "no-tokens" };
  }

  const messages = validTokens.map((to) => ({
    to: to as any,
    sound: "default" as const,
    title,
    body,
  }));

  try {
    const chunks = expo.chunkPushNotifications(messages);
    const ids: string[] = [];
    for (const chunk of chunks) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (const ticket of tickets) {
        if (ticket.status === "ok") ids.push(ticket.id);
      }
    }
    return { ok: true, messageId: ids.join(",") || "sent" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
