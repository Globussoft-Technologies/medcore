import { z } from "zod";

// Issue #368 (2026-04-26): unitPrice was `.min(0)` so a zero-priced line
// could survive create even though the add-line endpoint rejects zero.
// Tighten to `.positive()` to keep both create and add-line paths
// consistent — and surface the field-level error message rather than the
// generic "Number must be greater than 0".
const invoiceItemSchema = z.object({
  description: z.string().min(1, "Description is required"),
  category: z.string().min(1, "Category is required"),
  quantity: z.number().int().min(1, "Quantity must be at least 1").default(1),
  unitPrice: z.number().positive("Unit price must be greater than 0"),
});

export const createInvoiceSchema = z.object({
  appointmentId: z.string().uuid(),
  patientId: z.string().uuid(),
  items: z.array(invoiceItemSchema).min(1, "At least one item is required"),
  taxPercentage: z.number().min(0).max(100).default(0),
  discountAmount: z.number().min(0).default(0),
  applyPackageDiscount: z.boolean().default(false), // auto-apply active package
  applyAdvance: z.boolean().default(false), // auto-apply patient's advance
  dueDate: z.string().optional(),
  notes: z.string().optional(),
  // Pearl ERP Stage 1 §4.1 (gap row 101) — referring-doctor commission
  // split. If `referringDoctorId` is set OR `referralId` resolves to a
  // Referral with a fromDoctor, the POST handler auto-computes the
  // commission and snapshots it into ReferralCommission inside the same
  // transaction as the Invoice. Both fields are optional — walk-in
  // invoices with no referring doctor pass nothing and no commission row
  // is created. `referralId` takes precedence: if set, the handler reads
  // the Referral's commissionPercent (override) and fromDoctorId.
  referringDoctorId: z.string().uuid().optional(),
  referralId: z.string().uuid().optional(),
});

// Consolidated IPD invoice on discharge — auto-computes all services
export const consolidatedInvoiceSchema = z.object({
  admissionId: z.string().uuid(),
  taxPercentage: z.number().min(0).max(100).default(18),
  discountAmount: z.number().min(0).default(0),
  applyAdvance: z.boolean().default(true),
  notes: z.string().optional(),
});

export const sendReminderSchema = z.object({
  invoiceId: z.string().uuid(),
  channel: z.enum(["SMS", "EMAIL", "WHATSAPP"]).default("SMS"),
});

export const recordPaymentSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.number().min(0.01, "Amount must be greater than 0"),
  mode: z.enum(["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"]),
  transactionId: z.string().optional(),
});

export const insuranceClaimSchema = z.object({
  invoiceId: z.string().uuid(),
  patientId: z.string().uuid(),
  insuranceProvider: z.string().min(1),
  policyNumber: z.string().min(1),
  claimAmount: z.number().min(0.01),
});

export const updateClaimStatusSchema = z.object({
  status: z.enum(["SUBMITTED", "APPROVED", "REJECTED", "SETTLED"]),
  approvedAmount: z.number().min(0).optional(),
});

// ─── Refunds ─────────────────────────────────────────────

export const refundSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.number().min(0.01, "Refund amount must be greater than 0"),
  reason: z.string().min(1, "Reason is required").max(500),
  mode: z.enum(["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"]),
});

// ─── Add line item to an existing invoice ─────────────────
// Issue #368 (2026-04-26): same-rule alignment with `invoiceItemSchema`
// above — quantity must be ≥1, unitPrice must be > 0. Zero-priced "free"
// items belong on a discount, not a line item, so we reject them here.
export const addInvoiceItemSchema = z.object({
  description: z.string().min(1, "Description is required"),
  category: z.string().min(1, "Category is required"),
  quantity: z.number().int().min(1, "Quantity must be at least 1").default(1),
  unitPrice: z.number().positive("Unit price must be greater than 0"),
});

// ─── Apply discount to an invoice ─────────────────────────

export const applyDiscountSchema = z
  .object({
    percentage: z.number().min(0).max(100).optional(),
    flatAmount: z.number().min(0).optional(),
    reason: z.string().min(1, "Reason is required").max(500),
  })
  .refine(
    (v) => v.percentage !== undefined || v.flatAmount !== undefined,
    "Either percentage or flatAmount is required"
  );

// ─── Bulk payments across invoices ────────────────────────

export const bulkPaymentSchema = z.object({
  patientId: z.string().uuid(),
  payments: z
    .array(
      z.object({
        invoiceId: z.string().uuid(),
        amount: z.number().min(0.01),
        mode: z.enum(["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"]),
        transactionId: z.string().optional(),
      })
    )
    .min(1, "At least one payment is required"),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type InsuranceClaimInput = z.infer<typeof insuranceClaimSchema>;
export type UpdateClaimStatusInput = z.infer<typeof updateClaimStatusSchema>;
export type RefundInput = z.infer<typeof refundSchema>;
export type AddInvoiceItemInput = z.infer<typeof addInvoiceItemSchema>;
export type ApplyDiscountInput = z.infer<typeof applyDiscountSchema>;
export type BulkPaymentInput = z.infer<typeof bulkPaymentSchema>;
