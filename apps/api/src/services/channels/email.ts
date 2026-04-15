// Email channel adapter (SendGrid / SMTP gateway pattern via HTTP).
//
// Env vars:
//   EMAIL_API_URL    — provider HTTP endpoint (e.g. SendGrid v3 /mail/send)
//   EMAIL_API_KEY    — bearer / API key
//   EMAIL_FROM       — verified sender address

import type { ChannelResult } from "./whatsapp";

export async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<ChannelResult> {
  const apiKey = process.env.EMAIL_API_KEY;
  const apiUrl = process.env.EMAIL_API_URL;
  const from = process.env.EMAIL_FROM || "noreply@medcore.local";

  if (!apiKey || !apiUrl) {
    console.log(`[Email stub] to=${to} subject=${subject} body=${body}`);
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
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: "text/plain", value: body }],
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const messageId = res.headers.get("x-message-id") || undefined;
    return { ok: true, messageId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
