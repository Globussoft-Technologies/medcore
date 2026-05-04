/**
 * Issue #348 — bed counts were inconsistent across Wards/Admissions/
 * Dashboard because each page open-coded its own reduce. The shared
 * `summarizeBeds` / `getBedSummary` helpers collapse every fallback path
 * into one formula so all three pages always agree.
 *
 * These tests pin both the per-ward and the across-wards summary against
 * the three payload shapes the API can produce:
 *   • beds[] populated   → recompute from beds[]
 *   • beds[] omitted     → fall back to aggregate fields (totalBeds, etc.)
 *   • completely missing → return zeros (no crash)
 */
import { describe, it, expect } from "vitest";
import { summarizeBeds, getBedSummary, bedBarSegments } from "../bed-summary";

describe("summarizeBeds", () => {
  it("computes from beds[] when populated", () => {
    expect(
      summarizeBeds({
        beds: [
          { status: "AVAILABLE" },
          { status: "AVAILABLE" },
          { status: "OCCUPIED" },
          { status: "CLEANING" },
          { status: "MAINTENANCE" },
        ],
      })
    ).toEqual({
      total: 5,
      available: 2,
      occupied: 1,
      cleaning: 1,
      maintenance: 1,
    });
  });

  it("falls back to aggregate fields when beds[] is omitted", () => {
    expect(
      summarizeBeds({
        totalBeds: 10,
        availableBeds: 6,
        occupiedBeds: 3,
        cleaningBeds: 1,
        maintenanceBeds: 0,
      })
    ).toEqual({
      total: 10,
      available: 6,
      occupied: 3,
      cleaning: 1,
      maintenance: 0,
    });
  });

  it("returns all zeros for null/undefined ward — no crash", () => {
    expect(summarizeBeds(null)).toEqual({
      total: 0,
      available: 0,
      occupied: 0,
      cleaning: 0,
      maintenance: 0,
    });
    expect(summarizeBeds(undefined)).toEqual({
      total: 0,
      available: 0,
      occupied: 0,
      cleaning: 0,
      maintenance: 0,
    });
  });
});

describe("getBedSummary", () => {
  it("sums across multiple wards using a mix of payload shapes", () => {
    const wards = [
      // Modern shape — beds[] populated
      {
        beds: [{ status: "AVAILABLE" }, { status: "OCCUPIED" }],
      },
      // Aggregate shape — beds[] omitted
      {
        totalBeds: 5,
        availableBeds: 3,
        occupiedBeds: 2,
      },
    ];
    expect(getBedSummary(wards)).toEqual({
      total: 7,
      available: 4,
      occupied: 3,
      cleaning: 0,
      maintenance: 0,
    });
  });

  it("Issue #348 regression — Wards page formula and Admissions page formula must agree", () => {
    // The bug: the Admissions page's open-coded reduce only filtered
    // `beds[]` and never fell back to `availableBeds`. When the API
    // returned the aggregate shape it counted 0 instead of N. This test
    // pins that both paths now report the same number.
    const wards = [
      // Aggregate-only payload — the case where the bug manifested.
      { totalBeds: 4, availableBeds: 4, occupiedBeds: 0 },
    ];
    const summary = getBedSummary(wards);
    expect(summary.available).toBe(4);
    expect(summary.total).toBe(4);
  });
});

/**
 * Issue #507 — the Wards page bed-occupancy progress bar showed colors
 * that didn't match the numeric counts (e.g. "10 total / 7 avail / 3 occ"
 * rendered roughly half red instead of ~30% red). Two root causes:
 *   1. The four flex segments had no `flex-shrink: 0`, so flex shrunk
 *      them away from their declared widths.
 *   2. MAINTENANCE beds were never given a segment, so payloads with
 *      any maintenance bed produced widths that didn't sum to 100%.
 *
 * `bedBarSegments` is the pure function the bar now delegates to. These
 * tests pin its output for the bug repro plus the standard edge cases.
 */
describe("bedBarSegments (Issue #507)", () => {
  it("matches the bug-repro counts (10 total / 7 avail / 3 occ / 0 clean)", () => {
    const segments = bedBarSegments({
      total: 10,
      available: 7,
      occupied: 3,
      cleaning: 0,
      maintenance: 0,
    });
    expect(segments).toEqual({
      occupied: "30%",
      cleaning: "0%",
      maintenance: "0%",
      available: "70%",
    });
  });

  it("returns 0% green when all beds are occupied (full red)", () => {
    const segments = bedBarSegments({
      total: 10,
      available: 0,
      occupied: 10,
      cleaning: 0,
      maintenance: 0,
    });
    expect(segments.occupied).toBe("100%");
    expect(segments.available).toBe("0%");
  });

  it("returns 100% green when no beds are occupied (empty ward)", () => {
    const segments = bedBarSegments({
      total: 10,
      available: 10,
      occupied: 0,
      cleaning: 0,
      maintenance: 0,
    });
    expect(segments.available).toBe("100%");
    expect(segments.occupied).toBe("0%");
  });

  it("renders 50% red at 5/10 occupied (mid-occupancy)", () => {
    const segments = bedBarSegments({
      total: 10,
      available: 5,
      occupied: 5,
      cleaning: 0,
      maintenance: 0,
    });
    expect(segments.occupied).toBe("50%");
    expect(segments.available).toBe("50%");
  });

  it("gives MAINTENANCE its own slice — not silently merged with available", () => {
    // Pre-fix bug: the bar omitted maintenance entirely, so a ward with
    // 1 maintenance bed had segments summing to <100% and the empty
    // tail rendered as the gray track behind the bar.
    const segments = bedBarSegments({
      total: 10,
      available: 6,
      occupied: 2,
      cleaning: 1,
      maintenance: 1,
    });
    expect(segments.occupied).toBe("20%");
    expect(segments.cleaning).toBe("10%");
    expect(segments.maintenance).toBe("10%");
    expect(segments.available).toBe("60%");
  });

  it("returns all 0% when total is 0 (no division by zero, no NaN)", () => {
    expect(
      bedBarSegments({
        total: 0,
        available: 0,
        occupied: 0,
        cleaning: 0,
        maintenance: 0,
      })
    ).toEqual({
      occupied: "0%",
      cleaning: "0%",
      maintenance: "0%",
      available: "0%",
    });
  });

  it("caps at 100% when occupied > total (stale-summary safety)", () => {
    // If a stale summary ever reports occupied > total, the bar must
    // not overflow — clamp to fully red rather than render >100%.
    const segments = bedBarSegments({
      total: 10,
      available: 0,
      occupied: 99,
      cleaning: 0,
      maintenance: 0,
    });
    expect(segments.occupied).toBe("100%");
    expect(segments.available).toBe("0%");
  });

  it("priority order is occupied → cleaning → maintenance → available", () => {
    // Even if the inputs sum to more than total, allocating in this
    // order means the visible severity (red beats yellow beats gray
    // beats green) is preserved and the bar still sums to 100%.
    const segments = bedBarSegments({
      total: 10,
      available: 5,
      occupied: 4,
      cleaning: 4,
      maintenance: 4,
    });
    expect(segments.occupied).toBe("40%");
    expect(segments.cleaning).toBe("40%");
    expect(segments.maintenance).toBe("20%");
    expect(segments.available).toBe("0%");
  });
});
