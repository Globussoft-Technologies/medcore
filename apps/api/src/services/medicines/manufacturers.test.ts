/**
 * Test-cron tick (2026-05-25) — unit coverage for the manufacturer registry
 * + resolution helpers in `apps/api/src/services/medicines/manufacturers.ts`.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: full coverage of all 3 exports — `INDIAN_MANUFACTURERS` (the
 *   curated registry), `pickManufacturerFor()` (deterministic round-robin
 *   hash), `canonicalManufacturerFor()` (curated drug→manufacturer map),
 *   and `resolveManufacturer()` (canonical-first / round-robin-fallback
 *   composer). Pins:
 *     * Registry shape: non-empty, contains expected canonical brands
 *       (Cipla, Sun Pharma, Dr. Reddy's, Biocon — the ones used by the
 *       CANONICAL_MAP so a registry shrink doesn't silently orphan them),
 *       and is frozen at the type level (`readonly string[]`).
 *     * `pickManufacturerFor()` is deterministic — same key returns the
 *       same manufacturer across calls. This is load-bearing: the
 *       backfill migration's dry-run preview MUST match the apply run.
 *     * `pickManufacturerFor()` always returns a member of the registry
 *       (never `undefined`, never an out-of-range string).
 *     * `pickManufacturerFor()` handles the empty string (hash=0 → idx 0
 *       → first element) without throwing.
 *     * `pickManufacturerFor()` handles very long keys + Unicode keys
 *       without overflow / NaN (the `| 0` coercion keeps hash in int32).
 *     * `canonicalManufacturerFor()` resolves on substring match against
 *       lowercased name (so "Amlodipine 5mg" → "Cipla" via the
 *       "amlodipine" key) AND on case-insensitive input.
 *     * `canonicalManufacturerFor()` accepts both string input AND the
 *       `{ name, genericName }` object shape — the object shape
 *       concatenates name + genericName so a match on either wins.
 *     * `canonicalManufacturerFor()` handles null / undefined / empty
 *       name + genericName without throwing (the `?? ""` fallback).
 *     * `canonicalManufacturerFor()` returns `null` for unknown drugs.
 *     * `resolveManufacturer()` prefers canonical mapping when present;
 *       falls back to the hash when not. The `hashKey` override is used
 *       for the fallback's stable identity (so callers can pass the row
 *       id instead of the name).
 *     * `resolveManufacturer()` falls back to hashing the input's name
 *       when no explicit hashKey is provided; falls back to "" when
 *       neither name nor hashKey is available (regression guard — an
 *       empty hash key MUST still produce a valid registry entry, not
 *       throw).
 *
 * - MODULES: imports the 4 exports from `./manufacturers`. Pure logic —
 *   no I/O, no mocks needed.
 *
 * - WHY: file shipped at 0% coverage and is consumed by the seed +
 *   backfill scripts (medicines-seed.ts, backfill-manufacturers.ts). A
 *   regression to `pickManufacturerFor()`'s determinism would break
 *   migration dry-run-vs-apply symmetry; a regression to
 *   `canonicalManufacturerFor()`'s substring search would silently
 *   re-route familiar drugs through the round-robin fallback.
 */
import { describe, it, expect } from "vitest";
import {
  INDIAN_MANUFACTURERS,
  pickManufacturerFor,
  canonicalManufacturerFor,
  resolveManufacturer,
} from "./manufacturers";

// ── INDIAN_MANUFACTURERS registry ──────────────────────────────────────

describe("INDIAN_MANUFACTURERS registry exposes a diverse curated list", () => {
  it("is non-empty and contains the brands referenced by CANONICAL_MAP so the canonical map is never orphaned", () => {
    expect(INDIAN_MANUFACTURERS.length).toBeGreaterThan(0);
    // Brands the canonical map points to that are ALSO expected to live in
    // the round-robin registry. (Sanofi India is canonical-only; that's
    // intentional and we don't require it here.)
    const required = [
      "Cipla",
      "Sun Pharma",
      "Dr. Reddy's",
      "USV",
      "Torrent",
      "Glenmark",
      "Alembic",
      "Zydus",
      "Lupin",
      "Alkem",
      "Abbott India",
      "GSK",
      "Biocon",
    ];
    for (const brand of required) {
      expect(INDIAN_MANUFACTURERS).toContain(brand);
    }
  });

  it("has no duplicate entries — a duplicate would skew the round-robin distribution", () => {
    const set = new Set(INDIAN_MANUFACTURERS);
    expect(set.size).toBe(INDIAN_MANUFACTURERS.length);
  });

  it("has no empty or whitespace-only entries", () => {
    for (const entry of INDIAN_MANUFACTURERS) {
      expect(entry.trim().length).toBeGreaterThan(0);
    }
  });
});

// ── pickManufacturerFor ────────────────────────────────────────────────

