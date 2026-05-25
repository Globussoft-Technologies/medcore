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
  accessToken: trimmed("Meta Cloud API access token is required"),
  phoneNumberId: trimmed("Meta Cloud API phone-number id is required"),
  appSecret: trimmed("Meta Cloud API app secret is required"),
  verifyToken: trimmed("Meta Cloud API verify token is required"),
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
export const whatsappConfigPutSchema = z.object({
  credentials: whatsappCredentialsSchema,
  defaultProductId: z.string().trim().max(120).optional().nullable(),
  autoReply: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type WhatsAppConfigPutInput = z.infer<typeof whatsappConfigPutSchema>;
