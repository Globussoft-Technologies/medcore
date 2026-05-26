// Pins the runtime constants exported from `@medcore/shared/constants` —
// pagination defaults, token TTLs, MR/INV prefixes, and the three closed
// vocabularies (consultation categories, frequency options, Indian
// insurers) used across API/web. These values are wire contracts: a
// silent drift would either (a) break paginated list endpoints quietly,
// (b) make existing MR/INV identifiers stop matching, or (c) cause the
// Insurance Claims dropdown to render duplicate / missing entries.
// Invariants asserted: type/shape, positivity for limits, MAX > DEFAULT
// for pagination, prefix purity (no whitespace), no duplicates in any
// of the as-const arrays, and frequency-option formatting (each is
// either the canonical "X-Y-Z (...)" triplet or the SOS sentinel).

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SLOT_DURATION_MINUTES,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
  MR_NUMBER_PREFIX,
  INVOICE_NUMBER_PREFIX,
  CONSULTATION_CATEGORIES,
  FREQUENCY_OPTIONS,
  INDIAN_INSURERS,
} from "../constants";

describe("constants — scalar pagination + slot defaults", () => {
  it("DEFAULT_SLOT_DURATION_MINUTES is a positive integer", () => {
    expect(typeof DEFAULT_SLOT_DURATION_MINUTES).toBe("number");
    expect(Number.isInteger(DEFAULT_SLOT_DURATION_MINUTES)).toBe(true);
    expect(DEFAULT_SLOT_DURATION_MINUTES).toBeGreaterThan(0);
  });

  it("DEFAULT_PAGE_LIMIT is a positive integer", () => {
    expect(typeof DEFAULT_PAGE_LIMIT).toBe("number");
    expect(Number.isInteger(DEFAULT_PAGE_LIMIT)).toBe(true);
    expect(DEFAULT_PAGE_LIMIT).toBeGreaterThan(0);
  });

  it("MAX_PAGE_LIMIT is a positive integer", () => {
    expect(typeof MAX_PAGE_LIMIT).toBe("number");
    expect(Number.isInteger(MAX_PAGE_LIMIT)).toBe(true);
    expect(MAX_PAGE_LIMIT).toBeGreaterThan(0);
  });

  it("MAX_PAGE_LIMIT is strictly greater than DEFAULT_PAGE_LIMIT (else the cap is meaningless)", () => {
    expect(MAX_PAGE_LIMIT).toBeGreaterThan(DEFAULT_PAGE_LIMIT);
  });
});

describe("constants — JWT token expiry strings", () => {
  it("TOKEN_EXPIRY matches the jsonwebtoken duration grammar (<n><unit>)", () => {
    expect(typeof TOKEN_EXPIRY).toBe("string");
    expect(TOKEN_EXPIRY).toMatch(/^\d+[smhdwy]$/);
  });

  it("REFRESH_TOKEN_EXPIRY matches the jsonwebtoken duration grammar", () => {
    expect(typeof REFRESH_TOKEN_EXPIRY).toBe("string");
    expect(REFRESH_TOKEN_EXPIRY).toMatch(/^\d+[smhdwy]$/);
  });

  it("the two TTL strings differ (refresh should outlive access)", () => {
    expect(TOKEN_EXPIRY).not.toBe(REFRESH_TOKEN_EXPIRY);
  });
});

describe("constants — identifier prefixes", () => {
  it("MR_NUMBER_PREFIX is a non-empty string with no whitespace", () => {
    expect(typeof MR_NUMBER_PREFIX).toBe("string");
    expect(MR_NUMBER_PREFIX.length).toBeGreaterThan(0);
    expect(MR_NUMBER_PREFIX).not.toMatch(/\s/);
  });

  it("INVOICE_NUMBER_PREFIX is a non-empty string with no whitespace", () => {
    expect(typeof INVOICE_NUMBER_PREFIX).toBe("string");
    expect(INVOICE_NUMBER_PREFIX.length).toBeGreaterThan(0);
    expect(INVOICE_NUMBER_PREFIX).not.toMatch(/\s/);
  });

  it("the two prefixes are distinct (else MR vs INV ID streams collide)", () => {
    expect(MR_NUMBER_PREFIX).not.toBe(INVOICE_NUMBER_PREFIX);
  });
});

