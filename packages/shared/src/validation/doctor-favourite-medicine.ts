// Pearl ERP Stage 1 §2.1.4 (gap item #50) — per-doctor favourite-
// medicine quick-add list. Validation for the
// /api/v1/doctors/me/favourites surface (DOCTOR-only):
//   * addFavouriteMedicineSchema — POST one new favourite.
//   * updateFavouriteMedicineSchema — PATCH presets/position; medicineId
//     is immutable post-create (set via POST + delete-recreate, never
//     PATCH).
//   * reorderFavouritesSchema — atomic bulk reorder via a single
//     transaction (drag-and-drop reorder UI semantics).
//
// medicineId accepts either uuid (current Medicine.id default) or cuid
// so the schema isn't brittle if the Medicine model PK ever flips. The
// route handler resolves the actual Medicine record by id and 422s if
// it doesn't exist or isn't in the caller's tenant scope.
import { z } from "zod";

// Medicine.id is uuid in the current schema (line 2106), DoctorFavouriteMedicine.id
// is cuid. Accept either to keep the validation forward-compatible.
const idLike = z.string().min(1).max(64);

export const addFavouriteMedicineSchema = z.object({
  medicineId: idLike,
  position: z.number().int().min(0).max(9999).optional(),
  defaultDosage: z.string().trim().max(50).optional().nullable(),
  defaultFrequency: z.string().trim().max(20).optional().nullable(),
  defaultDuration: z.string().trim().max(30).optional().nullable(),
});

export const updateFavouriteMedicineSchema = z
  .object({
    position: z.number().int().min(0).max(9999).optional(),
    defaultDosage: z.string().trim().max(50).optional().nullable(),
    defaultFrequency: z.string().trim().max(20).optional().nullable(),
    defaultDuration: z.string().trim().max(30).optional().nullable(),
  })
  .refine(
    (b) =>
      b.position !== undefined ||
      b.defaultDosage !== undefined ||
      b.defaultFrequency !== undefined ||
      b.defaultDuration !== undefined,
    { message: "At least one field is required" },
  );

export const reorderFavouritesSchema = z.object({
  items: z
    .array(
      z.object({
        id: idLike,
        position: z.number().int().min(0).max(9999),
      }),
    )
    .min(1)
    .max(500),
});

export type AddFavouriteMedicineInput = z.infer<typeof addFavouriteMedicineSchema>;
export type UpdateFavouriteMedicineInput = z.infer<typeof updateFavouriteMedicineSchema>;
export type ReorderFavouritesInput = z.infer<typeof reorderFavouritesSchema>;
