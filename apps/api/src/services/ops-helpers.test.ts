import { describe, it, expect } from "vitest";
import {
  splitGst,
  analyzeSentiment,
  computeSlaDueAt,
  extractMentions,
  isWithinQuietHours,
} from "./ops-helpers";

describe("splitGst", () => {
  it("splits 18% GST evenly into CGST=9% + SGST=9%", () => {
    const r = splitGst(1000, 18);
    expect(r.taxAmount).toBe(180);
    expect(r.cgstAmount).toBe(90);
    expect(r.sgstAmount).toBe(90);
  });

  it("handles non-round amounts", () => {
    const r = splitGst(99.99, 18);
    expect(r.taxAmount).toBeCloseTo(18, 0);
    expect(r.cgstAmount + r.sgstAmount).toBeCloseTo(r.taxAmount, 2);
  });

  it("returns zero tax for 0% GST", () => {
    const r = splitGst(5000, 0);
    expect(r.taxAmount).toBe(0);
    expect(r.cgstAmount).toBe(0);
    expect(r.sgstAmount).toBe(0);
  });

  it("splits 12% correctly (6+6)", () => {
    const r = splitGst(500, 12);
    expect(r.taxAmount).toBe(60);
    expect(r.cgstAmount).toBe(30);
    expect(r.sgstAmount).toBe(30);
  });
});

describe("analyzeSentiment", () => {
  it("scores positive reviews as POSITIVE", () => {
    const r = analyzeSentiment("Doctor was great and staff was friendly");
    expect(r).not.toBeNull();
    expect(r!.label).toBe("POSITIVE");
    expect(r!.score).toBeGreaterThan(0);
  });

  it("scores negative reviews as NEGATIVE", () => {
    const r = analyzeSentiment("The wait was terrible and staff was rude");
    expect(r!.label).toBe("NEGATIVE");
    expect(r!.score).toBeLessThan(0);
  });

  it("scores neutral text without keywords as NEUTRAL", () => {
    const r = analyzeSentiment("I came to the clinic yesterday morning");
    expect(r!.label).toBe("NEUTRAL");
  });

  it("returns null for empty or blank input", () => {
    expect(analyzeSentiment("")).toBeNull();
    expect(analyzeSentiment("   ")).toBeNull();
    expect(analyzeSentiment(null)).toBeNull();
  });
});

describe("computeSlaDueAt", () => {
  const from = new Date("2024-01-01T00:00:00Z");

  it("uses 4h for CRITICAL", () => {
    const due = computeSlaDueAt("CRITICAL", from);
    expect(due.getTime() - from.getTime()).toBe(4 * 60 * 60 * 1000);
  });

  it("uses 24h for HIGH", () => {
    const due = computeSlaDueAt("HIGH", from);
    expect(due.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("uses 72h for MEDIUM (default)", () => {
    const due = computeSlaDueAt("MEDIUM", from);
    expect(due.getTime() - from.getTime()).toBe(72 * 60 * 60 * 1000);
  });

  it("uses 168h for LOW", () => {
    const due = computeSlaDueAt("LOW", from);
    expect(due.getTime() - from.getTime()).toBe(168 * 60 * 60 * 1000);
  });

  it("falls back to 72h for unknown priority", () => {
    const due = computeSlaDueAt("GIBBERISH", from);
    expect(due.getTime() - from.getTime()).toBe(72 * 60 * 60 * 1000);
  });
});

describe("extractMentions", () => {
  it("extracts @[uuid] tokens", () => {
    const ids = extractMentions(
      "Hi @[11111111-1111-1111-1111-111111111111] and @[22222222-2222-2222-2222-222222222222]"
    );
    expect(ids).toContain("11111111-1111-1111-1111-111111111111");
    expect(ids).toContain("22222222-2222-2222-2222-222222222222");
  });

  it("deduplicates repeated mentions", () => {
    const ids = extractMentions(
      "@[aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee] pinged @[aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]"
    );
    expect(ids.length).toBe(1);
  });

  it("returns an empty list when no mentions are present", () => {
    expect(extractMentions("plain message")).toEqual([]);
  });
});

describe("isWithinQuietHours", () => {
  function mk(h: number, m = 0): Date {
    const d = new Date("2024-01-01T00:00:00");
    d.setHours(h, m, 0, 0);
    return d;
  }

  it("returns true inside a standard window (09:00-17:00 at 12:00)", () => {
    expect(isWithinQuietHours(mk(12), "09:00", "17:00")).toBe(true);
  });

  it("returns false outside a standard window", () => {
    expect(isWithinQuietHours(mk(8), "09:00", "17:00")).toBe(false);
    expect(isWithinQuietHours(mk(18), "09:00", "17:00")).toBe(false);
  });

  it("handles overnight window 22:00-07:00 correctly", () => {
    expect(isWithinQuietHours(mk(23), "22:00", "07:00")).toBe(true);
    expect(isWithinQuietHours(mk(2), "22:00", "07:00")).toBe(true);
    expect(isWithinQuietHours(mk(8), "22:00", "07:00")).toBe(false);
  });

  it("returns false when config is missing", () => {
    expect(isWithinQuietHours(mk(12), null, null)).toBe(false);
    expect(isWithinQuietHours(mk(12), "09:00", undefined)).toBe(false);
  });
});
