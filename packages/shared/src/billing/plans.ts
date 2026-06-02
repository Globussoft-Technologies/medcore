// Authoritative plan-tier definitions for the platform-billing surface
// (Onviqa → tenant hospital). Used by:
//   - PlatformInvoice generation cron (apps/api/src/services/, piece 3b)
//   - Operator-billing UI (apps/web/src/app/super-admin/billing/, piece 3c)
//   - Feature-flag resolver at tenant-creation / plan-change time
//
// The `Plan` literal union below MIRRORS the Prisma `Plan` enum
// (packages/db/prisma/schema.prisma — gap rows 215-218 piece 3a).
// `@medcore/shared` cannot import from `@medcore/db` (cyclic dep — see
// packages/shared/src/validation/tenant-onboarding.ts header note), so
// the union here is the source-of-truth in TS-land; the test in
// __tests__/plans.test.ts pins the cross-package shape so any drift
// between Prisma + this file fails CI loudly.

// Plans are now dynamic (DB-backed `PlatformPlan` rows), so a plan "key" is
// any string. The STARTER/GROWTH/ENTERPRISE keys below are just the seed
// baseline shipped in PLAN_DEFINITIONS (consumed only by the DB seed).
export type Plan = string;

export interface PlanDefinition {
  key: Plan;
  /**
   * Monthly base price in paise (1 INR = 100 paise). Real prices may be
   * updated via DB seed post-launch — these unblock the agent today.
   * Custom Enterprise pricing handled via `TenantSubscription.
   * customPriceMonthlyInPaise` override field, not by editing this map.
   */
  monthlyPriceInPaise: number;
  /**
   * Feature flag keys (mirroring `packages/shared/src/feature-flags.ts`
   * FEATURE_KEYS) that this plan unlocks. On plan change the resolver
   * writes this set into `Tenant.featureFlags`; the existing
   * `isFeatureEnabled(tenantId, key)` middleware then gates routes.
   * Plans are STRICTLY ASCENDING — every flag in STARTER must also be
   * in GROWTH, every flag in GROWTH must also be in ENTERPRISE. The
   * ladder invariant is asserted in __tests__/plans.test.ts.
   */
  includedFeatures: string[];
}

export const PLAN_DEFINITIONS: Record<Plan, PlanDefinition> = {
  STARTER: {
    key: "STARTER",
    monthlyPriceInPaise: 499900, // ₹4,999
    includedFeatures: [
      "opd",
      "appointments",
      "prescriptions",
      "opd_billing",
      "patient_pwa",
      "crm_basic",
      "abha_link",
    ],
  },
  GROWTH: {
    key: "GROWTH",
    monthlyPriceInPaise: 1499900, // ₹14,999
    includedFeatures: [
      "opd",
      "appointments",
      "prescriptions",
      "opd_billing",
      "patient_pwa",
      "crm_basic",
      "abha_link",
      "lab",
      "radiology",
      "abdm_m1",
    ],
  },
  ENTERPRISE: {
    key: "ENTERPRISE",
    monthlyPriceInPaise: 3999900, // ₹39,999
    includedFeatures: [
      "opd",
      "appointments",
      "prescriptions",
      "opd_billing",
      "patient_pwa",
      "crm_basic",
      "abha_link",
      "lab",
      "radiology",
      "abdm_m1",
      "ipd",
      "ot",
      "abdm_m2",
      "ai_scribe",
    ],
  },
};

/**
 * Trial-period length in days. Set at signup as
 * `TenantSubscription.trialEndsAt = createdAt + TRIAL_DAYS`.
 * State machine starts in `trial`.
 */
export const TRIAL_DAYS = 30;

/**
 * Grace-period length in days. After `trialEndsAt` (or after a failed
 * recurring charge), the subscription flips to `past_due` for this many
 * days (read-only access with an upgrade banner) before transitioning
 * to `suspended` (login blocked except for billing).
 */
export const GRACE_PERIOD_DAYS = 7;

/**
 * SAC code for SaaS (Information Technology Software Services). Used as
 * the default for PlatformInvoice line items; may be overridden per
 * line for non-SaaS charges. Mirrors the DB-level default.
 */
export const DEFAULT_SAAS_SAC_CODE = "998314";
