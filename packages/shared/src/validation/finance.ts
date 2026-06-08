import { z } from "zod";

// ─── Health Packages ───────────────────────────────────
// Issue #730: previously the API accepted negative prices because the form
// posted them through unchecked. `price` and `discountPrice` are amounts in
// rupees; both must be strictly greater than zero. Validity days too — a
// 0-day "valid" package is meaningless.
export const createPackageSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  services: z.string().min(1, "Services are required"),
  price: z.number().positive("Price must be greater than 0"),
  discountPrice: z
    .number()
    .positive("Discount price must be greater than 0")
    .optional(),
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

// Issues #310 / #294 (2026-04-26): suppliers historically accepted any
// string for phone (incl. "asdf") and any malformed GSTIN — the only
// validation was on email. Reuse the same E.164-ish phone regex as
// patient.ts (10–15 digits, optional leading +) and surface a clear
// per-field message via the standard zod path so `extractFieldErrors`
// renders it next to the input.
const SUPPLIER_PHONE_REGEX = /^\+?\d{10,15}$/;

export const createSupplierSchema = z.object({
  name: z.string().min(1, "Name is required"),
  contactPerson: z.string().optional(),
  phone: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || v === "" || SUPPLIER_PHONE_REGEX.test(v),
      "Phone must be 10–15 digits, optional leading +"
    ),
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
// Issue #693 (May 2026): the New PO form was accepting decimal qty (e.g.
// 0.5 widgets) and zero qty would silently slip through if the user typed
// "0" then submitted — the prior `.positive()` on its own rejects 0 but
// allowed non-integer values that the warehouse can't actually receive.
// Tighten to integer + strictly > 0 so a PO line item is always at least
// one whole unit. Description min(1) already enforces "no empty supplier
// line"; the supplier-required check sits on `createPOSchema.supplierId`.
export const poItemSchema = z.object({
  description: z.string().min(1, "Description is required"),
  medicineId: z.string().uuid().optional(),
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .positive("Quantity must be at least 1"),
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

// Canonical billing UNIT per line-item category — the single source of truth
// used by the invoice table + PDF + admission running-bill so "Qty 1" reads
// "1 day" etc. ONLY bed charges have a quantity whose meaning is unambiguous
// regardless of how the line was created (always bed-days):
//   ROOM_CHARGE / ROOM → day(s).
// Every other category prints a bare count because the quantity's meaning
// isn't inferable from the category alone:
//   PHARMACY / MEDICINE — doses (IPD administrations) vs packs/strips (manual);
//     the description carries the drug + strength.
//   LAB — number of tests vs panels.
//   RADIOLOGY — "scans" vs films/views/studies.
//   CONSULTATION — rendered as its own line (per doctor + date), not a Qty.
export const UNIT_BY_CATEGORY: Record<string, string> = {
  ROOM_CHARGE: "day",
  ROOM: "day",
};

// The unit word for a category ("day", "dose", …) or null when the category
// has no natural unit (procedure, surgery, other → a bare count).
export function unitForCategory(category?: string | null): string | null {
  if (!category) return null;
  return UNIT_BY_CATEGORY[category.toUpperCase()] ?? null;
}

// Format a quantity with its category unit, pluralised: (ROOM_CHARGE, 2) →
// "2 days"; (LAB, 1) → "1 test"; (OTHER, 3) → "3".
export function formatQuantityWithUnit(
  category: string | null | undefined,
  qty: number,
): string {
  const unit = unitForCategory(category);
  if (!unit) return String(qty);
  return `${qty} ${qty === 1 ? unit : `${unit}s`}`;
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

// ─── Single source of truth for invoice totals (#202, #236) ──────────
// Older invoices were persisted with `taxAmount: 0` while the renderer
// derived per-line GST from category. That left the footer "Total" stuck
// at the pre-tax subtotal — short-changing GST collection by 18% and
// breaking GSTR-1 reconciliation. This helper takes the single line-item
// list + persisted overrides and returns a consistent breakdown that the
// web detail view, the PDF generator, and any future consumer all agree
// on. The rule is: prefer the larger of (persisted taxAmount,
// sum-of-per-line-tax) so that we never under-bill, and recompute Total
// from those — never echo an unverified persisted Total.
export interface InvoiceTotalBreakdown {
  subtotal: number;
  cgstAmount: number;
  sgstAmount: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  /**
   * True when the persisted invoice.totalAmount disagreed with the
   * recomputed total by more than 1 paisa. UIs may want to surface a
   * "data corrected on display" hint. The PDF + web detail page rely
   * on this to ensure they never echo a stale persisted Total.
   */
  totalAmountWasCorrected: boolean;
}

export interface InvoiceLineForTotals {
  amount: number;
  category?: string | null;
}

export function computeInvoiceTotals(
  items: ReadonlyArray<InvoiceLineForTotals>,
  persisted: {
    subtotal?: number;
    taxAmount?: number;
    cgstAmount?: number;
    sgstAmount?: number;
    discountAmount?: number;
    totalAmount?: number;
  } = {}
): InvoiceTotalBreakdown {
  const subtotal =
    persisted.subtotal !== undefined
      ? persisted.subtotal
      : items.reduce((s, it) => s + (it.amount || 0), 0);
  const lineTaxes = items.map((it) => computeLineItemTax(it.amount || 0, it.category));
  const sumLineCgst = +lineTaxes.reduce((s, t) => s + t.cgst, 0).toFixed(2);
  const sumLineSgst = +lineTaxes.reduce((s, t) => s + t.sgst, 0).toFixed(2);
  const sumLineTax = +(sumLineCgst + sumLineSgst).toFixed(2);

  // Prefer the persisted aggregate when it matches (or exceeds) what the
  // line items imply — it represents what was actually billed. Otherwise
  // fall back to the per-line sum so a `taxAmount: 0` snapshot doesn't
  // hide GST that the line breakdown itself shows. We treat the larger
  // of `taxAmount` and `cgstAmount + sgstAmount` as authoritative; some
  // older snapshots filled only the split columns.
  const persistedSplit = +(
    (persisted.cgstAmount ?? 0) + (persisted.sgstAmount ?? 0)
  ).toFixed(2);
  const persistedTax = Math.max(persisted.taxAmount ?? 0, persistedSplit);
  const useLineSum = persistedTax + 0.01 < sumLineTax;
  const cgstAmount = useLineSum
    ? sumLineCgst
    : persisted.cgstAmount !== undefined
      ? persisted.cgstAmount
      : +(persistedTax / 2).toFixed(2);
  const sgstAmount = useLineSum
    ? sumLineSgst
    : persisted.sgstAmount !== undefined
      ? persisted.sgstAmount
      : +(persistedTax - cgstAmount).toFixed(2);
  const taxAmount = +(cgstAmount + sgstAmount).toFixed(2);

  const discountAmount = persisted.discountAmount ?? 0;
  const recomputedTotal = +(subtotal + taxAmount - discountAmount).toFixed(2);
  const totalAmount = Math.max(0, recomputedTotal);
  const persistedTotal = persisted.totalAmount;
  const totalAmountWasCorrected =
    persistedTotal !== undefined &&
    Math.abs((persistedTotal ?? 0) - totalAmount) > 0.01;

  return {
    subtotal: +subtotal.toFixed(2),
    cgstAmount,
    sgstAmount,
    taxAmount,
    discountAmount: +discountAmount.toFixed(2),
    totalAmount,
    totalAmountWasCorrected,
  };
}

// ─── Payment status truth (#235) ────────────────────────────────────
// The backend mostly keeps `paymentStatus` in sync with payments, but
// historical rows + race conditions have produced "PAID" rows with a
// non-zero balance. Showing the badge as PAID while the Balance column
// is red is a financial-integrity bug. This helper is the single rule
// every UI uses to decide what to actually display: it never alters
// stored data, only the rendered string.
export type PaymentStatusDisplay = "PAID" | "PARTIAL" | "PENDING" | "REFUNDED" | "CANCELLED";

export function derivePaymentStatus(
  persistedStatus: string | null | undefined,
  totalAmount: number,
  netPaid: number
): PaymentStatusDisplay {
  // CANCELLED / REFUNDED rows are terminal — preserve them verbatim so
  // the watermark + audit trail remain truthful.
  if (persistedStatus === "CANCELLED") return "CANCELLED";
  if (persistedStatus === "REFUNDED") return "REFUNDED";

  const balance = +(totalAmount - netPaid).toFixed(2);
  // Treat anything within 1-paisa of zero as fully paid (rounding hygiene).
  if (balance <= 0.01) {
    if (netPaid <= 0.01 && totalAmount <= 0.01) {
      // Zero-amount invoice with no payments — surface the persisted
      // value (or PENDING by default) instead of misleading "PAID".
      return (persistedStatus as PaymentStatusDisplay) || "PENDING";
    }
    return "PAID";
  }
  if (netPaid > 0.01) return "PARTIAL";
  return "PENDING";
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

// Issue #297 (2026-04-26): the previous `.nonnegative()` accepted 0 and
// negative values would slip past the UI on a second submit. Tighten to
// `.positive()` so a budget always represents real allocated spend.
export const expenseBudgetSchema = z.object({
  category: expenseCategoryEnum,
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  amount: z.number().positive("Budget amount must be greater than 0"),
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
// Issue #729: pre-auth `estimatedCost` was previously left at the bare
// `.positive()` default, which produced "Number must be greater than 0" — a
// generic message that didn't read as an estimated-cost validation in the
// FE toast. Pin a clear, user-facing message and keep the strict > 0 floor
// so that zero / negative values (which would corrupt downstream insurance
// claim batches) cannot be persisted.
//
// Issue #578 (2026-05-08): the modal previously also accepted absurd amounts
// (e.g. `1e15`), free-text diagnosis garbage like "abcde", and policy IDs of
// any length / shape (incl. SQL-injection payloads). Tighten:
//   - estimatedCost capped at PREAUTH_MAX_AMOUNT (Rs 10 crore = 1e7) — covers
//     any realistic single-procedure pre-auth in the Indian market while
//     blocking float-overflow / display-corrupting inputs.
//   - diagnosis (when provided) must match ICD-10 shape (letter + 2 digits,
//     optional .digits, optional trailing alpha) OR a free-text clinical
//     summary of >= 4 chars. The strict ICD-10 lookup is deferred (#578.C2);
//     the format guard at least rejects pure-junk like "abcde" or "$#@!".
//   - policyNumber: 3-40 chars, alnum + hyphen + slash + space only. Long
//     enough for IRDA member-IDs (typically 12-18 chars) but tight enough to
//     reject SQLi payloads and overflow attempts.
export const PREAUTH_MAX_AMOUNT = 10_000_000; // Rs 10 crore single pre-auth ceiling

// ICD-10 canonical shape: 1 letter (A-Z, case-insensitive accepted), 2 digits,
// optional .[1-4 alnum] suffix. Matches "I10", "E11.9", "S72.001A". We accept
// either a recognisable code OR a >= 4-char clinical narrative — clinicians
// frequently dictate prose ("Acute appendicitis with peritonitis") while
// claims teams enter the code. Pure-junk strings of < 4 chars or matching
// neither shape are rejected.
const ICD10_REGEX = /^[A-Za-z]\d{2}(?:\.\d{1,4}[A-Za-z]?)?$/;
const POLICY_NUMBER_REGEX = /^[A-Za-z0-9][A-Za-z0-9 \-/]{1,38}[A-Za-z0-9]$/;

export const preAuthRequestSchema = z.object({
  patientId: z.string().uuid(),
  insuranceProvider: z.string().min(2, "Insurance provider is required").max(120),
  policyNumber: z
    .string()
    .min(3, "Policy number must be at least 3 characters")
    .max(40, "Policy number must be at most 40 characters")
    .regex(
      POLICY_NUMBER_REGEX,
      "Policy number may contain letters, digits, hyphens, slashes and spaces only",
    ),
  procedureName: z.string().min(1).max(200),
  estimatedCost: z
    .number()
    .positive("Estimated cost must be greater than 0")
    .max(
      PREAUTH_MAX_AMOUNT,
      `Estimated cost must not exceed Rs ${PREAUTH_MAX_AMOUNT.toLocaleString("en-IN")}`,
    ),
  diagnosis: z
    .string()
    .max(500)
    .optional()
    .refine(
      (v) => v === undefined || v === "" || ICD10_REGEX.test(v) || v.trim().length >= 4,
      "Diagnosis must be a valid ICD-10 code (e.g. E11.9) or a clinical description of at least 4 characters",
    ),
  supportingDocs: z.array(z.string()).max(20).optional(),
  notes: z.string().max(2000).optional(),
});

export const updatePreAuthStatusSchema = z
  .object({
    status: z.enum(["APPROVED", "REJECTED", "PARTIAL"]),
    approvedAmount: z
      .number()
      .nonnegative()
      .max(PREAUTH_MAX_AMOUNT, `Approved amount must not exceed Rs ${PREAUTH_MAX_AMOUNT.toLocaleString("en-IN")}`)
      .optional(),
    rejectionReason: z.string().max(1000).optional(),
    claimReferenceNumber: z.string().max(80).optional(),
    notes: z.string().max(2000).optional(),
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
