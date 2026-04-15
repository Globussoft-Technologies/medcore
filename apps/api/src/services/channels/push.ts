// Push channel adapter (Firebase Cloud Messaging HTTP v1 pattern).
//
// Env vars:
//   PUSH_API_URL  — FCM endpoint
//   PUSH_API_KEY  — server key / OAuth bearer token

import type { ChannelResult } from "./whatsapp";

export async function sendPush(
  userId: string,
  title: string,
  body: string
): Promise<ChannelResult> {
  const apiKey = process.env.PUSH_API_KEY;
  const apiUrl = process.env.PUSH_API_URL;

  if (!apiKey || !apiUrl) {
    console.log(`[Push stub] userId=${userId} title=${title} body=${body}`);
    return { ok: true, messageId: "stub-" + Date.now() };
  }

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        message: {
          topic: `user_${userId}`,
          notification: { title, body },
        },
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { name?: string };
    return { ok: true, messageId: data.name };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
