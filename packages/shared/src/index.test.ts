/**
 * Unit-level surface test for the `@medcore/shared` package entrypoint.
 *
 * Strategy:
 *   `packages/shared/src/index.ts` is a pure re-export barrel covering 47
 *   sub-modules — every `types/*`, every `validation/*`, every i18n / billing
 *   helper. Per the neighbour `packages/db/src/index.test.ts` (same barrel-
 *   test pattern, landed same wave), this file's job is to lock the public
 *   surface so a future refactor (renaming, removing, or moving a
 *   re-export) trips a fast unit test instead of a downstream consumer's
 *   red CI.
 *
 *   Why colocated (`packages/shared/src/index.test.ts`) and not under the
 *   existing `__tests__/` folder: the test-cron allowlist for this wave
 *   names this exact path; the root `vitest.config.ts` `include` glob
 *   (`packages/** /*.test.ts`) picks up both locations equally.
 *
 *   Why no mocks: `@medcore/shared` has zero runtime side-effects — only
 *   `zod` schemas, plain constants, enums, and pure helper functions.
 *   No DB, no env, no I/O. We can `import * as shared from "./index"` and
 *   sanity-check the surface directly.
 */

import { describe, it, expect } from "vitest";
import * as shared from "./index";

describe("@medcore/shared package index — public surface", () => {
  describe("Roles enum (./types/roles)", () => {
    it("re-exports `Role` enum with the canonical 8 string values", () => {
      expect(shared.Role).toBeDefined();
      expect(typeof shared.Role).toBe("object");
      expect(shared.Role.ADMIN).toBe("ADMIN");
      expect(shared.Role.DOCTOR).toBe("DOCTOR");
      expect(shared.Role.RECEPTION).toBe("RECEPTION");
      expect(shared.Role.NURSE).toBe("NURSE");
      expect(shared.Role.PATIENT).toBe("PATIENT");
      expect(shared.Role.PHARMACIST).toBe("PHARMACIST");
      expect(shared.Role.LAB_TECH).toBe("LAB_TECH");
      expect(shared.Role.BILLING).toBe("BILLING");
      expect(shared.Role.PLATFORM_OPERATOR).toBe("PLATFORM_OPERATOR");
      expect(shared.Role.PLATFORM_BILLING_OPERATOR).toBe(
        "PLATFORM_BILLING_OPERATOR",
      );
    });
  });

  describe("Constants re-exports (./constants)", () => {
    it("re-exports paging + slot-duration numeric constants", () => {
      expect(shared.DEFAULT_SLOT_DURATION_MINUTES).toBe(15);
      expect(shared.DEFAULT_PAGE_LIMIT).toBe(20);
      expect(shared.MAX_PAGE_LIMIT).toBe(100);
    });

    it("re-exports token-expiry string constants", () => {
      expect(shared.TOKEN_EXPIRY).toBe("24h");
      expect(shared.REFRESH_TOKEN_EXPIRY).toBe("7d");
    });

    it("re-exports MR + invoice number prefixes", () => {
      expect(shared.MR_NUMBER_PREFIX).toBe("MR");
      expect(shared.INVOICE_NUMBER_PREFIX).toBe("INV");
    });

    it("re-exports `CONSULTATION_CATEGORIES` as a non-empty readonly tuple", () => {
      expect(Array.isArray(shared.CONSULTATION_CATEGORIES)).toBe(true);
      expect(shared.CONSULTATION_CATEGORIES.length).toBeGreaterThan(0);
      expect(shared.CONSULTATION_CATEGORIES).toContain("Consultation Fee");
    });

    it("re-exports `FREQUENCY_OPTIONS` with the 8 prescription frequencies", () => {
      expect(Array.isArray(shared.FREQUENCY_OPTIONS)).toBe(true);
      expect(shared.FREQUENCY_OPTIONS.length).toBe(8);
    });

    it("re-exports `INDIAN_INSURERS` list (Issue #82) as a non-empty array", () => {
      expect(Array.isArray(shared.INDIAN_INSURERS)).toBe(true);
      expect(shared.INDIAN_INSURERS.length).toBeGreaterThan(0);
      // Spot check — the list is the IRDAI top insurers.
      expect(shared.INDIAN_INSURERS).toContain("Star Health and Allied Insurance");
    });
  });

  describe("Feature-flags re-exports (./feature-flags)", () => {
    it("re-exports `FEATURE_KEYS` covering Pearl PRD §18 surfaces", () => {
      expect(Array.isArray(shared.FEATURE_KEYS)).toBe(true);
      // Spot-check a handful from each cluster.
      expect(shared.FEATURE_KEYS).toContain("ipd");
      expect(shared.FEATURE_KEYS).toContain("ot");
      expect(shared.FEATURE_KEYS).toContain("aiFraud");
    });

    it("re-exports `FEATURE_METADATA` keyed by every FEATURE_KEYS entry", () => {
      expect(typeof shared.FEATURE_METADATA).toBe("object");
      for (const key of shared.FEATURE_KEYS) {
        expect(shared.FEATURE_METADATA[key]).toBeDefined();
        expect(typeof shared.FEATURE_METADATA[key].label).toBe("string");
        expect(typeof shared.FEATURE_METADATA[key].defaultEnabled).toBe(
          "boolean",
        );
      }
    });

    it("re-exports `isFeatureEnabled` as a pure resolver function", () => {
      expect(typeof shared.isFeatureEnabled).toBe("function");
      // Null tenant flags → defaults to true (current MedCore behaviour).
      expect(shared.isFeatureEnabled(null, "ipd")).toBe(true);
      // Explicit override wins.
      expect(shared.isFeatureEnabled({ ipd: false }, "ipd")).toBe(false);
      // Non-boolean override falls back to default.
      expect(shared.isFeatureEnabled({ ipd: "yes" }, "ipd")).toBe(true);
    });

    it("re-exports `resolveAllFeatureFlags` as a map-builder function", () => {
      expect(typeof shared.resolveAllFeatureFlags).toBe("function");
      const resolved = shared.resolveAllFeatureFlags(null);
      // Returned object must include every key, all defaults applied.
      for (const key of shared.FEATURE_KEYS) {
        expect(typeof resolved[key]).toBe("boolean");
      }
    });
  });

  describe("ABO compatibility re-exports (./abo-compatibility)", () => {
    it("re-exports `ALL_BLOOD_GROUPS` as 8 ABO+Rh codes", () => {
      expect(Array.isArray(shared.ALL_BLOOD_GROUPS)).toBe(true);
      expect(shared.ALL_BLOOD_GROUPS.length).toBe(8);
      expect(shared.ALL_BLOOD_GROUPS).toContain("O_NEG");
      expect(shared.ALL_BLOOD_GROUPS).toContain("AB_POS");
    });

    it("re-exports `RBC_COMPATIBILITY` and `PLASMA_COMPATIBILITY` matrices", () => {
      expect(typeof shared.RBC_COMPATIBILITY).toBe("object");
      expect(typeof shared.PLASMA_COMPATIBILITY).toBe("object");
      // O_NEG is universal RBC donor → recipient O_NEG only accepts O_NEG.
      expect(shared.RBC_COMPATIBILITY.O_NEG).toEqual(["O_NEG"]);
      // AB_POS is universal RBC recipient.
      expect(shared.RBC_COMPATIBILITY.AB_POS.length).toBe(8);
    });

    it("re-exports `isAboCompatible`, `prettyBloodGroup`, `aboMismatchReason` helpers", () => {
      expect(typeof shared.isAboCompatible).toBe("function");
      expect(typeof shared.prettyBloodGroup).toBe("function");
      expect(typeof shared.aboMismatchReason).toBe("function");

      // Sanity probes — exercise the fail-safe + happy paths.
      expect(shared.isAboCompatible("O_NEG", "AB_POS", "RBC")).toBe(true);
      expect(shared.isAboCompatible("AB_POS", "O_NEG", "RBC")).toBe(false);
      expect(shared.isAboCompatible(null, "O_NEG")).toBe(false);
      expect(shared.prettyBloodGroup("A_POS")).toBe("A+");
      expect(shared.prettyBloodGroup("O_NEG")).toBe("O-");
      expect(shared.aboMismatchReason("O_NEG", "AB_POS")).toBeNull();
      expect(typeof shared.aboMismatchReason("AB_POS", "O_NEG")).toBe("string");
    });
  });

  describe("Billing plans re-exports (./billing/plans)", () => {
    it("re-exports `PLAN_DEFINITIONS` keyed by the 3 Plan tiers", () => {
      expect(typeof shared.PLAN_DEFINITIONS).toBe("object");
      expect(shared.PLAN_DEFINITIONS.STARTER).toBeDefined();
      expect(shared.PLAN_DEFINITIONS.GROWTH).toBeDefined();
      expect(shared.PLAN_DEFINITIONS.ENTERPRISE).toBeDefined();
      expect(shared.PLAN_DEFINITIONS.STARTER.monthlyPriceInPaise).toBe(499900);
      expect(Array.isArray(shared.PLAN_DEFINITIONS.STARTER.includedFeatures)).toBe(
        true,
      );
    });

    it("re-exports `TRIAL_DAYS`, `GRACE_PERIOD_DAYS`, `DEFAULT_SAAS_SAC_CODE` constants", () => {
      expect(shared.TRIAL_DAYS).toBe(30);
      expect(shared.GRACE_PERIOD_DAYS).toBe(7);
      expect(shared.DEFAULT_SAAS_SAC_CODE).toBe("998314");
    });
  });

  describe("i18n symptom chips re-exports (./i18n/triage-symptom-chips)", () => {
    it("re-exports `SYMPTOM_CHIPS` keyed by language code with shaped chip rows", () => {
      expect(typeof shared.SYMPTOM_CHIPS).toBe("object");
      expect(Array.isArray(shared.SYMPTOM_CHIPS.en)).toBe(true);
      expect(shared.SYMPTOM_CHIPS.en.length).toBeGreaterThan(0);
      const first = shared.SYMPTOM_CHIPS.en[0];
      expect(typeof first.label).toBe("string");
      expect(typeof first.complaint).toBe("string");
    });
  });

  describe("Validation-schema re-exports — happy paths", () => {
    // The validation barrel covers 26 sub-files; we don't need to deep-test
    // each schema (per-module tests live next to each file). We pick a
    // representative schema per cluster and assert the Zod handle is wired
    // up via `.safeParse()`.
    it("re-exports `loginSchema` from ./validation/auth", () => {
      expect(shared.loginSchema).toBeDefined();
      expect(typeof shared.loginSchema.safeParse).toBe("function");
    });

    it("re-exports `createPatientSchema` + `PATIENT_NAME_REGEX` from ./validation/patient", () => {
      expect(shared.createPatientSchema).toBeDefined();
      expect(typeof shared.createPatientSchema.safeParse).toBe("function");
      expect(shared.PATIENT_NAME_REGEX).toBeInstanceOf(RegExp);
      // Digits are intentionally rejected (per CLAUDE.md gotcha #8).
      expect(shared.PATIENT_NAME_REGEX.test("Alice123")).toBe(false);
      expect(shared.PATIENT_NAME_REGEX.test("Alice O'Brien")).toBe(true);
    });

    it("re-exports `createBranchSchema` and `updateBranchSchema` from ./validation/branch", () => {
      expect(shared.createBranchSchema).toBeDefined();
      expect(shared.updateBranchSchema).toBeDefined();
      expect(typeof shared.createBranchSchema.safeParse).toBe("function");
    });

    it("re-exports campaign-engine surface from ./validation/campaign", () => {
      expect(shared.createCampaignSchema).toBeDefined();
      expect(shared.audienceRulesSchema).toBeDefined();
      expect(shared.audienceFilterSchema).toBeDefined();
      expect(Array.isArray(shared.AUDIENCE_FILTER_FIELDS)).toBe(true);
      expect(Array.isArray(shared.AUDIENCE_FILTER_OPS)).toBe(true);
      expect(Array.isArray(shared.AUDIENCE_MATCH_MODES)).toBe(true);
    });

    it("re-exports the WhatsApp inbound webhook schema from ./validation/whatsapp-webhook", () => {
      expect(shared.normalizedInboundMessageSchema).toBeDefined();
      expect(typeof shared.normalizedInboundMessageSchema.safeParse).toBe(
        "function",
      );
    });
  });

  describe("Surface inventory (regression guard)", () => {
    // Cheapest possible "did someone drop a named export?" check.
    // If this fails, look at index.ts vs the names listed below.
    it("ships every named export the api app + web app expect", () => {
      const expected = [
        // roles
        "Role",
        // constants
        "DEFAULT_SLOT_DURATION_MINUTES",
        "DEFAULT_PAGE_LIMIT",
        "MAX_PAGE_LIMIT",
        "TOKEN_EXPIRY",
        "REFRESH_TOKEN_EXPIRY",
        "MR_NUMBER_PREFIX",
        "INVOICE_NUMBER_PREFIX",
        "CONSULTATION_CATEGORIES",
        "FREQUENCY_OPTIONS",
        "INDIAN_INSURERS",
        // feature flags
        "FEATURE_KEYS",
        "FEATURE_METADATA",
        "isFeatureEnabled",
        "resolveAllFeatureFlags",
        // abo
        "ALL_BLOOD_GROUPS",
        "RBC_COMPATIBILITY",
        "PLASMA_COMPATIBILITY",
        "isAboCompatible",
        "prettyBloodGroup",
        "aboMismatchReason",
        // billing
        "PLAN_DEFINITIONS",
        "TRIAL_DAYS",
        "GRACE_PERIOD_DAYS",
        "DEFAULT_SAAS_SAC_CODE",
        // i18n
        "SYMPTOM_CHIPS",
        // validation — representative anchors per file
        "loginSchema",
        "registerSchema",
        "createPatientSchema",
        "updatePatientSchema",
        "PATIENT_NAME_REGEX",
        "PHONE_REGEX",
        "createBranchSchema",
        "updateBranchSchema",
        "createCampaignSchema",
        "audienceFilterSchema",
        "audienceRulesSchema",
        "AUDIENCE_FILTER_FIELDS",
        "AUDIENCE_FILTER_OPS",
        "AUDIENCE_MATCH_MODES",
        "normalizedInboundMessageSchema",
      ];
      const surface = Object.keys(shared as Record<string, unknown>);
      const missing = expected.filter((name) => !surface.includes(name));
      expect(missing).toEqual([]);
    });
  });
});
