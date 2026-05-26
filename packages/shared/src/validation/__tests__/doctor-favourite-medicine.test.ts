// Coverage tests for doctor-favourite-medicine validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   in packages/shared/src/validation/doctor-favourite-medicine.ts —
//   addFavouriteMedicineSchema (POST), updateFavouriteMedicineSchema (PATCH
//   with "at least one field" refine), reorderFavouritesSchema (atomic bulk
//   reorder with array bounds).
// Which modules: imports only schemas from ../doctor-favourite-medicine.
// Why: file shipped with 0% colocated coverage (Pearl §2.1.4 gap item #50).
//   Locks in: (a) idLike accepts both uuid and cuid (Medicine.id is uuid,
//   DoctorFavouriteMedicine.id is cuid; schema is forward-compatible);
//   (b) position integer + 0..9999 bounds; (c) string trim + max bounds on
//   the three default-* fields; (d) PATCH refine requires at least one field;
//   (e) reorder items array min 1 / max 500 bounds.
import { describe, it, expect } from "vitest";
import {
  addFavouriteMedicineSchema,
  updateFavouriteMedicineSchema,
  reorderFavouritesSchema,
} from "../doctor-favourite-medicine";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const CUID = "ckxyz1234567890abcdefghij";

// ───────────────────────────────────────────────────────
// addFavouriteMedicineSchema
// ───────────────────────────────────────────────────────

