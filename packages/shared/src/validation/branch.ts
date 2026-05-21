// Pearl ERP Stage 1 §7.2 + §8.1 (gap item #2 — piece 1 of 3) — Branch
// CRUD validation. The Branch model is per-tenant; the API resolves
// tenantId from the auth context (NOT the body), so neither schema
// accepts a tenantId field.
//
// Pieces 2 (branchScopedPrisma + branchId on other tables) and 3
// (branch picker UI + report filters) will land later — this validation
// only covers the schema-only piece 1 surface.
import { z } from "zod";

// Short branch codes like "MAIN", "JKR", "BTM" — uppercase letters/digits.
const branchCodeRegex = /^[A-Z0-9_-]{1,10}$/;

// Indian PIN code: exactly 6 digits.
const pincodeRegex = /^\d{6}$/;

// Loose phone regex — international or local digits, optional leading +.
const phoneRegex = /^\+?\d{7,15}$/;

// GSTIN — 15-char alphanumeric (2 state + 10 PAN + 1 entity + 1 Z + 1 check).
const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export const createBranchSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(branchCodeRegex, "Branch code must be 1-10 uppercase alphanumerics")
    .optional()
    .nullable(),
  address: z.string().trim().max(512).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  state: z.string().trim().max(80).optional().nullable(),
  pincode: z.string().trim().regex(pincodeRegex, "Pincode must be 6 digits").optional().nullable(),
  phone: z.string().trim().regex(phoneRegex, "Invalid phone").optional().nullable(),
  email: z.string().email("Invalid email").optional().nullable(),
  gstin: z.string().trim().toUpperCase().regex(gstinRegex, "Invalid GSTIN").optional().nullable(),
  isDefault: z.boolean().optional().default(false),
});

export const updateBranchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(branchCodeRegex, "Branch code must be 1-10 uppercase alphanumerics")
    .nullable()
    .optional(),
  address: z.string().trim().max(512).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  state: z.string().trim().max(80).nullable().optional(),
  pincode: z.string().trim().regex(pincodeRegex, "Pincode must be 6 digits").nullable().optional(),
  phone: z.string().trim().regex(phoneRegex, "Invalid phone").nullable().optional(),
  email: z.string().email("Invalid email").nullable().optional(),
  gstin: z.string().trim().toUpperCase().regex(gstinRegex, "Invalid GSTIN").nullable().optional(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
});

export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
