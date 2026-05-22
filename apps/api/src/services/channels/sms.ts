// SMS channel adapter.
//
// Env vars:
//   SMS_API_KEY    — provider API key / auth key (MSG91 + generic)
//   SMS_API_URL    — provider endpoint (MSG91 + generic)
//   SMS_SENDER_ID  — registered sender ID (default "MEDCOR")
//   SMS_PROVIDER   — "msg91" | "generic" | "twilio" (auto-detected from URL if omitted)
//
// Twilio-specific env vars (used when SMS_PROVIDER=twilio):
//   TWILIO_ACCOUNT_SID  — Twilio Account SID (ACxxxxxxxx...)
//   TWILIO_AUTH_TOKEN   — Twilio Auth Token (used as HTTP Basic password)
//   TWILIO_FROM_NUMBER  — registered sending number in E.164 (e.g. "+15551234567")
//
// Provider formats:
//   MSG91  — POST with authkey header + { sender, route, country, sms:[{message,to:[]}] }
//   Generic — POST with Authorization: Bearer header + { to, message, sender }
//   Twilio — POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
//            with HTTP Basic Auth ({AccountSid}:{AuthToken}) +
//            x-www-form-urlencoded body { To, From, Body }

import type { ChannelResult } from "./whatsapp";

export async function sendSMS(to: string, text: string): Promise<ChannelResult> {
  const provider = process.env.SMS_PROVIDER;

  if (provider === "twilio") {
    return sendViaTwilio(to, text);
  }

  const apiKey = process.env.SMS_API_KEY;
  const apiUrl = process.env.SMS_API_URL;
  const sender = process.env.SMS_SENDER_ID || "MEDCOR";

  if (!apiKey || !apiUrl) {
    console.log(`[SMS stub] to=${to} text=${text}`);
    return { ok: true, messageId: "stub-" + Date.now() };
  }

  const isMsg91 =
    provider === "msg91" || apiUrl.includes("msg91.com");

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

// Twilio Programmable SMS adapter.
// Selected when SMS_PROVIDER=twilio. Falls back to stub mode (with warning)
// when any of TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER
// is unset, mirroring the MSG91/generic fallback behaviour.
async function sendViaTwilio(to: string, text: string): Promise<ChannelResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.warn(
      "[SMS twilio stub] SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER not all set — falling back to stub mode"
    );
    console.log(`[SMS stub] to=${to} text=${text}`);
    return { ok: true, messageId: "stub-" + Date.now() };
  }

  // Twilio expects E.164 — best-effort prefix with +91 for bare Indian numbers.
  const toE164 = to.startsWith("+") ? to : `+91${to}`;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const form = new URLSearchParams();
  form.set("To", toE164);
  form.set("From", fromNumber);
  form.set("Body", text);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: form.toString(),
    });

    const data = (await res.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
      code?: number;
    };

    if (!res.ok) {
      const msg = data.message || `HTTP ${res.status}`;
      // Surface explicit auth hint on 401 so the orchestrator's failure log is actionable.
      if (res.status === 401) {
        return { ok: false, error: `Twilio unauthorized: ${msg}` };
      }
      return { ok: false, error: `Twilio: ${msg}` };
    }

    return { ok: true, messageId: data.sid };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
