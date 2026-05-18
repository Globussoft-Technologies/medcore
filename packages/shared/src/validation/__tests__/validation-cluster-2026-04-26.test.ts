/**
 * Validation cluster sweep — 2026-04-26
 *
 * One test per fix in the cluster so a future regression on any individual
 * issue produces a clear failure name. Every test parses with the shared
 * Zod schema (no UI / no API mocking) — the schemas are the canonical
 * source of truth for what the server will accept.
 *
 * Issues covered:
 *   #279 — recordPayment rejects amount <= 0
 *   #283 — payrollCalc rejects negative / zero basicSalary
 *   #297 — expenseBudget rejects 0 / negative amount
 *   #310 / #294 — supplier rejects malformed phone
 *   #358 — applyDiscount rejects percentage > 100
 *   #362 — recurring appointment rejects past startDate
 *   #366 — IPD vitals reject impossible BP / pulse / SpO2
 *   #368 — invoice item rejects zero unitPrice
 *   #370 — pre-auth rejects empty mandatory fields
 *   #371 — package purchase rejects zero amountPaid
 */

import { describe, it, expect } from "vitest";
import {
  recordPaymentSchema,
  applyDiscountSchema,
  addInvoiceItemSchema,
} from "../billing";
import {
  payrollCalcSchema,
} from "../hr";
import {
  expenseBudgetSchema,
  createSupplierSchema,
  preAuthRequestSchema,
  purchasePackageSchema,
} from "../finance";
import { recordIpdVitalsSchema } from "../ipd";
import { recurringAppointmentSchema } from "../appointment";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655441111";

