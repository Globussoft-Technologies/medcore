// Material catalog (2026-07) — validation for the general materials module
// (non-medicine store items such as consumables, equipment, instruments, and
// machines) that departments requisition against. Medicines live in the
// dedicated pharmacy / medicines flows instead. Shared between the API route
// and the web admin page.

import { z } from "zod";

export const MATERIAL_CATEGORIES = [
  "CONSUMABLE",
  "EQUIPMENT",
  "INSTRUMENT",
  "MACHINE",
] as const;

const category = z.enum(MATERIAL_CATEGORIES);
const uuid = z.string().uuid();

export const MATERIAL_STOCK_SCOPE_VALUES = ["ALL", "MAIN"] as const;
export const MATERIAL_ADJUSTMENT_LOCATION_VALUES = ["MAIN", "DEPARTMENT"] as const;
export const MATERIAL_ADJUSTMENT_REASON_VALUES = [
  "DAMAGED",
  "CORRECTION",
  "FOUND",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "OTHER",
] as const;
export const MATERIAL_ADJUSTMENT_REQUEST_STATUS_VALUES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
] as const;

const adjustmentLocation = z.enum(MATERIAL_ADJUSTMENT_LOCATION_VALUES);
const adjustmentReason = z.enum(MATERIAL_ADJUSTMENT_REASON_VALUES);
const adjustmentRequestStatus = z.enum(MATERIAL_ADJUSTMENT_REQUEST_STATUS_VALUES);

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
export const adjustMaterialStockSchema = z
  .object({
    locationType: adjustmentLocation.default("MAIN"),
    departmentId: uuid.optional(),
    delta: z.number().int().refine((n) => n !== 0, "Delta cannot be zero"),
    reasonCode: adjustmentReason,
    reasonNote: z.string().trim().max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.locationType === "DEPARTMENT" && !value.departmentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["departmentId"],
        message: "Department is required for a department adjustment",
      });
    }
    if (value.locationType === "MAIN" && value.departmentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["departmentId"],
        message: "departmentId is not allowed for main inventory adjustments",
      });
    }
    if (value.reasonCode === "DAMAGED" && value.delta > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delta"],
        message: "Damaged adjustments must reduce stock",
      });
    }
    if (value.reasonCode === "FOUND" && value.delta < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delta"],
        message: "Found-stock adjustments must increase stock",
      });
    }
    if (value.reasonCode === "OTHER" && !value.reasonNote?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonNote"],
        message: "Please add a note for Other adjustments",
      });
    }
  });
export type AdjustMaterialStockInput = z.infer<typeof adjustMaterialStockSchema>;

export const createMaterialAdjustmentRequestSchema = z
  .object({
    departmentId: uuid,
    delta: z.number().int().negative("Requested adjustment must reduce stock"),
    reasonCode: adjustmentReason,
    reasonNote: z.string().trim().max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (["FOUND", "TRANSFER_IN"].includes(value.reasonCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCode"],
        message: "Department requests may only reduce stock",
      });
    }
    if (value.reasonCode === "OTHER" && !value.reasonNote?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonNote"],
        message: "Please add a note for Other adjustments",
      });
    }
  });
export type CreateMaterialAdjustmentRequestInput = z.infer<
  typeof createMaterialAdjustmentRequestSchema
>;

export const reviewMaterialAdjustmentRequestSchema = z.object({
  status: adjustmentRequestStatus.refine((value) => value !== "PENDING", {
    message: "Review status must be APPROVED or REJECTED",
  }),
  reviewedNote: z.string().trim().max(200).optional(),
});
export type ReviewMaterialAdjustmentRequestInput = z.infer<
  typeof reviewMaterialAdjustmentRequestSchema
>;
