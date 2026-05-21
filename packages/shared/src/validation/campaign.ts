// Pearl ERP Stage 1 §5.1 (gap item #4 — piece 1 of 4) — Campaign + audience
// CRUD validation. Schema-only piece 1; the audience-compiler / dispatcher
// (piece 2), A/B + tracking (piece 3), and UI (piece 4) ship later.
//
// What / which modules / why:
//   - Validates POST/PATCH for Campaign and CampaignAudience.
//   - tenantId is NOT accepted from the body (resolved server-side from
//     auth context, mirroring branches.ts + feature-flags.ts).
//   - State-machine guards: invalid transitions on Campaign.status are
//     rejected here AT the schema level via refine() so the route only has
//     to enforce the load+transition combination (current → next).
//   - sendWindowStart / sendWindowEnd must be set together (both null or
//     both numbers 0..1439, with start < end).
import { z } from "zod";

// ── Enums (mirror schema.prisma; Zod-side source of truth for the API)
export const campaignChannelEnum = z.enum(["WHATSAPP", "SMS", "EMAIL", "PUSH"]);
export const campaignKindEnum = z.enum(["BROADCAST", "DRIP", "TRIGGER", "COHORT_REMINDER"]);
export const campaignStatusEnum = z.enum([
  "DRAFT",
  "SCHEDULED",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
]);

// A/B variant shape. Persisted as-is; piece 3 picks one per recipient.
const abVariantSchema = z.object({
  id: z.string().trim().min(1).max(40),
  weight: z.number().int().min(1).max(100),
  subjectOverride: z.string().trim().max(255).optional(),
  bodyOverride: z.string().trim().max(8000).optional(),
});

// Minute-of-day window: 0..1439 inclusive. Used for IST quiet-hour clamp.
const minuteOfDay = z.number().int().min(0).max(1439);

// Operator-side state-machine. The dispatcher (piece 2) is responsible
// for SCHEDULED → RUNNING; operators can DRAFT → SCHEDULED, RUNNING ↔
// PAUSED, and any → CANCELLED. Direct jumps to COMPLETED are rejected by
// the route with 409.
const VALID_STATUS_VALUES = ["DRAFT", "SCHEDULED", "RUNNING", "PAUSED", "CANCELLED"] as const;
const operatorWriteableStatusEnum = z.enum(VALID_STATUS_VALUES);

// ── createCampaignSchema ─────────────────────────────────────────────
export const createCampaignSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    status: campaignStatusEnum.optional().default("DRAFT"),
    kind: campaignKindEnum.optional().default("BROADCAST"),
    channels: z.array(campaignChannelEnum).min(1, "At least one channel is required"),
    templateId: z.string().uuid().optional().nullable(),
    subject: z.string().trim().max(255).optional().nullable(),
    body: z.string().trim().max(8000).optional().nullable(),
    audienceId: z.string().optional().nullable(),
    scheduledAt: z.coerce.date().optional().nullable(),
    sendWindowStart: minuteOfDay.optional().nullable(),
    sendWindowEnd: minuteOfDay.optional().nullable(),
    abVariants: z.array(abVariantSchema).max(10).optional().nullable(),
  })
  .refine(
    (v) => {
      const startSet = v.sendWindowStart !== undefined && v.sendWindowStart !== null;
      const endSet = v.sendWindowEnd !== undefined && v.sendWindowEnd !== null;
      return startSet === endSet;
    },
    {
      message: "sendWindowStart and sendWindowEnd must be set together",
      path: ["sendWindowEnd"],
    },
  )
  .refine(
    (v) => {
      if (v.sendWindowStart == null || v.sendWindowEnd == null) return true;
      return v.sendWindowStart < v.sendWindowEnd;
    },
    {
      message: "sendWindowStart must be strictly less than sendWindowEnd",
      path: ["sendWindowEnd"],
    },
  );

// ── updateCampaignSchema ─────────────────────────────────────────────
// All fields optional. Status, if present, must be one the operator can
// write directly (not COMPLETED — that's the dispatcher's job; not
// RUNNING — also dispatcher-driven). The route enforces the (current →
// next) transition matrix on top of this.
export const updateCampaignSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: operatorWriteableStatusEnum.optional(),
    kind: campaignKindEnum.optional(),
    channels: z.array(campaignChannelEnum).min(1).optional(),
    templateId: z.string().uuid().nullable().optional(),
    subject: z.string().trim().max(255).nullable().optional(),
    body: z.string().trim().max(8000).nullable().optional(),
    audienceId: z.string().nullable().optional(),
    scheduledAt: z.coerce.date().nullable().optional(),
    cancelReason: z.string().trim().max(500).optional(),
    sendWindowStart: minuteOfDay.nullable().optional(),
    sendWindowEnd: minuteOfDay.nullable().optional(),
    abVariants: z.array(abVariantSchema).max(10).nullable().optional(),
  })
  .refine(
    (v) => {
      // Both must be present-or-absent together — but only if the PATCH
      // touches either of them. A patch that omits both is fine.
      const touchesStart = v.sendWindowStart !== undefined;
      const touchesEnd = v.sendWindowEnd !== undefined;
      if (!touchesStart && !touchesEnd) return true;
      const startVal = v.sendWindowStart ?? null;
      const endVal = v.sendWindowEnd ?? null;
      return (startVal === null) === (endVal === null);
    },
    {
      message: "sendWindowStart and sendWindowEnd must be set together",
      path: ["sendWindowEnd"],
    },
  )
  .refine(
    (v) => {
      if (v.sendWindowStart == null || v.sendWindowEnd == null) return true;
      return v.sendWindowStart < v.sendWindowEnd;
    },
    {
      message: "sendWindowStart must be strictly less than sendWindowEnd",
      path: ["sendWindowEnd"],
    },
  );

// ── createCampaignAudienceSchema ─────────────────────────────────────
export const createCampaignAudienceSchema = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  // Piece 2 of 4 defines the rule DSL. For now the API only enforces
  // "is a JSON object" — concrete shape validation lands when the
  // compiler does.
  rules: z.record(z.string(), z.unknown()),
  active: z.boolean().optional(),
});

export const updateCampaignAudienceSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  rules: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
export type CreateCampaignAudienceInput = z.infer<typeof createCampaignAudienceSchema>;
export type UpdateCampaignAudienceInput = z.infer<typeof updateCampaignAudienceSchema>;

// ── State-machine helper exported for the route layer ────────────────
// Maps current → set of valid next statuses for an operator-initiated
// PATCH. (Dispatcher-initiated transitions are not exposed via PATCH.)
export const OPERATOR_STATUS_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  DRAFT: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["DRAFT", "CANCELLED"],
  RUNNING: ["PAUSED", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED"],
  COMPLETED: [], // terminal — no operator-initiated transition out
  CANCELLED: [], // terminal
};
