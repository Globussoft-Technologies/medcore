// SMS channel adapter (MSG91 / Twilio pattern).
//
// Env vars:
//   SMS_API_URL    — provider HTTP endpoint
//   SMS_API_KEY    — bearer token / API key
//   SMS_SENDER_ID  — registered sender id (optional)

import type { ChannelResult } from "./whatsapp";

export async function sendSMS(to: string, text: string): Promise<ChannelResult> {
  const apiKey = process.env.SMS_API_KEY;
  const apiUrl = process.env.SMS_API_URL;
  const sender = process.env.SMS_SENDER_ID || "MEDCOR";

  if (!apiKey || !apiUrl) {
    console.log(`[SMS stub] to=${to} text=${text}`);
    return { ok: true, messageId: "stub-" + Date.now() };
  }

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ to, message: text, sender }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { messageId?: string; id?: string };
    return { ok: true, messageId: data.messageId || data.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
