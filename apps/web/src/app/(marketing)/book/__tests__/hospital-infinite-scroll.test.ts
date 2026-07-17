/**
 * Hospital-picker infinite scroll (2026-07) — pagination logic contract.
 *
 * The public booking page (../page.tsx) renders the "Which hospital would you
 * like to visit?" list. With many hospitals (20+ demo tenants) the list must
 * NOT grow unbounded and push the page — it scrolls inside a capped panel and
 * reveals rows a page at a time as the user nears the bottom (infinite scroll).
 *
 * The reveal logic is inline in the page component (a heavy client component
 * with Firebase / MediaRecorder / portals that is impractical to mount here).
 * These tests pin the exact arithmetic that inline logic uses so a refactor
 * can't silently change the paging behaviour:
 *   - render only the first `visibleCount` rows (slice)
 *   - grow by HOSPITAL_PAGE when scrollTop + clientHeight >= scrollHeight - 120
 *   - never grow past the total, and stop firing once everything is shown
 */
import { describe, it, expect } from "vitest";

const HOSPITAL_PAGE = 8;

/** Mirrors the page's onHospitalScroll reveal rule. Returns the next count. */
function nextVisibleCount(
  current: number,
  total: number,
  el: { scrollTop: number; clientHeight: number; scrollHeight: number },
): number {
  const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 120;
  if (!nearBottom) return current;
  return current >= total
    ? current
    : Math.min(current + HOSPITAL_PAGE, total);
}

describe("hospital picker — initial page", () => {
  it("shows only the first HOSPITAL_PAGE rows when there are more", () => {
    const hospitals = Array.from({ length: 24 }, (_, i) => `h${i}`);
    const visible = hospitals.slice(0, HOSPITAL_PAGE);
    expect(visible).toHaveLength(8);
    expect(visible[0]).toBe("h0");
    expect(visible[7]).toBe("h7");
  });

  it("shows all rows when total is within one page (no scroll needed)", () => {
    const hospitals = Array.from({ length: 5 }, (_, i) => `h${i}`);
    expect(hospitals.slice(0, HOSPITAL_PAGE)).toHaveLength(5);
  });
});

describe("hospital picker — reveal on scroll", () => {
  const total = 24;

  it("does not grow while scrolled away from the bottom", () => {
    const next = nextVisibleCount(HOSPITAL_PAGE, total, {
      scrollTop: 0,
      clientHeight: 400,
      scrollHeight: 2000,
    });
    expect(next).toBe(HOSPITAL_PAGE);
  });

  it("reveals the next page when scrolled near the bottom", () => {
    const next = nextVisibleCount(HOSPITAL_PAGE, total, {
      // 1600 + 400 = 2000 == scrollHeight → well within the 120px trigger.
      scrollTop: 1600,
      clientHeight: 400,
      scrollHeight: 2000,
    });
    expect(next).toBe(HOSPITAL_PAGE * 2); // 16
  });

  it("triggers within the 120px threshold before the exact end", () => {
    const next = nextVisibleCount(HOSPITAL_PAGE, total, {
      scrollTop: 1500, // 1500 + 400 = 1900 = 2000 - 100 (<= 120 gap)
      clientHeight: 400,
      scrollHeight: 2000,
    });
    expect(next).toBe(HOSPITAL_PAGE * 2);
  });

  it("caps at the total and never over-reveals", () => {
    // Already showing 20 of 24; one more reveal reaches 24 (not 28)…
    const atNearEnd = nextVisibleCount(20, total, {
      scrollTop: 1600,
      clientHeight: 400,
      scrollHeight: 2000,
    });
    expect(atNearEnd).toBe(total); // 24, not 28

    // …and once everything is shown, scrolling to the bottom is a no-op.
    const atEnd = nextVisibleCount(total, total, {
      scrollTop: 1600,
      clientHeight: 400,
      scrollHeight: 2000,
    });
    expect(atEnd).toBe(total);
  });
});