describe("addFavouriteMedicineSchema", () => {
  it("accepts a minimal valid input (medicineId only)", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: UUID }).success
    ).toBe(true);
  });

  it("accepts a medicineId as cuid (forward-compat with PK flip)", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: CUID }).success
    ).toBe(true);
  });

  it("accepts a fully-populated input", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({
        medicineId: UUID,
        position: 5,
        defaultDosage: "500mg",
        defaultFrequency: "BD",
        defaultDuration: "5 days",
      }).success
    ).toBe(true);
  });

  it("accepts explicit nulls on optional default-* fields", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({
        medicineId: UUID,
        defaultDosage: null,
        defaultFrequency: null,
        defaultDuration: null,
      }).success
    ).toBe(true);
  });

  it("rejects empty-string medicineId (min 1)", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: "" }).success
    ).toBe(false);
  });

  it("rejects medicineId longer than 64 chars", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: "x".repeat(65) }).success
    ).toBe(false);
  });

  it("accepts medicineId at exactly 64 chars (boundary)", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: "x".repeat(64) }).success
    ).toBe(true);
  });

  it("accepts medicineId at exactly 1 char (boundary)", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: "x" }).success
    ).toBe(true);
  });

  it("rejects missing medicineId", () => {
    expect(addFavouriteMedicineSchema.safeParse({}).success).toBe(false);
  });

  it("rejects non-string medicineId", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: 123 as any }).success
    ).toBe(false);
  });

  it("rejects non-integer position", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: UUID, position: 1.5 }).success
    ).toBe(false);
  });

  it("rejects negative position", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: UUID, position: -1 }).success
    ).toBe(false);
  });

  it("accepts position=0 (min boundary)", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: UUID, position: 0 }).success
    ).toBe(true);
  });

  it("accepts position=9999 (max boundary)", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: UUID, position: 9999 }).success
    ).toBe(true);
  });

  it("rejects position > 9999", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({ medicineId: UUID, position: 10000 }).success
    ).toBe(false);
  });

  it("rejects defaultDosage longer than 50 chars", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({
        medicineId: UUID,
        defaultDosage: "x".repeat(51),
      }).success
    ).toBe(false);
  });

  it("accepts defaultDosage at exactly 50 chars (boundary)", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({
        medicineId: UUID,
        defaultDosage: "x".repeat(50),
      }).success
    ).toBe(true);
  });

  it("trims whitespace on defaultDosage", () => {
    const r = addFavouriteMedicineSchema.safeParse({
      medicineId: UUID,
      defaultDosage: "  500mg  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.defaultDosage).toBe("500mg");
  });

  it("rejects defaultFrequency longer than 20 chars", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({
        medicineId: UUID,
        defaultFrequency: "x".repeat(21),
      }).success
    ).toBe(false);
  });

  it("accepts defaultFrequency at exactly 20 chars (boundary)", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({
        medicineId: UUID,
        defaultFrequency: "x".repeat(20),
      }).success
    ).toBe(true);
  });

  it("trims whitespace on defaultFrequency", () => {
    const r = addFavouriteMedicineSchema.safeParse({
      medicineId: UUID,
      defaultFrequency: "  BD  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.defaultFrequency).toBe("BD");
  });

  it("rejects defaultDuration longer than 30 chars", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({
        medicineId: UUID,
        defaultDuration: "x".repeat(31),
      }).success
    ).toBe(false);
  });

  it("accepts defaultDuration at exactly 30 chars (boundary)", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({
        medicineId: UUID,
        defaultDuration: "x".repeat(30),
      }).success
    ).toBe(true);
  });

  it("trims whitespace on defaultDuration", () => {
    const r = addFavouriteMedicineSchema.safeParse({
      medicineId: UUID,
      defaultDuration: "  5 days  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.defaultDuration).toBe("5 days");
  });

  it("rejects non-string defaultDosage", () => {
    expect(
      addFavouriteMedicineSchema.safeParse({
        medicineId: UUID,
        defaultDosage: 500 as any,
      }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// updateFavouriteMedicineSchema (PATCH with refine)
// ───────────────────────────────────────────────────────

describe("updateFavouriteMedicineSchema", () => {
  it("accepts a position-only patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ position: 3 }).success
    ).toBe(true);
  });

  it("accepts a defaultDosage-only patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ defaultDosage: "250mg" }).success
    ).toBe(true);
  });

  it("accepts a defaultFrequency-only patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ defaultFrequency: "TDS" }).success
    ).toBe(true);
  });

  it("accepts a defaultDuration-only patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ defaultDuration: "7 days" }).success
    ).toBe(true);
  });

  it("accepts a fully-populated patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({
        position: 1,
        defaultDosage: "500mg",
        defaultFrequency: "OD",
        defaultDuration: "3 days",
      }).success
    ).toBe(true);
  });

  it("accepts a null-only patch (null counts as 'provided' for refine)", () => {
    // Even setting a default-* field to null is a meaningful PATCH (clearing
    // a preset). The refine checks `!== undefined`, so null passes.
    expect(
      updateFavouriteMedicineSchema.safeParse({ defaultDosage: null }).success
    ).toBe(true);
  });

  it("rejects an empty patch (refine: at least one field required)", () => {
    const r = updateFavouriteMedicineSchema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /At least one field is required/.test(i.message))
      ).toBe(true);
    }
  });

  it("rejects non-integer position on patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ position: 1.5 }).success
    ).toBe(false);
  });

  it("rejects negative position on patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ position: -1 }).success
    ).toBe(false);
  });

  it("accepts position=0 boundary on patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ position: 0 }).success
    ).toBe(true);
  });

  it("accepts position=9999 boundary on patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ position: 9999 }).success
    ).toBe(true);
  });

  it("rejects position > 9999 on patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ position: 10000 }).success
    ).toBe(false);
  });

  it("rejects defaultDosage longer than 50 chars on patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ defaultDosage: "x".repeat(51) }).success
    ).toBe(false);
  });

  it("rejects defaultFrequency longer than 20 chars on patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ defaultFrequency: "x".repeat(21) }).success
    ).toBe(false);
  });

  it("rejects defaultDuration longer than 30 chars on patch", () => {
    expect(
      updateFavouriteMedicineSchema.safeParse({ defaultDuration: "x".repeat(31) }).success
    ).toBe(false);
  });

  it("trims whitespace on patch defaultDosage", () => {
    const r = updateFavouriteMedicineSchema.safeParse({ defaultDosage: "  1 tab  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.defaultDosage).toBe("1 tab");
  });

  it("does NOT accept medicineId on patch (stripped — immutable post-create)", () => {
    // The schema doesn't include medicineId, so it'll be stripped as an
    // unknown key (default Zod object behavior). But the refine still needs
    // a recognized field to pass — a body with ONLY medicineId should fail
    // the refine because none of the known fields were provided.
    const r = updateFavouriteMedicineSchema.safeParse({ medicineId: UUID } as any);
    expect(r.success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// reorderFavouritesSchema
// ───────────────────────────────────────────────────────

describe("reorderFavouritesSchema", () => {
  it("accepts a single-item reorder", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ id: CUID, position: 0 }],
      }).success
    ).toBe(true);
  });

  it("accepts a multi-item reorder", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [
          { id: CUID, position: 0 },
          { id: UUID, position: 1 },
          { id: "another-id", position: 2 },
        ],
      }).success
    ).toBe(true);
  });

  it("accepts id as either uuid or cuid", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [
          { id: UUID, position: 0 },
          { id: CUID, position: 1 },
        ],
      }).success
    ).toBe(true);
  });

  it("accepts a 500-item reorder (max boundary)", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: `id-${i}`,
      position: i,
    }));
    expect(reorderFavouritesSchema.safeParse({ items }).success).toBe(true);
  });

  it("rejects a 501-item reorder (over max)", () => {
    const items = Array.from({ length: 501 }, (_, i) => ({
      id: `id-${i}`,
      position: i,
    }));
    expect(reorderFavouritesSchema.safeParse({ items }).success).toBe(false);
  });

  it("rejects an empty items array (min 1)", () => {
    expect(
      reorderFavouritesSchema.safeParse({ items: [] }).success
    ).toBe(false);
  });

  it("rejects missing items key", () => {
    expect(reorderFavouritesSchema.safeParse({}).success).toBe(false);
  });

  it("rejects non-array items", () => {
    expect(
      reorderFavouritesSchema.safeParse({ items: "not-array" as any }).success
    ).toBe(false);
  });

  it("rejects empty-string id within items", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ id: "", position: 0 }],
      }).success
    ).toBe(false);
  });

  it("rejects id longer than 64 chars within items", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ id: "x".repeat(65), position: 0 }],
      }).success
    ).toBe(false);
  });

  it("accepts id at exactly 64 chars boundary", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ id: "x".repeat(64), position: 0 }],
      }).success
    ).toBe(true);
  });

  it("rejects missing id in an item", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ position: 0 } as any],
      }).success
    ).toBe(false);
  });

  it("rejects missing position in an item", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ id: CUID } as any],
      }).success
    ).toBe(false);
  });

  it("rejects non-integer position in an item", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ id: CUID, position: 1.5 }],
      }).success
    ).toBe(false);
  });

  it("rejects negative position in an item", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ id: CUID, position: -1 }],
      }).success
    ).toBe(false);
  });

  it("accepts position=0 boundary in an item", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ id: CUID, position: 0 }],
      }).success
    ).toBe(true);
  });

  it("accepts position=9999 boundary in an item", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ id: CUID, position: 9999 }],
      }).success
    ).toBe(true);
  });

  it("rejects position > 9999 in an item", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [{ id: CUID, position: 10000 }],
      }).success
    ).toBe(false);
  });

  it("rejects mixed-validity items array (one invalid sinks the whole)", () => {
    expect(
      reorderFavouritesSchema.safeParse({
        items: [
          { id: CUID, position: 0 },
          { id: "", position: 1 },
        ],
      }).success
    ).toBe(false);
  });
});
