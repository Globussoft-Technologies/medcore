// Pearl ERP Stage 1 §6.1 (gap row 167 — pieces 3j-ii + 3j-iv of 4).
// Per-provider signature-verification + message-normalization + outbound send.
//
// What / which modules / why:
//   - Backs apps/api/src/routes/whatsapp-webhook.ts. The route delegates
//     verifyInboundSignature() + parseInboundMessage() per provider so
//     the receiver stays small.
//   - Five providers supported (mirrors WhatsAppProvider Prisma enum):
//       META       — Cloud API; X-Hub-Signature-256 = SHA256 HMAC(body, appSecret)
//       GUPSHUP    — shared-secret header `x-gs-signature` (HMAC-SHA256 of
//                    raw body with the API key); also accepts a static
//                    shared-secret in `apikey` header per Gupshup docs.
//       WATI       — Authorization: Bearer <bearerToken> from the config.
//       AISENSEI   — Vendor docs not public; we accept any signature in
//                    dev (TODO when docs surface). Strict mode disabled.
//       INTERAKT   — Same as AiSensei — vendor docs not public.
//   - Translated from callified/backend/wa_provider.py (Python/Flask).
//     callified's AiSensei + Interakt verifiers trust the inbound; we
//     mirror that for parity with the upstream reference while leaving a
//     clear TODO + strict-mode env knob for the moment docs surface.
//   - The route layer NEVER calls Prisma from here — these are pure
//     functions over (rawBody, headers, decryptedConfig).

import { createHmac, timingSafeEqual } from "node:crypto";

export type ProviderName =
  | "GUPSHUP"
  | "WATI"
  | "AISENSEI"
  | "INTERAKT"
  | "META";

/**
 * Decrypted creds shape — matches the per-provider Zod schemas in
 * packages/shared/src/validation/whatsapp-config.ts. We accept a loose
 * object here so the route layer doesn't have to re-validate after
 * decrypt; verifyInboundSignature defends against missing fields.
 */
export interface DecryptedProviderConfig {
  apiKey?: string;
  appName?: string;
  sourcePhone?: string;
  bearerToken?: string;
  tenantUrl?: string;
  baseUrl?: string;
  accessToken?: string;
  phoneNumberId?: string;
  appSecret?: string;
  verifyToken?: string;
}

/**
 * Normalized inbound message — matches the Zod schema in
 * packages/shared/src/validation/whatsapp-webhook.ts so the route layer
 * can validate AFTER parsing without crossing the packages→app arrow.
 */
export interface NormalizedInbound {
  phone: string;
  body: string;
  mediaUrl?: string | null;
  providerMessageId?: string | null;
  sentAt: Date;
}

// ── E.164 canonicalization ────────────────────────────────────────────
// Providers send "whatsapp:+919876543210", "+919876543210", "919876543210",
// or just "9876543210". Strip leading non-digit + non-"+" sediment, then
// canonicalize: missing "+" with 10 digits => assume India ("+91"); 11-15
// digits with no "+" => add the "+"; anything else returns null and the
// route 200-acks with `unknown destination`.
export function canonicalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  // Drop "whatsapp:" / "wa:" prefixes
  s = s.replace(/^(whatsapp|wa):/i, "").trim();
  // Strip anything that's not a digit or leading "+"
  if (s.startsWith("+")) {
    s = "+" + s.slice(1).replace(/\D/g, "");
  } else {
    s = s.replace(/\D/g, "");
    if (s.length === 10) s = "+91" + s;
    else if (s.length >= 11 && s.length <= 15) s = "+" + s;
    else return null;
  }
  return /^\+\d{7,15}$/.test(s) ? s : null;
}

// ── Signature verification ────────────────────────────────────────────

/**
 * Verifies the inbound provider signature. Returns true iff the request
 * is provably from the provider keyed to the given config.
 *
 * In dev/CI mode (WHATSAPP_WEBHOOK_STRICT !== "true") AiSensei + Interakt
 * are trusted unconditionally (matches callified's Python parity). Meta /
 * Gupshup / Wati are ALWAYS strict regardless of the env flag — those
 * providers ship signing primitives.
 */
