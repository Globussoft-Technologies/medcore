/**
 * Adapter registry — PM-JAY resolution.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: pins that `getAdapter("PMJAY")` (any case) resolves to the real
 *   `pmjayAdapter`, that PMJAY is listed by `listProviders()`, and that the
 *   test-override hook still wins for PMJAY.
 * - MODULES: `registry.ts` + the concrete `pmjayAdapter`. No mocks.
 * - WHY: registry wiring is what makes the reconciliation poller pick up PM-JAY
 *   claims automatically; a missing/incorrect entry would silently route PM-JAY
 *   claims to the MOCK fallback.
 */
import { describe, it, expect, afterEach } from "vitest";
import { getAdapter, listProviders, setAdapterOverride, clearAdapterOverrides } from "./registry";
import { pmjayAdapter } from "./adapters/pmjay";

afterEach(() => clearAdapterOverrides());

describe("registry — PMJAY", () => {
  it("resolves the PMJAY key to the real pmjayAdapter", () => {
    expect(getAdapter("PMJAY")).toBe(pmjayAdapter);
  });

  it("is case-insensitive on the provider key", () => {
    expect(getAdapter("pmjay")).toBe(pmjayAdapter);
  });

  it("lists PMJAY among the known providers", () => {
    expect(listProviders()).toContain("PMJAY");
  });

  it("honours a test override for PMJAY", () => {
    const fake = { ...pmjayAdapter, provider: "PMJAY" as const };
    setAdapterOverride("PMJAY", fake);
    expect(getAdapter("PMJAY")).toBe(fake);
  });
});
