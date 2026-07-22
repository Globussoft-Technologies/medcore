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
  createMaterialAdjustmentRequestSchema,
  reviewMaterialAdjustmentRequestSchema,
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

  it("rejects medicine because pharmacy owns that flow", () => {
    expect(
      createMaterialSchema.safeParse({ name: "Paracetamol 650mg", category: "MEDICINE" }).success,
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
    expect(
      adjustMaterialStockSchema.safeParse({
        locationType: "MAIN",
        delta: 5,
        reasonCode: "FOUND",
      }).success,
    ).toBe(true);
  });

  it("accepts a negative delta (correction)", () => {
    expect(
      adjustMaterialStockSchema.safeParse({
        locationType: "MAIN",
        delta: -3,
        reasonCode: "CORRECTION",
      }).success,
    ).toBe(true);
  });

  it("rejects a zero delta", () => {
    expect(
      adjustMaterialStockSchema.safeParse({
        locationType: "MAIN",
        delta: 0,
        reasonCode: "CORRECTION",
      }).success,
    ).toBe(false);
  });

  it("requires a department when adjusting department-held stock", () => {
    expect(
      adjustMaterialStockSchema.safeParse({
        locationType: "DEPARTMENT",
        delta: -1,
        reasonCode: "DAMAGED",
      }).success,
    ).toBe(false);
  });

  it("requires damage adjustments to reduce stock", () => {
    expect(
      adjustMaterialStockSchema.safeParse({
        locationType: "MAIN",
        delta: 2,
        reasonCode: "DAMAGED",
      }).success,
    ).toBe(false);
  });

  it("requires a note for OTHER adjustments", () => {
    expect(
      adjustMaterialStockSchema.safeParse({
        locationType: "MAIN",
        delta: -1,
        reasonCode: "OTHER",
      }).success,
    ).toBe(false);
  });
});

describe("material adjustment request schemas", () => {
  const DEPT = "d93c8b27-4f78-4ee1-a7ac-298b5b4eb09d";

  it("accepts a department reduction request", () => {
    expect(
      createMaterialAdjustmentRequestSchema.safeParse({
        departmentId: DEPT,
        delta: -2,
        reasonCode: "DAMAGED",
      }).success,
    ).toBe(true);
  });

  it("rejects a non-negative department request", () => {
    expect(
      createMaterialAdjustmentRequestSchema.safeParse({
        departmentId: DEPT,
        delta: 1,
        reasonCode: "DAMAGED",
      }).success,
    ).toBe(false);
  });

  it("rejects increase-only reasons in department requests", () => {
    expect(
      createMaterialAdjustmentRequestSchema.safeParse({
        departmentId: DEPT,
        delta: -1,
        reasonCode: "FOUND",
      }).success,
    ).toBe(false);
  });

  it("accepts approve/reject review payloads and rejects pending", () => {
    expect(
      reviewMaterialAdjustmentRequestSchema.safeParse({ status: "APPROVED" }).success,
    ).toBe(true);
    expect(
      reviewMaterialAdjustmentRequestSchema.safeParse({ status: "REJECTED" }).success,
    ).toBe(true);
    expect(
      reviewMaterialAdjustmentRequestSchema.safeParse({ status: "PENDING" }).success,
    ).toBe(false);
  });
});
