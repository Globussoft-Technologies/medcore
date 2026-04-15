import { describe, it, expect } from "vitest";
import {
  createInvoiceSchema,
  recordPaymentSchema,
  refundSchema,
  applyDiscountSchema,
  bulkPaymentSchema,
  insuranceClaimSchema,
} from "../billing";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("createInvoiceSchema", () => {
  const valid = {
    appointmentId: UUID,
    patientId: UUID,
    items: [{ description: "Consult", category: "OPD", quantity: 1, unitPrice: 500 }],
  };
  it("accepts valid invoice", () => {
    expect(createInvoiceSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects empty items", () => {
    expect(createInvoiceSchema.safeParse({ ...valid, items: [] }).success).toBe(false);
  });
  it("rejects negative unitPrice", () => {
    expect(
      createInvoiceSchema.safeParse({
        ...valid,
        items: [{ description: "x", category: "y", quantity: 1, unitPrice: -1 }],
      }).success
    ).toBe(false);
  });
  it("rejects tax > 100", () => {
    expect(createInvoiceSchema.safeParse({ ...valid, taxPercentage: 200 }).success).toBe(false);
  });
});

describe("recordPaymentSchema", () => {
  it("accepts a valid payment", () => {
    expect(
      recordPaymentSchema.safeParse({ invoiceId: UUID, amount: 500, mode: "CASH" }).success
    ).toBe(true);
  });
  it("rejects zero amount", () => {
    expect(
      recordPaymentSchema.safeParse({ invoiceId: UUID, amount: 0, mode: "CASH" }).success
    ).toBe(false);
  });
  it("rejects unknown mode", () => {
    expect(
      recordPaymentSchema.safeParse({ invoiceId: UUID, amount: 5, mode: "BARTER" as any }).success
    ).toBe(false);
  });
});

describe("refundSchema", () => {
  it("accepts a valid refund", () => {
    expect(
      refundSchema.safeParse({ invoiceId: UUID, amount: 100, reason: "Mistake", mode: "CASH" })
        .success
    ).toBe(true);
  });
  it("rejects empty reason", () => {
    expect(
      refundSchema.safeParse({ invoiceId: UUID, amount: 100, reason: "", mode: "CASH" }).success
    ).toBe(false);
  });
});

describe("applyDiscountSchema", () => {
  it("accepts a percentage discount", () => {
    expect(applyDiscountSchema.safeParse({ percentage: 10, reason: "Loyalty" }).success).toBe(true);
  });
  it("accepts a flat discount", () => {
    expect(applyDiscountSchema.safeParse({ flatAmount: 100, reason: "Goodwill" }).success).toBe(
      true
    );
  });
  it("rejects when neither is provided", () => {
    expect(applyDiscountSchema.safeParse({ reason: "x" }).success).toBe(false);
  });
  it("rejects percentage > 100", () => {
    expect(applyDiscountSchema.safeParse({ percentage: 150, reason: "x" }).success).toBe(false);
  });
});

describe("bulkPaymentSchema", () => {
  it("accepts a valid bulk payment", () => {
    expect(
      bulkPaymentSchema.safeParse({
        patientId: UUID,
        payments: [{ invoiceId: UUID, amount: 100, mode: "UPI" }],
      }).success
    ).toBe(true);
  });
  it("rejects empty payments", () => {
    expect(
      bulkPaymentSchema.safeParse({ patientId: UUID, payments: [] }).success
    ).toBe(false);
  });
});

describe("insuranceClaimSchema", () => {
  it("accepts valid claim", () => {
    expect(
      insuranceClaimSchema.safeParse({
        invoiceId: UUID,
        patientId: UUID,
        insuranceProvider: "ACME",
        policyNumber: "P1",
        claimAmount: 1000,
      }).success
    ).toBe(true);
  });
  it("rejects empty provider", () => {
    expect(
      insuranceClaimSchema.safeParse({
        invoiceId: UUID,
        patientId: UUID,
        insuranceProvider: "",
        policyNumber: "P1",
        claimAmount: 1000,
      }).success
    ).toBe(false);
  });
});
