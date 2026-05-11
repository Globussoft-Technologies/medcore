import { describe, it, expect } from "vitest";
import {
  createPackageSchema,
  purchasePackageSchema,
  createSupplierSchema,
  createPOSchema,
  createExpenseSchema,
  expenseBudgetSchema,
  createCreditNoteSchema,
  createAdvancePaymentSchema,
  paymentPlanSchema,
  preAuthRequestSchema,
  discountApprovalSchema,
} from "../finance";

const UUID = "550e8400-e29b-41d4-a716-446655441111";

describe("createPackageSchema", () => {
  const valid = { name: "Master Health Checkup", services: "CBC, ECG", price: 1999 };
  it("accepts a minimal valid package", () => {
    expect(createPackageSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects non-positive price", () => {
    expect(createPackageSchema.safeParse({ ...valid, price: 0 }).success).toBe(false);
  });
  it("rejects empty name", () => {
    expect(createPackageSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });
});

describe("purchasePackageSchema", () => {
  it("accepts a valid purchase", () => {
    expect(
      purchasePackageSchema.safeParse({ packageId: UUID, patientId: UUID, amountPaid: 500 })
        .success
    ).toBe(true);
  });
  it("rejects non-uuid packageId", () => {
    expect(
      purchasePackageSchema.safeParse({ packageId: "abc", patientId: UUID, amountPaid: 500 })
        .success
    ).toBe(false);
  });
  it("rejects non-positive amountPaid", () => {
    expect(
      purchasePackageSchema.safeParse({ packageId: UUID, patientId: UUID, amountPaid: 0 })
        .success
    ).toBe(false);
  });
});

describe("createSupplierSchema", () => {
  it("accepts a minimal supplier", () => {
    expect(createSupplierSchema.safeParse({ name: "Acme Pharma" }).success).toBe(true);
  });
  it("rejects malformed GSTIN", () => {
    expect(
      createSupplierSchema.safeParse({ name: "Acme", gstNumber: "BADGSTIN" }).success
    ).toBe(false);
  });
  it("accepts a canonical 15-char GSTIN", () => {
    expect(
      createSupplierSchema.safeParse({ name: "Acme", gstNumber: "27AAAPL1234C1Z5" }).success
    ).toBe(true);
  });
  it("rejects junk phone", () => {
    expect(
      createSupplierSchema.safeParse({ name: "Acme", phone: "asdf" }).success
    ).toBe(false);
  });
});

describe("createPOSchema", () => {
  const item = { description: "Paracetamol 500mg", quantity: 100, unitPrice: 1.5 };
  it("accepts a valid PO", () => {
    expect(
      createPOSchema.safeParse({ supplierId: UUID, items: [item] }).success
    ).toBe(true);
  });
  it("rejects empty items array", () => {
    expect(createPOSchema.safeParse({ supplierId: UUID, items: [] }).success).toBe(false);
  });
  it("rejects taxPercentage > 100", () => {
    expect(
      createPOSchema.safeParse({ supplierId: UUID, items: [item], taxPercentage: 150 }).success
    ).toBe(false);
  });
  // Issue #693 — supplier required + line quantity strictly positive integer.
  it("#693 rejects empty/missing supplier", () => {
    expect(
      createPOSchema.safeParse({ supplierId: "", items: [item] }).success
    ).toBe(false);
    expect(
      createPOSchema.safeParse({ items: [item] } as any).success
    ).toBe(false);
  });
  it("#693 rejects zero quantity line item", () => {
    expect(
      createPOSchema.safeParse({
        supplierId: UUID,
        items: [{ ...item, quantity: 0 }],
      }).success
    ).toBe(false);
  });
  it("#693 rejects negative quantity line item", () => {
    expect(
      createPOSchema.safeParse({
        supplierId: UUID,
        items: [{ ...item, quantity: -5 }],
      }).success
    ).toBe(false);
  });
  it("#693 rejects fractional quantity (not a whole unit)", () => {
    expect(
      createPOSchema.safeParse({
        supplierId: UUID,
        items: [{ ...item, quantity: 0.5 }],
      }).success
    ).toBe(false);
  });
});

describe("createExpenseSchema", () => {
  const todayStr = new Date().toISOString().slice(0, 10);
  const valid = {
    category: "UTILITIES" as const,
    amount: 1000,
    description: "Electricity bill",
    date: todayStr,
  };
  it("accepts a same-day expense", () => {
    expect(createExpenseSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects an unknown category", () => {
    expect(
      createExpenseSchema.safeParse({ ...valid, category: "RANDOM" as any }).success
    ).toBe(false);
  });
  it("rejects a future-dated expense", () => {
    expect(
      createExpenseSchema.safeParse({ ...valid, date: "2099-01-01" }).success
    ).toBe(false);
  });
  it("rejects malformed date", () => {
    expect(
      createExpenseSchema.safeParse({ ...valid, date: "yesterday" }).success
    ).toBe(false);
  });
  // Issue #694 — Add Expense form was accepting negative amount + future date.
  it("#694 rejects negative amount", () => {
    expect(
      createExpenseSchema.safeParse({ ...valid, amount: -100 }).success
    ).toBe(false);
  });
  it("#694 rejects zero amount", () => {
    expect(
      createExpenseSchema.safeParse({ ...valid, amount: 0 }).success
    ).toBe(false);
  });
});

describe("expenseBudgetSchema", () => {
  const valid = { category: "RENT" as const, year: 2026, month: 5, amount: 50000 };
  it("accepts a valid budget", () => {
    expect(expenseBudgetSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects month=13", () => {
    expect(expenseBudgetSchema.safeParse({ ...valid, month: 13 }).success).toBe(false);
  });
  it("rejects zero amount (Issue #297)", () => {
    expect(expenseBudgetSchema.safeParse({ ...valid, amount: 0 }).success).toBe(false);
  });
});

describe("createCreditNoteSchema", () => {
  it("accepts a valid credit note", () => {
    expect(
      createCreditNoteSchema.safeParse({ invoiceId: UUID, amount: 500, reason: "Overcharge" })
        .success
    ).toBe(true);
  });
  it("rejects empty reason", () => {
    expect(
      createCreditNoteSchema.safeParse({ invoiceId: UUID, amount: 500, reason: "" }).success
    ).toBe(false);
  });
});

describe("createAdvancePaymentSchema", () => {
  it("accepts a valid advance", () => {
    expect(
      createAdvancePaymentSchema.safeParse({ patientId: UUID, amount: 1000, mode: "UPI" })
        .success
    ).toBe(true);
  });
  it("rejects unknown payment mode", () => {
    expect(
      createAdvancePaymentSchema.safeParse({ patientId: UUID, amount: 1000, mode: "BITCOIN" as any })
        .success
    ).toBe(false);
  });
});

describe("paymentPlanSchema", () => {
  const valid = { invoiceId: UUID, installments: 6, startDate: "2026-06-01" };
  it("accepts a valid plan", () => {
    expect(paymentPlanSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects installments < 2", () => {
    expect(paymentPlanSchema.safeParse({ ...valid, installments: 1 }).success).toBe(false);
  });
  it("rejects malformed startDate", () => {
    expect(paymentPlanSchema.safeParse({ ...valid, startDate: "06/01/2026" }).success).toBe(false);
  });
});

describe("preAuthRequestSchema", () => {
  const validBase = {
    patientId: UUID,
    insuranceProvider: "Star Health",
    policyNumber: "POL-001234",
    procedureName: "Knee replacement",
    estimatedCost: 200000,
  };

  it("accepts a valid pre-auth request", () => {
    expect(preAuthRequestSchema.safeParse(validBase).success).toBe(true);
  });

  it("rejects non-positive estimatedCost", () => {
    expect(
      preAuthRequestSchema.safeParse({ ...validBase, estimatedCost: 0 }).success
    ).toBe(false);
  });

  // Issue #578 — concern #1 (overflow): cap at Rs 10 crore so 1e15 / 1e10
  // values can't reach the DB and corrupt downstream claim batches.
  it("#578 rejects estimatedCost above the Rs 10 crore ceiling (1e15 overflow)", () => {
    expect(
      preAuthRequestSchema.safeParse({ ...validBase, estimatedCost: 1e15 }).success
    ).toBe(false);
    expect(
      preAuthRequestSchema.safeParse({ ...validBase, estimatedCost: 10_000_001 }).success
    ).toBe(false);
    // Boundary: exactly 1 crore (10_000_000) is allowed.
    expect(
      preAuthRequestSchema.safeParse({ ...validBase, estimatedCost: 10_000_000 }).success
    ).toBe(true);
  });

  // Issue #578 — concern #4 (policy number format): blocks SQLi payloads,
  // empty-after-trim, and over-long inputs.
  it("#578 rejects policyNumber that is too short, too long, or contains unsafe characters", () => {
    expect(
      preAuthRequestSchema.safeParse({ ...validBase, policyNumber: "AB" }).success
    ).toBe(false); // < 3 chars
    expect(
      preAuthRequestSchema.safeParse({
        ...validBase,
        policyNumber: "A".repeat(41),
      }).success
    ).toBe(false); // > 40 chars
    expect(
      preAuthRequestSchema.safeParse({
        ...validBase,
        policyNumber: "POL-1' OR 1=1--",
      }).success
    ).toBe(false); // SQLi payload (quotes / equals)
    expect(
      preAuthRequestSchema.safeParse({
        ...validBase,
        policyNumber: "<script>",
      }).success
    ).toBe(false);
    expect(
      preAuthRequestSchema.safeParse({ ...validBase, policyNumber: "POL/2026-001234" })
        .success
    ).toBe(true); // common format with slash + hyphen
  });

  // Issue #578 — concern #2 (diagnosis format): rejects 1-3 char gibberish
  // when not an ICD-10 code; accepts both an ICD-10 code and a real clinical
  // description.
  it("#578 rejects junk diagnosis but accepts ICD-10 codes and prose >= 4 chars", () => {
    expect(
      preAuthRequestSchema.safeParse({ ...validBase, diagnosis: "abc" }).success
    ).toBe(false); // 3-char gibberish
    expect(
      preAuthRequestSchema.safeParse({ ...validBase, diagnosis: "E11.9" }).success
    ).toBe(true); // canonical ICD-10
    expect(
      preAuthRequestSchema.safeParse({ ...validBase, diagnosis: "S72.001A" }).success
    ).toBe(true); // ICD-10 with extension
    expect(
      preAuthRequestSchema.safeParse({
        ...validBase,
        diagnosis: "Acute appendicitis with peritonitis",
      }).success
    ).toBe(true); // clinical prose
    expect(
      preAuthRequestSchema.safeParse({ ...validBase, diagnosis: undefined }).success
    ).toBe(true); // optional
  });
});

describe("discountApprovalSchema", () => {
  it("accepts a valid discount", () => {
    expect(
      discountApprovalSchema.safeParse({ invoiceId: UUID, amount: 100, reason: "Goodwill" })
        .success
    ).toBe(true);
  });
  it("rejects percentage > 100", () => {
    expect(
      discountApprovalSchema.safeParse({
        invoiceId: UUID,
        amount: 100,
        percentage: 150,
        reason: "Goodwill",
      }).success
    ).toBe(false);
  });
});
