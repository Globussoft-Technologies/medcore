// Dashboard onboarding nudge — Pearl §8.1.
//
// Shown to a TENANT admin (role ADMIN with a non-null tenantId; super-admins
// have tenantId == null and never see it) when their tenant still has
// onboarding steps that are neither completed nor skipped. Status-driven:
// it reappears on every login until the remaining steps are done, and a
// skipped step silences itself (counts as resolved). Links to the per-tenant
// onboarding checklist; not dismissible by design (the count IS the dismiss).
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Rocket } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { countPendingOnboardingSteps } from "@/lib/onboarding-steps";

interface OnboardingStatusResponse {
  data: {
    steps?: Record<string, string>;
    skipped?: Record<string, string>;
  };
}

export function OnboardingBanner() {
  const { user } = useAuthStore();
  const tenantId = user?.tenantId ?? null;
  // Super-admins manage onboarding from the Tenants page and never get the
  // clinic nudge. The store coerces role SUPER_ADMIN → ADMIN (keeping
  // `actualRole`), so we must check `actualRole` too — checking only
  // `tenantId == null` is fragile (a super-admin wrongly assigned a tenant
  // would otherwise see this banner).
  const isSuperAdmin =
    user?.actualRole === "SUPER_ADMIN" || (user?.role === "ADMIN" && !tenantId);
  // Only genuine tenant admins (ADMIN with a tenant, not a super-admin) get it.
  const isTenantAdmin = user?.role === "ADMIN" && !!tenantId && !isSuperAdmin;

  const [pending, setPending] = useState(0);

  useEffect(() => {
    if (!isTenantAdmin || !tenantId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<OnboardingStatusResponse>(
          `/tenants/${tenantId}/onboarding`,
        );
        if (cancelled) return;
        setPending(
          countPendingOnboardingSteps(res.data.steps, res.data.skipped),
        );
      } catch {
        // Endpoint unavailable / forbidden → stay silent rather than nag.
        if (!cancelled) setPending(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isTenantAdmin, tenantId]);

  if (!isTenantAdmin || !tenantId || pending <= 0) return null;

  return (
    <Link
      href={`/dashboard/tenants/${tenantId}/onboarding`}
      data-testid="dashboard-onboarding-banner"
      className="group mb-6 flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 transition hover:border-primary/50 hover:bg-primary/10 hover:shadow-sm sm:flex-row sm:items-center sm:justify-between dark:border-primary/40 dark:bg-primary/10 dark:hover:bg-primary/20"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary dark:bg-primary/20">
          <Rocket size={18} aria-hidden="true" />
        </span>
        <div>
          <p className="font-semibold text-gray-900 dark:text-gray-100">
            Finish setting up your clinic
          </p>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-300">
            {pending} step{pending === 1 ? "" : "s"} left — complete onboarding
            to unlock the full workflow.
          </p>
        </div>
      </div>
      <span
        data-testid="dashboard-onboarding-banner-resume"
        className="inline-flex shrink-0 items-center gap-1.5 self-start text-sm font-medium text-primary sm:self-auto"
      >
        Resume onboarding
        <ArrowRight
          size={14}
          aria-hidden="true"
          className="transition group-hover:translate-x-0.5"
        />
      </span>
    </Link>
  );
}
