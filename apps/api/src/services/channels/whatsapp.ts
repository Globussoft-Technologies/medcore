// WhatsApp Business channel adapter (Gupshup / Wati / 360dialog / Meta Cloud).
// Activates only when WHATSAPP_API_URL and WHATSAPP_API_KEY are configured;
// otherwise logs a stub message and returns success.
//
// Env vars:
//   WHATSAPP_API_URL  — provider HTTP endpoint
//   WHATSAPP_API_KEY  — bearer token / API key

export interface ChannelResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendWhatsApp(to: string, text: string): Promise<ChannelResult> {
  const apiKey = process.env.WHATSAPP_API_KEY;
  const apiUrl = process.env.WHATSAPP_API_URL;

  if (!apiKey || !apiUrl) {
    console.log(`[WhatsApp stub] to=${to} text=${text}`);
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
        to,
        type: "text",
        text: { body: text },
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { messageId?: string; id?: string };
    return { ok: true, messageId: data.messageId || data.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
