// Test-only helpers for the insurance-claims module.
//
// Previously `forceStatus` and `resetMockState` lived in
// `adapters/mock.ts` alongside the deterministic MOCK adapter. They were
// pulled out here so it is impossible to import them from a production code
// path by accident — every function in this file runtime-checks
// `NODE_ENV === "test"` and throws otherwise.
//
// They still manipulate the MOCK adapter's internal timeline (so `getClaimStatus`
// returns the forced status on next call), because that is the *TPA-side*
// state machine the adapter is simulating. Our own persistence is Prisma-backed
// via `store.ts`; the route layer is what picks up the TPA state change on a
// `?sync=1` call and writes it through to Prisma + adds a ClaimStatusEvent row.

import { __mockInternals } from "./adapters/mock";
import { NormalisedClaimStatus } from "./adapter";
import { resetStore } from "./store";

function assertTestEnv(fnName: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `${fnName}() is a test-only helper and cannot be called when NODE_ENV='${process.env.NODE_ENV}'. ` +
        `If you hit this in production code, stop and rewrite the call site to use the real store API.`
    );
  }
}

/**
 * Force a particular MOCK-adapter claim into a specific status. The forced
 * status / amount / note will surface via the next `getClaimStatus(providerRef)`
 * call — the route's `GET /claims/:id?sync=1` handler then writes it through
 * to the Prisma store + appends a ClaimStatusEvent.
 *
 * Returns `true` if the providerRef was known to the mock, `false` otherwise.
 */
export function forceStatus(
  providerRef: string,
  status: NormalisedClaimStatus,
  opts: { amountApproved?: number; deniedReason?: string; note?: string } = {}
): boolean {
  assertTestEnv("forceStatus");
  return __mockInternals.forceStatus(providerRef, status, opts);
}

/**
 * Wipe the MOCK adapter's in-memory state. Call between tests to ensure the
 * adapter's idempotency cache doesn't bleed across cases.
 */
export function resetMockState(): void {
  assertTestEnv("resetMockState");
  __mockInternals.reset();
}

/**
 * Wipe every insurance-claim row from the Prisma test DB. Lives here so the
 * test suites have a single import site for "reset everything claims-shaped"
 * without reaching into `store.ts`'s internals.
 */
export async function resetClaimsDb(): Promise<void> {
  assertTestEnv("resetClaimsDb");
  await resetStore();
}
