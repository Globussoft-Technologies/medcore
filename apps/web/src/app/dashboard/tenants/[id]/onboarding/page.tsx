"use client";

/**
 * Post-creation onboarding checklist for a newly-provisioned tenant.
 *
 * Each step has a completion marker persisted to SystemConfig under the key
 *   tenant:<id>:onboarding_step_<name>_completed_at
 * (the tenants API exposes `/tenants/:id/onboarding` + `/tenants/:id/onboarding/:step`
 * wrappers around those rows so the client doesn't touch SystemConfig directly).
 *
 * Step meanings:
 *   - account_created: auto-completed the moment the tenant + admin exist.
 *   - hospital_config: hospital-identity SystemConfig keys are all non-empty.
 *   - first_doctor: mark complete once the operator has added a doctor.
 *   - duty_roster: mark complete once at least one DoctorSchedule row exists.
 *   - notification_templates: mark complete once the admin has reviewed.
 *   - seed_test_patient: mark complete once the admin has registered a dry-run patient.
 *
 * The UI focuses on guiding the admin; actual completion detection is
 * best-effort (auto-detected for hospital_config, explicit button for the
 * rest). All state is per-tenant so multiple tenants can be in different
 * onboarding stages simultaneously.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Check, Circle, ArrowRight, ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { SkeletonCard } from "@/components/Skeleton";

interface OnboardingResponse {
  data: {
    tenantId: string;
    steps: Record<string, string>;
  };
}

interface TenantDetail {
  id: string;
  name: string;
  subdomain: string;
  active: boolean;
  config: Record<string, string>;
}

interface Step {
  key: string;
  titleKey: string;
  titleDefault: string;
  descriptionKey: string;
  descriptionDefault: string;
  linkHref: string;
  linkLabelKey: string;
  linkLabelDefault: string;
  autoDetect?: (detail: TenantDetail | null) => boolean;
}

const STEPS: Step[] = [
  {
    key: "account_created",
    titleKey: "tenants.onb.accountCreated",
    titleDefault: "Account created",
    descriptionKey: "tenants.onb.accountCreated.desc",
    descriptionDefault: "Tenant record and first admin user have been provisioned.",
    linkHref: "/dashboard/tenants",
    linkLabelKey: "tenants.onb.accountCreated.link",
    linkLabelDefault: "View tenants list",
    autoDetect: (d) => !!d,
  },
  {
    key: "hospital_config",
    titleKey: "tenants.onb.hospitalConfig",
    titleDefault: "Configure hospital details",
    descriptionKey: "tenants.onb.hospitalConfig.desc",
    descriptionDefault:
      "Name, phone, email, GSTIN and address — shown on invoices, prescriptions and notifications.",
    linkHref: "/dashboard/settings",
    linkLabelKey: "tenants.onb.hospitalConfig.link",
    linkLabelDefault: "Open hospital settings",
    autoDetect: (d) => {
      if (!d) return false;
      const required = ["hospital_name", "hospital_phone", "hospital_email", "hospital_address"];
      return required.every((k) => (d.config[k] || "").trim().length > 0);
    },
  },
  {
    key: "first_doctor",
    titleKey: "tenants.onb.firstDoctor",
    titleDefault: "Add first doctor",
    descriptionKey: "tenants.onb.firstDoctor.desc",
    descriptionDefault:
      "Doctors are needed before appointments can be booked. Create at least one to enable the queue.",
    linkHref: "/dashboard/doctors",
    linkLabelKey: "tenants.onb.firstDoctor.link",
    linkLabelDefault: "Open doctors directory",
  },
  {
    key: "duty_roster",
    titleKey: "tenants.onb.dutyRoster",
    titleDefault: "Set duty roster",
    descriptionKey: "tenants.onb.dutyRoster.desc",
    descriptionDefault:
      "Configure consulting hours per doctor so the slot calculator has something to work with.",
    linkHref: "/dashboard/duty-roster",
    linkLabelKey: "tenants.onb.dutyRoster.link",
    linkLabelDefault: "Open duty roster",
  },
  {
    key: "notification_templates",
    titleKey: "tenants.onb.templates",
    titleDefault: "Review notification templates",
    descriptionKey: "tenants.onb.templates.desc",
    descriptionDefault:
      "We seeded default templates. Review wording and branding before they go to your patients.",
    linkHref: "/dashboard/notification-templates",
    linkLabelKey: "tenants.onb.templates.link",
    linkLabelDefault: "Open templates",
  },
  {
    key: "seed_test_patient",
    titleKey: "tenants.onb.testPatient",
    titleDefault: "Seed a test patient for dry run",
    descriptionKey: "tenants.onb.testPatient.desc",
    descriptionDefault:
      "Register a dummy patient and book them an appointment to validate the full flow end-to-end.",
    linkHref: "/dashboard/patients",
    linkLabelKey: "tenants.onb.testPatient.link",
    linkLabelDefault: "Open patients",
  },
];

export default function TenantOnboardingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const tenantId = params.id;

  const [steps, setSteps] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user && user.role !== "ADMIN") router.push("/dashboard");
  }, [user, router]);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const [onbRes, detailRes] = await Promise.all([
        api.get<OnboardingResponse>(`/tenants/${tenantId}/onboarding`),
        api.get<{ data: TenantDetail }>(`/tenants/${tenantId}`),
      ]);
      setSteps(onbRes.data.steps || {});
      setDetail(detailRes.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load onboarding");
    }
    setLoading(false);
  }, [tenantId]);

  useEffect(() => {
    if (user?.role === "ADMIN") load();
  }, [load, user]);

  async function markComplete(stepKey: string) {
    try {
      await api.post(`/tenants/${tenantId}/onboarding/${stepKey}`);
      toast.success(t("tenants.onb.stepDone", "Step marked complete"));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  function isComplete(step: Step): boolean {
    if (steps[step.key]) return true;
    if (step.autoDetect && step.autoDetect(detail)) return true;
    return false;
  }

  const completedCount = STEPS.filter(isComplete).length;
  const percent = Math.round((completedCount / STEPS.length) * 100);

  if (user && user.role !== "ADMIN") return null;

  return (
    <div data-testid="tenant-onboarding">
      <div className="mb-4">
        <Link
          href="/dashboard/tenants"
          className="mb-2 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft size={14} /> {t("tenants.onb.back", "Back to tenants")}
        </Link>
        <h1 className="text-2xl font-bold">
          {t("tenants.onb.title", "Tenant Onboarding")}
        </h1>
        {detail && (
          <p className="text-sm text-gray-500">
            <span className="font-medium">{detail.name}</span> ·{" "}
            <span className="font-mono">{detail.subdomain}</span>
          </p>
        )}
      </div>

      <div className="mb-6 rounded-xl bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-gray-600">
            {t("tenants.onb.progress", "Progress")}: {completedCount} /{" "}
            {STEPS.length}
          </span>
          <span className="font-medium">{percent}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${percent}%` }}
            data-testid="tenant-onboarding-progress"
          />
        </div>
      </div>

      {loading ? (
        // Pearl §7.2 skeleton sweep (wave 13, 2026-05-23): replaced the
        // bare "Loading..." text with a `SkeletonCard ×3` block (matching
        // the 6-step checklist shape) under a stable
        // `tenant-onboarding-loading` testid + `aria-busy="true"`.
        <div
          data-testid="tenant-onboarding-loading"
          aria-busy="true"
          className="space-y-3"
        >
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : (
        <ol className="space-y-3">
          {STEPS.map((step, idx) => {
            const complete = isComplete(step);
            return (
              <li
                key={step.key}
                data-testid={`tenant-onboarding-step-${step.key}`}
                className={`flex items-start gap-4 rounded-xl border bg-white p-4 shadow-sm transition ${
                  complete ? "border-green-200 bg-green-50/40" : ""
                }`}
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white">
                  {complete ? (
                    <Check size={18} className="text-green-600" />
                  ) : (
                    <Circle size={18} className="text-gray-300" />
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">
                      {idx + 1}. {t(step.titleKey, step.titleDefault)}
                    </h3>
                    {complete && steps[step.key] && (
                      <span className="text-xs text-green-600">
                        ✓{" "}
                        {new Date(steps[step.key]).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-gray-600">
                    {t(step.descriptionKey, step.descriptionDefault)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link
                      href={step.linkHref}
                      className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
                      data-testid={`tenant-onboarding-link-${step.key}`}
                    >
                      {t(step.linkLabelKey, step.linkLabelDefault)}{" "}
                      <ArrowRight size={12} />
                    </Link>
                    {!complete && step.key !== "account_created" && (
                      <button
                        data-testid={`tenant-onboarding-complete-${step.key}`}
                        onClick={() => markComplete(step.key)}
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-dark"
                      >
                        {t("tenants.onb.markComplete", "Mark complete")}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
