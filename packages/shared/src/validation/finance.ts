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
  maxFamilyMembers: z.number().int().min(1).default(1).optional(),
});

export const updatePackageSchema = createPackageSchema.partial();

export const purchasePackageSchema = z.object({
  packageId: z.string().uuid(),
  patientId: z.string().uuid(),
  amountPaid: z.number().positive("Amount paid must be positive"),
  familyMemberIds: z.array(z.string().uuid()).optional(),
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
  contractStart: z.string().optional(),
  contractEnd: z.string().optional(),
});

export const updateSupplierSchema = createSupplierSchema.partial().extend({
  isActive: z.boolean().optional(),
  rating: z.number().min(0).max(5).optional(),
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
  isRecurring: z.boolean().default(false).optional(),
  recurringFrequency: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).optional(),
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
  attachmentPath: z.string().optional(),
  isRecurring: z.boolean().default(false).optional(),
  recurringFrequency: z.enum(["MONTHLY", "QUARTERLY", "YEARLY"]).optional(),
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
export const GRN_NUMBER_PREFIX = "GRN";
export const CREDIT_NOTE_PREFIX = "CN";
export const ADVANCE_RECEIPT_PREFIX = "ADV";

// ─── GST Defaults ──────────────────────────────────────
export const DEFAULT_GST_PERCENT = 18;

// ─── Credit Note ───────────────────────────────────────
export const createCreditNoteSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.number().positive("Amount must be positive"),
  reason: z.string().min(1).max(500),
});

// ─── Advance Payment ───────────────────────────────────
export const createAdvancePaymentSchema = z.object({
  patientId: z.string().uuid(),
  amount: z.number().positive(),
  mode: z.enum(["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"]),
  transactionId: z.string().optional(),
  notes: z.string().optional(),
});

export const applyAdvanceSchema = z.object({
  advanceId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amount: z.number().positive(),
});

// ─── Supplier Enhancements ─────────────────────────────
export const supplierPaymentSchema = z.object({
  supplierId: z.string().uuid(),
  poId: z.string().uuid().optional(),
  amount: z.number().positive(),
  mode: z.enum(["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"]),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

export const supplierCatalogItemSchema = z.object({
  medicineId: z.string().uuid().optional(),
  itemName: z.string().min(1),
  unitPrice: z.number().positive(),
  moq: z.number().int().positive().default(1),
  leadTimeDays: z.number().int().nonnegative().default(7),
});

// ─── GRN ───────────────────────────────────────────────
export const createGrnSchema = z.object({
  poId: z.string().uuid(),
  invoiceNumber: z.string().optional(),
  notes: z.string().optional(),
  items: z
    .array(
      z.object({
        poItemId: z.string().uuid(),
        quantity: z.number().positive(),
        batchNumber: z.string().optional(),
        expiryDate: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

// ─── Expense Enhancements ──────────────────────────────
export const EXPENSE_APPROVAL_THRESHOLD = 10000;

export const approveExpenseSchema = z.object({
  approved: z.boolean(),
  rejectionReason: z.string().optional(),
});

export const expenseBudgetSchema = z.object({
  category: expenseCategoryEnum,
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  amount: z.number().nonnegative(),
  notes: z.string().optional(),
});

// ─── Package Enhancements ──────────────────────────────
export const packageConsumptionSchema = z.object({
  service: z.string().min(1),
  patientId: z.string().uuid().optional(),
  appointmentId: z.string().uuid().optional(),
  notes: z.string().optional(),
});

export const renewPackageSchema = z.object({
  amountPaid: z.number().positive(),
});
