// Colocated coverage for the material catalog validation surface.
//
// What: happy + invalid cases for createMaterialSchema (name, category enum,
// unit default, quantity/reorderLevel non-negative), updateMaterialSchema
// (partial + non-empty refine, nullable clears) and adjustMaterialStockSchema
// (non-zero delta refine).
// Why: pure Zod safeParse — pins the category enum, the unit default and the
// "delta != 0" refinement directly.

import { describe, it, expect } from "vitest";
import {
  createMaterialSchema,
  updateMaterialSchema,
  adjustMaterialStockSchema,
} from "./material";

describe("createMaterialSchema", () => {
  it("accepts a valid material and defaults the unit", () => {
    const r = createMaterialSchema.safeParse({ name: "Surgical Gloves", category: "CONSUMABLE" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.unit).toBe("unit");
      expect(r.data.quantity).toBe(0);
      expect(r.data.reorderLevel).toBe(10);
    }
  });

  it("rejects an unknown category", () => {
    expect(
      createMaterialSchema.safeParse({ name: "X-Ray Machine", category: "GADGET" }).success,
    ).toBe(false);
  });

  it("rejects a negative quantity", () => {
    expect(
      createMaterialSchema.safeParse({ name: "Gloves", category: "CONSUMABLE", quantity: -1 }).success,
    ).toBe(false);
  });

  it("rejects a too-short name", () => {
    expect(createMaterialSchema.safeParse({ name: "G", category: "CONSUMABLE" }).success).toBe(false);
  });
});

describe("updateMaterialSchema", () => {
  it("accepts a partial update", () => {
    expect(updateMaterialSchema.safeParse({ reorderLevel: 5 }).success).toBe(true);
  });

  it("rejects an empty update (non-empty refine)", () => {
    expect(updateMaterialSchema.safeParse({}).success).toBe(false);
  });
});

describe("adjustMaterialStockSchema", () => {
  it("accepts a positive delta", () => {
    expect(adjustMaterialStockSchema.safeParse({ delta: 5 }).success).toBe(true);
  });

  it("accepts a negative delta (correction)", () => {
    expect(adjustMaterialStockSchema.safeParse({ delta: -3 }).success).toBe(true);
  });

  it("rejects a zero delta", () => {
    expect(adjustMaterialStockSchema.safeParse({ delta: 0 }).success).toBe(false);
  });
});
