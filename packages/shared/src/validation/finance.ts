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
// Issue #63: canonical GSTIN format — 15 chars, structured per India's CBIC
// notification: 2-digit state code, 5-letter PAN body, 4-digit PAN seq, 1-letter
// PAN check, 1 entity number (1-9 or A-Z), literal "Z", 1 alnum checksum.
// Centralised here so the supplier seed, supplier UI, and tests all share one
// source of truth — previously each call site re-rolled its own regex with
// drift potential.
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function isValidGstin(value: string | null | undefined): boolean {
  if (!value) return false;
  return GSTIN_REGEX.test(value);
}

export const createSupplierSchema = z.object({
  name: z.string().min(1, "Name is required"),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  // Allow empty string for "not provided"; otherwise enforce canonical format.
  gstNumber: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || v === "" || GSTIN_REGEX.test(v),
      "GSTIN must match 2-digit state, 5-letter PAN, 4-digit seq, PAN check letter, entity number, Z, and a final alphanumeric (15 chars total).",
    ),
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
  notes: z.string().optional(),
  invoiceNumber: z.string().optional(),
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

// Issue #64: expenses must reflect work that has already happened — future-
// dated rows could be used to game month-end totals or pre-book reimbursements
// the books haven't accrued yet. We compare against the user's local "today"
// at the YYYY-MM-DD level (timezone-agnostic string compare) so a clerk in
// IST can record an expense up to 23:59 of the same calendar day.
function isNotFutureDate(yyyyMmDd: string): boolean {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return yyyyMmDd <= todayStr;
}

export const createExpenseSchema = z.object({
  category: expenseCategoryEnum,
  amount: z.number().positive("Amount must be positive"),
  description: z.string().min(1, "Description is required"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .refine(isNotFutureDate, "Expense date cannot be in the future"),
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

// Invoice line-item categories (kept as string literals to match the
// `InvoiceItem.category` Prisma column, which is a free-form `String`).
export const INVOICE_ITEM_CATEGORIES = [
  "CONSULTATION",
  "PROCEDURE",
  "LAB",
  "RADIOLOGY",
  "PHARMACY",
  "MEDICINE",
  "ROOM_CHARGE",
  "SURGERY",
  "OTHER",
] as const;

export type InvoiceItemCategory = (typeof INVOICE_ITEM_CATEGORIES)[number];

// Per-category GST rates (intra-state total; CGST+SGST = this).
// For inter-state invoices the same rate applies as IGST (single column).
// Notes per PRD guidance:
//   - Consultations are GST-exempt (health-care services under notification 12/2017).
//   - Essential medicines may be 5%; we default MEDICINE to 12% for OTC/non-essentials.
//   - Hospital room charges are exempt for IPD <=Rs.5000/day; we default to 12%.
export const GST_RATE_BY_CATEGORY: Record<string, number> = {
  CONSULTATION: 0,
  MEDICINE: 12,
  PHARMACY: 12,
  LAB: 12,
  RADIOLOGY: 12,
  PROCEDURE: 18,
  SURGERY: 18,
  ROOM_CHARGE: 12,
  ROOM: 12, // legacy alias used by some older seeds / UI
  OTHER: 18,
};

// Canonical HSN / SAC codes per category (SAC 9993 = human health services).
// Stored as strings to preserve any leading zeros and because GSTR forms
// expect string values.
export const HSN_SAC_BY_CATEGORY: Record<string, string> = {
  CONSULTATION: "9993",
  PROCEDURE: "9993",
  SURGERY: "9993",
  LAB: "9993",
  RADIOLOGY: "9993",
  ROOM_CHARGE: "9993",
  ROOM: "9993",
  // Medicines move goods, so HSN (not SAC). 3004 covers formulated drugs.
  MEDICINE: "3004",
  PHARMACY: "3004",
  OTHER: "9993",
};

// Resolve the GST rate for a line-item category. Unknown categories fall
// back to DEFAULT_GST_PERCENT so nothing "looks free" by accident.
export function gstRateForCategory(category?: string | null): number {
  if (!category) return DEFAULT_GST_PERCENT;
  const key = category.toUpperCase();
  const rate = GST_RATE_BY_CATEGORY[key];
  return rate === undefined ? DEFAULT_GST_PERCENT : rate;
}

export function hsnSacForCategory(category?: string | null): string {
  if (!category) return "9993";
  const key = category.toUpperCase();
  return HSN_SAC_BY_CATEGORY[key] ?? "9993";
}

// Map a free-text service / line-item description to a canonical invoice
// category. Used by the web Add-Line-Item form to pre-fill the Category
// dropdown when a clerk picks a service. The user can still manually
// override. Matching is case-insensitive and substring-based so
// "X-Ray Chest", "X-ray (chest)", and "Chest X Ray" all land on RADIOLOGY.
export function categorizeService(description?: string | null): InvoiceItemCategory {
  if (!description) return "CONSULTATION";
  const d = description.toLowerCase();

  // Order matters: more specific / unambiguous keywords first.
  // Imaging / radiology — always wins because it's orthogonal to the
  // consult/surgery/lab axes ("X-Ray Consultation" still bills as imaging).
  if (
    /\b(x[- ]?ray|mri|ct\b|ct[- ]scan|ultrasound|sonograph|mammograph|doppler|pet[- ]?scan|dexa)\b/.test(
      d
    )
  ) {
    return "RADIOLOGY";
  }

  // Consultations come next: a line like "Consultation — General Medicine"
  // must resolve to CONSULTATION, not MEDICINE. The keyword is highly
  // specific so false positives from other buckets are unlikely.
  if (/\b(consult|consultation|follow[- ]?up|review|opd visit|visit fee)/.test(d)) {
    return "CONSULTATION";
  }

  // Surgery / operative procedures
  if (/\b(surgery|surgical|operation|appendectomy|cholecystectomy|laparotom)/.test(d)) {
    return "SURGERY";
  }
  if (/\b(procedure|biopsy|endoscopy|colonoscopy|ecg|ekg|eeg|dialysis|suture|dressing)\b/.test(d)) {
    return "PROCEDURE";
  }

  // Lab work
  if (/\b(lab|test|panel|cbc|culture|pathology|blood test|urine|stool|swab|haemogram|hemogram|lipid|thyroid|glucose|hba1c)\b/.test(d)) {
    return "LAB";
  }

  // Pharmacy / medicine — checked AFTER consultation so "General Medicine"
  // in a consult description doesn't hijack the category.
  if (/\b(medicine|tablet|tab\.|capsule|cap\.|syrup|injection|inj\.|ointment|drops|cream|antibiotic|vaccine)\b/.test(d)) {
    return "MEDICINE";
  }

  // Room / bed charges
  if (/\b(bed|room charge|room rent|icu|ward|cabin|suite|nicu|hdu)\b/.test(d)) {
    return "ROOM_CHARGE";
  }

  return "CONSULTATION";
}

// Compute the CGST + SGST + total breakdown for a single line item. Used by
// the invoice renderer (web + PDF) when the DB doesn't persist per-item tax.
export interface LineItemTaxBreakdown {
  taxable: number;
  gstRate: number;
  cgst: number;
  sgst: number;
  total: number;
  hsnSac: string;
}

export function computeLineItemTax(
  amount: number,
  category?: string | null
): LineItemTaxBreakdown {
  const rate = gstRateForCategory(category);
  const taxable = +amount.toFixed(2);
  const taxAmount = +((taxable * rate) / 100).toFixed(2);
  const cgst = +(taxAmount / 2).toFixed(2);
  const sgst = +(taxAmount - cgst).toFixed(2); // avoid rounding drift
  return {
    taxable,
    gstRate: rate,
    cgst,
    sgst,
    total: +(taxable + cgst + sgst).toFixed(2),
    hsnSac: hsnSacForCategory(category),
  };
}

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

// ─── Payment Plans / EMI (Apr 2026) ────────────────────
export const paymentPlanFrequency = z.enum(["MONTHLY", "WEEKLY", "BIWEEKLY"]);

export const paymentPlanSchema = z.object({
  invoiceId: z.string().uuid(),
  downPayment: z.number().nonnegative().default(0),
  installments: z.number().int().min(2).max(60),
  frequency: paymentPlanFrequency.default("MONTHLY"),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
});

export const installmentPaymentSchema = z.object({
  installmentId: z.string().uuid(),
  amount: z.number().positive(),
  mode: z.enum(["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"]),
  transactionId: z.string().optional(),
});

// ─── Pre-Authorization ─────────────────────────────────
export const preAuthRequestSchema = z.object({
  patientId: z.string().uuid(),
  insuranceProvider: z.string().min(1),
  policyNumber: z.string().min(1),
  procedureName: z.string().min(1),
  estimatedCost: z.number().positive(),
  diagnosis: z.string().optional(),
  supportingDocs: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const updatePreAuthStatusSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "PARTIAL"]),
  approvedAmount: z.number().nonnegative().optional(),
  rejectionReason: z.string().optional(),
  claimReferenceNumber: z.string().optional(),
  notes: z.string().optional(),
});

// ─── Discount Approval ─────────────────────────────────
export const discountApprovalSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.number().positive(),
  percentage: z.number().min(0).max(100).optional(),
  reason: z.string().min(1).max(500),
});

export const rejectDiscountSchema = z.object({
  rejectionReason: z.string().min(1).max(500),
});

// ─── Constants ─────────────────────────────────────────
export const PAYMENT_PLAN_PREFIX = "PP";
export const PREAUTH_PREFIX = "PA";

export type PaymentPlanInput = z.infer<typeof paymentPlanSchema>;
export type InstallmentPaymentInput = z.infer<typeof installmentPaymentSchema>;
export type PreAuthRequestInput = z.infer<typeof preAuthRequestSchema>;
export type UpdatePreAuthStatusInput = z.infer<typeof updatePreAuthStatusSchema>;
export type DiscountApprovalInput = z.infer<typeof discountApprovalSchema>;
