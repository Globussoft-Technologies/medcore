// SOW row M4 — care cohorts (named patient groups) validation.
//
// A cohort = a saved patient list ("Diabetic patients on insulin",
// "ANC 3rd trimester"). Mirrors the leads.ts shape: createX / updateX
// pairs, generous strings, nullable optionals so PATCH bodies stay
// sparse.

import { z } from "zod";

// Name + description are operator-typed so they don't carry a strict
// HTML/script guard at this layer — the global sanitize middleware strips
// the dangerous bits before this schema runs.
export const createCohortSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
  description: z.string().max(2000).optional().nullable(),
});

export const updateCohortSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  // archivedAt is set via the soft-delete endpoint (POST /:id/archive +
  // /:id/restore) rather than directly through PATCH, matching the
  // tenant suspend/restore convention used elsewhere in the codebase.
});

// Adding a single member at a time. Bulk add is a separate endpoint —
// see addCohortMembersSchema below — so the "add one" UX (single
// EntityPicker) stays a tight payload.
export const addCohortMemberSchema = z.object({
  patientId: z.string().uuid("patientId must be a valid UUID"),
  note: z.string().max(500).optional().nullable(),
});

// Bulk-add: an array of patientIds (e.g. from a filter-then-select UX).
// The route dedupes against existing members per the unique constraint,
// so resubmitting the same set is idempotent.
export const addCohortMembersSchema = z.object({
  patientIds: z
    .array(z.string().uuid())
    .min(1, "At least one patientId is required")
    .max(500, "Bulk add capped at 500 patients per request"),
});

export type CreateCohortInput = z.infer<typeof createCohortSchema>;
export type UpdateCohortInput = z.infer<typeof updateCohortSchema>;
export type AddCohortMemberInput = z.infer<typeof addCohortMemberSchema>;
export type AddCohortMembersInput = z.infer<typeof addCohortMembersSchema>;
