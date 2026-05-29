"use client";

/**
 * Post-creation onboarding checklist for a newly-provisioned tenant.
 *
 * Each step has a completion marker persisted to SystemConfig under the key
 *   tenant:<id>:onboarding_step_<name>_completed_at
 * (the tenants API exposes `/tenants/:id/onboarding` + `/tenants/:id/onboarding/:step`
 * wrappers around those rows so the client doesn't touch SystemConfig directly).
 *
 * Step meanings (Pearl §8.1 wizard alignment):
 *   - account_created: auto-completed the moment the tenant + admin exist (SOW step 1).
 *   - default_permissions: confirm default role+permission matrix (SOW step 3).
 *   - first_doctor: mark complete once a doctor exists with consult mode picked
 *     — Calling / Token / Slot (SOW step 4).
 *   - abdm_registration: ABDM HFR (facility) + HPR (per-doctor) initiation;
 *     links to the gov portals + a checklist (SOW step 5).
 *   - whatsapp_setup: drop Gupshup app name + API key into tenant settings
 *     so Meta Cloud delivery works (SOW step 6).
 *   - payment_gateway: configure Razorpay / Cashfree credentials (SOW step 7).
 *   - duty_roster: mark complete once at least one DoctorSchedule row exists.
 *   - notification_templates: mark complete once the admin has reviewed.
 *
 * SOW step 2 ("First branch") is dropped from this checklist per the
 * 2026-05-29 product decision — the create-tenant modal already seeds a
 * default branch so a dedicated checklist row was redundant.
 * The legacy "Seed a test patient for dry run" extra was dropped on
 * 2026-05-29 — operators preferred to skip it on every run; the dry-run
 * value is better delivered via a dedicated post-launch playbook.
 * SOW step 8 ("Goes live with one click") is similarly deferred — the
 * per-step skip/complete signals make a single "go live" affordance
 * redundant until the activation flow lands.
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
    // SOW §8.1 skip support — `skipped` carries an ISO timestamp keyed by
    // step name for any step the operator chose to defer. A step can be
    // either completed OR skipped (not both — completing implicitly
    // un-skips on the API side).
    skipped?: Record<string, string>;
  };
}

interface TenantDetail {
  id: string;
  name: string;
  subdomain: string;
  active: boolean;
  config: Record<string, string>;
}

// Secondary links are always external (e.g. ABDM HPR portal) — the
// `external` field is intentionally not on the type because the
// renderer always uses `<a target="_blank">`. If a future step needs
// an internal `<Link>` secondary, reintroduce the flag here + the
// conditional in the renderer with its own test coverage.
interface StepLink {
  href: string;
  labelKey: string;
  labelDefault: string;
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
  linkExternal?: boolean;
  secondaryLink?: StepLink;
  checklistItems?: { key: string; defaultText: string }[];
  autoDetect?: (detail: TenantDetail | null) => boolean;
}

const STEPS: Step[] = [
  {
    key: "account_created",
    titleKey: "tenants.onb.accountCreated",
    titleDefault: "Account created",
    descriptionKey: "tenants.onb.accountCreated.desc",
    descriptionDefault:
      "Tenant record and first admin user have been provisioned — name and email captured for invoices, prescriptions and notifications.",
    linkHref: "/dashboard/tenants",
    linkLabelKey: "tenants.onb.accountCreated.link",
    linkLabelDefault: "View tenants list",
    autoDetect: (d) => !!d,
  },
  {
    key: "default_permissions",
    titleKey: "tenants.onb.defaultPermissions",
    titleDefault: "Review default permissions & roles",
    descriptionKey: "tenants.onb.defaultPermissions.desc",
    descriptionDefault:
      "Defaults work for most clinics — verify which roles can prescribe, refund and approve discounts before inviting staff.",
    // `{tenantId}` is templated by the renderer with the current tenant's
    // id before the link resolves.
    linkHref: "/dashboard/tenants/{tenantId}/role-permissions",
    linkLabelKey: "tenants.onb.defaultPermissions.link",
    linkLabelDefault: "Review role permissions",
  },
  {
    key: "first_doctor",
    titleKey: "tenants.onb.firstDoctor",
    titleDefault: "Add first doctor (pick consult mode)",
    descriptionKey: "tenants.onb.firstDoctor.desc",
    descriptionDefault:
      "Doctors are needed before appointments can be booked. Create at least one and choose the default consult mode — Calling, Token or Slot — to enable the queue.",
    linkHref: "/dashboard/doctors",
    linkLabelKey: "tenants.onb.firstDoctor.link",
    linkLabelDefault: "Open doctors directory",
  },
  {
    key: "abdm_registration",
    titleKey: "tenants.onb.abdm",
    titleDefault: "Register on ABDM (HFR + HPR)",
    descriptionKey: "tenants.onb.abdm.desc",
    descriptionDefault:
      "Initiate Ayushman Bharat Digital Mission onboarding: register the facility on HFR and each clinician on HPR so prescriptions and records are linkable to ABHA.",
    linkHref: "https://facility.abdm.gov.in",
    linkLabelKey: "tenants.onb.abdm.link",
    linkLabelDefault: "Open HFR portal",
    linkExternal: true,
    secondaryLink: {
      href: "https://hpr.abdm.gov.in",
      labelKey: "tenants.onb.abdm.linkHpr",
      labelDefault: "Open HPR portal",
    },
    checklistItems: [
      {
        key: "tenants.onb.abdm.checklist.hfr",
        defaultText:
          "HFR — hospital PAN, GSTIN, address proof and facility photo ready.",
      },
      {
        key: "tenants.onb.abdm.checklist.hpr",
        defaultText:
          "HPR — each doctor's NMC/state-council registration number and Aadhaar-linked mobile.",
      },
      {
        key: "tenants.onb.abdm.checklist.save",
        defaultText:
          "Save the HFR ID and per-doctor HPR IDs back in the doctors directory once issued.",
      },
    ],
  },
  {
    key: "whatsapp_setup",
    titleKey: "tenants.onb.whatsapp",
    titleDefault: "WhatsApp Business API (Gupshup) setup",
    descriptionKey: "tenants.onb.whatsapp.desc",
    descriptionDefault:
      "Drop the Gupshup app name + API key so appointment confirmations, lab-ready alerts and prescription shares actually deliver over WhatsApp.",
    linkHref: "/dashboard/whatsapp",
    linkLabelKey: "tenants.onb.whatsapp.link",
    linkLabelDefault: "Open WhatsApp settings",
    checklistItems: [
      {
        key: "tenants.onb.whatsapp.checklist.appName",
        defaultText: "Gupshup app name (Business Manager → App Settings).",
      },
      {
        key: "tenants.onb.whatsapp.checklist.apiKey",
        defaultText: "Gupshup API key + opted-in source phone number.",
      },
    ],
  },
  {
    key: "payment_gateway",
    titleKey: "tenants.onb.payment",
    titleDefault: "Payment gateway credentials",
    descriptionKey: "tenants.onb.payment.desc",
    descriptionDefault:
      "Add Razorpay or Cashfree key + secret so patient billing can capture online payments and the discount-approval flow can issue refunds.",
    linkHref: "/dashboard/payment-plans",
    linkLabelKey: "tenants.onb.payment.link",
    linkLabelDefault: "Open payment settings",
    checklistItems: [
      {
        key: "tenants.onb.payment.checklist.keyId",
        defaultText: "Razorpay / Cashfree Key ID (live or test mode).",
      },
      {
        key: "tenants.onb.payment.checklist.secret",
        defaultText:
          "Matching Key Secret — kept server-side, never exposed to the client.",
      },
    ],
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
];

export default function TenantOnboardingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const tenantId = params.id;

  const [steps, setSteps] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, string>>({});
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
      setSkipped(onbRes.data.skipped || {});
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

  async function markSkipped(stepKey: string) {
    try {
      await api.post(`/tenants/${tenantId}/onboarding/${stepKey}/skip`);
      toast.success(
        t("tenants.onb.stepSkipped", "Step skipped — revisit later"),
      );
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

  function isSkipped(step: Step): boolean {
    // A completed step always wins — `skipped` only matters while pending.
    if (isComplete(step)) return false;
    return !!skipped[step.key];
  }

  // Skipped steps do NOT count toward progress — the operator explicitly
  // deferred them and they're still pending.
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
            const skippedNow = isSkipped(step);
            // Template `{tenantId}` in linkHref / secondaryLink.href with the
            // current tenant's id so per-tenant deep links (e.g. the
            // role-permissions review page) resolve at render time without
            // each step having to know how to compose the URL.
            const resolveHref = (href: string) =>
              href.replace(/\{tenantId\}/g, tenantId ?? "");
            const primaryHref = resolveHref(step.linkHref);
            const secondaryHref = step.secondaryLink
              ? resolveHref(step.secondaryLink.href)
              : null;
            return (
              <li
                key={step.key}
                data-testid={`tenant-onboarding-step-${step.key}`}
                data-step-status={
                  complete ? "complete" : skippedNow ? "skipped" : "pending"
                }
                className={`flex items-start gap-4 rounded-xl border bg-white p-4 shadow-sm transition ${
                  complete
                    ? "border-green-200 bg-green-50/40"
                    : skippedNow
                      ? "border-amber-200 bg-amber-50/40"
                      : ""
                }`}
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white">
                  {complete ? (
                    <Check size={18} className="text-green-600" />
                  ) : (
                    <Circle
                      size={18}
                      className={skippedNow ? "text-amber-400" : "text-gray-300"}
                    />
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
                    {skippedNow && skipped[step.key] && (
                      <span
                        data-testid={`tenant-onboarding-skipped-badge-${step.key}`}
                        className="text-xs text-amber-600"
                      >
                        {t("tenants.onb.skippedOn", "Skipped on")}{" "}
                        {new Date(skipped[step.key]).toLocaleDateString("en-IN", {
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
                  {step.checklistItems && step.checklistItems.length > 0 && (
                    <ul
                      data-testid={`tenant-onboarding-checklist-${step.key}`}
                      className="mt-2 list-disc space-y-1 pl-5 text-xs text-gray-600"
                    >
                      {step.checklistItems.map((item) => (
                        <li key={item.key}>{t(item.key, item.defaultText)}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {step.linkExternal ? (
                      <a
                        href={primaryHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
                        data-testid={`tenant-onboarding-link-${step.key}`}
                      >
                        {t(step.linkLabelKey, step.linkLabelDefault)}{" "}
                        <ArrowRight size={12} />
                      </a>
                    ) : (
                      <Link
                        href={primaryHref}
                        className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
                        data-testid={`tenant-onboarding-link-${step.key}`}
                      >
                        {t(step.linkLabelKey, step.linkLabelDefault)}{" "}
                        <ArrowRight size={12} />
                      </Link>
                    )}
                    {step.secondaryLink && secondaryHref && (
                      <a
                        href={secondaryHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
                        data-testid={`tenant-onboarding-link2-${step.key}`}
                      >
                        {t(
                          step.secondaryLink.labelKey,
                          step.secondaryLink.labelDefault,
                        )}{" "}
                        <ArrowRight size={12} />
                      </a>
                    )}
                    {!complete && step.key !== "account_created" && (
                      <>
                        <button
                          data-testid={`tenant-onboarding-complete-${step.key}`}
                          onClick={() => markComplete(step.key)}
                          className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-dark"
                        >
                          {t("tenants.onb.markComplete", "Mark complete")}
                        </button>
                        {!skippedNow && (
                          <button
                            data-testid={`tenant-onboarding-skip-${step.key}`}
                            onClick={() => markSkipped(step.key)}
                            className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-50"
                          >
                            {t("tenants.onb.skipForNow", "Skip for now")}
                          </button>
                        )}
                      </>
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
