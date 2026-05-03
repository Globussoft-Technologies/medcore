import { z } from "zod";

export const InteractionSeverity = z.enum([
  "MILD",
  "MODERATE",
  "SEVERE",
  "CONTRAINDICATED",
]);

export const StockMovementType = z.enum([
  "PURCHASE",
  "DISPENSED",
  "RETURNED",
  "EXPIRED",
  "ADJUSTMENT",
  "DAMAGED",
]);

// Manufacturer is REQUIRED on create (Issue #41 — every row must show a
// manufacturer in the list view). The UI sends it as `manufacturer`; the API
// persists it into the `brand` column via mapMedicineInputToPrisma.
// Either `brand` OR `manufacturer` is accepted (they alias), but at least one
// non-empty string is required.
export const createMedicineSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    genericName: z.string().optional(),
    brand: z.string().optional(),
    manufacturer: z.string().optional(),
    form: z.string().optional(),
    strength: z.string().optional(),
    category: z.string().optional(),
    description: z.string().optional(),
    sideEffects: z.string().optional(),
    contraindications: z.string().optional(),
    prescriptionRequired: z.boolean().optional(),
    rxRequired: z.boolean().optional(),
  })
  .refine(
    (v) =>
      (typeof v.manufacturer === "string" && v.manufacturer.trim().length > 0) ||
      (typeof v.brand === "string" && v.brand.trim().length > 0),
    { message: "Manufacturer is required", path: ["manufacturer"] }
  );

// Update schema: every field optional, no manufacturer-required refinement.
export const updateMedicineSchema = z.object({
  name: z.string().min(1).optional(),
  genericName: z.string().optional(),
  brand: z.string().optional(),
  manufacturer: z.string().optional(),
  form: z.string().optional(),
  strength: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  sideEffects: z.string().optional(),
  contraindications: z.string().optional(),
  prescriptionRequired: z.boolean().optional(),
  rxRequired: z.boolean().optional(),
});

export const createDrugInteractionSchema = z.object({
  drugAId: z.string().uuid(),
  drugBId: z.string().uuid(),
  severity: InteractionSeverity,
  description: z.string().min(1, "Description is required"),
});

// Issue #141 + #96 (Apr 2026):
// - medicineId remains a strict UUID — the backend MUST reject a missing
//   medicine selection (the form previously let users submit with no
//   medicine bound, ending up as a Prisma FK 500).
// - quantity / unitCost / sellingPrice are now strictly positive (a stock
//   record with quantity=0 or price=0 is meaningless and obscures real low-
//   stock alerts; reorderLevel may legitimately be 0).
// - expiryDate must be strictly in the future — adding a batch that expires
//   today or earlier would silently sit in inventory and dispense to a
//   patient.
export const createInventoryItemSchema = z
  .object({
    medicineId: z.string().uuid("Medicine is required"),
    batchNumber: z.string().min(1, "Batch number is required"),
    quantity: z
      .number({
        required_error: "Quantity is required",
        invalid_type_error: "Quantity must be a number",
      })
      .int("Quantity must be a whole number")
      .positive("Quantity must be at least 1"),
    unitCost: z
      .number({
        required_error: "Unit cost is required",
        invalid_type_error: "Unit cost must be a number",
      })
      .positive("Unit cost must be greater than 0"),
    sellingPrice: z
      .number({
        required_error: "Selling price is required",
        invalid_type_error: "Selling price must be a number",
      })
      .positive("Selling price must be greater than 0"),
    expiryDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expiry date must be YYYY-MM-DD"),
    supplier: z.string().optional(),
    reorderLevel: z
      .number()
      .int("Reorder level must be a whole number")
      .nonnegative("Reorder level cannot be negative")
      .optional(),
    location: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    // Issue #96: must be strictly in the future. We treat midnight UTC of
    // today as the cut-off so a batch expiring "today" is still rejected
    // (a batch dispensed today would already be expired by law).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exp = new Date(v.expiryDate + "T00:00:00");
    if (!Number.isFinite(exp.getTime()) || exp.getTime() <= today.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiryDate"],
        message: "Expiry date must be in the future",
      });
    }
  });

