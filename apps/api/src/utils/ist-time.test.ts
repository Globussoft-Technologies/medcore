// Unit tests for the shared IST (Asia/Kolkata, UTC+05:30) date helpers.
//
// These helpers are load-bearing for two recurring bug classes documented in
// CLAUDE.md and in the source file itself:
//   1. "today IST vs today UTC" — a server in UTC and a server in IST disagree
//      on which calendar day a row belongs to once the clock crosses 18:30 UTC
//      (the IST midnight). This is the same trap commit `bf86f57` fixed in
//      the patient-dashboard `FUTURE = now + 24h` constant.
//   2. `new Date("YYYY-MM-DD")` parsing as UTC-midnight, which is already
//      05:30 IST — so a subsequent `setHours(0)` slides the date by one
//      day on an IST host.
//
// What this test file locks in:
//   - IST_OFFSET_MIN is exactly 330 (the only correct value for India).
//   - istMidnightUtc: produces a UTC instant whose IST-projection lands on
//     IST midnight; offsets walk forward/backward by whole days; identical
//     output regardless of the host's runtime TZ (mocked via process.env.TZ
//     conceptually — verified by checking the wall-clock arithmetic
//     directly).
//   - istTodayBounds: start == istMidnightUtc(0); end == istMidnightUtc(1)-1ms;
//     bounds span exactly one IST day (86_400_000 ms - 1).
//   - parseIstDateOnly: round-trips a YYYY-MM-DD string to the matching IST
//     midnight; rejects malformed input (returns null); handles leap days
//     (2024-02-29 valid, 2025-02-29 normalised by JS Date math); the
//     18:30 UTC rollover trap from commit `bf86f57` is verified by
//     parsing "2026-05-25" and asserting the UTC instant is the prior
//     day's 18:30Z.
//   - India observes no DST — istMidnightUtc/parseIstDateOnly produce the
//     same offset year-round (verified across summer + winter dates).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  IST_OFFSET_MIN,
  istMidnightUtc,
  istTodayBounds,
  istTodayDateStr,
  istNowMinutes,
  parseIstDateOnly,
} from "./ist-time";

describe("IST_OFFSET_MIN", () => {
  it("is exactly 330 minutes (5 hours 30 minutes)", () => {
    expect(IST_OFFSET_MIN).toBe(330);
    expect(IST_OFFSET_MIN).toBe(5 * 60 + 30);
  });
});

