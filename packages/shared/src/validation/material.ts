// Material catalog (2026-07) — validation for the general materials module
// (medicines, consumables, equipment, instruments, machines) that departments
// requisition against. Shared between the API route and the web admin page.

import { z } from "zod";

export const MATERIAL_CATEGORIES = [
  "MEDICINE",
  "CONSUMABLE",
  "EQUIPMENT",
  "INSTRUMENT",
  "MACHINE",
] as const;

const category = z.enum(MATERIAL_CATEGORIES);

// ── Create a material (admin / pharmacist / store) ─────────────────────────
export const createMaterialSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
  sku: z.string().trim().max(40).optional(),
  category,
  unit: z.string().trim().min(1).max(20).default("unit"),
  quantity: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(10),
  unitCost: z.number().min(0).optional(),
  location: z.string().trim().max(120).optional(),
});
export type CreateMaterialInput = z.infer<typeof createMaterialSchema>;

// ── Update a material — all fields optional (partial edit) ─────────────────
export const updateMaterialSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    sku: z.string().trim().max(40).nullable().optional(),
    category: category.optional(),
    unit: z.string().trim().min(1).max(20).optional(),
    reorderLevel: z.number().int().min(0).optional(),
    unitCost: z.number().min(0).nullable().optional(),
    location: z.string().trim().max(120).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateMaterialInput = z.infer<typeof updateMaterialSchema>;

// ── Adjust stock (add / correct on-hand) ───────────────────────────────────
// delta may be negative (a correction); the route rejects moves that would
// push quantity below the reserved amount.
export const adjustMaterialStockSchema = z.object({
  delta: z.number().int().refine((n) => n !== 0, "Delta cannot be zero"),
  reason: z.string().trim().max(200).optional(),
});
export type AdjustMaterialStockInput = z.infer<typeof adjustMaterialStockSchema>;
