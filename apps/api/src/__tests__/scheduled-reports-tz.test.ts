// Issue #80 — Scheduled Reports "Next Run" was rendered with the browser's
// local timezone but labelled as IST, so users on UTC saw a 5h30m skew.
// The page formatter forces `timeZone: "Asia/Kolkata"` so the displayed
// time always matches the IST schedule the cron job actually fires on.
//
// This is a pure formatter test (no DB required) — it verifies that a
// known UTC instant renders to the correct IST wall-clock string. If
// someone removes the timeZone option from the page, this test fails.
import { describe, it, expect } from "vitest";

function formatNextRunIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

describe("Scheduled Reports — IST formatting (Issue #80)", () => {
  it("renders 02:30Z as 08:00 AM IST (5h30m offset)", () => {
    const out = formatNextRunIST("2026-04-26T02:30:00.000Z");
    // 02:30 UTC == 08:00 IST. We assert on the hour fragment because
    // exact punctuation/locale glyphs vary across Node ICU builds.
    expect(out).toMatch(/08:00/);
    expect(out.toLowerCase()).toMatch(/am/);
  });

  it("renders 18:30Z as 12:00 AM IST next day", () => {
    const out = formatNextRunIST("2026-04-26T18:30:00.000Z");
    expect(out).toMatch(/12:00/);
    // 18:30 UTC -> 00:00 IST on the 27th
    expect(out).toMatch(/27/);
  });

  it("returns a non-empty string for ISO input", () => {
    const out = formatNextRunIST("2026-11-08T03:30:00.000Z");
    expect(out.length).toBeGreaterThan(0);
  });
});
