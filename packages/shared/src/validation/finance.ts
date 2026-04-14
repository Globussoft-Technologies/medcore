import { z } from "zod";

// ─── Health Packages ───────────────────────────────────
export const createPackageSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  services: z.string().min(1, "Services are required"),
  price: z.number().positive("Price must be positive"),
  discountPrice: z.number().positive().optional(),
  validityDays: z.number().int().positive().default(365),
  category: z.string().optional(),
});

export const updatePackageSchema = createPackageSchema.partial();

export const purchasePackageSchema = z.object({
  packageId: z.string().uuid(),
  patientId: z.string().uuid(),
  amountPaid: z.number().positive("Amount paid must be positive"),
});

// ─── Suppliers ─────────────────────────────────────────
export const createSupplierSchema = z.object({
  name: z.string().min(1, "Name is required"),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  gstNumber: z.string().optional(),
  paymentTerms: z.string().optional(),
});

export const updateSupplierSchema = createSupplierSchema.partial().extend({
  isActive: z.boolean().optional(),
});

// ─── Purchase Orders ───────────────────────────────────
export const poItemSchema = z.object({
  description: z.string().min(1, "Description is required"),
  medicineId: z.string().uuid().optional(),
  quantity: z.number().positive("Quantity must be positive"),
  unitPrice: z.number().positive("Unit price must be positive"),
});

export const createPOSchema = z.object({
  supplierId: z.string().uuid(),
  items: z.array(poItemSchema).min(1, "At least one item is required"),
  expectedAt: z.string().optional(),
  notes: z.string().optional(),
  taxPercentage: z.number().min(0).max(100).default(0),
});

export const updatePOSchema = z.object({
  items: z.array(poItemSchema).min(1).optional(),
  expectedAt: z.string().optional(),
  notes: z.string().optional(),
  taxPercentage: z.number().min(0).max(100).optional(),
});

export const approvePOSchema = z.object({});

export const receivePOSchema = z.object({
  receivedItems: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        receivedQuantity: z.number().nonnegative(),
      })
    )
    .optional(),
});

// ─── Expenses ──────────────────────────────────────────
export const expenseCategoryEnum = z.enum([
  "SALARY",
  "UTILITIES",
  "EQUIPMENT",
  "MAINTENANCE",
  "CONSUMABLES",
  "RENT",
  "MARKETING",
  "OTHER",
]);

export const createExpenseSchema = z.object({
  category: expenseCategoryEnum,
  amount: z.number().positive("Amount must be positive"),
  description: z.string().min(1, "Description is required"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  paidTo: z.string().optional(),
  referenceNo: z.string().optional(),
});

export const updateExpenseSchema = createExpenseSchema.partial();

// ─── Types ─────────────────────────────────────────────
export type CreatePackageInput = z.infer<typeof createPackageSchema>;
export type UpdatePackageInput = z.infer<typeof updatePackageSchema>;
export type PurchasePackageInput = z.infer<typeof purchasePackageSchema>;
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type POItemInput = z.infer<typeof poItemSchema>;
export type CreatePOInput = z.infer<typeof createPOSchema>;
export type UpdatePOInput = z.infer<typeof updatePOSchema>;
export type ReceivePOInput = z.infer<typeof receivePOSchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

export const EXPENSE_CATEGORIES = [
  "SALARY",
  "UTILITIES",
  "EQUIPMENT",
  "MAINTENANCE",
  "CONSUMABLES",
  "RENT",
  "MARKETING",
  "OTHER",
] as const;

export const PACKAGE_CATEGORIES = [
  "Master Health Checkup",
  "Diabetes Package",
  "Cardiac Package",
  "Pregnancy Care",
  "Senior Citizen",
  "Preventive",
  "Pediatric",
  "Gynec",
  "Other",
] as const;

export const PACKAGE_NUMBER_PREFIX = "PKG";
export const PO_NUMBER_PREFIX = "PO";
