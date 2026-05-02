import { describe, it, expect } from "vitest";
import {
  createMedicineSchema,
  updateMedicineSchema,
  createDrugInteractionSchema,
  createInventoryItemSchema,
  stockMovementSchema,
  controlledSubstanceSchema,
  checkInteractionsSchema,
  pharmacyReturnSchema,
  stockTransferSchema,
  valuationMethodSchema,
} from "../pharmacy";

const UUID = "11111111-1111-1111-1111-111111111111";

// Build a far-future YYYY-MM-DD so the strict expiry rule (#96) doesn't
// invalidate the tests as time marches on.
const FUTURE_DATE = "2099-12-31";

describe("createMedicineSchema", () => {
  it("accepts a medicine with manufacturer", () => {
    expect(
      createMedicineSchema.safeParse({ name: "Paracetamol", manufacturer: "Cipla" }).success
    ).toBe(true);
  });
  it("accepts a medicine with brand instead of manufacturer", () => {
    expect(
      createMedicineSchema.safeParse({ name: "Paracetamol", brand: "Crocin" }).success
    ).toBe(true);
  });
  it("rejects when neither manufacturer nor brand provided (Issue #41)", () => {
    expect(createMedicineSchema.safeParse({ name: "Paracetamol" }).success).toBe(false);
  });
  it("rejects empty name", () => {
    expect(
      createMedicineSchema.safeParse({ name: "", manufacturer: "Cipla" }).success
    ).toBe(false);
  });
});

describe("updateMedicineSchema", () => {
  it("accepts a partial update", () => {
    expect(updateMedicineSchema.safeParse({ category: "Analgesic" }).success).toBe(true);
  });
  it("rejects empty name on update", () => {
    expect(updateMedicineSchema.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("createDrugInteractionSchema", () => {
  it("accepts a valid interaction", () => {
    expect(
      createDrugInteractionSchema.safeParse({
        drugAId: UUID,
        drugBId: UUID,
        severity: "MODERATE",
        description: "Increases bleeding risk",
      }).success
    ).toBe(true);
  });
  it("rejects unknown severity", () => {
    expect(
      createDrugInteractionSchema.safeParse({
        drugAId: UUID,
        drugBId: UUID,
        severity: "DEADLY" as any,
        description: "x",
      }).success
    ).toBe(false);
  });
});

describe("createInventoryItemSchema", () => {
  const valid = {
    medicineId: UUID,
    batchNumber: "BATCH-1",
    quantity: 100,
    unitCost: 1.5,
    sellingPrice: 2.0,
    expiryDate: FUTURE_DATE,
  };
  it("accepts a valid inventory item", () => {
    expect(createInventoryItemSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects zero quantity (Issue #141)", () => {
    expect(createInventoryItemSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(false);
  });
  it("rejects past expiry (Issue #96)", () => {
    expect(
      createInventoryItemSchema.safeParse({ ...valid, expiryDate: "2020-01-01" }).success
    ).toBe(false);
  });
  it("rejects non-positive sellingPrice", () => {
    expect(
      createInventoryItemSchema.safeParse({ ...valid, sellingPrice: 0 }).success
    ).toBe(false);
  });
  it("rejects malformed expiryDate", () => {
    expect(
      createInventoryItemSchema.safeParse({ ...valid, expiryDate: "31/12/2099" }).success
    ).toBe(false);
  });
});

describe("stockMovementSchema", () => {
  it("accepts a valid PURCHASE movement", () => {
    expect(
      stockMovementSchema.safeParse({
        inventoryItemId: UUID,
        type: "PURCHASE",
        quantity: 50,
      }).success
    ).toBe(true);
  });
  it("rejects unknown movement type", () => {
    expect(
      stockMovementSchema.safeParse({
        inventoryItemId: UUID,
        type: "STOLEN" as any,
        quantity: 5,
      }).success
    ).toBe(false);
  });
});

describe("controlledSubstanceSchema", () => {
  it("accepts a valid controlled-substance entry", () => {
    expect(
      controlledSubstanceSchema.safeParse({ medicineId: UUID, quantity: 1 }).success
    ).toBe(true);
  });
  it("rejects zero quantity", () => {
    expect(
      controlledSubstanceSchema.safeParse({ medicineId: UUID, quantity: 0 }).success
    ).toBe(false);
  });
});

describe("checkInteractionsSchema", () => {
  it("accepts at least one medicineId", () => {
    expect(checkInteractionsSchema.safeParse({ medicineIds: [UUID] }).success).toBe(true);
  });
  it("rejects empty medicineIds array", () => {
    expect(checkInteractionsSchema.safeParse({ medicineIds: [] }).success).toBe(false);
  });
});

describe("pharmacyReturnSchema", () => {
  it("accepts a valid return", () => {
    expect(
      pharmacyReturnSchema.safeParse({
        inventoryItemId: UUID,
        quantity: 5,
        reason: "EXPIRED",
      }).success
    ).toBe(true);
  });
  it("rejects unknown return reason", () => {
    expect(
      pharmacyReturnSchema.safeParse({
        inventoryItemId: UUID,
        quantity: 5,
        reason: "BORED" as any,
      }).success
    ).toBe(false);
  });
});

describe("stockTransferSchema", () => {
  it("accepts a valid transfer", () => {
    expect(
      stockTransferSchema.safeParse({
        inventoryItemId: UUID,
        fromLocation: "MAIN",
        toLocation: "ER",
        quantity: 10,
      }).success
    ).toBe(true);
  });
  it("rejects same-location transfer with empty toLocation", () => {
    expect(
      stockTransferSchema.safeParse({
        inventoryItemId: UUID,
        fromLocation: "MAIN",
        toLocation: "",
        quantity: 10,
      }).success
    ).toBe(false);
  });
});

describe("valuationMethodSchema", () => {
  it("accepts FIFO", () => {
    expect(valuationMethodSchema.safeParse("FIFO").success).toBe(true);
  });
  it("rejects unknown method", () => {
    expect(valuationMethodSchema.safeParse("HIFO").success).toBe(false);
  });
});
