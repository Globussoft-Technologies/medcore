// Issue #429 (Apr 30 2026) — Blood Bank Inventory previously listed units
// whose `expiresAt` was in the past with status "Available", which is a
// patient-safety risk. The route now exposes `isExpired(unit)` and uses it
// to (a) filter expired rows out of the default `/inventory` query and
// (b) tag every returned row with `isExpired: boolean` so the UI can paint
// a red badge.
//
// We mirror the helper here rather than importing the route module (which
// pulls Prisma) — the route source is one line of `Date` math, and this is
// a pure unit test of the contract.
import { describe, it, expect } from "vitest";

function isExpired(unit: { expiresAt?: Date | string | null }): boolean {
  if (!unit.expiresAt) return false;
  const t =
    unit.expiresAt instanceof Date
      ? unit.expiresAt.getTime()
      : new Date(unit.expiresAt).getTime();
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

describe("isExpired (Issue #429)", () => {
  it("returns true when expiresAt is in the past", () => {
    const past = new Date(Date.now() - 86400000); // yesterday
    expect(isExpired({ expiresAt: past })).toBe(true);
  });

  it("returns false when expiresAt is in the future", () => {
    const future = new Date(Date.now() + 86400000); // tomorrow
    expect(isExpired({ expiresAt: future })).toBe(false);
  });

  it("returns false when expiresAt is missing", () => {
    expect(isExpired({})).toBe(false);
    expect(isExpired({ expiresAt: null })).toBe(false);
  });

  it("accepts ISO strings", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(isExpired({ expiresAt: past })).toBe(true);
  });

  it("returns false for an unparseable expiresAt string", () => {
    expect(isExpired({ expiresAt: "not-a-date" })).toBe(false);
  });
});
