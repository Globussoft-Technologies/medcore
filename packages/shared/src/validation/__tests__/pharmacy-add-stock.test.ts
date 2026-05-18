import { describe, it, expect } from "vitest";
import { createInventoryItemSchema } from "../pharmacy";

// Issue #141 / #96 (Apr 2026): the Add Stock form previously accepted a
// missing medicineId, quantity 0, ₹0 prices, negative reorder levels and
// past-dated expiries. The schema is now the single source of truth.

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const tomorrow = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 30); // 30 days out — well in the future, not edge
  return d.toISOString().slice(0, 10);
})();
const today = new Date().toISOString().slice(0, 10);

const validInput = {
  medicineId: UUID,
  batchNumber: "B-001",
  quantity: 100,
  unitCost: 5.5,
  sellingPrice: 8.0,
  expiryDate: tomorrow,
};

describe("createInventoryItemSchema (Add Stock)", () => {
  it("accepts a valid input", () => {
    expect(createInventoryItemSchema.safeParse(validInput).success).toBe(true);
  });

  // Issue #141: medicineId required.
  it("rejects a missing medicineId", () => {
    const { medicineId, ...rest } = validInput;
    void medicineId;
    expect(createInventoryItemSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects a non-UUID medicineId", () => {
    expect(
      createInventoryItemSchema.safeParse({ ...validInput, medicineId: "" })
        .success
    ).toBe(false);
  });

  // Issue #96: numeric mins.
  it("rejects quantity < 1", () => {
    expect(
      createInventoryItemSchema.safeParse({ ...validInput, quantity: 0 }).success
    ).toBe(false);
  });
  it("rejects negative quantity", () => {
    expect(
      createInventoryItemSchema.safeParse({ ...validInput, quantity: -1 })
        .success
    ).toBe(false);
  });
  it("rejects unitCost <= 0", () => {
    expect(
      createInventoryItemSchema.safeParse({ ...validInput, unitCost: 0 }).success
    ).toBe(false);
  });
  it("rejects sellingPrice <= 0", () => {
    expect(
      createInventoryItemSchema.safeParse({ ...validInput, sellingPrice: 0 })
        .success
    ).toBe(false);
  });
  it("rejects negative reorderLevel", () => {
    expect(
      createInventoryItemSchema.safeParse({
        ...validInput,
        reorderLevel: -1,
      }).success
    ).toBe(false);
  });
  it("accepts reorderLevel 0 (never auto-flag low)", () => {
    expect(
      createInventoryItemSchema.safeParse({
        ...validInput,
        reorderLevel: 0,
      }).success
    ).toBe(true);
  });

  // Issue #96: expiry must be strictly in the future.
  it("rejects expiry in the past", () => {
    expect(
      createInventoryItemSchema.safeParse({
        ...validInput,
        expiryDate: "2020-01-01",
      }).success
    ).toBe(false);
  });
  it("rejects expiry today", () => {
    expect(
      createInventoryItemSchema.safeParse({
        ...validInput,
        expiryDate: today,
      }).success
    ).toBe(false);
  });
});
