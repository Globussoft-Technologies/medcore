// Pins the Pearl Stage-1 §6+§18 feature-flag contract shared between
// the API middleware (`requireFeature`), the web sidebar gating, and the
// super-admin tenant editor. Three invariants the resolver depends on:
//   - FEATURE_KEYS is the closed set; FEATURE_METADATA covers exactly it
//     (no orphan keys, no missing metadata rows) and every default is
//     `true` (the no-regression contract for non-Pearl tenants).
//   - `isFeatureEnabled` honors a boolean override and otherwise falls
//     back to the metadata default — robust against null / undefined /
//     non-object / non-boolean override JSON (the field is `Json?` in
//     Prisma so all of these are real wire shapes).
//   - `resolveAllFeatureFlags` always emits every key with an explicit
//     boolean (no nulls, no missing entries) so the web client can
//     compare `flags.ipd === false` directly.
//
// Cross-checked against `billing/plans.ts` `PLAN_DEFINITIONS` — the two
// vocabularies are intentionally disjoint domains (Pearl-exclusion
// camelCase here vs. plan-tier-inclusion snake_case there) and only the
// `ipd` / `ot` strings overlap by spelling. The test pins that overlap
// so a future rename in either file fails CI loudly.

import { describe, it, expect } from "vitest";
import {
  FEATURE_KEYS,
  FEATURE_METADATA,
  isFeatureEnabled,
  resolveAllFeatureFlags,
  type FeatureKey,
} from "../feature-flags";
import { PLAN_DEFINITIONS } from "../billing/plans";

describe("FEATURE_KEYS — closed set contract", () => {
  it("exposes every Pearl-§18 surface key (clinical phase-2 + granular AI)", () => {
    // Lock the exact set so any add/remove forces a deliberate test edit.
    expect([...FEATURE_KEYS].sort()).toEqual(
      [
        "abdmAdvanced",
        "aiCapacity",
        "aiCoaching",
        "aiDischarge",
        "aiFollowup",
        "aiFraud",
        "aiRadiology",
        "aiRoster",
        "hl7Inbound",
        "hrmsPayroll",
        "ipd",
        "nabhDashboard",
        "ot",
        "predictiveCds",
        "telemedicine",
        "voiceRx",
      ].sort(),
    );
  });

  it("ships at least the 16 Stage-2 keys (regression floor)", () => {
    expect(FEATURE_KEYS.length).toBeGreaterThanOrEqual(16);
  });

  it("contains no duplicate keys", () => {
    const set = new Set(FEATURE_KEYS);
    expect(set.size).toBe(FEATURE_KEYS.length);
  });

  it("emits keys as strings (the runtime contract Json overrides rely on)", () => {
    for (const key of FEATURE_KEYS) {
      expect(typeof key).toBe("string");
      expect(key.length).toBeGreaterThan(0);
    }
  });
});

describe("FEATURE_METADATA — covers exactly FEATURE_KEYS", () => {
  it("has a metadata row for every key in FEATURE_KEYS", () => {
    for (const key of FEATURE_KEYS) {
      expect(FEATURE_METADATA[key]).toBeDefined();
    }
  });

  it("has no orphan metadata rows beyond FEATURE_KEYS", () => {
    const metadataKeys = Object.keys(FEATURE_METADATA).sort();
    const featureKeys = [...FEATURE_KEYS].sort();
    expect(metadataKeys).toEqual(featureKeys);
  });

  it("populates label + description for every metadata row", () => {
    for (const key of FEATURE_KEYS) {
      const meta = FEATURE_METADATA[key];
      expect(meta.label).toBeTruthy();
      expect(typeof meta.label).toBe("string");
      expect(meta.description).toBeTruthy();
      expect(typeof meta.description).toBe("string");
    }
  });

  it("defaults every feature to enabled (no-regression contract for non-Pearl tenants)", () => {
    for (const key of FEATURE_KEYS) {
      expect(FEATURE_METADATA[key].defaultEnabled).toBe(true);
    }
  });
});

