// Tests for the 2026-04-26 inventory + finance fix bundle
//   - Issue #51: pharmacy-return quantity cap
//   - Issue #63: GSTIN regex (canonical 15-char format)
//   - Issue #64: future-dated expense rejection
import { describe, it, expect } from "vitest";
import {
  GSTIN_REGEX,
  isValidGstin,
  createSupplierSchema,
  createExpenseSchema,
} from "../finance";
import { pharmacyReturnSchema } from "../pharmacy";

describe("Issue #63 — GSTIN_REGEX", () => {
  it("accepts the four canonical seed-finance GSTINs", () => {
    // These are the exact strings persisted by packages/db/src/seed-finance.ts.
    // If any of them stops matching the regex, the seed will throw before
    // hitting the DB so production data won't drift.
    expect(GSTIN_REGEX.test("27AABCM1234Z1ZP")).toBe(true);
    expect(GSTIN_REGEX.test("29AACCP5678Q1Z9")).toBe(true);
    expect(GSTIN_REGEX.test("09AAECH9876K1ZN")).toBe(true);
    expect(GSTIN_REGEX.test("36AAACL4567M1Z4")).toBe(true);
  });

  it("rejects malformed GSTINs", () => {
    expect(isValidGstin("")).toBe(false);
    expect(isValidGstin(null)).toBe(false);
    expect(isValidGstin(undefined)).toBe(false);
    expect(isValidGstin("INVALIDGSTIN")).toBe(false);
    // 14 chars instead of 15
    expect(isValidGstin("27AABCM1234Z1Z")).toBe(false);
    // Position 14 must be literal "Z"
    expect(isValidGstin("27AABCM1234Z1AA")).toBe(false);
    // First two must be digits
    expect(isValidGstin("AAAACM1234Z1ZP1")).toBe(false);
    // PAN body (pos 3-7) must be A-Z
    expect(isValidGstin("2712345A1234Z1ZP")).toBe(false);
  });

  it("supplier schema lets gstNumber be undefined or empty", () => {
    expect(
      createSupplierSchema.safeParse({ name: "X" }).success,
    ).toBe(true);
    expect(
      createSupplierSchema.safeParse({ name: "X", gstNumber: "" }).success,
    ).toBe(true);
  });

  it("supplier schema rejects malformed gstNumber", () => {
    const res = createSupplierSchema.safeParse({
      name: "X",
      gstNumber: "BAD-GSTIN",
    });
    expect(res.success).toBe(false);
  });

  it("supplier schema accepts a canonical gstNumber", () => {
    const res = createSupplierSchema.safeParse({
      name: "X",
      gstNumber: "27AABCM1234Z1ZP",
    });
    expect(res.success).toBe(true);
  });
});

describe("Issue #64 — createExpenseSchema rejects future dates", () => {
  function offsetDate(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  it("accepts today's date", () => {
    const res = createExpenseSchema.safeParse({
      category: "OTHER",
      amount: 100,
      description: "Today",
      date: offsetDate(0),
    });
    expect(res.success).toBe(true);
  });

  it("accepts a past date", () => {
    const res = createExpenseSchema.safeParse({
      category: "OTHER",
      amount: 100,
      description: "Yesterday",
      date: offsetDate(-1),
    });
    expect(res.success).toBe(true);
  });

  it("rejects a date one day in the future", () => {
    const res = createExpenseSchema.safeParse({
      category: "OTHER",
      amount: 100,
      description: "Tomorrow",
      date: offsetDate(1),
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toMatch(/future/i);
    }
  });

  it("rejects a far-future date (the original bug — 01/01/2030)", () => {
    const res = createExpenseSchema.safeParse({
      category: "OTHER",
      amount: 100,
      description: "Far future",
      date: "2030-01-01",
    });
    expect(res.success).toBe(false);
  });
});

describe("Issue #51 — pharmacyReturnSchema shape", () => {
  // The on-hand cap itself is enforced at runtime against the live inventory
  // row (the schema doesn't know on-hand). This test pins the schema's static
  // contract so we don't accidentally relax `quantity`'s positive-int rule —
  // that's the floor the runtime check builds on.
  it("requires quantity to be a positive integer", () => {
    const base = {
      inventoryItemId: "00000000-0000-0000-0000-000000000001",
      reason: "PATIENT_RETURNED" as const,
    };
    expect(pharmacyReturnSchema.safeParse({ ...base, quantity: 0 }).success).toBe(
      false,
    );
    expect(pharmacyReturnSchema.safeParse({ ...base, quantity: -1 }).success).toBe(
      false,
    );
    expect(
      pharmacyReturnSchema.safeParse({ ...base, quantity: 1.5 }).success,
    ).toBe(false);
    expect(pharmacyReturnSchema.safeParse({ ...base, quantity: 1 }).success).toBe(
      true,
    );
  });
});
