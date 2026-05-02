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

const UUID = "11111111-1111-1111-1111-111111111111";

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
  it("accepts a valid pre-auth request", () => {
    expect(
      preAuthRequestSchema.safeParse({
        patientId: UUID,
        insuranceProvider: "Star Health",
        policyNumber: "POL-1",
        procedureName: "Knee replacement",
        estimatedCost: 200000,
      }).success
    ).toBe(true);
  });
  it("rejects non-positive estimatedCost", () => {
    expect(
      preAuthRequestSchema.safeParse({
        patientId: UUID,
        insuranceProvider: "Star Health",
        policyNumber: "POL-1",
        procedureName: "Knee replacement",
        estimatedCost: 0,
      }).success
    ).toBe(false);
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
