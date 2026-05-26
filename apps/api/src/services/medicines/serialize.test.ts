/**
 * Test-cron tick (2026-05-25) — unit coverage for the medicine serializer
 * helpers in `apps/api/src/services/medicines/serialize.ts`.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: full coverage of both exports — `serializeMedicine()` (per-row
 *   aliasing) and `serializeMedicines()` (list map). Pins:
 *     * `rxRequired` is aliased from `prescriptionRequired`.
 *     * `rxRequired` defaults to `true` (safer default — Rx-required) when
 *       `prescriptionRequired` is null/undefined. This is load-bearing: the
 *       UI shows "Rx Required: Yes" rather than silently dropping a
 *       prescription gate when the column is missing.
 *     * `prescriptionRequired === false` survives as `rxRequired: false`
 *       (regression guard against a naive `||` instead of `??`).
 *     * `manufacturer` is aliased from `brand`, defaulting to `null` (NOT
 *       the string "null", NOT undefined) when `brand` is null/undefined.
 *     * Empty string `brand: ""` survives as `manufacturer: ""` (again,
 *       guards against `||` vs `??`).
 *     * Existing raw columns (`prescriptionRequired`, `brand`) are
 *       preserved on the output — callers querying the raw columns keep
 *       working alongside the aliased fields.
 *     * Arbitrary extra fields (id, name, dosage, etc.) pass through
 *       unchanged via the spread.
 *     * `serializeMedicines([])` returns `[]` (no throw on empty list).
 *     * `serializeMedicines([...])` applies the same aliasing to every
 *       row independently.
 *
 * - MODULES: imports the 2 exports from `./serialize`. Pure logic — no
 *   I/O, no mocks needed.
 *
 * - WHY: file shipped at 0% coverage and is consumed by the medicines
 *   list/detail routes. A regression to the `??` defaulting (e.g.
 *   switching to `||`) would silently misreport `rxRequired: true` for
 *   explicitly-OTC medicines (prescriptionRequired=false → false → true),
 *   re-introducing a prescription gate on OTC drugs. A regression to the
 *   `brand` alias would break the medicines UI's manufacturer column.
 */
import { describe, it, expect } from "vitest";
import { serializeMedicine, serializeMedicines } from "./serialize";

// ── serializeMedicine ──────────────────────────────────────────────────

