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

// ─────────────────────────────────────────────────────────────────────────
// PLAN FEATURE CATALOG (Platform-Billing plan editor, 2026-06-11)
//
// The super-admin Edit-Plan dialog renders this as a grouped checkbox list:
// each gateable module the plan unlocks for its tenants. `common: true` rows
// are baseline modules every tenant always gets (shown checked + disabled).
// `dependsOn` rows auto-select their prerequisites so the operator can't grant
// a module without what it needs (e.g. Refunds needs Billing).
//
// NOTE (staging): this catalog drives the PLAN EDITOR + (next stage) live
// plan→tenant gating. The legacy 16 FEATURE_KEYS above still drive the current
// route gating until Stage 2 reconciles them. Keys here are route-slug-based.
// ─────────────────────────────────────────────────────────────────────────

export interface PlanFeature {
  key: string;
  label: string;
  category: string;
  /** Always-on for every tenant regardless of plan (checked + locked in UI). */
  common?: boolean;
  /** Other catalog keys this feature requires (auto-selected when checked). */
  dependsOn?: string[];
}

export const PLAN_FEATURE_CATALOG: PlanFeature[] = [
  // Core (common — every tenant always gets these)
  { key: "dashboard", label: "Dashboard", category: "Core", common: true },
  { key: "patients", label: "Patients", category: "Core", common: true },
  { key: "appointments", label: "Appointments", category: "Core", common: true },
  { key: "queue", label: "Live Queue", category: "Core", common: true },
  { key: "calendar", label: "Calendar", category: "Core", common: true },
  { key: "doctors", label: "Doctors", category: "Core", common: true },
  { key: "users", label: "User Management", category: "Core", common: true },
  { key: "notifications", label: "Notifications", category: "Core", common: true },
  { key: "chat", label: "Chat", category: "Core", common: true },

  // Clinical
  { key: "prescriptions", label: "Prescriptions", category: "Clinical" },
  { key: "medicines", label: "Medicines (formulary)", category: "Clinical" },
  { key: "immunizations", label: "Immunizations", category: "Clinical" },
  { key: "referrals", label: "Referrals", category: "Clinical" },
  { key: "antenatal", label: "Antenatal", category: "Clinical" },
  { key: "pediatric", label: "Pediatric / Growth", category: "Clinical" },
  { key: "cohorts", label: "Care Cohorts", category: "Clinical" },
  { key: "adherence", label: "Adherence", category: "Clinical" },

  // Inpatient & OT
  { key: "ipd", label: "IPD — Wards / Admissions", category: "Inpatient & OT" },
  { key: "surgery", label: "Surgery", category: "Inpatient & OT" },
  { key: "ot", label: "Operating Theatres", category: "Inpatient & OT", dependsOn: ["surgery"] },
  { key: "emergency", label: "Emergency / ER", category: "Inpatient & OT" },
  { key: "bloodbank", label: "Blood Bank", category: "Inpatient & OT" },
  { key: "ambulance", label: "Ambulance", category: "Inpatient & OT" },
  { key: "census", label: "Census Report", category: "Inpatient & OT", dependsOn: ["ipd"] },

  // Diagnostics
  { key: "lab", label: "Lab", category: "Diagnostics" },
  { key: "labQc", label: "Lab QC", category: "Diagnostics", dependsOn: ["lab"] },
  { key: "labExplainer", label: "Lab Explainer", category: "Diagnostics", dependsOn: ["lab"] },

  // Pharmacy
  { key: "pharmacy", label: "Pharmacy (inventory)", category: "Pharmacy", dependsOn: ["medicines"] },
  { key: "controlledRegister", label: "Controlled Register", category: "Pharmacy", dependsOn: ["pharmacy"] },
  { key: "suppliers", label: "Suppliers", category: "Pharmacy" },
  { key: "purchaseOrders", label: "Purchase Orders", category: "Pharmacy", dependsOn: ["suppliers"] },
  { key: "pharmacyForecast", label: "Pharmacy Forecast (AI)", category: "Pharmacy", dependsOn: ["pharmacy"] },

  // Finance & Billing
  { key: "billing", label: "Billing", category: "Finance & Billing", common: true },
  { key: "refunds", label: "Refunds", category: "Finance & Billing", dependsOn: ["billing"] },
  { key: "paymentPlans", label: "Payment Plans", category: "Finance & Billing", dependsOn: ["billing"] },
  { key: "packages", label: "Health Packages", category: "Finance & Billing", dependsOn: ["billing"] },
  { key: "discountApprovals", label: "Discount Approvals", category: "Finance & Billing", dependsOn: ["billing"] },
  { key: "insuranceClaims", label: "Insurance Claims", category: "Finance & Billing", dependsOn: ["billing"] },
  { key: "preauth", label: "Pre-Authorization", category: "Finance & Billing", dependsOn: ["insuranceClaims"] },
  { key: "expenses", label: "Expenses", category: "Finance & Billing" },
  { key: "budgets", label: "Budgets", category: "Finance & Billing", dependsOn: ["expenses"] },

  // Front Office & CRM
  { key: "visitors", label: "Visitor Management", category: "Front Office & CRM" },
  { key: "leads", label: "Leads (CRM)", category: "Front Office & CRM" },
  { key: "campaigns", label: "Campaigns", category: "Front Office & CRM", dependsOn: ["leads"] },
  { key: "broadcasts", label: "Broadcasts", category: "Front Office & CRM" },
  { key: "feedback", label: "Feedback", category: "Front Office & CRM" },
  { key: "complaints", label: "Complaints", category: "Front Office & CRM" },

  // HR & Staff
  { key: "hrmsPayroll", label: "Payroll", category: "HR & Staff" },
  { key: "dutyRoster", label: "Duty Roster", category: "HR & Staff" },
  { key: "leaveManagement", label: "Leave Requests", category: "HR & Staff" },
  { key: "holidays", label: "Holidays", category: "HR & Staff" },
  { key: "certifications", label: "Certifications", category: "HR & Staff" },
  { key: "assets", label: "Assets", category: "HR & Staff" },

  // Analytics & Reports
  { key: "analytics", label: "Analytics Dashboard", category: "Analytics & Reports" },
  { key: "reports", label: "Report Builder", category: "Analytics & Reports", dependsOn: ["analytics"] },
  { key: "scheduledReports", label: "Scheduled Reports", category: "Analytics & Reports", dependsOn: ["reports"] },
  { key: "auditLog", label: "Audit Log", category: "Analytics & Reports" },

  // AI suite
  { key: "agentConsole", label: "Agent Console", category: "AI" },
  { key: "voiceRx", label: "AI Scribe / Voice-Rx", category: "AI" },
  { key: "aiBooking", label: "AI Booking", category: "AI" },
  { key: "predictiveCds", label: "Diagnosis / Predictive CDS", category: "AI" },
  { key: "chartSearch", label: "AI Chart Search", category: "AI" },
  { key: "aiAnalytics", label: "AI Analytics", category: "AI", dependsOn: ["analytics"] },
  { key: "aiKpis", label: "AI KPIs", category: "AI", dependsOn: ["analytics"] },
  { key: "predictiveNoShow", label: "No-Show Predictions", category: "AI" },
  { key: "erTriage", label: "ER Triage (AI)", category: "AI", dependsOn: ["emergency"] },
  { key: "aiLetters", label: "AI Letters", category: "AI" },
  { key: "aiRadiology", label: "AI Radiology", category: "AI" },

  // Integrations
  { key: "telemedicine", label: "Telemedicine", category: "Integrations" },
  { key: "abdm", label: "ABDM / ABHA", category: "Integrations" },
  { key: "fhirExport", label: "FHIR Export", category: "Integrations" },
];

/** Catalog keys that are common (always granted to every tenant). */
export const COMMON_FEATURE_KEYS: string[] = PLAN_FEATURE_CATALOG.filter(
  (f) => f.common,
).map((f) => f.key);

/**
 * Resolve a plan's selected feature keys into the full effective set a tenant
 * on that plan can access: the common baseline ∪ the plan's picks ∪ every
 * dependency those picks transitively require. Used by the plan editor (to
 * auto-select deps) and (Stage 2) by live plan→tenant gating.
 */
export function resolvePlanFeatures(selected: string[]): Set<string> {
  const byKey = new Map(PLAN_FEATURE_CATALOG.map((f) => [f.key, f]));
  const out = new Set<string>(COMMON_FEATURE_KEYS);
  const visit = (key: string) => {
    if (out.has(key)) return;
    out.add(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) visit(dep);
  };
  for (const key of selected) visit(key);
  return out;
}

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
