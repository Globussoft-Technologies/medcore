// Department module (2026-07) — validation for the admin department CRUD.
//
// Shared between the API route (apps/api/src/routes/departments.ts) and the
// web admin page so both agree on the payload shapes. Departments are the
// operational units (Pharmacy, Lab, OT, Nursing …) that raise requisitions
// against the central store — NOT doctor specializations.

import { z } from "zod";

// Code: short, uppercase, machine-friendly (e.g. "DENTAL", "GEN_OPD"). Unique
// per tenant (enforced by the @@unique([tenantId, code]) DB constraint). We
// normalize to uppercase and allow letters, digits and underscores only.
const code = z
  .string()
  .trim()
  .min(2, "Code must be at least 2 characters")
  .max(20, "Code is too long")
  .regex(/^[A-Za-z0-9_]+$/, "Code may only contain letters, digits and underscores")
  .transform((s) => s.toUpperCase());

const name = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name is too long");

// ── Create a department (admin) ───────────────────────────────────────────
export const createDepartmentSchema = z.object({
  name,
  code,
});
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

// ── Update a department (admin) — all fields optional (partial edit) ──────
export const updateDepartmentSchema = z
  .object({
    name: name.optional(),
    code: code.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