export const updateInventoryItemSchema = z.object({
  location: z.string().optional(),
  reorderLevel: z.number().int().nonnegative().optional(),
  sellingPrice: z.number().nonnegative().optional(),
});

export const stockMovementSchema = z.object({
  inventoryItemId: z.string().uuid(),
  type: StockMovementType,
  quantity: z.number().int(),
  reason: z.string().optional(),
});

export const dispensePrescriptionSchema = z.object({
  prescriptionId: z.string().uuid(),
});

export const controlledSubstanceSchema = z.object({
  medicineId: z.string().uuid(),
  quantity: z.number().int().positive(),
  patientId: z.string().uuid().optional(),
  prescriptionId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  notes: z.string().optional(),
  // Witness co-signing on Schedule-H/H1 dispense (Drugs and Cosmetics
  // Rules 1945 §65). 2026-05-03 migration. `witnessSignature` is the
  // free-text capture of the witness's printed name + role (e.g.
  // "Dr. Vikram Kapoor / Senior Pharmacist"). `witnessUserId` is an
  // optional FK to the User row if the witness is a staff member with
  // an account; null/omitted for external witnesses. The route enforces
  // that Schedule-H/H1 medicines REQUIRE a non-blank witnessSignature.
  witnessSignature: z
    .string()
    .trim()
    .min(3, "Witness signature must be at least 3 characters")
    .optional(),
  witnessUserId: z.string().uuid().optional(),
});

export type ControlledSubstanceInput = z.infer<typeof controlledSubstanceSchema>;

export const checkInteractionsSchema = z.object({
  medicineIds: z.array(z.string().uuid()).min(1, "Provide at least one medicine"),
});

export type CreateMedicineInput = z.infer<typeof createMedicineSchema>;
export type UpdateMedicineInput = z.infer<typeof updateMedicineSchema>;
export type CreateDrugInteractionInput = z.infer<
  typeof createDrugInteractionSchema
>;
export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;
export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;
export type StockMovementInput = z.infer<typeof stockMovementSchema>;
export type DispensePrescriptionInput = z.infer<
  typeof dispensePrescriptionSchema
>;
export type CheckInteractionsInput = z.infer<typeof checkInteractionsSchema>;

// ─── Pharmacy Returns (Apr 2026) ───────────────────────
export const pharmacyReturnReason = z.enum([
  "EXPIRED",
  "DAMAGED",
  "WRONG_ITEM",
  "PATIENT_RETURNED",
]);

export const pharmacyReturnSchema = z.object({
  inventoryItemId: z.string().uuid(),
  quantity: z.number().int().positive(),
  reason: pharmacyReturnReason,
  refundAmount: z.number().nonnegative().default(0),
  originalDispenseId: z.string().uuid().optional(),
  notes: z.string().optional(),
});

// ─── Stock Transfer ────────────────────────────────────
export const stockTransferSchema = z.object({
  inventoryItemId: z.string().uuid(),
  fromLocation: z.string().min(1),
  toLocation: z.string().min(1),
  quantity: z.number().int().positive(),
  notes: z.string().optional(),
});

// ─── Valuation Method ──────────────────────────────────
export const valuationMethodSchema = z.enum(["FIFO", "LIFO", "WEIGHTED_AVG"]);

export const PHARMACY_RETURN_PREFIX = "PR";
export const STOCK_TRANSFER_PREFIX = "ST";

export type PharmacyReturnInput = z.infer<typeof pharmacyReturnSchema>;
export type StockTransferInput = z.infer<typeof stockTransferSchema>;
export type ValuationMethod = z.infer<typeof valuationMethodSchema>;