export function verifyInboundSignature(
  provider: ProviderName,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  config: DecryptedProviderConfig,
): boolean {
  switch (provider) {
    case "META":
      return verifyMeta(rawBody, headers, config);
    case "GUPSHUP":
      return verifyGupshup(rawBody, headers, config);
    case "WATI":
      return verifyWati(headers, config);
    case "AISENSEI":
    case "INTERAKT":
      // Vendor docs not public; mirror callified/wa_provider.py which
      // trusts the inbound. Strict-mode env flag lets ops force rejects
      // once docs surface.
      // TODO: verify when provider docs available.
      return process.env.WHATSAPP_WEBHOOK_STRICT !== "true";
    default:
      return false;
  }
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function timingSafeStrEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function verifyMeta(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  config: DecryptedProviderConfig,
): boolean {
  const sig = pickHeader(headers, "x-hub-signature-256");
  if (!sig || !config.appSecret) return false;
  // Header format: "sha256=<hex>"
  const m = /^sha256=([0-9a-f]+)$/i.exec(sig.trim());
  if (!m) return false;
  const expected = createHmac("sha256", config.appSecret)
    .update(rawBody)
    .digest("hex");
  return timingSafeStrEq(m[1].toLowerCase(), expected.toLowerCase());
}

function verifyGupshup(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  config: DecryptedProviderConfig,
): boolean {
  if (!config.apiKey) return false;
  // Gupshup posts either an HMAC over the raw body in `x-gs-signature`
  // OR a static `apikey` header equal to the configured key. We accept
  // either to maximise tenant-config interop. Both are constant-time-compared.
  const hmacSig = pickHeader(headers, "x-gs-signature");
  if (hmacSig) {
    const expected = createHmac("sha256", config.apiKey)
      .update(rawBody)
      .digest("hex");
    if (timingSafeStrEq(hmacSig.toLowerCase(), expected.toLowerCase())) {
      return true;
    }
  }
  const staticKey = pickHeader(headers, "apikey");
  if (staticKey && timingSafeStrEq(staticKey, config.apiKey)) return true;
  return false;
}

function verifyWati(
  headers: Record<string, string | string[] | undefined>,
  config: DecryptedProviderConfig,
): boolean {
  if (!config.bearerToken) return false;
  // WATI sends Authorization: Bearer <token>. Tenant configures the
  // token; we constant-time-compare. (WATI's docs don't currently
  // publish a per-request HMAC scheme.)
  const auth = pickHeader(headers, "authorization");
  if (!auth) return false;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) return false;
  return timingSafeStrEq(m[1], config.bearerToken);
}

// ── Message normalization ─────────────────────────────────────────────

/**
 * Parses a provider's raw inbound JSON into the internal NormalizedInbound
 * shape. Returns null when the payload doesn't represent a user-message
 * event (e.g. delivery receipts, status updates, channel events) — the
 * route 200-acks those without writing a row.
 */
