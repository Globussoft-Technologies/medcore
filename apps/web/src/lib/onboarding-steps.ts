// Shared onboarding step keys — Pearl §8.1 wizard.
//
// The full step definitions (titles, descriptions, links) live in
// apps/web/src/app/dashboard/tenants/[id]/onboarding/page.tsx. This module
// holds just the canonical key list + the auto-completed subset so the
// dashboard's OnboardingBanner can compute "how many steps are still
// pending" without importing the heavy page module. Keep this list in sync
// with STEPS in that page (8 steps; account_created auto-completes).

export const ONBOARDING_STEP_KEYS = [
  "account_created",
  "default_permissions",
  "first_doctor",
  "abdm_registration",
  "whatsapp_setup",
  "payment_gateway",
  "duty_roster",
  "notification_templates",
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

// Steps that complete themselves (auto-detected, no manual action). These
// never count as "pending" and can't be marked complete via a visit.
export const AUTO_COMPLETE_STEP_KEYS: readonly string[] = ["account_created"];

/**
 * Count steps that are still pending = neither completed, auto-completed,
 * nor skipped. A skipped step is treated as resolved for surfacing purposes
 * (product decision 2026-06: "skip silences that step"), so only truly
 * untouched steps drive the dashboard onboarding banner.
 */
export function countPendingOnboardingSteps(
  completed: Record<string, string> | undefined,
  skipped: Record<string, string> | undefined,
): number {
  const done = completed ?? {};
  const skip = skipped ?? {};
  return ONBOARDING_STEP_KEYS.filter(
    (k) => !AUTO_COMPLETE_STEP_KEYS.includes(k) && !done[k] && !skip[k],
  ).length;
}
