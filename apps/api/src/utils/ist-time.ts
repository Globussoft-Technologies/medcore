// IST (India Standard Time, +05:30) date helpers — single source of truth.
//
// MedCore deploys to UTC-host Linux servers but its semantic timezone is
// IST: appointment dates, OPD calendars, "today's patients" and walk-in
// rows all refer to the IST calendar day the user thinks they're booking
// for. Two patterns of bug class were recurring before this helper:
//
//   1. `new Date(); date.setHours(0,0,0,0)` — produces UTC-midnight on a
//      UTC host (good), IST-midnight on an IST host (also good), but the
//      two answers DIFFER (by 5:30h). A walk-in row written on a UTC host
//      lands at YYYY-MM-DD where "DD" is the UTC date; an IST host lands
//      at the IST date. Across host migrations, history shifts by a day.
//
//   2. `new Date("2026-05-17")` parses as UTC-midnight, which is
//      2026-05-17 05:30 IST. Then `setHours(0,0,0,0)` re-anchors to
//      server-local midnight, which on a UTC host stays at 00:00 UTC
//      (good) but on an IST host slides to 2026-05-16 18:30 UTC —
//      missing every row stored as 2026-05-17.
//
// This helper produces the SAME UTC instant regardless of server tz, so
// stored DATE values are stable across host migrations and the queries
// that compare against them are predictable.
//
// Codebase history: this was first introduced inline in
// `apps/api/src/routes/analytics.ts` (efd42c9, closing the admin
// Today-Snapshot Registered=0 bug from `.issue-details.txt #48`) and
// independently re-derived in `visitors-stats.ts`. A11 in TODO.md
// canonical follow-ups tracked the lift to here; both routes now
// import from this module.

/** IST offset in minutes — UTC+05:30 → +330. */
export const IST_OFFSET_MIN = 5 * 60 + 30;

/**
 * Returns a UTC `Date` representing IST midnight `daysOffset` days from
 * "today IST". Works identically on a UTC host and an IST host.
 *
 *   istMidnightUtc(0)   → IST midnight today      (e.g. 2026-05-17 00:00 IST = 2026-05-16T18:30Z)
 *   istMidnightUtc(1)   → IST midnight tomorrow
 *   istMidnightUtc(-30) → IST midnight 30 days ago
 *
 * Use this for "the start of an IST calendar day" — typical for
 * appointment booking, walk-in registration, recurring-series base
 * dates, and "today's report" range bounds.
 */
export function istMidnightUtc(daysOffset: number): Date {
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate() + daysOffset;
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - IST_OFFSET_MIN * 60_000);
}

/**
 * Convenience: returns `{ start, end }` UTC bounds spanning IST today.
 *
 *   start = istMidnightUtc(0)
 *   end   = istMidnightUtc(1) − 1ms  (last instant of today IST)
 *
 * Useful for `where: { createdAt: { gte: start, lte: end } }` queries
 * scoped to "today IST".
 */
export function istTodayBounds(): { start: Date; end: Date } {
  const start = istMidnightUtc(0);
  const end = new Date(istMidnightUtc(1).getTime() - 1);
  return { start, end };
}

/**
 * Returns today's IST calendar day as a `YYYY-MM-DD` string.
 *
 * Use for same-day comparisons of a caller-supplied date param against
 * "today". MUST be used instead of `new Date().getFullYear()/...`,
 * which returns the SERVER-local day — on a UTC host that's up to 5.5h
 * behind IST, so a late-evening IST booking is mis-classified as a
 * different calendar day. See the slot-leak bug class at the top of
 * this file.
 *
 *   istTodayDateStr() → "2026-06-03"  (at any time on 3 Jun IST)
 */
export function istTodayDateStr(): string {
  const istNow = new Date(Date.now() + IST_OFFSET_MIN * 60_000);
  const y = istNow.getUTCFullYear();
  const m = String(istNow.getUTCMonth() + 1).padStart(2, "0");
  const d = String(istNow.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Returns the number of minutes elapsed since IST midnight for "now"
 * (0–1439). Use as the cutoff when filtering same-day HH:MM slot
 * strings, which are clinic-local IST clock times.
 *
 * MUST be used instead of `new Date().getHours() * 60 + getMinutes()`,
 * which yields SERVER-local minutes — on a UTC host that's 330 minutes
 * behind IST, so the past-slot filter under-rejects and elapsed slots
 * (e.g. 17:15 at 18:58 IST) leak into the availability grid. This was
 * the medcore.globusdemos.com slot-leak bug.
 *
 *   istNowMinutes() → 1138  (when it's 18:58 IST)
 */
export function istNowMinutes(): number {
  const istNow = new Date(Date.now() + IST_OFFSET_MIN * 60_000);
  return istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
}

/**
 * Parse a `YYYY-MM-DD` string as an IST midnight (returns the UTC
 * `Date`). Use when the caller passed a date as a query param and
 * meant "the IST calendar day".
 *
 *   parseIstDateOnly("2026-05-17") → 2026-05-16T18:30:00.000Z
 *                                   (i.e. 2026-05-17 00:00 IST)
 *
 * Returns `null` if the string doesn't match YYYY-MM-DD or yields an
 * invalid date.
 */
export function parseIstDateOnly(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  // m is 1-12 here, Date.UTC wants 0-11.
  const utcMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MIN * 60_000;
  const out = new Date(utcMs);
  return isNaN(out.getTime()) ? null : out;
}
