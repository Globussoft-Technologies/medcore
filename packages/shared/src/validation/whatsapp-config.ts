// Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-i of 4).
// Zod schema for the per-tenant WhatsApp provider config.
//
// What / which modules / why:
//   - Backs the GET / PUT /api/v1/wa/config routes
//     (apps/api/src/routes/whatsapp-config.ts) AND the provider-config
//     form on /dashboard/settings/whatsapp.
//   - Five providers are supported today (Gupshup, Wati, AiSensei, Interakt,
//     Meta Cloud API). Each provider has a distinct credential shape — we
//     use z.discriminatedUnion("provider", [...]) so the server-side parse
//     rejects payloads where the provider field disagrees with the field
//     set (e.g. provider="GUPSHUP" but a META `accessToken` instead of an
//     `apiKey`). Translated from `callified/frontend/.../WhatsAppTab.jsx`
//     + `callified/backend/wa_provider.py`.
//   - Credentials never leave this surface in cleartext over an audit row:
//     the API route logs only `provider` to the AuditLog `details` blob.
//     Storage is AES-256-GCM via apps/api/src/services/whatsapp-crypto.ts.

import { z } from "zod";

// Mirrors the Prisma enum `WhatsAppProvider` exactly. Kept inline because
// @medcore/shared cannot import from @medcore/db (cyclic dep).
export const whatsappProviderSchema = z.enum([
  "GUPSHUP",
  "WATI",
  "AISENSEI",
  "INTERAKT",
  "META",
]);
export type WhatsAppProviderValue = z.infer<typeof whatsappProviderSchema>;

// ── Per-provider credential shapes ───────────────────────────────────
// String fields are trimmed; min(1) trips on whitespace-only.
const trimmed = (msg: string) => z.string().trim().min(1, msg);

const gupshupCredentialsSchema = z.object({
  provider: z.literal("GUPSHUP"),
  apiKey: trimmed("Gupshup API key is required"),
  appName: trimmed("Gupshup app name is required"),
  sourcePhone: trimmed("Gupshup source phone (E.164) is required"),
});

const watiCredentialsSchema = z.object({
  provider: z.literal("WATI"),
  bearerToken: trimmed("WATI bearer token is required"),
  tenantUrl: trimmed("WATI tenant URL is required"),
});

const aisenseiCredentialsSchema = z.object({
  provider: z.literal("AISENSEI"),
  apiKey: trimmed("AiSensei API key is required"),
  baseUrl: trimmed("AiSensei base URL is required"),
});

const interaktCredentialsSchema = z.object({
  provider: z.literal("INTERAKT"),
  apiKey: trimmed("Interakt API key is required"),
});

const metaCredentialsSchema = z.object({
  provider: z.literal("META"),
  // Outbound (send-only) creds — always required for Meta.
  accessToken: trimmed("Meta Cloud API access token is required"),
  phoneNumberId: trimmed("Meta Cloud API phone-number id is required"),
  // Inbound (webhook) creds — the App secret verifies Meta's request signature
  // and the Verify token completes the subscription handshake. They are ONLY
  // needed to RECEIVE messages (i.e. auto-reply). A hospital that just wants to
  // SEND confirmations/reminders doesn't need them, so they're optional here
  // and conditionally required by the superRefine on whatsappConfigPutSchema
  // when autoReply is enabled.
  appSecret: z.string().trim().max(512).optional().or(z.literal("")),
  verifyToken: z.string().trim().max(512).optional().or(z.literal("")),
});

export const whatsappCredentialsSchema = z.discriminatedUnion("provider", [
  gupshupCredentialsSchema,
  watiCredentialsSchema,
  aisenseiCredentialsSchema,
  interaktCredentialsSchema,
  metaCredentialsSchema,
]);
export type WhatsAppCredentials = z.infer<typeof whatsappCredentialsSchema>;

// ── PUT /api/v1/wa/config payload ────────────────────────────────────
export const whatsappConfigPutSchema = z
  .object({
    // The provider whose creds are in `credentials` — this call saves/updates
    // THIS provider in the tenant's per-provider vault.
    credentials: whatsappCredentialsSchema,
    // Which provider should be ACTIVE (used to send/receive) after this save.
    // Optional — defaults to the provider in `credentials`. Lets an admin flip
    // the active provider (among ones they've already saved) without re-typing
    // creds. Must be a provider the tenant has creds for (enforced server-side).
    activeProvider: whatsappProviderSchema.optional(),
    defaultProductId: z.string().trim().max(120).optional().nullable(),
    autoReply: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  // Meta's inbound webhook creds are required ONLY when auto-reply (receiving)
  // is on. Send-only configs (autoReply false/omitted) skip them. Enforced here
  // rather than on the field so it can read the sibling `autoReply` flag.
  .superRefine((val, ctx) => {
    if (val.credentials.provider !== "META" || val.autoReply !== true) return;
    const c = val.credentials as { appSecret?: string; verifyToken?: string };
    if (!c.appSecret || c.appSecret.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentials", "appSecret"],
        message: "App secret is required to receive messages / auto-reply",
      });
    }
    if (!c.verifyToken || c.verifyToken.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentials", "verifyToken"],
        message: "Verify token is required to receive messages / auto-reply",
      });
    }
  });
export type WhatsAppConfigPutInput = z.infer<typeof whatsappConfigPutSchema>;
