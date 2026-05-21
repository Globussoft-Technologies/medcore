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

// ── Audience rule DSL (piece 2a of 4 — 2026-05-21) ─────────────────────
//
// The compiler (`apps/api/src/services/audience-compiler.ts`) turns this
// JSON into a Prisma `where` over Patient. v1 supports a small predicate
// set per the PRD §5.1 "demographic + clinical filters" requirement.
//
// Design note — permissive runtime shape over strict discriminated union:
//   We use a permissive `{ field, op, value }` triple at the Zod level
//   (any string field / op, value unknown) rather than the strict
//   `z.discriminatedUnion` of every (field, op, value) combination. Why:
//   1) Tenants' saved audiences must survive DSL evolution — a future
//      field/op rename should NOT 400 their existing campaigns.
//   2) The piece-1 integration tests already shipped audiences with
//      `op:"gt"` and `field:"chronicConditions.code"` (out-of-v1-DSL).
//      Compiler treats unknown predicates as no-op + warns; storage
//      stays lossless.
//   3) The compiler is the single source of truth for which (field, op)
//      pairs actually filter. Zod just enforces *structural* validity
//      (filters is an array, matchMode is ALL/ANY, top-level keys are
//      `filters` / `matchMode` only — see `.strict()` below).
//
// v1-supported predicates (handled by compiler — anything else is no-op):
//   - { field: "gender", op: "eq", value: "MALE" | "FEMALE" | "OTHER" }
//   - { field: "age", op: "gte" | "lte", value: number }
//       (computed from Patient.dateOfBirth)
//   - { field: "lastVisitDays", op: "gte" | "lte", value: number }
//       (days since most recent Appointment.date; gte = "no visit in
//        last N days", lte = "had a visit within N days")
//   - { field: "abhaLinked", op: "eq", value: boolean }
//       (boolean → Patient.abhaId IS NULL / IS NOT NULL)
//   - { field: "city", op: "eq" | "in", value: string | string[] }
//       (NOTE: Patient has no `city` column in the current schema; the
//        compiler emits a no-op + warning for this filter until Patient
//        gains an address.city field. Documented in the gap doc.)
//   - { field: "branchId", op: "eq", value: string }
//       (NOTE: Patient.branchId does NOT exist yet — only Appointment
//        has branchId per `f37570c`. Compiler emits a no-op + warning
//        for this filter until Pearl gap #2 piece 2b lands. Documented
//        in the gap doc.)
//   - { field: "optedOut", op: "eq", value: boolean }
//       (no Patient.optedOut column today either — compiler emits no-op
//        + warning. NotificationPreference is per-user-per-channel, so
//        "globally opted out" can't be expressed without a join the
//        compiler doesn't yet do. Documented in the gap doc.)

export const AUDIENCE_FILTER_FIELDS = [
  "gender",
  "age",
  "lastVisitDays",
  "abhaLinked",
  "city",
  "branchId",
  "optedOut",
] as const;

export const AUDIENCE_FILTER_OPS = ["eq", "gte", "lte", "in"] as const;

export const AUDIENCE_MATCH_MODES = ["ALL", "ANY"] as const;

// A single filter triple. Permissive at Zod (field/op are strings; value
// is unknown) so saved campaigns survive DSL evolution and the unknown-
// field test from piece 1 still passes. Compiler handles the (field, op)
// → Prisma `where`-clause mapping and warns on unknown pairs.
export const audienceFilterSchema = z
  .object({
    field: z.string().trim().min(1).max(80),
    op: z.string().trim().min(1).max(20),
    value: z.unknown(),
  })
  .strict();

// Top-level rules envelope. `.strict()` rejects unknown TOP-level keys —
// this is what the spec calls "malformed rules → 400 from Zod
// refinement". Unknown FILTER fields are handled by the compiler as
// no-ops, not by Zod (see design note above).
export const audienceRulesSchema = z
  .object({
    filters: z.array(audienceFilterSchema).optional(),
    matchMode: z.enum(AUDIENCE_MATCH_MODES).optional(),
  })
  .strict();

export type AudienceFilter = z.infer<typeof audienceFilterSchema>;
export type AudienceRules = z.infer<typeof audienceRulesSchema>;

// ── createCampaignAudienceSchema ─────────────────────────────────────
export const createCampaignAudienceSchema = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  rules: audienceRulesSchema,
  active: z.boolean().optional(),
});

export const updateCampaignAudienceSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  rules: audienceRulesSchema.optional(),
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
