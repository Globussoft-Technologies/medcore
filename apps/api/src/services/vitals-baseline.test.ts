import { describe, it, expect } from "vitest";
import { isBaselineDeviation } from "./vitals-baseline";

describe("isBaselineDeviation", () => {
  it("returns true for values >20% above baseline", () => {
    expect(isBaselineDeviation(150, 120)).toBe(true); // +25%
  });

  it("returns true for values >20% below baseline", () => {
    expect(isBaselineDeviation(80, 120)).toBe(true); // -33%
  });

  it("returns false for values within 20%", () => {
    expect(isBaselineDeviation(135, 120)).toBe(false); // +12.5%
    expect(isBaselineDeviation(100, 120)).toBe(false); // -16.6%
  });

  it("returns false when value is null/undefined", () => {
    expect(isBaselineDeviation(null as any, 120)).toBe(false);
    expect(isBaselineDeviation(undefined, 120)).toBe(false);
  });

  it("returns false when baseline is null or zero", () => {
    expect(isBaselineDeviation(120, null)).toBe(false);
    expect(isBaselineDeviation(120, 0)).toBe(false);
  });

  it("returns false at exactly 20% boundary", () => {
    // 144 is exactly 20% above 120, so abs(deviation)/baseline = 0.2 — NOT > 0.2
    expect(isBaselineDeviation(144, 120)).toBe(false);
  });
});