describe("istMidnightUtc", () => {
  // Pin "now" to a known UTC instant so day-arithmetic is deterministic.
  // 2026-05-15T12:00:00Z is 2026-05-15T17:30:00 IST — comfortably mid-day
  // in IST, so daysOffset=0 should yield 2026-05-15T00:00 IST
  // == 2026-05-14T18:30:00Z.
  const PINNED_NOW = new Date("2026-05-15T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns IST midnight today as a UTC instant (the 18:30Z rollover trap)", () => {
    // 2026-05-15 00:00 IST = 2026-05-14 18:30 UTC.
    const out = istMidnightUtc(0);
    expect(out.toISOString()).toBe("2026-05-14T18:30:00.000Z");
  });

  it("returns IST midnight tomorrow when daysOffset=1", () => {
    // 2026-05-16 00:00 IST = 2026-05-15 18:30 UTC.
    const out = istMidnightUtc(1);
    expect(out.toISOString()).toBe("2026-05-15T18:30:00.000Z");
  });

  it("walks backward when daysOffset is negative", () => {
    const out = istMidnightUtc(-30);
    // 30 days before 2026-05-15 IST = 2026-04-15 IST -> 2026-04-14T18:30Z.
    expect(out.toISOString()).toBe("2026-04-14T18:30:00.000Z");
  });

  it("returns Date instances that are exactly 24h apart for consecutive offsets", () => {
    const today = istMidnightUtc(0);
    const tomorrow = istMidnightUtc(1);
    expect(tomorrow.getTime() - today.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("works around the IST-day rollover (host clock at 18:31 UTC)", () => {
    // 2026-05-15T18:31:00Z is 2026-05-16T00:01 IST — the IST day has
    // ALREADY ticked over to the 16th. istMidnightUtc(0) MUST return
    // 2026-05-16 00:00 IST (= 2026-05-15 18:30 UTC), not the 15th.
    vi.setSystemTime(new Date("2026-05-15T18:31:00.000Z"));
    const out = istMidnightUtc(0);
    expect(out.toISOString()).toBe("2026-05-15T18:30:00.000Z");
  });

  it("works around the IST-day rollover (host clock at 18:29 UTC)", () => {
    // 2026-05-15T18:29:00Z is 2026-05-15T23:59 IST — STILL the 15th IST.
    // istMidnightUtc(0) returns 2026-05-15 00:00 IST = 2026-05-14 18:30 UTC.
    vi.setSystemTime(new Date("2026-05-15T18:29:00.000Z"));
    const out = istMidnightUtc(0);
    expect(out.toISOString()).toBe("2026-05-14T18:30:00.000Z");
  });

  it("crosses month boundaries cleanly", () => {
    // Pin to 2026-05-31 mid-day IST; daysOffset=1 should be 2026-06-01 IST.
    vi.setSystemTime(new Date("2026-05-31T06:00:00.000Z"));
    const out = istMidnightUtc(1);
    expect(out.toISOString()).toBe("2026-05-31T18:30:00.000Z");
  });

  it("crosses year boundaries cleanly", () => {
    // 2026-12-31 mid-day IST; +1 -> 2027-01-01 IST.
    vi.setSystemTime(new Date("2026-12-31T06:00:00.000Z"));
    const out = istMidnightUtc(1);
    expect(out.toISOString()).toBe("2026-12-31T18:30:00.000Z");
  });

  it("handles leap-day arithmetic (2024 was a leap year)", () => {
    // 2024-02-28 mid-day IST; +1 should be 2024-02-29 IST (leap).
    vi.setSystemTime(new Date("2024-02-28T06:00:00.000Z"));
    const out = istMidnightUtc(1);
    expect(out.toISOString()).toBe("2024-02-28T18:30:00.000Z");
    // +2 should be 2024-03-01 IST.
    const twoOut = istMidnightUtc(2);
    expect(twoOut.toISOString()).toBe("2024-02-29T18:30:00.000Z");
  });

  it("handles non-leap-year Feb arithmetic (2025 normalises Feb 29 -> Mar 1)", () => {
    // 2025-02-28 mid-day IST; +1 should be 2025-03-01 IST (no Feb 29).
    vi.setSystemTime(new Date("2025-02-28T06:00:00.000Z"));
    const out = istMidnightUtc(1);
    // 2025-03-01 00:00 IST = 2025-02-28 18:30 UTC.
    expect(out.toISOString()).toBe("2025-02-28T18:30:00.000Z");
  });

  it("returns the same offset year-round (India has no DST) — summer", () => {
    vi.setSystemTime(new Date("2026-06-21T06:00:00.000Z"));
    const out = istMidnightUtc(0);
    // 06:00 UTC on 2026-06-21 is 11:30 IST -> already past midnight IST,
    // so today IST is the 21st. Midnight IST = 2026-06-20T18:30Z.
    expect(out.toISOString()).toBe("2026-06-20T18:30:00.000Z");
    // The UTC-IST gap is always exactly IST_OFFSET_MIN minutes — verify
    // by checking the time-portion ends at :30:00.
    expect(out.getUTCMinutes()).toBe(30);
    expect(out.getUTCHours()).toBe(18);
  });

  it("returns the same offset year-round (India has no DST) — winter", () => {
    vi.setSystemTime(new Date("2026-12-21T06:00:00.000Z"));
    const out = istMidnightUtc(0);
    expect(out.toISOString()).toBe("2026-12-20T18:30:00.000Z");
    expect(out.getUTCMinutes()).toBe(30);
    expect(out.getUTCHours()).toBe(18);
  });
});

describe("istTodayBounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns start = istMidnightUtc(0)", () => {
    const { start } = istTodayBounds();
    expect(start.toISOString()).toBe("2026-05-14T18:30:00.000Z");
    expect(start.getTime()).toBe(istMidnightUtc(0).getTime());
  });

  it("returns end = istMidnightUtc(1) - 1ms (last instant of today IST)", () => {
    const { end } = istTodayBounds();
    expect(end.getTime()).toBe(istMidnightUtc(1).getTime() - 1);
    // 2026-05-15T23:59:59.999 IST == 2026-05-15T18:29:59.999Z.
    expect(end.toISOString()).toBe("2026-05-15T18:29:59.999Z");
  });

  it("spans exactly one IST day (86_400_000 - 1 ms wide)", () => {
    const { start, end } = istTodayBounds();
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it("start strictly precedes end", () => {
    const { start, end } = istTodayBounds();
    expect(start.getTime()).toBeLessThan(end.getTime());
  });

  it("recomputes correctly after the IST-day rollover", () => {
    // 18:31Z — IST is already on the next day. Bounds should advance.
    vi.setSystemTime(new Date("2026-05-15T18:31:00.000Z"));
    const { start, end } = istTodayBounds();
    expect(start.toISOString()).toBe("2026-05-15T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-05-16T18:29:59.999Z");
  });
});

describe("istTodayDateStr", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the IST calendar day, not the UTC day, in the evening (the slot-leak bug window)", () => {
    // 18:58 IST on 2026-06-03 == 13:28 UTC same day. Both happen to be
    // the 3rd here, but pin it to prove we read IST.
    vi.setSystemTime(new Date("2026-06-03T13:28:00.000Z"));
    expect(istTodayDateStr()).toBe("2026-06-03");
  });

  it("rolls the IST day forward before the UTC day at the 18:30Z boundary", () => {
    // 2026-06-03T19:00:00Z == 2026-06-04T00:30 IST. UTC is still the 3rd,
    // but IST has already ticked to the 4th — istTodayDateStr MUST return
    // the 4th (a server-local impl on a UTC host would wrongly say the 3rd).
    vi.setSystemTime(new Date("2026-06-03T19:00:00.000Z"));
    expect(istTodayDateStr()).toBe("2026-06-04");
  });

  it("still reports the prior IST day just before the boundary (18:29Z)", () => {
    // 2026-06-03T18:29:00Z == 2026-06-03T23:59 IST — still the 3rd.
    vi.setSystemTime(new Date("2026-06-03T18:29:00.000Z"));
    expect(istTodayDateStr()).toBe("2026-06-03");
  });

  it("crosses month + year boundaries via the IST clock", () => {
    // 2026-12-31T19:00:00Z == 2027-01-01T00:30 IST.
    vi.setSystemTime(new Date("2026-12-31T19:00:00.000Z"));
    expect(istTodayDateStr()).toBe("2027-01-01");
  });
});

