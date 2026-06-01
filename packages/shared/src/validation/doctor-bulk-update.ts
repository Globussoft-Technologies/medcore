// Pearl ERP Stage 1 §3.1 (gap row 74) — bulk-edit dialog for admins.
//
// Why this exists: admins onboarding a new branch / specialty cohort
// frequently want to apply the same appointment-mode defaults (e.g. "all
// OPD doctors get SLOT mode, token prefix 'O', daily limit 40") across
// 10–80 doctors at once. Today they would PATCH /doctors/:id/appointment-mode
// once per doctor — boring, slow, and easy to drift a field by accident.
//
// Schema shape: `{ doctorIds: string[], updates: <subset of mode knobs> }`.
// `updates` is a subset of `doctorAppointmentModeSchema` so the bulk path
// stays a strict superset of the per-row PATCH semantics (a doctor will
// end up with the same column values either way). The bulk endpoint
// rejects any key not in the allowlist below so a typo can never silently
// no-op or mass-assign an unintended column.
//
// Surface: POST /api/v1/doctors/bulk-update (ADMIN-only, tenant-scoped,
// $transaction-atomic). See apps/api/src/routes/doctors.ts.
import { z } from "zod";

// Allowlist of Doctor columns the bulk endpoint may modify. Mirrors the
// per-row appointment-mode schema (every field is optional individually,
// but the overall `updates` object must contain at least one key — that's
// the .refine() at the bottom). Adding a new bulk-editable column? Update
// this enum + the route's update-payload builder + the doc string.
export const BULK_UPDATE_ALLOWED_FIELDS = [
  "appointmentMode",
  "tokenPrefix",
  "tokenStartNumber",
  "dailyAppointmentLimit",
  "nearTurnAlertThreshold",
  "lastHourPolicy",
  // Pearl §3.1 (gap closed 2026-05-29) — bulk-edit dialog now supports
  // the two remaining mode knobs from §3.2 row 77. Mirrors the
  // per-doctor doctorAppointmentModeSchema entries for `enabledChannels`
  // and `bufferMinutes` so the bulk path is a strict superset of the
  // per-row PATCH semantics.
  "enabledChannels",
  "bufferMinutes",
] as const;

export type BulkUpdateAllowedField = (typeof BULK_UPDATE_ALLOWED_FIELDS)[number];

// `.strict()` makes Zod REJECT any unknown key (rather than stripping it
// silently). This is the mass-assignment guard — if a caller sends
// `{ commissionPercent: 99, isActive: false }` we want a 400, not a quiet
// success that ignored the unknown fields.
export const bulkUpdateDoctorsUpdatesSchema = z
  .object({
    appointmentMode: z.enum(["CALLING", "TOKEN", "SLOT"]).optional(),
    tokenPrefix: z.string().max(8).nullable().optional(),
    tokenStartNumber: z.number().int().min(1).max(99999).nullable().optional(),
    dailyAppointmentLimit: z.number().int().min(1).max(500).nullable().optional(),
    nearTurnAlertThreshold: z.number().int().min(1).max(50).nullable().optional(),
    lastHourPolicy: z
      .enum(["ACCEPT_ALL", "BLOCK_NEW", "WALK_IN_ONLY"])
      .nullable()
      .optional(),
    // Pearl §3.1 (gap closed 2026-05-29). Shape mirrors the per-row
    // doctorAppointmentModeSchema: enabledChannels = array of channel
    // enums (max 4, dedup at consumer); bufferMinutes = 0..120 int.
    enabledChannels: z
      .array(z.enum(["CALLING", "SLOT", "TOKEN", "WALKIN"]))
      .max(4)
      .optional(),
    bufferMinutes: z.number().int().min(0).max(120).optional(),
  })
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "updates must contain at least one field",
  });

export const bulkUpdateDoctorsSchema = z.object({
  // 100-row cap keeps a single $transaction proportional. If a tenant
  // genuinely needs to update 200+ doctors at once, they batch in chunks
  // of 100 client-side. UUID OR CUID — different fixtures historically
  // mint different id shapes; either is fine on the wire.
  doctorIds: z
    .array(z.string().uuid().or(z.string().cuid()))
    .min(1, "doctorIds must contain at least one id")
    .max(100, "doctorIds may not exceed 100 entries per request"),
  updates: bulkUpdateDoctorsUpdatesSchema,
});

export type BulkUpdateDoctorsInput = z.infer<typeof bulkUpdateDoctorsSchema>;
