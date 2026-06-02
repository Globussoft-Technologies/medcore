// Pins the platform-billing plan-definition invariants for the SEED BASELINE.
//
// Plans are now dynamic (DB-backed `PlatformPlan`, super-admin CRUD), so
// `PLAN_DEFINITIONS` is no longer the runtime source of truth — it is the
// seed baseline the DB is initialised with (see packages/db/src/seed.ts) and
// the `Plan` type widened to `string`. These guards still pin the shipped
// STARTER/GROWTH/ENTERPRISE defaults so the seed can't silently drift:
//   - Plan tier ladder: every STARTER feature is in GROWTH;
//                       every GROWTH feature is in ENTERPRISE.
//   - Price ordering: STARTER < GROWTH < ENTERPRISE (monotonic ascending).
//   - 30-day trial constant + 7-day grace constant frozen (state-machine
//     transitions read these — silent change would break
//     `trial → past_due → suspended` timing).

import { describe, it, expect } from "vitest";
import {
  PLAN_DEFINITIONS,
  TRIAL_DAYS,
  GRACE_PERIOD_DAYS,
  DEFAULT_SAAS_SAC_CODE,
  type Plan,
} from "../plans";

describe("PLAN_DEFINITIONS — plan-tier ladder", () => {
  it("exposes exactly the three Stage-1 plan tiers", () => {
    const keys = Object.keys(PLAN_DEFINITIONS).sort();
    expect(keys).toEqual(["ENTERPRISE", "GROWTH", "STARTER"]);
  });

  it("uses the same key inside each definition as the map key (no drift)", () => {
    for (const [key, def] of Object.entries(PLAN_DEFINITIONS)) {
      expect(def.key).toBe(key as Plan);
    }
  });

  it("GROWTH is a strict superset of STARTER (every STARTER feature is in GROWTH)", () => {
    const starter = new Set(PLAN_DEFINITIONS.STARTER.includedFeatures);
    const growth = new Set(PLAN_DEFINITIONS.GROWTH.includedFeatures);
    for (const feature of starter) {
      expect(growth.has(feature)).toBe(true);
    }
    expect(growth.size).toBeGreaterThan(starter.size);
  });

  it("ENTERPRISE is a strict superset of GROWTH (every GROWTH feature is in ENTERPRISE)", () => {
    const growth = new Set(PLAN_DEFINITIONS.GROWTH.includedFeatures);
    const enterprise = new Set(PLAN_DEFINITIONS.ENTERPRISE.includedFeatures);
    for (const feature of growth) {
      expect(enterprise.has(feature)).toBe(true);
    }
    expect(enterprise.size).toBeGreaterThan(growth.size);
  });

  it("STARTER includes the OPD-core feature flags required for Stage-1 pilot", () => {
    const starterFeatures = new Set(PLAN_DEFINITIONS.STARTER.includedFeatures);
    for (const required of [
      "opd",
      "appointments",
      "prescriptions",
      "opd_billing",
      "patient_pwa",
      "crm_basic",
      "abha_link",
    ]) {
      expect(starterFeatures.has(required)).toBe(true);
    }
  });

  it("ENTERPRISE includes the heavy clinical + AI surfaces (ipd / ot / abdm_m2 / ai_scribe)", () => {
    const enterpriseFeatures = new Set(PLAN_DEFINITIONS.ENTERPRISE.includedFeatures);
    for (const required of ["ipd", "ot", "abdm_m2", "ai_scribe"]) {
      expect(enterpriseFeatures.has(required)).toBe(true);
    }
  });
});

describe("PLAN_DEFINITIONS — price ordering", () => {
  it("STARTER price < GROWTH price < ENTERPRISE price (strictly ascending)", () => {
    expect(PLAN_DEFINITIONS.STARTER.monthlyPriceInPaise).toBeLessThan(
      PLAN_DEFINITIONS.GROWTH.monthlyPriceInPaise,
    );
    expect(PLAN_DEFINITIONS.GROWTH.monthlyPriceInPaise).toBeLessThan(
      PLAN_DEFINITIONS.ENTERPRISE.monthlyPriceInPaise,
    );
  });

  it("every plan price is a positive integer count of paise (no rupees, no fractions)", () => {
    for (const def of Object.values(PLAN_DEFINITIONS)) {
      expect(def.monthlyPriceInPaise).toBeGreaterThan(0);
      expect(Number.isInteger(def.monthlyPriceInPaise)).toBe(true);
    }
  });
});

describe("Billing lifecycle constants", () => {
  it("freezes the 30-day trial window", () => {
    expect(TRIAL_DAYS).toBe(30);
  });

  it("freezes the 7-day past-due grace window", () => {
    expect(GRACE_PERIOD_DAYS).toBe(7);
  });

  it("uses SAC code 998314 (Information Technology Software Services) as the SaaS default", () => {
    expect(DEFAULT_SAAS_SAC_CODE).toBe("998314");
  });
});
