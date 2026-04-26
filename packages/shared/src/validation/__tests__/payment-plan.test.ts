// Issue #60 (Apr 2026) — payment plan create input validation.
//
// The new "+ New Plan" modal on /dashboard/payment-plans posts to
// `/api/v1/payment-plans` and the API validates the payload with
// `paymentPlanSchema`. These tests pin down the contract the UI relies on
// (installments 2..60, frequency enum, ISO startDate, non-negative
// downPayment) so the modal's client-side guards stay in sync.
import { describe, it, expect } from "vitest";
import { paymentPlanSchema } from "../finance";

const UUID = "11111111-1111-1111-1111-111111111111";
const baseDate = "2026-05-01";

describe("paymentPlanSchema (Issue #60)", () => {
  it("accepts a valid plan", () => {
    expect(
      paymentPlanSchema.safeParse({
        invoiceId: UUID,
        downPayment: 500,
        installments: 6,
        frequency: "MONTHLY",
        startDate: baseDate,
      }).success
    ).toBe(true);
  });

  it("defaults frequency to MONTHLY and downPayment to 0", () => {
    const r = paymentPlanSchema.safeParse({
      invoiceId: UUID,
      installments: 3,
      startDate: baseDate,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.frequency).toBe("MONTHLY");
      expect(r.data.downPayment).toBe(0);
    }
  });

  it("rejects fewer than 2 installments", () => {
    expect(
      paymentPlanSchema.safeParse({
        invoiceId: UUID,
        installments: 1,
        startDate: baseDate,
      }).success
    ).toBe(false);
  });

  it("rejects more than 60 installments", () => {
    expect(
      paymentPlanSchema.safeParse({
        invoiceId: UUID,
        installments: 61,
        startDate: baseDate,
      }).success
    ).toBe(false);
  });

  it("rejects unknown frequency", () => {
    expect(
      paymentPlanSchema.safeParse({
        invoiceId: UUID,
        installments: 6,
        startDate: baseDate,
        frequency: "DAILY" as unknown as "MONTHLY",
      }).success
    ).toBe(false);
  });

  it("rejects non-ISO startDate", () => {
    expect(
      paymentPlanSchema.safeParse({
        invoiceId: UUID,
        installments: 6,
        startDate: "May 1 2026",
      }).success
    ).toBe(false);
  });

  it("rejects negative downPayment", () => {
    expect(
      paymentPlanSchema.safeParse({
        invoiceId: UUID,
        downPayment: -100,
        installments: 6,
        startDate: baseDate,
      }).success
    ).toBe(false);
  });

  it("rejects non-uuid invoiceId", () => {
    expect(
      paymentPlanSchema.safeParse({
        invoiceId: "not-a-uuid",
        installments: 6,
        startDate: baseDate,
      }).success
    ).toBe(false);
  });

  it("accepts WEEKLY and BIWEEKLY frequencies", () => {
    for (const f of ["WEEKLY", "BIWEEKLY"] as const) {
      expect(
        paymentPlanSchema.safeParse({
          invoiceId: UUID,
          installments: 4,
          frequency: f,
          startDate: baseDate,
        }).success
      ).toBe(true);
    }
  });
});