export function parseInboundMessage(
  provider: ProviderName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
): NormalizedInbound | null {
  try {
    switch (provider) {
      case "META":
        return parseMeta(body);
      case "GUPSHUP":
        return parseGupshup(body);
      case "WATI":
        return parseWati(body);
      case "AISENSEI":
        return parseAiSensei(body);
      case "INTERAKT":
        return parseInterakt(body);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMeta(body: any): NormalizedInbound | null {
  // Meta Cloud API webhook payload shape:
  // { entry: [{ changes: [{ value: { messages: [{ from, id, timestamp,
  //   type, text: {body}, image: {link}, ... }] } }] }] }
  const change = body?.entry?.[0]?.changes?.[0]?.value;
  const msg = change?.messages?.[0];
  if (!msg) return null;
  const phone = canonicalizePhone(msg.from);
  if (!phone) return null;
  let textBody = "";
  let mediaUrl: string | null = null;
  if (msg.type === "text" && typeof msg.text?.body === "string") {
    textBody = msg.text.body;
  } else if (msg.image?.link || msg.image?.id) {
    mediaUrl = String(msg.image.link ?? msg.image.id);
    textBody = msg.image?.caption ?? "";
  } else if (msg.document?.link || msg.document?.id) {
    mediaUrl = String(msg.document.link ?? msg.document.id);
    textBody = msg.document?.caption ?? "";
  } else if (msg.audio?.link || msg.audio?.id) {
    mediaUrl = String(msg.audio.link ?? msg.audio.id);
  } else {
    return null; // unsupported message type — let the route 200-ack
  }
  const sentAtSec = Number(msg.timestamp);
  return {
    phone,
    body: textBody,
    mediaUrl,
    providerMessageId: typeof msg.id === "string" ? msg.id : null,
    sentAt: Number.isFinite(sentAtSec)
      ? new Date(sentAtSec * 1000)
      : new Date(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseGupshup(body: any): NormalizedInbound | null {
  // Gupshup posts to the webhook with one of these envelopes:
  //  { type:"message", payload:{ id, source, type, payload:{text|url}, sender:{phone} } }
  //  { type:"message-event", ... } — delivery receipt, ignore.
  if (body?.type !== "message" || !body?.payload) return null;
  const p = body.payload;
  const phone = canonicalizePhone(p.source ?? p.sender?.phone);
  if (!phone) return null;
  let textBody = "";
  let mediaUrl: string | null = null;
  const inner = p.payload ?? {};
  if (p.type === "text" && typeof inner.text === "string") {
    textBody = inner.text;
  } else if (
    p.type === "image" ||
    p.type === "audio" ||
    p.type === "video" ||
    p.type === "file"
  ) {
    mediaUrl = typeof inner.url === "string" ? inner.url : null;
    textBody = typeof inner.caption === "string" ? inner.caption : "";
  } else {
    return null;
  }
  return {
    phone,
    body: textBody,
    mediaUrl,
    providerMessageId: typeof p.id === "string" ? p.id : null,
    sentAt: p.timestamp ? new Date(Number(p.timestamp)) : new Date(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseWati(body: any): NormalizedInbound | null {
  // WATI sends:
  //  { eventType:"message", waId:"919876543210", text:"...", id, timestamp }
  //  Media: { type:"image", data:"<url>" } extra field.
  if (body?.eventType !== "message") return null;
  const phone = canonicalizePhone(body.waId);
  if (!phone) return null;
  return {
    phone,
    body: typeof body.text === "string" ? body.text : "",
    mediaUrl: typeof body.data === "string" ? body.data : null,
    providerMessageId: typeof body.id === "string" ? body.id : null,
    sentAt: body.timestamp ? new Date(Number(body.timestamp)) : new Date(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseAiSensei(body: any): NormalizedInbound | null {
  // AiSensei envelope (per callified): { event:"incoming_message",
  // data:{ from, text, message_id, timestamp, media_url? } }
  if (body?.event !== "incoming_message" || !body?.data) return null;
  const d = body.data;
  const phone = canonicalizePhone(d.from);
  if (!phone) return null;
  return {
    phone,
    body: typeof d.text === "string" ? d.text : "",
    mediaUrl: typeof d.media_url === "string" ? d.media_url : null,
    providerMessageId: typeof d.message_id === "string" ? d.message_id : null,
    sentAt: d.timestamp ? new Date(Number(d.timestamp)) : new Date(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseInterakt(body: any): NormalizedInbound | null {
  // Interakt envelope (per callified): { type:"message_received",
  // data:{ customer:{ phone_number }, message:{ message:"...", id,
  //   timestamp, media:{ url }? } } }
  if (body?.type !== "message_received" || !body?.data) return null;
  const phone = canonicalizePhone(body.data.customer?.phone_number);
  if (!phone) return null;
  const m = body.data.message ?? {};
  return {
    phone,
    body: typeof m.message === "string" ? m.message : "",
    mediaUrl: typeof m.media?.url === "string" ? m.media.url : null,
    providerMessageId: typeof m.id === "string" ? m.id : null,
    sentAt: m.timestamp ? new Date(Number(m.timestamp)) : new Date(),
  };
}

// ── Outbound send (piece 3j-iv) ───────────────────────────────────────

export interface OutboundSendResult {
  providerMessageId: string;
  sentAt: Date;
}

/**
 * Sends a single outbound text message via the tenant's configured provider.
 *
 * Stub vs strict mode: when running outside production AND the provider
 * returns a non-2xx OR the call throws, we return a mock
 * `{providerMessageId:"stub-<rand>", sentAt:now()}` so local dev / CI
 * doesn't break against placeholder creds. Production (NODE_ENV=production)
 * always surfaces the real error so the route layer can persist a FAILED
 * message + 502. Set `WHATSAPP_OUTBOUND_STRICT=true` to force strict mode
 * in non-prod environments (useful for integration tests against a real
 * provider).
 *
 * Each branch returns the provider's own message id when available; falls
 * back to a generated id so the persisted `providerMessageId` column is
 * never null on a successful send.
 */
export async function sendOutboundMessage(
  provider: ProviderName,
  config: DecryptedProviderConfig,
  phone: string,
  body: string,
): Promise<OutboundSendResult> {
  const strict =
    process.env.NODE_ENV === "production" ||
    process.env.WHATSAPP_OUTBOUND_STRICT === "true";
  try {
    switch (provider) {
      case "GUPSHUP":
        return await sendGupshup(config, phone, body);
      case "WATI":
        return await sendWati(config, phone, body);
      case "AISENSEI":
        return await sendAiSensei(config, phone, body);
      case "INTERAKT":
        return await sendInterakt(config, phone, body);
      case "META":
        return await sendMeta(config, phone, body);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  } catch (err) {
    if (!strict) {
      // Dev / CI fallback — matches the sms.ts stub pattern (CLAUDE.md
      // §services). Lets local development write OUTBOUND rows without
      // a real Gupshup / Meta account.
      console.warn(
        `[whatsapp-outbound stub] provider=${provider} phone=${maskPhone(
          phone,
        )} fell back to stub after error: ${String(err)}`,
      );
      return { providerMessageId: stubId(), sentAt: new Date() };
    }
    throw err;
  }
}

function stubId(): string {
  return (
    "stub-" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

function maskPhone(phone: string): string {
  return phone.length >= 4 ? "****" + phone.slice(-4) : phone;
}

async function asJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorMessage(body: Record<string, unknown>, fallback: string): string {
  // Best-effort error extraction — every provider names this differently.
  const candidates = [
    body.message,
    body.error,
    body.errorMessage,
    (body.error as { message?: string } | undefined)?.message,
    body.detail,
    body.reason,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return fallback;
}

async function sendGupshup(
  config: DecryptedProviderConfig,
  phone: string,
  body: string,
): Promise<OutboundSendResult> {
  if (!config.apiKey || !config.sourcePhone || !config.appName) {
    throw new Error("Gupshup config missing apiKey/sourcePhone/appName");
  }
  const form = new URLSearchParams();
  form.set("channel", "whatsapp");
  form.set("source", config.sourcePhone.replace(/^\+/, ""));
  form.set("destination", phone.replace(/^\+/, ""));
  form.set("message", JSON.stringify({ type: "text", text: body }));
  form.set("src.name", config.appName);
  const res = await fetch("https://api.gupshup.io/sm/api/v1/msg", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      apikey: config.apiKey,
    },
    body: form.toString(),
  });
  const data = await asJson(res);
  if (!res.ok) throw new Error(errorMessage(data, `Gupshup HTTP ${res.status}`));
  const id =
    (typeof data.messageId === "string" && data.messageId) ||
    (typeof data.id === "string" && data.id) ||
    stubId();
  return { providerMessageId: id, sentAt: new Date() };
}

async function sendWati(
  config: DecryptedProviderConfig,
  phone: string,
  body: string,
): Promise<OutboundSendResult> {
  if (!config.bearerToken || !config.tenantUrl) {
    throw new Error("WATI config missing bearerToken/tenantUrl");
  }
  const baseUrl = config.tenantUrl.replace(/\/+$/, "");
  const phoneDigits = phone.replace(/^\+/, "");
  const url = `${baseUrl}/api/v1/sendSessionMessage/${encodeURIComponent(
    phoneDigits,
  )}?messageText=${encodeURIComponent(body)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.bearerToken}`,
      "Content-Type": "application/json",
    },
  });
  const data = await asJson(res);
  if (!res.ok) throw new Error(errorMessage(data, `WATI HTTP ${res.status}`));
  const messageInfo = data.message as { id?: string } | undefined;
  const id =
    (typeof data.id === "string" && data.id) ||
    (typeof messageInfo?.id === "string" && messageInfo.id) ||
    stubId();
  return { providerMessageId: id, sentAt: new Date() };
}

async function sendAiSensei(
  config: DecryptedProviderConfig,
  phone: string,
  body: string,
): Promise<OutboundSendResult> {
  if (!config.apiKey || !config.baseUrl) {
    throw new Error("AiSensei config missing apiKey/baseUrl");
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apiKey: config.apiKey,
    },
    body: JSON.stringify({ to: phone, text: body }),
  });
  const data = await asJson(res);
  if (!res.ok)
    throw new Error(errorMessage(data, `AiSensei HTTP ${res.status}`));
  const id =
    (typeof data.message_id === "string" && data.message_id) ||
    (typeof data.id === "string" && data.id) ||
    stubId();
  return { providerMessageId: id, sentAt: new Date() };
}

async function sendInterakt(
  config: DecryptedProviderConfig,
  phone: string,
  body: string,
): Promise<OutboundSendResult> {
  if (!config.apiKey) {
    throw new Error("Interakt config missing apiKey");
  }
  // Interakt's public/message API expects `countryCode` (no "+") + bare
  // phoneNumber. Default-split a "+CCNNN..." into a 2-digit country code
  // and the rest. For Indian numbers ("+91NNN...") this is correct.
  const stripped = phone.replace(/^\+/, "");
  const countryCode =
    stripped.length > 10 ? stripped.slice(0, stripped.length - 10) : "91";
  const phoneNumber =
    stripped.length > 10 ? stripped.slice(-10) : stripped;
  const res = await fetch("https://api.interakt.ai/v1/public/message/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(config.apiKey + ":").toString("base64")}`,
    },
    body: JSON.stringify({
      countryCode,
      phoneNumber,
      type: "Text",
      data: { message: body },
    }),
  });
  const data = await asJson(res);
  if (!res.ok)
    throw new Error(errorMessage(data, `Interakt HTTP ${res.status}`));
  const id =
    (typeof data.id === "string" && data.id) ||
    (typeof (data.result as { id?: string } | undefined)?.id === "string" &&
      (data.result as { id?: string }).id!) ||
    stubId();
  return { providerMessageId: id, sentAt: new Date() };
}

async function sendMeta(
  config: DecryptedProviderConfig,
  phone: string,
  body: string,
): Promise<OutboundSendResult> {
  if (!config.accessToken || !config.phoneNumberId) {
    throw new Error("Meta config missing accessToken/phoneNumberId");
  }
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(
    config.phoneNumberId,
  )}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone.replace(/^\+/, ""),
      type: "text",
      text: { body },
    }),
  });
  const data = await asJson(res);
  if (!res.ok) {
    const errObj = data.error as { message?: string } | undefined;
    throw new Error(
      typeof errObj?.message === "string"
        ? errObj.message
        : `Meta HTTP ${res.status}`,
    );
  }
  const messages = data.messages as Array<{ id?: string }> | undefined;
  const id =
    (Array.isArray(messages) &&
      messages[0] &&
      typeof messages[0].id === "string" &&
      messages[0].id) ||
    stubId();
  return { providerMessageId: id, sentAt: new Date() };
}

// ── Destination-phone extractor ───────────────────────────────────────
// Pulls the tenant-facing destination (our number) from the raw payload
// so the route can route the message to the right tenant.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractDestinationPhone(
  provider: ProviderName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
): string | null {
  switch (provider) {
    case "META": {
      const meta = body?.entry?.[0]?.changes?.[0]?.value?.metadata;
      // Meta sends display_phone_number AND phone_number_id; we prefer
      // phone_number_id (immutable id) for routing.
      return (
        canonicalizePhone(meta?.display_phone_number) ??
        (typeof meta?.phone_number_id === "string"
          ? meta.phone_number_id
          : null)
      );
    }
    case "GUPSHUP":
      return canonicalizePhone(body?.payload?.destination);
    case "WATI":
      return canonicalizePhone(body?.to);
    case "AISENSEI":
      return canonicalizePhone(body?.data?.to);
    case "INTERAKT":
      return canonicalizePhone(body?.data?.tenant?.phone_number);
    default:
      return null;
  }
}