describe("isFeatureEnabled — override resolution", () => {
  it("returns the metadata default when storedFlags is null", () => {
    expect(isFeatureEnabled(null, "ipd")).toBe(true);
    expect(isFeatureEnabled(null, "aiFraud")).toBe(true);
  });

  it("returns the metadata default when storedFlags is undefined", () => {
    expect(isFeatureEnabled(undefined, "telemedicine")).toBe(true);
    expect(isFeatureEnabled(undefined, "hl7Inbound")).toBe(true);
  });

  it("returns the metadata default when the key is absent from storedFlags", () => {
    expect(isFeatureEnabled({ ot: false }, "ipd")).toBe(true);
    expect(isFeatureEnabled({}, "voiceRx")).toBe(true);
  });

  it("honors an explicit `false` override (Pearl-tenant pattern)", () => {
    expect(isFeatureEnabled({ ipd: false }, "ipd")).toBe(false);
    expect(isFeatureEnabled({ ot: false, aiRadiology: false }, "ot")).toBe(false);
    expect(
      isFeatureEnabled({ ot: false, aiRadiology: false }, "aiRadiology"),
    ).toBe(false);
  });

  it("honors an explicit `true` override (would also be the default, but pinned)", () => {
    expect(isFeatureEnabled({ ipd: true }, "ipd")).toBe(true);
  });

  it("ignores non-boolean override values (strings/numbers/null/objects → default)", () => {
    // The Json? field can carry anything; only `boolean` is honored —
    // everything else falls back to the metadata default. Pins the
    // type-narrowing inside isFeatureEnabled.
    expect(isFeatureEnabled({ ipd: "false" as unknown as boolean }, "ipd")).toBe(true);
    expect(isFeatureEnabled({ ipd: 0 as unknown as boolean }, "ipd")).toBe(true);
    expect(isFeatureEnabled({ ipd: 1 as unknown as boolean }, "ipd")).toBe(true);
    expect(isFeatureEnabled({ ipd: null as unknown as boolean }, "ipd")).toBe(true);
    expect(
      isFeatureEnabled({ ipd: { nested: true } as unknown as boolean }, "ipd"),
    ).toBe(true);
  });

  it("treats a non-object stored value as null (defensive against bad seed JSON)", () => {
    // Real-world Tenant.featureFlags has been seen carrying arrays /
    // primitives from migration accidents; resolver MUST not throw.
    expect(
      isFeatureEnabled(
        ["ipd", false] as unknown as Record<string, unknown>,
        "ipd",
      ),
    ).toBe(true);
    expect(
      isFeatureEnabled(
        "ipd:false" as unknown as Record<string, unknown>,
        "ipd",
      ),
    ).toBe(true);
    expect(
      isFeatureEnabled(42 as unknown as Record<string, unknown>, "ipd"),
    ).toBe(true);
  });

  it("resolves each key independently — one override does not bleed into siblings", () => {
    const flags = { ipd: false, ot: false };
    expect(isFeatureEnabled(flags, "ipd")).toBe(false);
    expect(isFeatureEnabled(flags, "ot")).toBe(false);
    expect(isFeatureEnabled(flags, "telemedicine")).toBe(true);
    expect(isFeatureEnabled(flags, "aiCoaching")).toBe(true);
  });
});