describe("constants — CONSULTATION_CATEGORIES vocabulary", () => {
  it("is a non-empty readonly array of strings", () => {
    expect(Array.isArray(CONSULTATION_CATEGORIES)).toBe(true);
    expect(CONSULTATION_CATEGORIES.length).toBeGreaterThan(0);
    for (const c of CONSULTATION_CATEGORIES) {
      expect(typeof c).toBe("string");
      expect(c.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate entries (would break dropdown rendering)", () => {
    const set = new Set(CONSULTATION_CATEGORIES);
    expect(set.size).toBe(CONSULTATION_CATEGORIES.length);
  });

  it("includes the canonical 'Consultation Fee' entry (relied on by invoice category defaults)", () => {
    expect(CONSULTATION_CATEGORIES).toContain("Consultation Fee");
  });
});

describe("constants — FREQUENCY_OPTIONS prescription vocabulary", () => {
  it("is a non-empty readonly array of strings", () => {
    expect(Array.isArray(FREQUENCY_OPTIONS)).toBe(true);
    expect(FREQUENCY_OPTIONS.length).toBeGreaterThan(0);
    for (const f of FREQUENCY_OPTIONS) {
      expect(typeof f).toBe("string");
      expect(f.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate entries", () => {
    const set = new Set(FREQUENCY_OPTIONS);
    expect(set.size).toBe(FREQUENCY_OPTIONS.length);
  });

  it("each entry is either an X-Y-Z (...) triplet or the SOS sentinel", () => {
    // Positive contract: every freq option must be parseable by downstream
    // dispensing logic. Triplets like "1-0-1 (Morning-Night)" decompose
    // into AM/noon/PM doses; "SOS (As needed)" means PRN dosing. Anything
    // else would mean dispensing renders an option it can't price.
    const tripletRe = /^[01]-[01]-[01] \(.+\)$/;
    const sosRe = /^SOS \(.+\)$/;
    for (const f of FREQUENCY_OPTIONS) {
      expect(tripletRe.test(f) || sosRe.test(f)).toBe(true);
    }
  });

  it("contains the SOS (As needed) sentinel exactly once", () => {
    const sosCount = FREQUENCY_OPTIONS.filter((f) => f.startsWith("SOS")).length;
    expect(sosCount).toBe(1);
  });
});

describe("constants — INDIAN_INSURERS dropdown vocabulary (Issue #82)", () => {
  it("is a non-empty readonly array of strings", () => {
    expect(Array.isArray(INDIAN_INSURERS)).toBe(true);
    expect(INDIAN_INSURERS.length).toBeGreaterThan(0);
    for (const i of INDIAN_INSURERS) {
      expect(typeof i).toBe("string");
      expect(i.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate entries (duplicate dropdown rows are the original UX hazard)", () => {
    const set = new Set(INDIAN_INSURERS);
    expect(set.size).toBe(INDIAN_INSURERS.length);
  });

  it("contains no leading or trailing whitespace (would break exact-match lookups)", () => {
    for (const i of INDIAN_INSURERS) {
      expect(i).toBe(i.trim());
    }
  });

  it("contains no placeholder / mock entries (the bug Issue #82 was filed for)", () => {
    for (const i of INDIAN_INSURERS) {
      expect(i.toLowerCase()).not.toContain("mock");
      expect(i.toLowerCase()).not.toContain("test");
      expect(i.toLowerCase()).not.toContain("tpa");
    }
  });

  it("includes a representative known IRDAI insurer (smoke check the list wasn't blanked)", () => {
    expect(INDIAN_INSURERS).toContain("Star Health and Allied Insurance");
  });
});