describe("istNowMinutes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns IST minutes-since-midnight, reproducing the 18:58 bug scenario", () => {
    // This is the exact medcore.globusdemos.com repro: a UTC-host server at
    // 13:28 UTC. A server-local impl returns 808 (13:28) — which would keep
    // the elapsed 17:15/18:00 slots. The IST-correct answer is 1138 (18:58).
    vi.setSystemTime(new Date("2026-06-03T13:28:00.000Z"));
    expect(istNowMinutes()).toBe(18 * 60 + 58); // 1138
  });

  it("is 0 at IST midnight", () => {
    // IST midnight == 18:30Z the previous day.
    vi.setSystemTime(new Date("2026-06-02T18:30:00.000Z"));
    expect(istNowMinutes()).toBe(0);
  });

  it("is 1439 one minute before IST midnight", () => {
    // 23:59 IST == 18:29Z.
    vi.setSystemTime(new Date("2026-06-03T18:29:00.000Z"));
    expect(istNowMinutes()).toBe(23 * 60 + 59); // 1439
  });

  it("wraps past the UTC-day boundary correctly (00:30 IST → 30)", () => {
    // 19:00Z == 00:30 IST next day → 30 minutes past IST midnight.
    vi.setSystemTime(new Date("2026-06-03T19:00:00.000Z"));
    expect(istNowMinutes()).toBe(30);
  });

  it("always stays within [0, 1439]", () => {
    for (const iso of [
      "2026-06-03T00:00:00.000Z",
      "2026-06-03T06:00:00.000Z",
      "2026-06-03T13:28:00.000Z",
      "2026-06-03T18:30:00.000Z",
      "2026-06-03T23:59:59.000Z",
    ]) {
      vi.setSystemTime(new Date(iso));
      const m = istNowMinutes();
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1439);
    }
  });
});

