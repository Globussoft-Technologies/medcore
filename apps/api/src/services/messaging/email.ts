// SendGrid email transport. Loaded lazily on first use so the API can boot
// without SENDGRID_API_KEY in dev (the share-prescription endpoint will then
// return a clear "not configured" error instead of crashing the server).
//
// Env vars consumed:
//   SENDGRID_API_KEY     — required for real delivery (starts with `SG.`)
//   SENDGRID_FROM_EMAIL  — verified single sender address (or any address on
//                          a domain-authenticated domain). Required.
//   SENDGRID_FROM_NAME   — optional display name; defaults to "MedCore".
//
// Public surface: sendEmail(...) returns Promise<{ ok: true } | { ok: false, error }>.
// Callers MUST branch on the result and surface failures to the user — this
// module never throws on provider errors (so a route handler can return a
// proper 502 with the provider's message instead of crashing).

import sgMail from "@sendgrid/mail";

let initialized = false;

function ensureInitialized(): { ok: true } | { ok: false; error: string } {
  if (initialized) return { ok: true };
  const key = process.env.SENDGRID_API_KEY;
  if (!key) {
    return {
      ok: false,
      error:
        "Email is not configured: SENDGRID_API_KEY is missing in apps/api/.env. " +
        "Add the key from https://app.sendgrid.com/settings/api_keys and restart the API.",
    };
  }
  if (!process.env.SENDGRID_FROM_EMAIL) {
    return {
      ok: false,
      error:
        "Email is not configured: SENDGRID_FROM_EMAIL is missing. " +
        "Use the email you verified at https://app.sendgrid.com/settings/sender_auth/senders.",
    };
  }
  sgMail.setApiKey(key);
  initialized = true;
  return { ok: true };
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    type?: string;
    disposition?: "attachment" | "inline";
  }>;
}

export interface SendEmailResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const init = ensureInitialized();
  if (!init.ok) return { ok: false, error: init.error };

  if (!input.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) {
    return { ok: false, error: `Invalid recipient email: ${input.to}` };
  }

  try {
    const [response] = await sgMail.send({
      to: input.to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL!,
        name: process.env.SENDGRID_FROM_NAME || "MedCore",
      },
      subject: input.subject,
      html: input.html,
      text: input.text || stripHtml(input.html),
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        content: typeof a.content === "string" ? a.content : a.content.toString("base64"),
        type: a.type,
        disposition: a.disposition || "attachment",
      })),
    });
    return {
      ok: true,
      messageId: response.headers["x-message-id"] as string | undefined,
    };
  } catch (err: unknown) {
    // SendGrid errors carry useful detail in `response.body.errors[]`. Surface
    // the first one so the route handler can pass a meaningful 502 to the UI
    // (e.g. "The from address does not match a verified Sender Identity").
    const e = err as {
      message?: string;
      response?: { body?: { errors?: Array<{ message: string }> } };
    };
    const detail =
      e.response?.body?.errors?.[0]?.message || e.message || "Unknown SendGrid error";
    return { ok: false, error: detail };
  }
}

// Generates the plain-text fallback that ships alongside the HTML body so
// spam filters score the email better. NOT a security boundary — the HTML
// content we send is constructed by us, not user-supplied. But CodeQL
// flagged the single-pass replace as "incomplete multi-character
// sanitization" because a nested payload like `<scr<script>ipt>` survives
// one pass of `<script>...</script>` removal and re-emerges as a real tag.
// We therefore loop until the regexes converge, which guarantees no
// matched-pattern remnants regardless of nesting.
function stripHtml(html: string): string {
  const blockTags = /<(style|script|noscript|iframe|object|embed)[\s\S]*?<\/\1>/gi;
  let prev: string;
  let next = html;
  do {
    prev = next;
    next = next.replace(blockTags, "");
  } while (next !== prev);
  do {
    prev = next;
    next = next.replace(/<[^>]+>/g, "");
  } while (next !== prev);
  return next.replace(/\s+/g, " ").trim();
}
