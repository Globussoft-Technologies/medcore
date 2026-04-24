// Unit tests for the defensive formatters in lib/format.
//
// The `ageFromDOB` / `formatPatientAge` helpers guard against the Issue #13
// class of bug: a legacy Patient row with age=0 OR a missing DOB must NEVER
// render as "0" on the UI. We exhaustively cover the edge cases where the
// previous ad-hoc inline code was silently returning 0.
import { describe, it, expect } from "vitest";
import {
  ageFromDOB,
  formatPatientAge,
  formatDate,
  formatDateTime,
  formatDateRange,
} from "../format";

describe("ageFromDOB", () => {
  const NOW = new Date("2026-04-24T00:00:00.000Z");

  it("returns null for null / undefined / empty string", () => {
    expect(ageFromDOB(null, NOW)).toBeNull();
    expect(ageFromDOB(undefined, NOW)).toBeNull();
    expect(ageFromDOB("", NOW)).toBeNull();
    expect(ageFromDOB("   ", NOW)).toBeNull();
  });

  it("returns null for unparseable strings", () => {
    expect(ageFromDOB("not a date", NOW)).toBeNull();
    expect(ageFromDOB("2026-99-99", NOW)).toBeNull();
  });

  it("returns correct completed years for a standard DOB", () => {
    expect(ageFromDOB("1980-04-24", NOW)).toBe(46);
    expect(ageFromDOB("1990-01-01", NOW)).toBe(36);
  });

  it("returns 0 (valid infant answer) for DOB < 1 year old", () => {
    // 3 days before NOW
    const dob = new Date(NOW.getTime() - 3 * 24 * 3600 * 1000);
    expect(ageFromDOB(dob, NOW)).toBe(0);
  });

  it("respects anniversary — birthday yet to come this year", () => {
    // NOW = 2026-04-24. Someone born 2000-04-25 has NOT had their birthday yet → 25.
    expect(ageFromDOB("2000-04-25", NOW)).toBe(25);
    // Same day, birthday today → 26.
    expect(ageFromDOB("2000-04-24", NOW)).toBe(26);
    // After today → not yet 26.
    expect(ageFromDOB("2000-05-01", NOW)).toBe(25);
  });

  it("leap-year Feb 29 DOB computes correctly on a non-leap year", () => {
    // Someone born 2000-02-29 on 2026-04-24 is 26 (birthday already passed this year).
    expect(ageFromDOB("2000-02-29", NOW)).toBe(26);
    // On 2026-02-28 (not yet "Feb 29" equivalent) they're still 25.
    const beforeLeap = new Date("2026-02-28T00:00:00.000Z");
    expect(ageFromDOB("2000-02-29", beforeLeap)).toBe(25);
  });

  it("returns null (NOT 0) for a DOB in the future", () => {
    const futureDob = new Date(NOW.getTime() + 365 * 24 * 3600 * 1000);
    expect(ageFromDOB(futureDob, NOW)).toBeNull();
    expect(ageFromDOB("2099-01-01", NOW)).toBeNull();
  });

  it("returns null for absurdly old DOBs (>150 years)", () => {
    expect(ageFromDOB("1700-01-01", NOW)).toBeNull();
  });

  it("accepts Date, ISO string, and millisecond-number inputs", () => {
    const d = new Date("1985-06-15");
    expect(ageFromDOB(d, NOW)).toBe(40);
    expect(ageFromDOB("1985-06-15", NOW)).toBe(40);
    expect(ageFromDOB(d.getTime(), NOW)).toBe(40);
  });
});

describe("formatPatientAge", () => {
  it("prefers DOB over stored age when DOB is present", () => {
    const fiftyYearsAgo = new Date();
    fiftyYearsAgo.setFullYear(fiftyYearsAgo.getFullYear() - 50);
    expect(
      formatPatientAge({ age: 99, dateOfBirth: fiftyYearsAgo })
    ).toBe("50");
  });

  it("falls back to stored age when DOB is missing", () => {
    expect(formatPatientAge({ age: 35, dateOfBirth: null })).toBe("35");
    expect(formatPatientAge({ age: 35 })).toBe("35");
  });

  it("renders placeholder (NOT '0') when DOB is missing and age is 0", () => {
    // This is the Issue #13 scenario — legacy row with age=0 and no DOB.
    expect(formatPatientAge({ age: 0, dateOfBirth: null })).toBe("—");
    expect(formatPatientAge({ age: 0 })).toBe("—");
  });

  it("renders placeholder for both-null", () => {
    expect(formatPatientAge({ age: null, dateOfBirth: null })).toBe("—");
    expect(formatPatientAge({})).toBe("—");
  });

  it("renders '0' for genuine infant (DOB < 1y)", () => {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    expect(formatPatientAge({ dateOfBirth: threeMonthsAgo })).toBe("0");
  });

  it("accepts a custom placeholder", () => {
    expect(
      formatPatientAge({ age: null, dateOfBirth: null }, "Unknown")
    ).toBe("Unknown");
  });
});

// ─── formatDate / formatDateTime / formatDateRange — Issue #6 ────────────
// These defensive renderers prevent the "Invalid Date → Invalid Date" bug
// from appearing in the leave approval queue when a LeaveRequest row has
// null or malformed fromDate/toDate fields.
describe("formatDate", () => {
  it("returns placeholder for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("returns placeholder for undefined", () => {
    expect(formatDate(undefined)).toBe("—");
  });

  it("returns placeholder for empty string", () => {
    expect(formatDate("")).toBe("—");
  });

  it("returns placeholder for whitespace-only string", () => {
    expect(formatDate("   ")).toBe("—");
  });

  it("returns placeholder for an unparsable string", () => {
    expect(formatDate("not a date")).toBe("—");
    expect(formatDate("hello world")).toBe("—");
  });

  it("returns placeholder for NaN number", () => {
    expect(formatDate(NaN)).toBe("—");
  });

  it("renders a valid ISO string as a non-placeholder, non-'Invalid Date' string", () => {
    const out = formatDate("2026-04-24");
    expect(out).not.toBe("—");
    expect(out).not.toBe("Invalid Date");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("renders a Date instance", () => {
    const out = formatDate(new Date("2026-04-24T00:00:00Z"));
    expect(out).not.toBe("—");
    expect(out).not.toBe("Invalid Date");
  });

  it("renders a numeric millisecond value", () => {
    const out = formatDate(new Date("2026-04-24T00:00:00Z").getTime());
    expect(out).not.toBe("—");
    expect(out).not.toBe("Invalid Date");
  });
});

describe("formatDateTime", () => {
  it("returns placeholder for null / invalid", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime("bogus")).toBe("—");
    expect(formatDateTime(NaN)).toBe("—");
  });
  it("renders a valid date as a non-placeholder string", () => {
    const out = formatDateTime(new Date("2026-04-24T10:30:00Z"));
    expect(out).not.toBe("—");
    expect(out).not.toBe("Invalid Date");
  });
});

describe("formatDateRange", () => {
  it("renders '— – —' when both sides are null (no 'Invalid Date → Invalid Date')", () => {
    expect(formatDateRange(null, null)).toBe("— – —");
    expect(formatDateRange(undefined, undefined)).toBe("— – —");
  });
  it("degrades each side independently", () => {
    const half = formatDateRange(null, "2026-04-24");
    expect(half.startsWith("—")).toBe(true);
    expect(half.includes("–")).toBe(true);
    expect(half.includes("Invalid")).toBe(false);
  });
});
