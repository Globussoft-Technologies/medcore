// Pearl ERP Stage 1 §6 + §18 (gap item #9) — feature-flag keys shared
// between API and web. The canonical list lives here so the API
// middleware, the web sidebar gating, and the super-admin tenant editor
// all reference the same identifiers.
//
// Each key maps to one Pearl-excluded surface that MedCore ships by
// default but a Pearl-branded tenant deployment hides. Default state
// for every flag (when the tenant has `featureFlags = null` or the key
// is absent) is **enabled** — current MedCore behaviour, no regression
// for non-Pearl tenants. A Pearl pilot tenant explicitly sets the
// relevant keys to `false`.
//
// When adding a new flag:
//   1. Append the key to FEATURE_KEYS.
//   2. Add the matching `enabled by default` row to FEATURE_METADATA.
//   3. (Optional) Wire the API middleware in the matching route file:
//      `router.use(requireFeature("<key>"));`
//   4. (Optional) Add the matching nav-config conditional in
//      `apps/web/src/app/dashboard/layout.tsx`.

export const FEATURE_KEYS = [
  // Phase 2+ clinical surfaces (Pearl PRD §18 exclusions)
  "ipd", // wards/beds/admissions/eMAR/nurse-rounds
  "ot", // operating-theater scheduling + implants
  "telemedicine", // video sessions + waiting room
  "voiceRx", // AI scribe + ASR
  "aiDischarge", // AI-generated discharge summaries
  "predictiveCds", // sepsis/deterioration/no-show predictors
  "aiRadiology", // chest X-ray / ECG / retinal triage
  "nabhDashboard", // NABH quality reporting surface
  "abdmAdvanced", // ABDM M2/M3/M4 (Stage 1 keeps M1)
  "hrmsPayroll", // payroll + leave-management + duty-roster
  "hl7Inbound", // HL7v2 lab analyser inbound feed
  // Granular AI surfaces
  "aiCoaching",
  "aiFollowup",
  "aiCapacity",
  "aiFraud",
  "aiRoster",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureMetadata {
  /** Display name shown in the super-admin tenant editor. */
  label: string;
  /** One-line description of what the feature surface does. */
  description: string;
  /** Default enabled state when the tenant has no override. */
  defaultEnabled: boolean;
}

export const FEATURE_METADATA: Record<FeatureKey, FeatureMetadata> = {
  ipd: {
    label: "IPD (in-patient)",
    description: "Wards, beds, admissions, eMAR, nurse rounds, IO chart",
    defaultEnabled: true,
  },
  ot: {
    label: "Operating Theatre",
    description: "OT scheduling, anesthesia records, post-op observation, implant register",
    defaultEnabled: true,
  },
  telemedicine: {
    label: "Telemedicine",
    description: "Video consultations, waiting room, recording",
    defaultEnabled: true,
  },
  voiceRx: {
    label: "Voice-Rx (AI scribe)",
    description: "ASR-driven Rx drafting + SOAP scribe",
    defaultEnabled: true,
  },
  aiDischarge: {
    label: "AI Discharge Summary",
    description: "LLM-generated discharge summary drafts",
    defaultEnabled: true,
  },
  predictiveCds: {
    label: "Predictive CDS",
    description: "Sepsis / deterioration / no-show predictors",
    defaultEnabled: true,
  },
  aiRadiology: {
    label: "AI Radiology",
    description: "Chest X-ray, ECG, retinal image triage",
    defaultEnabled: true,
  },
  nabhDashboard: {
    label: "NABH Quality Dashboard",
    description: "NABH-accreditation reporting surface",
    defaultEnabled: true,
  },
  abdmAdvanced: {
    label: "ABDM M2/M3/M4",
    description: "Advanced ABDM tiers (Stage 1 ships M1 only)",
    defaultEnabled: true,
  },
  hrmsPayroll: {
    label: "HRMS / Payroll",
    description: "Payroll, leave management, duty roster (clinical shift scheduling stays)",
    defaultEnabled: true,
  },
  hl7Inbound: {
    label: "HL7 v2 inbound feed",
    description: "Lab analyser HL7 inbound integration",
    defaultEnabled: true,
  },
  aiCoaching: {
    label: "AI Coaching",
    description: "Chronic-care patient coaching agent",
    defaultEnabled: true,
  },
  aiFollowup: {
    label: "AI Follow-up",
    description: "Post-consultation follow-up sequencing",
    defaultEnabled: true,
  },
  aiCapacity: {
    label: "AI Capacity planning",
    description: "Bed + OT capacity forecasting",
    defaultEnabled: true,
  },
  aiFraud: {
    label: "AI Fraud detection",
    description: "Billing anomaly + claim fraud detection",
    defaultEnabled: true,
  },
  aiRoster: {
    label: "AI Roster",
    description: "Staff roster optimisation",
    defaultEnabled: true,
  },
};

/**
 * Resolve a single feature flag against the tenant's stored overrides.
 * Pure function — accepts the raw JSON from `Tenant.featureFlags` and
 * the key to check; returns the effective enabled state.
 */
export function isFeatureEnabled(
  storedFlags: Record<string, unknown> | null | undefined,
  key: FeatureKey,
): boolean {
  if (!storedFlags || typeof storedFlags !== "object") {
    return FEATURE_METADATA[key].defaultEnabled;
  }
  const override = storedFlags[key];
  if (typeof override === "boolean") return override;
  return FEATURE_METADATA[key].defaultEnabled;
}

/**
 * Resolve all flags at once for shipping the whole map to the web
 * client. The returned shape always has every key, with explicit
 * boolean values (no nulls, no missing keys) so the frontend can rely
 * on `flags.ipd === false` rather than `flags.ipd === null`.
 */
export function resolveAllFeatureFlags(
  storedFlags: Record<string, unknown> | null | undefined,
): Record<FeatureKey, boolean> {
  const result = {} as Record<FeatureKey, boolean>;
  for (const key of FEATURE_KEYS) {
    result[key] = isFeatureEnabled(storedFlags, key);
  }
  return result;
}
