// Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-ii of 4).
// Internal normalized-message Zod schema for inbound WhatsApp webhooks.
//
// What / which modules / why:
//   - Translates each provider's raw webhook payload (Gupshup / Wati /
//     AiSensei / Interakt / Meta Cloud API) into a single uniform shape
//     before the route layer persists it as a WhatsAppMessage row.
//   - Per-provider parse logic lives in
//     apps/api/src/services/whatsapp-providers.ts which emits objects
//     of this shape.
//   - The route layer (apps/api/src/routes/whatsapp-webhook.ts) consumes
//     this schema to defend against provider drift — if a provider
//     changes its payload contract and the parser misses a required
//     field, the schema catches it before we write a half-baked row.
//   - Integration tests assert against this exact shape.

import { z } from "zod";

// Canonical E.164 — at least "+" followed by 7+ digits. We don't enforce
// strict E.164 (country-code list) because providers occasionally send
// numbers with whatsapp:+91... or wa:+... prefixes; the parser strips
// those before validation.
const e164Schema = z
  .string()
  .trim()
  .regex(/^\+\d{7,15}$/, "phone must be canonical E.164 (+<7-15 digits>)");

export const normalizedInboundMessageSchema = z.object({
  // Canonical E.164 of the sender (the patient / lead).
  phone: e164Schema,
  // Plain-text body. Media-only messages carry an empty string here
  // and a non-null mediaUrl.
  body: z.string().max(8192),
  // Optional CDN/media URL when the inbound carries an image/audio/document.
  mediaUrl: z.string().url().optional().nullable(),
  // Provider's own message id — used for idempotent dedup. May be null
  // if the provider's payload doesn't surface one (rare).
  providerMessageId: z.string().trim().min(1).optional().nullable(),
  // When the provider says the message was sent. We use this for
  // ordering; ingest time (createdAt) is set by the DB.
  sentAt: z.date(),
});
export type NormalizedInboundMessage = z.infer<
  typeof normalizedInboundMessageSchema
>;