describe("serializeMedicine aliases DB columns to API field names", () => {
  it("aliases prescriptionRequired=true → rxRequired=true", () => {
    const result = serializeMedicine({ prescriptionRequired: true });
    expect(result.rxRequired).toBe(true);
  });

  it("aliases prescriptionRequired=false → rxRequired=false (guards against || vs ??)", () => {
    // Regression guard: if someone replaces `??` with `||`, false collapses
    // to the default `true` and OTC medicines silently get a Rx gate.
    const result = serializeMedicine({ prescriptionRequired: false });
    expect(result.rxRequired).toBe(false);
  });

  it("defaults rxRequired to true when prescriptionRequired is null (safer default)", () => {
    const result = serializeMedicine({ prescriptionRequired: null });
    expect(result.rxRequired).toBe(true);
  });

  it("defaults rxRequired to true when prescriptionRequired is undefined / missing", () => {
    const result = serializeMedicine({});
    expect(result.rxRequired).toBe(true);
  });

  it("aliases brand → manufacturer when brand is a non-empty string", () => {
    const result = serializeMedicine({ brand: "Cipla" });
    expect(result.manufacturer).toBe("Cipla");
  });

  it("aliases brand → manufacturer preserving empty string (guards against || vs ??)", () => {
    // Regression guard: `||` would coerce "" to the null default. The
    // current `??` preserves the explicit empty string.
    const result = serializeMedicine({ brand: "" });
    expect(result.manufacturer).toBe("");
  });

  it("defaults manufacturer to null (not undefined, not 'null' string) when brand is null", () => {
    const result = serializeMedicine({ brand: null });
    expect(result.manufacturer).toBeNull();
  });

  it("defaults manufacturer to null when brand is undefined / missing", () => {
    const result = serializeMedicine({});
    expect(result.manufacturer).toBeNull();
  });

  it("preserves the raw prescriptionRequired column alongside the aliased rxRequired", () => {
    const result = serializeMedicine({ prescriptionRequired: false });
    expect(result.prescriptionRequired).toBe(false);
    expect(result.rxRequired).toBe(false);
  });

  it("preserves the raw brand column alongside the aliased manufacturer", () => {
    const result = serializeMedicine({ brand: "Sun Pharma" });
    expect(result.brand).toBe("Sun Pharma");
    expect(result.manufacturer).toBe("Sun Pharma");
  });

  it("passes through arbitrary extra fields unchanged (id, name, dosage, etc.)", () => {
    const row = {
      id: "med-001",
      name: "Amoxicillin 500mg",
      dosage: "500mg",
      stockQty: 42,
      brand: "Cipla",
      prescriptionRequired: true,
      createdAt: new Date("2026-01-01"),
    };
    const result = serializeMedicine(row);
    expect(result.id).toBe("med-001");
    expect(result.name).toBe("Amoxicillin 500mg");
    expect(result.dosage).toBe("500mg");
    expect(result.stockQty).toBe(42);
    expect(result.createdAt).toEqual(new Date("2026-01-01"));
    // And the aliased fields are still applied.
    expect(result.rxRequired).toBe(true);
    expect(result.manufacturer).toBe("Cipla");
  });

  it("handles a fully-populated realistic medicine row end-to-end", () => {
    const row = {
      id: "med-xyz",
      name: "Atorvastatin 10mg",
      genericName: "atorvastatin",
      brand: "Sun Pharma",
      prescriptionRequired: true,
      stockQty: 100,
      priceCents: 4500,
    };
    const result = serializeMedicine(row);
    expect(result).toMatchObject({
      id: "med-xyz",
      name: "Atorvastatin 10mg",
      genericName: "atorvastatin",
      brand: "Sun Pharma",
      prescriptionRequired: true,
      stockQty: 100,
      priceCents: 4500,
      rxRequired: true,
      manufacturer: "Sun Pharma",
    });
  });

  it("does NOT mutate the input row (returns a fresh object)", () => {
    const row = { prescriptionRequired: false, brand: "Lupin" };
    const result = serializeMedicine(row);
    expect(result).not.toBe(row);
    // Original row should NOT have the aliased fields injected onto it.
    expect((row as Record<string, unknown>).rxRequired).toBeUndefined();
    expect((row as Record<string, unknown>).manufacturer).toBeUndefined();
  });
});

// ── serializeMedicines ─────────────────────────────────────────────────

describe("serializeMedicines applies aliasing to each row in a list", () => {
  it("returns an empty array for an empty input list (no throw)", () => {
    expect(serializeMedicines([])).toEqual([]);
  });

  it("aliases every row independently", () => {
    const rows = [
      { id: "1", brand: "Cipla", prescriptionRequired: true },
      { id: "2", brand: "Sun Pharma", prescriptionRequired: false },
      { id: "3", brand: null, prescriptionRequired: null },
    ];
    const result = serializeMedicines(rows);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      id: "1",
      manufacturer: "Cipla",
      rxRequired: true,
    });
    expect(result[1]).toMatchObject({
      id: "2",
      manufacturer: "Sun Pharma",
      rxRequired: false,
    });
    expect(result[2]).toMatchObject({
      id: "3",
      manufacturer: null,
      rxRequired: true, // null prescriptionRequired → safer default true
    });
  });

  it("preserves list order (map, not sort/filter)", () => {
    const rows = [
      { id: "a", brand: "A" },
      { id: "b", brand: "B" },
      { id: "c", brand: "C" },
    ];
    const result = serializeMedicines(rows);
    expect(result.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("does NOT mutate input rows", () => {
    const rows = [
      { brand: "Cipla", prescriptionRequired: true },
      { brand: "Lupin", prescriptionRequired: false },
    ];
    const snapshot = JSON.parse(JSON.stringify(rows));
    serializeMedicines(rows);
    expect(rows).toEqual(snapshot);
  });

  it("returns a new array instance (not the input list)", () => {
    const rows = [{ brand: "Cipla" }];
    const result = serializeMedicines(rows);
    expect(result).not.toBe(rows);
  });
});
