import { describe, it, expect } from "vitest";
import { formatPhone } from "../format-phone";

// Issue #278 (Apr 2026): the helper is the contract that lets the
// ambulance card, patients table, and any future surface render the
// SAME phone string for the same underlying number. These tests pin
// the canonical shapes — if a future contributor "improves" the
// formatter and breaks one of these, downstream UI consistency goes
// with it.
describe("formatPhone", () => {
  it("returns empty for null/undefined/empty", () => {
    expect(formatPhone(null)).toBe("");
    expect(formatPhone(undefined)).toBe("");
    expect(formatPhone("")).toBe("");
    expect(formatPhone("   ")).toBe("");
  });

  it("formats a plain 10-digit Indian local number", () => {
    expect(formatPhone("9876543212")).toBe("98765 43212");
  });

  it("formats a +91-prefixed 12-digit number", () => {
    // Mirrors the failing case from issue #278 directly.
    expect(formatPhone("+917321588452")).toBe("+91 73215 88452");
  });

  it("normalises a 91-prefixed 12-digit number with no plus", () => {
    expect(formatPhone("917321588452")).toBe("+91 73215 88452");
  });

  it("strips a leading domestic 0 and formats as 10-digit", () => {
    expect(formatPhone("09876543212")).toBe("98765 43212");
  });

  it("preserves non-Indian international shapes by keeping +", () => {
    // 11-digit US-style number with country code 1 and leading +
    expect(formatPhone("+12025550123")).toBe("+12025 55012 3");
  });

  it("returns the trimmed original for nonsense fixture data", () => {
    // The issue cited a 15-char `DEF-10` style value — callers should see
    // it untouched so they know to fix it, rather than the formatter
    // silently mutating it.
    expect(formatPhone("DEF-10-asdfghjk")).toBe("DEF-10-asdfghjk");
    expect(formatPhone("123")).toBe("123");
  });
});
