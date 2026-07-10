// Colocated coverage for the requisition validation surface.
//
// What: the create schema's per-line "exactly one source" refinement
// (inventoryItemId XOR materialId) plus the approve/reject/issue/receive
// payload shapes.
// Why: the dual-source refinement is the load-bearing new rule (2026-07) — a
// line must reference a pharmacy item OR a material, never both / neither.

import { describe, it, expect } from "vitest";
import {
  createRequisitionSchema,
  approveRequisitionSchema,
  rejectRequisitionSchema,
  issueRequisitionSchema,
} from "./requisition";

const DEPT = "d93c8b27-4f78-4ee1-a7ac-298b5b4eb09d";
const INV = "80b8246b-9ef1-4a0c-a003-2d9a2749b328";
const MAT = "2c9b0a1e-7d3f-4a6b-9c2e-1f5a6b7c8d9e";
const ITEM = "51a45df7-934e-41eb-a62d-71ecfe94567a";

describe("createRequisitionSchema — dual-source lines", () => {
  it("accepts a line with only inventoryItemId", () => {
    const r = createRequisitionSchema.safeParse({
      departmentId: DEPT,
      items: [{ inventoryItemId: INV, requestedQty: 2 }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts a line with only materialId", () => {
    const r = createRequisitionSchema.safeParse({
      departmentId: DEPT,
      items: [{ materialId: MAT, requestedQty: 2 }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a line that sets BOTH sources", () => {
    const r = createRequisitionSchema.safeParse({
      departmentId: DEPT,
      items: [{ inventoryItemId: INV, materialId: MAT, requestedQty: 1 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a line that sets NEITHER source", () => {
    const r = createRequisitionSchema.safeParse({
      departmentId: DEPT,
      items: [{ requestedQty: 1 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty items array", () => {
    expect(createRequisitionSchema.safeParse({ departmentId: DEPT, items: [] }).success).toBe(false);
  });

  it("rejects a non-positive requestedQty", () => {
    const r = createRequisitionSchema.safeParse({
      departmentId: DEPT,
      items: [{ materialId: MAT, requestedQty: 0 }],
    });
    expect(r.success).toBe(false);
  });
});

describe("approve / reject / issue schemas", () => {
  it("approve accepts per-line approvedQty (0 allowed = line-reject)", () => {
    expect(
      approveRequisitionSchema.safeParse({ items: [{ itemId: ITEM, approvedQty: 0 }] }).success,
    ).toBe(true);
  });

  it("reject requires a non-empty reason", () => {
    expect(rejectRequisitionSchema.safeParse({ remarks: "" }).success).toBe(false);
    expect(rejectRequisitionSchema.safeParse({ remarks: "no budget" }).success).toBe(true);
  });

  it("issue accepts per-line issuedQty", () => {
    expect(
      issueRequisitionSchema.safeParse({ items: [{ itemId: ITEM, issuedQty: 3 }] }).success,
    ).toBe(true);
  });
});
