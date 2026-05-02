// Background scheduler for the insurance-claims reconciliation worker.
//
// Mirrors the pattern in `./retention-scheduler.ts`: expose a
// `start*` function that callers (app.ts) invoke once at boot. The interval
// handle is not exported because there is no shutdown path that needs it.
//
// Two cadences are registered:
//   - Hourly: polls pending-status claims (SUBMITTED / IN_REVIEW /
//     QUERY_RAISED) for their latest TPA status.
//   - Daily at 03:00 local: sweeps terminal-status claims (APPROVED /
//     DENIED / SETTLED / PARTIALLY_APPROVED) whose last sync is older than
//     7 days. Catches late revisions by the TPA (e.g. an approval reversed
//     on audit) that the hourly sweep never sees because the claim left
//     the pending set.

import {
  reconcilePendingClaims,
  reconcileTerminalClaims,
} from "./insurance-claims/reconciliation";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * Compute the delay (ms) from `from` until the next occurrence of the given
 * hour/minute in local time. Used to align the daily terminal sweep to 03:00.
 * Exported for unit tests.
 */
export function msUntilNextDailyTick(hour: number, minute: number, from: Date = new Date()): number {
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - from.getTime();
}

/**
 * Registers:
 *   - an hourly interval reconciling still-open claims, and
 *   - a daily (03:00 local) sweep of terminal-status claims to catch late
 *     TPA revisions.
 * Call `startClaimsScheduler()` once at app startup.
 */
export function startClaimsScheduler(): void {
  // Hourly: pending claims.
  setInterval(async () => {
    try {
      const result = await reconcilePendingClaims();
      console.log(
        `[ClaimsReconcile] Checked ${result.checked}, updated ${result.updated}, errors ${result.errors.length}`
      );
    } catch (err) {
      console.error("[ClaimsReconcile] Reconciliation run failed:", err);
    }
  }, ONE_HOUR_MS);

  // Daily at 03:00 local: terminal-claim sweep. We align the first run to the
  // next 03:00, then tick every 24h.
  const runTerminalSweep = async (): Promise<void> => {
    try {
      const result = await reconcileTerminalClaims();
      console.log(
        `[ClaimsReconcile:Terminal] Checked ${result.checked}, updated ${result.updated}, errors ${result.errors.length}`
      );
    } catch (err) {
      console.error("[ClaimsReconcile:Terminal] Terminal sweep failed:", err);
    }
  };

  setTimeout(() => {
    void runTerminalSweep();
    setInterval(() => {
      void runTerminalSweep();
    }, ONE_DAY_MS);
  }, msUntilNextDailyTick(3, 0));
}