describe("pickManufacturerFor deterministically maps a key to a registry entry", () => {
  it("returns the same manufacturer for the same key across calls (deterministic)", () => {
    const a = pickManufacturerFor("paracetamol-500mg");
    const b = pickManufacturerFor("paracetamol-500mg");
    const c = pickManufacturerFor("paracetamol-500mg");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("always returns a member of INDIAN_MANUFACTURERS (never undefined, never out-of-range)", () => {
    const samples = [
      "a",
      "abc",
      "amoxicillin",
      "very-long-key-name-with-many-characters-1234567890",
      "x".repeat(500),
      "med-001",
      "med-002",
      "med-999",
    ];
    for (const key of samples) {
      const result = pickManufacturerFor(key);
      expect(result).toBeTypeOf("string");
      expect(INDIAN_MANUFACTURERS).toContain(result);
    }
  });

  it("handles the empty string without throwing — empty hash collapses to index 0", () => {
    const result = pickManufacturerFor("");
    expect(INDIAN_MANUFACTURERS).toContain(result);
    // Empty string → hash stays 0 → idx 0 → first registry entry ("Cipla").
    expect(result).toBe(INDIAN_MANUFACTURERS[0]);
  });

  it("handles Unicode + non-ASCII keys (Devanagari / emoji) without NaN or RangeError", () => {
    const devanagari = pickManufacturerFor("पैरासिटामोल");
    const emoji = pickManufacturerFor("med-💊-001");
    expect(INDIAN_MANUFACTURERS).toContain(devanagari);
    expect(INDIAN_MANUFACTURERS).toContain(emoji);
  });

  it("distributes different keys across multiple registry entries (sanity check on the hash)", () => {
    // Generate 200 distinct keys and assert the hash hits at least 5 distinct
    // registry entries — a degenerate hash that always returned the same
    // entry would fail this.
    const hits = new Set<string>();
    for (let i = 0; i < 200; i++) {
      hits.add(pickManufacturerFor(`medicine-${i}`));
    }
    expect(hits.size).toBeGreaterThanOrEqual(5);
  });

  it("differs between two related-but-distinct keys (hash sensitivity)", () => {
    // Not strictly required by the contract, but a regression that made
    // pickManufacturerFor() return the same value for everything would be
    // caught here too.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(pickManufacturerFor(`key-${i}`));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

// ── canonicalManufacturerFor ───────────────────────────────────────────

describe("canonicalManufacturerFor resolves curated drug→manufacturer mappings", () => {
  it("returns the canonical manufacturer for an exact-lowercase drug name", () => {
    expect(canonicalManufacturerFor("amlodipine")).toBe("Cipla");
    expect(canonicalManufacturerFor("atorvastatin")).toBe("Sun Pharma");
    expect(canonicalManufacturerFor("metformin")).toBe("USV");
    expect(canonicalManufacturerFor("insulin")).toBe("Biocon");
    expect(canonicalManufacturerFor("paracetamol")).toBe("GSK");
  });

  it("matches the canonical key as a substring of a longer brand name (case-insensitive)", () => {
    expect(canonicalManufacturerFor("Amlodipine 5mg Tablet")).toBe("Cipla");
    expect(canonicalManufacturerFor("AMOXICILLIN 500MG CAP")).toBe("Cipla");
    expect(canonicalManufacturerFor("Atorvastatin Calcium 10mg")).toBe(
      "Sun Pharma",
    );
  });

  it("returns null for an unknown drug name (string input)", () => {
    expect(canonicalManufacturerFor("unknown-drug-xyz-99")).toBeNull();
    expect(canonicalManufacturerFor("zzz")).toBeNull();
  });

  it("returns null for an empty string input", () => {
    expect(canonicalManufacturerFor("")).toBeNull();
  });

  it("accepts the { name, genericName } object shape and matches against the concatenation", () => {
    expect(
      canonicalManufacturerFor({
        name: "BrandX Tablet 10mg",
        genericName: "amlodipine",
      }),
    ).toBe("Cipla");

    // Match in `name` even when genericName is irrelevant
    expect(
      canonicalManufacturerFor({
        name: "Atorvastatin 20mg",
        genericName: "lipid-lowering agent",
      }),
    ).toBe("Sun Pharma");
  });

  it("treats null / undefined name + genericName as empty (no throw, returns null)", () => {
    expect(canonicalManufacturerFor({})).toBeNull();
    expect(canonicalManufacturerFor({ name: null })).toBeNull();
    expect(canonicalManufacturerFor({ genericName: null })).toBeNull();
    expect(
      canonicalManufacturerFor({ name: null, genericName: null }),
    ).toBeNull();
    expect(
      canonicalManufacturerFor({ name: undefined, genericName: undefined }),
    ).toBeNull();
  });

  it("matches a canonical drug surfaced via genericName when name has no match", () => {
    expect(
      canonicalManufacturerFor({
        name: "MysteryBrand Plus",
        genericName: "azithromycin",
      }),
    ).toBe("Alembic");
  });

  it("returns the FIRST canonical map match when input contains multiple canonical drug names (insertion order)", () => {
    // The implementation iterates Object.entries(CANONICAL_MAP) in insertion
    // order. "amlodipine" appears before "atorvastatin" in the map, so a
    // combo string is resolved to amlodipine's manufacturer.
    expect(
      canonicalManufacturerFor("amlodipine + atorvastatin combination"),
    ).toBe("Cipla");
  });

  it("resolves antibiotic + anti-diabetic + cardiac canonical entries (covers each map branch)", () => {
    expect(canonicalManufacturerFor("rosuvastatin")).toBe("Dr. Reddy's");
    expect(canonicalManufacturerFor("glimepiride")).toBe("Sanofi India");
    expect(canonicalManufacturerFor("losartan")).toBe("Torrent");
    expect(canonicalManufacturerFor("telmisartan")).toBe("Glenmark");
    expect(canonicalManufacturerFor("enalapril")).toBe("Cipla");
    expect(canonicalManufacturerFor("ramipril")).toBe("Sun Pharma");
    expect(canonicalManufacturerFor("atenolol")).toBe("Alembic");
    expect(canonicalManufacturerFor("metoprolol")).toBe("Zydus");
    expect(canonicalManufacturerFor("clopidogrel")).toBe("Lupin");
    expect(canonicalManufacturerFor("warfarin")).toBe("Cipla");
    expect(canonicalManufacturerFor("ciprofloxacin")).toBe("Dr. Reddy's");
    expect(canonicalManufacturerFor("doxycycline")).toBe("Zydus");
    expect(canonicalManufacturerFor("metronidazole")).toBe("Alkem");
    expect(canonicalManufacturerFor("levothyroxine")).toBe("Abbott India");
    expect(canonicalManufacturerFor("pantoprazole")).toBe("Sun Pharma");
    expect(canonicalManufacturerFor("omeprazole")).toBe("Dr. Reddy's");
    expect(canonicalManufacturerFor("cetirizine")).toBe("GSK");
    expect(canonicalManufacturerFor("ibuprofen")).toBe("Cipla");
    expect(canonicalManufacturerFor("aspirin")).toBe("USV");
  });
});

// ── resolveManufacturer ────────────────────────────────────────────────

describe("resolveManufacturer prefers canonical mapping and falls back to round-robin hash", () => {
  it("returns the canonical manufacturer when one is known for the input", () => {
    expect(resolveManufacturer("amlodipine")).toBe("Cipla");
    expect(resolveManufacturer("metformin")).toBe("USV");
    expect(resolveManufacturer({ name: "Atorvastatin 20mg" })).toBe(
      "Sun Pharma",
    );
  });

  it("falls back to pickManufacturerFor when no canonical mapping matches (string input)", () => {
    const unknown = "made-up-medicine-xyz";
    const fallback = pickManufacturerFor(unknown);
    expect(resolveManufacturer(unknown)).toBe(fallback);
    expect(INDIAN_MANUFACTURERS).toContain(resolveManufacturer(unknown));
  });

  it("uses the explicit hashKey for the fallback when provided (canonical lookup STILL runs against the input)", () => {
    // Unknown input + explicit hashKey → fallback hashes the hashKey, not the input.
    const expected = pickManufacturerFor("row-id-12345");
    expect(resolveManufacturer("unknown-drug", "row-id-12345")).toBe(expected);
  });

  it("ignores hashKey when the canonical lookup hits (canonical wins regardless of hashKey)", () => {
    // "amlodipine" → canonical "Cipla" — the hashKey is never consulted.
    expect(resolveManufacturer("amlodipine", "ignored-hash-key")).toBe("Cipla");
  });

  it("falls back to hashing the object's name when no hashKey is provided and canonical misses", () => {
    const input = { name: "MysteryBrand 50mg", genericName: "mystery-generic" };
    const expected = pickManufacturerFor("MysteryBrand 50mg");
    expect(resolveManufacturer(input)).toBe(expected);
  });

  it("falls back to hashing the empty string when name is null/missing and no hashKey is provided", () => {
    // Regression guard: an input with no name AND no hashKey MUST still
    // produce a valid registry entry (not throw, not undefined).
    const result = resolveManufacturer({ name: null, genericName: null });
    expect(result).toBe(pickManufacturerFor(""));
    expect(INDIAN_MANUFACTURERS).toContain(result);
  });

  it("falls back to hashing the empty string when input is an object with no fields and no hashKey", () => {
    const result = resolveManufacturer({});
    expect(result).toBe(pickManufacturerFor(""));
    expect(INDIAN_MANUFACTURERS).toContain(result);
  });

  it("is deterministic end-to-end: same input → same output across calls (fallback path)", () => {
    const a = resolveManufacturer("never-heard-of-this-drug");
    const b = resolveManufacturer("never-heard-of-this-drug");
    expect(a).toBe(b);
  });

  it("is deterministic end-to-end: same input → same output across calls (canonical path)", () => {
    const a = resolveManufacturer({ name: "Insulin Glargine 100IU" });
    const b = resolveManufacturer({ name: "Insulin Glargine 100IU" });
    expect(a).toBe(b);
    expect(a).toBe("Biocon");
  });
});
