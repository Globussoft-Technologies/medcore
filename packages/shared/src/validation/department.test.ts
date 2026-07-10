// Colocated coverage for the department admin validation surface.
//
// What: happy + invalid cases for createDepartmentSchema (name min 2 / max 100,
// code regex + uppercase transform, code length 2..20) and
// updateDepartmentSchema (partial + "at least one field" refine).
// Why: pure Zod safeParse — no DB/network — pins the code-uppercasing transform
// and the update non-empty refinement directly, not just via the route tests.

import { describe, it, expect } from "vitest";
import { createDepartmentSchema, updateDepartmentSchema } from "./department";

describe("createDepartmentSchema", () => {
  it("accepts a valid department and UPPERCASES the code", () => {
    const r = createDepartmentSchema.safeParse({ name: "Radiology", code: "rad" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("RAD");
  });

  it("rejects a too-short name", () => {
    expect(createDepartmentSchema.safeParse({ name: "R", code: "RAD" }).success).toBe(false);
  });

  it("rejects a code with illegal characters", () => {
    expect(createDepartmentSchema.safeParse({ name: "Radiology", code: "ra d!" }).success).toBe(false);
  });

  it("rejects a code shorter than 2 chars", () => {
    expect(createDepartmentSchema.safeParse({ name: "Radiology", code: "R" }).success).toBe(false);
  });
});

describe("updateDepartmentSchema", () => {
  it("accepts a partial update (name only)", () => {
    expect(updateDepartmentSchema.safeParse({ name: "New Name" }).success).toBe(true);
  });

  it("accepts an active-only toggle", () => {
    expect(updateDepartmentSchema.safeParse({ active: false }).success).toBe(true);
  });

  it("rejects an empty update object (at-least-one-field refine)", () => {
    expect(updateDepartmentSchema.safeParse({}).success).toBe(false);
  });
});