describe("parseIstDateOnly", () => {
  it("parses a YYYY-MM-DD string as IST midnight (the 18:30Z rollover trap)", () => {
    // The trap from commit bf86f57: parsing "2026-05-25" must yield the
    // PRIOR day's 18:30Z, NOT 2026-05-25T00:00Z (which would be 05:30 IST).
    const out = parseIstDateOnly("2026-05-25");
    expect(out).not.toBeNull();
    expect(out!.toISOString()).toBe("2026-05-24T18:30:00.000Z");
  });

  it("round-trips an arbitrary date", () => {
    const out = parseIstDateOnly("2026-01-01");
    // 2026-01-01 00:00 IST = 2025-12-31 18:30 UTC.
    expect(out!.toISOString()).toBe("2025-12-31T18:30:00.000Z");
  });

  it("returns null for empty string", () => {
    expect(parseIstDateOnly("")).toBeNull();
  });

  it("returns null for the wrong format (missing dashes)", () => {
    expect(parseIstDateOnly("20260525")).toBeNull();
  });

  it("returns null for the wrong format (slashes)", () => {
    expect(parseIstDateOnly("2026/05/25")).toBeNull();
  });

  it("returns null for a date with a time component", () => {
    expect(parseIstDateOnly("2026-05-25T00:00:00Z")).toBeNull();
  });

  it("returns null for an only-partially-numeric string", () => {
    expect(parseIstDateOnly("2026-5-25")).toBeNull();
    expect(parseIstDateOnly("26-05-25")).toBeNull();
    expect(parseIstDateOnly("garbage")).toBeNull();
  });

  it("accepts 2024-02-29 (leap year — valid date)", () => {
    const out = parseIstDateOnly("2024-02-29");
    expect(out).not.toBeNull();
    // 2024-02-29 00:00 IST = 2024-02-28 18:30 UTC.
    expect(out!.toISOString()).toBe("2024-02-28T18:30:00.000Z");
  });

  it("normalises 2025-02-29 (non-leap year — JS Date rolls to Mar 1)", () => {
    // JS Date math treats Feb 29 in a non-leap year as March 1. The helper
    // does NOT explicitly reject this — it returns a valid (rolled) Date.
    // This locks in the behaviour so any future tightening is intentional.
    const out = parseIstDateOnly("2025-02-29");
    expect(out).not.toBeNull();
    // 2025-03-01 00:00 IST = 2025-02-28 18:30 UTC.
    expect(out!.toISOString()).toBe("2025-02-28T18:30:00.000Z");
  });

  it("produces output identical to istMidnightUtc for 'today'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    try {
      const fromParse = parseIstDateOnly("2026-05-15");
      const fromMidnight = istMidnightUtc(0);
      expect(fromParse!.getTime()).toBe(fromMidnight.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the same offset year-round (India has no DST)", () => {
    // The Δ between input-date-midnight-IST and the returned UTC is always
    // 5:30:00 — verify across summer + winter.
    const summer = parseIstDateOnly("2026-06-21")!;
    const winter = parseIstDateOnly("2026-12-21")!;
    // Both should end at :30 minutes past an :18 hour on the prior UTC day.
    expect(summer.getUTCHours()).toBe(18);
    expect(summer.getUTCMinutes()).toBe(30);
    expect(winter.getUTCHours()).toBe(18);
    expect(winter.getUTCMinutes()).toBe(30);
  });
});