describe("resolveAllFeatureFlags — full-map projection for web client", () => {
  it("always returns every FEATURE_KEY (no missing entries when input is null)", () => {
    const resolved = resolveAllFeatureFlags(null);
    const resolvedKeys = Object.keys(resolved).sort();
    expect(resolvedKeys).toEqual([...FEATURE_KEYS].sort());
  });

  it("always returns every FEATURE_KEY (no missing entries when input is undefined)", () => {
    const resolved = resolveAllFeatureFlags(undefined);
    expect(Object.keys(resolved).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it("always returns every FEATURE_KEY (no missing entries when input is {})", () => {
    const resolved = resolveAllFeatureFlags({});
    expect(Object.keys(resolved).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it("emits explicit booleans for every entry (no nulls / undefineds)", () => {
    const resolved = resolveAllFeatureFlags({ ipd: false });
    for (const key of FEATURE_KEYS) {
      expect(typeof resolved[key]).toBe("BOOLEAN".toLowerCase());
    }
  });

  it("merges metadata defaults with per-tenant overrides (Pearl-pilot shape)", () => {
    // A representative Pearl-pilot tenant — disable IPD + OT + advanced
    // ABDM + HRMS; leave AI knobs at default-enabled.
    const pearlOverrides = {
      ipd: false,
      ot: false,
      abdmAdvanced: false,
      hrmsPayroll: false,
    };
    const resolved = resolveAllFeatureFlags(pearlOverrides);
    expect(resolved.ipd).toBe(false);
    expect(resolved.ot).toBe(false);
    expect(resolved.abdmAdvanced).toBe(false);
    expect(resolved.hrmsPayroll).toBe(false);
    // Everything not in the override stays at metadata default (true).
    expect(resolved.telemedicine).toBe(true);
    expect(resolved.aiCoaching).toBe(true);
    expect(resolved.aiFraud).toBe(true);
    expect(resolved.hl7Inbound).toBe(true);
  });

  it("returns the all-true map for a non-Pearl tenant (null storedFlags)", () => {
    const resolved = resolveAllFeatureFlags(null);
    for (const key of FEATURE_KEYS) {
      expect(resolved[key]).toBe(true);
    }
  });

  it("ignores unknown keys in storedFlags (does not leak them into the output)", () => {
    const resolved = resolveAllFeatureFlags({
      ipd: false,
      bogusKey: true,
      anotherBogus: false,
    } as Record<string, unknown>);
    expect("bogusKey" in resolved).toBe(false);
    expect("anotherBogus" in resolved).toBe(false);
    expect(resolved.ipd).toBe(false);
  });

  it("each entry is the same value isFeatureEnabled would return for that key", () => {
    // Property-style: bulk resolver and per-key resolver MUST agree.
    const stored = {
      ipd: false,
      ot: true,
      telemedicine: false,
      aiCapacity: null as unknown as boolean,
    };
    const resolved = resolveAllFeatureFlags(stored);
    for (const key of FEATURE_KEYS) {
      expect(resolved[key]).toBe(isFeatureEnabled(stored, key));
    }
  });
});

describe("Cross-package contract — feature-flags vs billing/plans", () => {
  // The two vocabularies are intentionally disjoint domains:
  //   - FEATURE_KEYS (this file): camelCase Pearl-exclusion keys, what
  //     to HIDE for Pearl-branded tenants.
  //   - PLAN_DEFINITIONS.includedFeatures (billing/plans.ts): snake_case
  //     plan-tier inclusion strings, what the subscription UNLOCKS.
  // Only "ipd" and "ot" overlap by spelling (both are clinical phase-2
  // surfaces gated at BOTH the plan-tier level and the Pearl-exclusion
  // level). The pin below catches an accidental rename in either file
  // that breaks the overlap relationship the API middleware relies on.

  it("the FEATURE_KEYS that ALSO appear by name in any plan are exactly { ipd, ot }", () => {
    const allPlanFeatureNames = new Set<string>();
    for (const def of Object.values(PLAN_DEFINITIONS)) {
      for (const f of def.includedFeatures) allPlanFeatureNames.add(f);
    }
    const overlap = (FEATURE_KEYS as readonly string[]).filter((k) =>
      allPlanFeatureNames.has(k),
    );
    expect(overlap.sort()).toEqual(["ipd", "ot"]);
  });

  it("ENTERPRISE plan's includedFeatures contain both overlap keys (ipd, ot gated by ENTERPRISE tier)", () => {
    const enterprise = new Set(PLAN_DEFINITIONS.ENTERPRISE.includedFeatures);
    expect(enterprise.has("ipd")).toBe(true);
    expect(enterprise.has("ot")).toBe(true);
  });

  it("STARTER plan does NOT include ipd or ot (they live behind ENTERPRISE)", () => {
    const starter = new Set(PLAN_DEFINITIONS.STARTER.includedFeatures);
    expect(starter.has("ipd")).toBe(false);
    expect(starter.has("ot")).toBe(false);
  });
});

describe("FeatureKey type — compile-time narrowing surface", () => {
  it("accepts every FEATURE_KEYS entry as a FeatureKey at runtime", () => {
    // Trivial assignment guard — ensures the const-assertion exports
    // narrow correctly so callers like requireFeature(k: FeatureKey)
    // type-check against the canonical list.
    for (const key of FEATURE_KEYS) {
      const narrowed: FeatureKey = key;
      expect(FEATURE_METADATA[narrowed]).toBeDefined();
    }
  });
});
