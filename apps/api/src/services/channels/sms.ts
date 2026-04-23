// SMS channel adapter.
//
// Env vars:
//   SMS_API_KEY    — provider API key / auth key
//   SMS_API_URL    — provider endpoint
//   SMS_SENDER_ID  — registered sender ID (default "MEDCOR")
//   SMS_PROVIDER   — "msg91" | "generic" (auto-detected from URL if omitted)
//
// Provider formats:
//   MSG91  — POST with authkey header + { sender, route, country, sms:[{message,to:[]}] }
//   Generic — POST with Authorization: Bearer header + { to, message, sender }

import type { ChannelResult } from "./whatsapp";

export async function sendSMS(to: string, text: string): Promise<ChannelResult> {
  const apiKey = process.env.SMS_API_KEY;
  const apiUrl = process.env.SMS_API_URL;
  const sender = process.env.SMS_SENDER_ID || "MEDCOR";

  if (!apiKey || !apiUrl) {
    console.log(`[SMS stub] to=${to} text=${text}`);
    return { ok: true, messageId: "stub-" + Date.now() };
  }

  const isMsg91 =
    process.env.SMS_PROVIDER === "msg91" || apiUrl.includes("msg91.com");

  try {
    let res: Response;

    if (isMsg91) {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authkey: apiKey,
        },
        body: JSON.stringify({
          sender,
          route: "4",
          country: "91",
          sms: [{ message: text, to: [to] }],
        }),
      });
    } else {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ to, message: text, sender }),
      });
    }

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as {
      messageId?: string;
      id?: string;
      request_id?: string;
    };
    return { ok: true, messageId: data.messageId || data.id || data.request_id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
