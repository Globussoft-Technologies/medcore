/**
 * Unit tests for `msUntilNextDailyTick`. The substantive reconciliation logic
 * is exercised by `insurance-claims/reconciliation.test.ts`; the rest of the
 * scheduler file is just `setInterval` + `setTimeout` plumbing which the
 * project policy explicitly allows to remain smoke-only.
 *
 * The helper is the alignment math that places the daily 03:00 terminal
 * sweep — getting it wrong slides the sweep into business hours and creates
 * unbounded TPA traffic spikes, so we cover the edge cases.
 */

import { describe, it, expect } from "vitest";
import { msUntilNextDailyTick } from "./insurance-claims-scheduler";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

describe("msUntilNextDailyTick", () => {
  it("targets later-the-same-day when 'from' is before the target hour", () => {
    const from = new Date(2026, 4, 2, 1, 30, 0); // 01:30 local
    const ms = msUntilNextDailyTick(3, 0, from);
    expect(ms).toBe(90 * 60 * 1000); // 1h 30m
  });

  it("rolls to next day when 'from' is past the target hour", () => {
    const from = new Date(2026, 4, 2, 4, 0, 0); // 04:00 local
    const ms = msUntilNextDailyTick(3, 0, from);
    expect(ms).toBe(23 * ONE_HOUR_MS);
  });

  it("rolls to next day when 'from' is exactly at the target hour", () => {
    const from = new Date(2026, 4, 2, 3, 0, 0, 0); // exactly 03:00
    const ms = msUntilNextDailyTick(3, 0, from);
    // The helper uses `<= from`, so an exact match still rolls forward 24h.
    expect(ms).toBe(ONE_DAY_MS);
  });

  it("respects minute precision", () => {
    const from = new Date(2026, 4, 2, 2, 0, 0); // 02:00 local
    const ms = msUntilNextDailyTick(3, 30, from);
    expect(ms).toBe(90 * 60 * 1000); // 1h 30m
  });

  it("zeroes seconds and ms on the target tick (drift-free)", () => {
    const from = new Date(2026, 4, 2, 2, 59, 30, 250); // 02:59:30.250
    const ms = msUntilNextDailyTick(3, 0, from);
    // From 02:59:30.250 to 03:00:00.000 = 29.75s = 29750ms.
    expect(ms).toBe(29_750);
  });

  it("returns a positive value (never 0 or negative)", () => {
    const from = new Date(2026, 4, 2, 3, 0, 0, 0); // exact match
    expect(msUntilNextDailyTick(3, 0, from)).toBeGreaterThan(0);
  });
});