describe("Validation cluster — 2026-04-26", () => {
  // ─── #279 Save Payment rejects negative / zero amount ────────────
  it("#279 recordPaymentSchema rejects amount <= 0", () => {
    expect(
      recordPaymentSchema.safeParse({
        invoiceId: VALID_UUID,
        amount: -50,
        mode: "CASH",
      }).success
    ).toBe(false);

    expect(
      recordPaymentSchema.safeParse({
        invoiceId: VALID_UUID,
        amount: 0,
        mode: "CASH",
      }).success
    ).toBe(false);

    expect(
      recordPaymentSchema.safeParse({
        invoiceId: VALID_UUID,
        amount: 100,
        mode: "CASH",
      }).success
    ).toBe(true);
  });

  // ─── #283 Payroll basic salary must be positive ────────────────────
  it("#283 payrollCalcSchema rejects negative or zero basicSalary", () => {
    const base = {
      userId: VALID_UUID,
      year: 2026,
      month: 4,
      allowances: 0,
      deductions: 0,
      overtimeRate: 0,
    };
    expect(
      payrollCalcSchema.safeParse({ ...base, basicSalary: -50000 }).success
    ).toBe(false);
    expect(
      payrollCalcSchema.safeParse({ ...base, basicSalary: 0 }).success
    ).toBe(false);
    expect(
      payrollCalcSchema.safeParse({ ...base, basicSalary: 25000 }).success
    ).toBe(true);
  });

  // ─── #297 Monthly budget amount must be positive ───────────────────
  it("#297 expenseBudgetSchema rejects 0 / negative amount", () => {
    const base = { category: "RENT" as const, year: 2026, month: 4 };
    expect(expenseBudgetSchema.safeParse({ ...base, amount: -100 }).success).toBe(false);
    expect(expenseBudgetSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
    expect(expenseBudgetSchema.safeParse({ ...base, amount: 50000 }).success).toBe(true);
  });

  // ─── #310 / #294 Supplier phone format must match regex ────────────
  it("#310 createSupplierSchema rejects malformed phone", () => {
    const valid = { name: "ACME Pharma" };
    // Garbage phone is rejected
    expect(
      createSupplierSchema.safeParse({ ...valid, phone: "asdf" }).success
    ).toBe(false);
    // Too few digits
    expect(
      createSupplierSchema.safeParse({ ...valid, phone: "123" }).success
    ).toBe(false);
    // Properly formatted Indian mobile
    expect(
      createSupplierSchema.safeParse({ ...valid, phone: "+919876543210" }).success
    ).toBe(true);
    // Empty string still allowed (phone is optional)
    expect(
      createSupplierSchema.safeParse({ ...valid, phone: "" }).success
    ).toBe(true);
  });

  // ─── #358 Apply Discount caps percentage at 100 ─────────────────────
  it("#358 applyDiscountSchema rejects percentage > 100 and negative percent", () => {
    expect(
      applyDiscountSchema.safeParse({ percentage: 150, reason: "spam" }).success
    ).toBe(false);
    expect(
      applyDiscountSchema.safeParse({ percentage: -10, reason: "spam" }).success
    ).toBe(false);
    expect(
      applyDiscountSchema.safeParse({ percentage: 50, reason: "senior citizen" }).success
    ).toBe(true);
  });

  // ─── #362 Recurring appointments cannot start in the past ──────────
  it("#362 recurringAppointmentSchema rejects past startDate", () => {
    const base = {
      patientId: VALID_UUID,
      doctorId: VALID_UUID,
      slotStart: "10:00",
      frequency: "WEEKLY" as const,
      occurrences: 4,
    };
    expect(
      recurringAppointmentSchema.safeParse({
        ...base,
        startDate: "2020-01-01",
      }).success
    ).toBe(false);
    // 2099 is comfortably in the future regardless of when the test runs.
    expect(
      recurringAppointmentSchema.safeParse({
        ...base,
        startDate: "2099-01-01",
      }).success
    ).toBe(true);
  });

  // ─── #366 IPD vitals reject impossible numbers ─────────────────────
  it("#366 recordIpdVitalsSchema rejects out-of-range BP / pulse / SpO2", () => {
    expect(
      recordIpdVitalsSchema.safeParse({
        admissionId: VALID_UUID,
        bloodPressureSystolic: -50,
      }).success
    ).toBe(false);
    expect(
      recordIpdVitalsSchema.safeParse({
        admissionId: VALID_UUID,
        pulseRate: 500,
      }).success
    ).toBe(false);
    expect(
      recordIpdVitalsSchema.safeParse({
        admissionId: VALID_UUID,
        spO2: 200,
      }).success
    ).toBe(false);
    expect(
      recordIpdVitalsSchema.safeParse({
        admissionId: VALID_UUID,
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 80,
        pulseRate: 72,
        spO2: 98,
      }).success
    ).toBe(true);
  });

  // ─── #368 Add Invoice line item rejects zero / negative qty + price ─
  it("#368 addInvoiceItemSchema rejects zero / negative qty and unitPrice", () => {
    const valid = {
      description: "Consultation",
      category: "CONSULTATION",
      quantity: 1,
      unitPrice: 500,
    };
    // Zero unit price
    expect(
      addInvoiceItemSchema.safeParse({ ...valid, unitPrice: 0 }).success
    ).toBe(false);
    // Negative qty (also caught by `int().min(1)`)
    expect(
      addInvoiceItemSchema.safeParse({ ...valid, quantity: -1 }).success
    ).toBe(false);
    expect(addInvoiceItemSchema.safeParse(valid).success).toBe(true);
  });

  // ─── #370 Pre-Auth rejects empty mandatory fields ──────────────────
  it("#370 preAuthRequestSchema rejects empty mandatory fields", () => {
    const valid = {
      patientId: VALID_UUID,
      insuranceProvider: "Star Health",
      policyNumber: "ABC123",
      procedureName: "Knee replacement",
      estimatedCost: 250000,
    };
    // Missing insurance provider
    expect(
      preAuthRequestSchema.safeParse({ ...valid, insuranceProvider: "" }).success
    ).toBe(false);
    // Missing policy number
    expect(
      preAuthRequestSchema.safeParse({ ...valid, policyNumber: "" }).success
    ).toBe(false);
    // Missing procedure name
    expect(
      preAuthRequestSchema.safeParse({ ...valid, procedureName: "" }).success
    ).toBe(false);
    // Estimated cost <= 0
    expect(
      preAuthRequestSchema.safeParse({ ...valid, estimatedCost: 0 }).success
    ).toBe(false);
    expect(preAuthRequestSchema.safeParse(valid).success).toBe(true);
  });

  // ─── #371 Sell Package rejects zero / negative amountPaid ──────────
  it("#371 purchasePackageSchema rejects zero / negative amountPaid", () => {
    const base = {
      packageId: VALID_UUID,
      patientId: VALID_UUID,
    };
    expect(
      purchasePackageSchema.safeParse({ ...base, amountPaid: 0 }).success
    ).toBe(false);
    expect(
      purchasePackageSchema.safeParse({ ...base, amountPaid: -100 }).success
    ).toBe(false);
    expect(
      purchasePackageSchema.safeParse({ ...base, amountPaid: 1000 }).success
    ).toBe(true);
  });
});
