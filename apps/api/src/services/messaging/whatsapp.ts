// WhatsApp Cloud API transport. Mirrors the contract of `./email.ts` so a
// route handler can do `if (!result.ok) return 502 with result.error` and
// never have a provider error crash the server.
//
// Env vars consumed (Milestone 1 — send-only, no webhook):
//   WHATSAPP_ACCESS_TOKEN     — Bearer token from Meta. The "temporary" token
//                                expires in 24h; in prod use a permanent
//                                System User token from Meta Business Manager.
//   WHATSAPP_PHONE_NUMBER_ID  — Internal Meta ID for your sender number
//                                (NOT the actual phone number).
//
// What we send today: a free-form TEXT message inside an open 24-hour
// service window. WhatsApp Cloud API rejects free-form messages outside
// that window with `(#131047) Message failed to send because more than 24
// hours have passed since the customer last replied to this number`. For
// the production rollout you MUST register and use an approved Utility
// template (e.g. `prescription_ready`) — see the `// TODO(template)` notes
// below. The text-message path is fine for the demo where the patient
// just messaged the clinic.
//
// Public surface: sendWhatsApp(...) returns
//   Promise<{ ok: true, messageId } | { ok: false, error }>.
// Callers MUST branch on the result; this module never throws on provider
// errors.

let initialized = false;

function ensureInitialized(): { ok: true } | { ok: false; error: string } {
  if (initialized) return { ok: true };
  if (!process.env.WHATSAPP_ACCESS_TOKEN) {
    return {
      ok: false,
      error:
        "WhatsApp is not configured: WHATSAPP_ACCESS_TOKEN is missing in apps/api/.env. " +
        "Get one from https://developers.facebook.com/apps → your app → WhatsApp → API Setup.",
    };
  }
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID) {
    return {
      ok: false,
      error:
        "WhatsApp is not configured: WHATSAPP_PHONE_NUMBER_ID is missing. " +
        "Find it on the same API Setup page (under the test/registered phone number).",
    };
  }
  initialized = true;
  return { ok: true };
}

export interface SendWhatsAppInput {
  /** E.164-formatted phone number, e.g. `+919876543210`. The country code
   *  is mandatory; without it Meta returns a generic 400. */
  to: string;
  /** Plain-text body. Must be ≤ 4096 chars. URLs are auto-linkified by
   *  WhatsApp clients, so embedding the verify URL inline is fine. */
  body: string;
}

export interface SendWhatsAppResult {
  ok: boolean;
  error?: string;
  /** Meta's wamid (WhatsApp Message ID) — useful for delivery-receipt
   *  reconciliation when the webhook layer ships in Milestone 2. */
  messageId?: string;
}

/**
 * Normalise to E.164 (`+<countrycode><subscriber>`).
 *
 * Patient phone numbers in our DB come from the registration form which
 * accepts a 10-digit local number, an E.164 number, or a "+91 98765-43210"
 * style — we strip non-digits and then add the country code if missing.
 * India default is hard-coded for now; if we ever support other countries
 * the registration validator should normalise at write-time and we can
 * drop this fallback.
 */
function normalisePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  // Already has a country code (e.g. 919876543210 or 12025550100).
  if (digits.length >= 11) return `+${digits}`;
  // Bare 10-digit Indian mobile.
  if (digits.length === 10) return `+91${digits}`;
  return null;
}

export async function sendWhatsApp(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
  const init = ensureInitialized();
  if (!init.ok) return { ok: false, error: init.error };

  const to = normalisePhone(input.to);
  if (!to) {
    return { ok: false, error: `Invalid recipient phone number: ${input.to}` };
  }

  // Cloud API endpoint. We pin v20.0 — Meta deprecates major versions on a
  // ~2 year cadence so this needs to be reviewed annually. Bump in lockstep
  // with the Meta-API changelog (https://developers.facebook.com/docs/graph-api/changelog).
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  // TODO(template): for production, replace the `text` payload with a
  // `template` payload referencing an APPROVED Utility template. Sending
  // free-form text outside an open service window will return Meta error
  // (#131047). The demo currently relies on the test phone being inside the
  // 24-hour customer-initiated window.
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: true, body: input.body },
  };

  try {
    console.log(`[whatsapp] → POST ${url}`);
    console.log(`[whatsapp] → to=${to} body="${input.body.slice(0, 80)}..."`);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // Meta returns 200 with a JSON envelope; non-2xx means delivery was
    // refused. Surface the most informative error (`error.message` from
    // Meta's body, e.g. "Recipient phone number not in allowed list" in
    // sandbox mode, or "Invalid OAuth access token" if the token has
    // rotated/expired).
    const body = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id: string }>;
      contacts?: Array<{ input: string; wa_id: string }>;
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    console.log(`[whatsapp] ← ${res.status} ${JSON.stringify(body)}`);

    if (!res.ok) {
      const detail =
        body.error?.message ||
        `WhatsApp Cloud API returned ${res.status} ${res.statusText}`;
      return { ok: false, error: detail };
    }

    return {
      ok: true,
      messageId: body.messages?.[0]?.id,
    };
  } catch (err: unknown) {
    // Network-layer failure (DNS, TLS, etc). Distinct from a Meta-side
    // refusal — the route handler may want to retry on this class.
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `WhatsApp transport error: ${msg}` };
  }
}
