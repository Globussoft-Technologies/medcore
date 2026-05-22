// Super-admin onboarding wizard — Pearl ERP Stage 1 §8.1 (gap #6 piece 2 of 4).
//
// 3-step MVP wizard that posts a single atomic payload to
// /api/v1/tenant-onboarding (which creates Tenant + first Branch + super-admin
// User in one transaction). Steps:
//   1. Tenant basics (name, subdomain, plan)
//   2. First branch (name, code, address, city, state, pincode, phone)
//   3. Super-admin user (name, email, phone, password)
//
// The full PRD calls for 8 steps including HFR / HPR / WhatsApp /
// Razorpay config. Those are deferred to piece 2b — each needs an
// external integration the wizard would validate against, which is
// meaningfully more work than this MVP.
//
// Auth: relies on the super-admin layout's client-side gate. No
// additional check needed here.
//
// Test ids: onboarding-step-{1,2,3}, onboarding-back, onboarding-next,
// onboarding-submit, onboarding-error-banner, plus per-field
// onboarding-tenant-name / onboarding-branch-name / onboarding-admin-*
// for the smoke component test.

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

type Plan = "BASIC" | "PRO" | "ENTERPRISE";
type Step = 1 | 2 | 3;

interface TenantStepState {
  name: string;
  subdomain: string;
  plan: Plan;
}
interface BranchStepState {
  name: string;
  code: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
}
interface AdminStepState {
  name: string;
  email: string;
  phone: string;
  password: string;
}

// Mirror the server-side regex (kept in sync with
// packages/shared/src/validation/tenant-onboarding.ts). We duplicate
// instead of importing because pulling @medcore/shared into a client
// component bundles all the Zod schemas — too heavy for this MVP.
const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$/;
const RESERVED_SUBDOMAINS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "console",
  "dashboard",
  "default",
  "docs",
  "help",
  "mail",
  "medcore",
  "public",
  "root",
  "status",
  "support",
  "system",
  "www",
]);
const BRANCH_CODE_REGEX = /^[A-Z0-9_-]{1,10}$/;
const PINCODE_REGEX = /^\d{6}$/;
const PHONE_REGEX = /^\+?\d{7,15}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateTenantStep(s: TenantStepState): string | null {
  if (s.name.trim().length < 2) return "Hospital name must be at least 2 characters";
  const sub = s.subdomain.trim().toLowerCase();
  if (!SUBDOMAIN_REGEX.test(sub))
    return "Subdomain must be 3-30 chars, lowercase letters/digits/hyphens";
  if (RESERVED_SUBDOMAINS.has(sub)) return "Subdomain is reserved";
  return null;
}

function validateBranchStep(s: BranchStepState): string | null {
  if (s.name.trim().length < 2) return "Branch name must be at least 2 characters";
  if (s.code && !BRANCH_CODE_REGEX.test(s.code.toUpperCase()))
    return "Branch code must be 1-10 uppercase alphanumerics";
  if (s.pincode && !PINCODE_REGEX.test(s.pincode))
    return "Pincode must be 6 digits";
  if (s.phone && !PHONE_REGEX.test(s.phone.trim()))
    return "Invalid phone (7-15 digits, optional leading +)";
  return null;
}

function validateAdminStep(s: AdminStepState): string | null {
  if (s.name.trim().length < 2) return "Admin name must be at least 2 characters";
  if (!EMAIL_REGEX.test(s.email.trim())) return "Invalid email";
  if (!PHONE_REGEX.test(s.phone.trim())) return "Invalid phone";
  if (s.password.length < 8) return "Password must be at least 8 characters";
  return null;
}

export default function OnboardingWizardPage() {
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // Per-field error from a server 409, keyed by the `field` returned
  // by the API. Cleared whenever the user navigates back.
  const [serverFieldError, setServerFieldError] = useState<
    { field: string; message: string } | null
  >(null);

  const [tenantStep, setTenantStep] = useState<TenantStepState>({
    name: "",
    subdomain: "",
    plan: "BASIC",
  });
  const [branchStep, setBranchStep] = useState<BranchStepState>({
    name: "",
    code: "",
    address: "",
    city: "",
    state: "",
    pincode: "",
    phone: "",
  });
  const [adminStep, setAdminStep] = useState<AdminStepState>({
    name: "",
    email: "",
    phone: "",
    password: "",
  });

  const tenantError = useMemo(
    () => (step === 1 && (tenantStep.name || tenantStep.subdomain) ? validateTenantStep(tenantStep) : null),
    [step, tenantStep],
  );
  const branchError = useMemo(
    () => (step === 2 && branchStep.name ? validateBranchStep(branchStep) : null),
    [step, branchStep],
  );
  const adminError = useMemo(
    () =>
      step === 3 && (adminStep.name || adminStep.email || adminStep.phone || adminStep.password)
        ? validateAdminStep(adminStep)
        : null,
    [step, adminStep],
  );

  function goBack() {
    setErrorBanner(null);
    setServerFieldError(null);
    if (step > 1) setStep((step - 1) as Step);
  }

  function goNext() {
    setErrorBanner(null);
    if (step === 1) {
      const e = validateTenantStep(tenantStep);
      if (e) {
        setErrorBanner(e);
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      const e = validateBranchStep(branchStep);
      if (e) {
        setErrorBanner(e);
        return;
      }
      setStep(3);
      return;
    }
  }

  async function submit() {
    setErrorBanner(null);
    setServerFieldError(null);

    const tErr = validateTenantStep(tenantStep);
    if (tErr) {
      setErrorBanner(`Step 1: ${tErr}`);
      setStep(1);
      return;
    }
    const bErr = validateBranchStep(branchStep);
    if (bErr) {
      setErrorBanner(`Step 2: ${bErr}`);
      setStep(2);
      return;
    }
    const aErr = validateAdminStep(adminStep);
    if (aErr) {
      setErrorBanner(`Step 3: ${aErr}`);
      return;
    }

    const payload = {
      tenant: {
        name: tenantStep.name.trim(),
        subdomain: tenantStep.subdomain.trim().toLowerCase(),
        plan: tenantStep.plan,
      },
      branch: {
        name: branchStep.name.trim(),
        code: branchStep.code.trim() || null,
        address: branchStep.address.trim() || null,
        city: branchStep.city.trim() || null,
        state: branchStep.state.trim() || null,
        pincode: branchStep.pincode.trim() || null,
        phone: branchStep.phone.trim() || null,
      },
      admin: {
        name: adminStep.name.trim(),
        email: adminStep.email.trim(),
        phone: adminStep.phone.trim(),
        password: adminStep.password,
      },
    };

    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/tenant-onboarding", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json: {
        success: boolean;
        data: { tenant: { id: string } } | null;
        error: string | null;
        field?: string;
      } = await res.json().catch(() => ({
        success: false,
        data: null,
        error: "Invalid server response",
      }));

      if (!res.ok || !json.success) {
        const fieldName = json.field ?? "";
        if (fieldName) {
          setServerFieldError({
            field: fieldName,
            message: json.error ?? "Validation failed",
          });
          // Bounce the user back to the step that owns the field so
          // they can correct it in-context.
          if (fieldName.startsWith("tenant.")) setStep(1);
          else if (fieldName.startsWith("branch.")) setStep(2);
          else if (fieldName.startsWith("admin.")) setStep(3);
        }
        setErrorBanner(json.error ?? `Onboarding failed (HTTP ${res.status})`);
        return;
      }

      setSuccess(true);
      // Short delay so the success card is visible before the bounce.
      setTimeout(() => {
        // /super-admin/tenants/[id] doesn't exist yet (piece 3+);
        // fall back to the landing page. Operator can verify the new
        // tenant from there.
        router.push("/super-admin");
      }, 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBanner(`Network error: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <section
        data-testid="onboarding-success"
        className="mx-auto max-w-2xl space-y-4 py-12 text-center"
      >
        <CheckCircle2
          className="mx-auto text-emerald-500"
          size={48}
          aria-hidden="true"
        />
        <h1 className="text-2xl font-semibold">Tenant onboarded</h1>
        <p className="text-sm text-slate-600">
          {tenantStep.name} ({tenantStep.subdomain}) is now active.
          Redirecting to the super-admin console…
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="onboarding-wizard"
      className="mx-auto max-w-2xl space-y-6 py-4"
    >
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Onboard new tenant
        </h1>
        <p className="text-sm text-slate-600">
          3-step MVP wizard. Creates the tenant, its first branch, and the
          super-admin user atomically. HFR / HPR / WhatsApp / Razorpay
          steps land in piece 2b.
        </p>
      </header>

      {/* Step indicator */}
      <ol
        className="flex items-center gap-2 text-xs"
        data-testid="onboarding-step-indicator"
        aria-label="Onboarding progress"
      >
        {([1, 2, 3] as const).map((n) => (
          <li
            key={n}
            data-testid={`onboarding-step-indicator-${n}`}
            className={`flex flex-1 items-center gap-2 rounded-md px-3 py-2 ${
              step === n
                ? "bg-slate-900 text-white"
                : step > n
                  ? "bg-emerald-100 text-emerald-900"
                  : "bg-slate-100 text-slate-500"
            }`}
            aria-current={step === n ? "step" : undefined}
          >
            <span className="font-semibold">{n}.</span>
            <span>
              {n === 1 ? "Tenant" : n === 2 ? "First branch" : "Super-admin"}
            </span>
          </li>
        ))}
      </ol>

      {errorBanner && (
        <div
          data-testid="onboarding-error-banner"
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          {errorBanner}
        </div>
      )}

      {step === 1 && (
        <fieldset
          data-testid="onboarding-step-1"
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-6"
        >
          <legend className="sr-only">Tenant basics</legend>
          <h2 className="text-lg font-semibold">Tenant basics</h2>

          <Field
            label="Hospital name"
            hint="Shown on invoices, prescriptions, notifications."
            error={
              serverFieldError?.field === "tenant.name"
                ? serverFieldError.message
                : null
            }
          >
            <input
              data-testid="onboarding-tenant-name"
              value={tenantStep.name}
              onChange={(e) =>
                setTenantStep({ ...tenantStep, name: e.target.value })
              }
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
              autoComplete="organization"
            />
          </Field>

          <Field
            label="Subdomain"
            hint="3-30 lowercase letters/digits/hyphens. Used for the tenant's URL."
            error={
              serverFieldError?.field === "tenant.subdomain"
                ? serverFieldError.message
                : tenantError && tenantStep.subdomain
                  ? tenantError
                  : null
            }
          >
            <input
              data-testid="onboarding-tenant-subdomain"
              value={tenantStep.subdomain}
              onChange={(e) =>
                setTenantStep({
                  ...tenantStep,
                  subdomain: e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, ""),
                })
              }
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-base focus:border-slate-500 focus:outline-none"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </Field>

          <Field label="Plan">
            <select
              data-testid="onboarding-tenant-plan"
              value={tenantStep.plan}
              onChange={(e) =>
                setTenantStep({ ...tenantStep, plan: e.target.value as Plan })
              }
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
            >
              <option value="BASIC">BASIC</option>
              <option value="PRO">PRO</option>
              <option value="ENTERPRISE">ENTERPRISE</option>
            </select>
          </Field>
        </fieldset>
      )}

      {step === 2 && (
        <fieldset
          data-testid="onboarding-step-2"
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-6"
        >
          <legend className="sr-only">First branch</legend>
          <h2 className="text-lg font-semibold">First branch</h2>
          <p className="text-xs text-slate-500">
            Becomes the default branch. The operator can add more from
            /dashboard later.
          </p>

          <Field label="Branch name">
            <input
              data-testid="onboarding-branch-name"
              value={branchStep.name}
              onChange={(e) =>
                setBranchStep({ ...branchStep, name: e.target.value })
              }
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
            />
          </Field>

          <Field
            label="Branch code (optional)"
            hint="Short uppercase identifier — e.g. MAIN, JKR, BTM."
            error={branchError && branchStep.code ? branchError : null}
          >
            <input
              data-testid="onboarding-branch-code"
              value={branchStep.code}
              onChange={(e) =>
                setBranchStep({
                  ...branchStep,
                  code: e.target.value.toUpperCase(),
                })
              }
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-base focus:border-slate-500 focus:outline-none"
              autoCapitalize="characters"
            />
          </Field>

          <Field label="Address">
            <textarea
              data-testid="onboarding-branch-address"
              value={branchStep.address}
              onChange={(e) =>
                setBranchStep({ ...branchStep, address: e.target.value })
              }
              rows={2}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="City">
              <input
                data-testid="onboarding-branch-city"
                value={branchStep.city}
                onChange={(e) =>
                  setBranchStep({ ...branchStep, city: e.target.value })
                }
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
              />
            </Field>
            <Field label="State">
              <input
                data-testid="onboarding-branch-state"
                value={branchStep.state}
                onChange={(e) =>
                  setBranchStep({ ...branchStep, state: e.target.value })
                }
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Pincode"
              error={branchError && branchStep.pincode ? branchError : null}
            >
              <input
                data-testid="onboarding-branch-pincode"
                value={branchStep.pincode}
                onChange={(e) =>
                  setBranchStep({
                    ...branchStep,
                    pincode: e.target.value.replace(/[^0-9]/g, ""),
                  })
                }
                inputMode="numeric"
                maxLength={6}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
              />
            </Field>
            <Field
              label="Phone"
              error={branchError && branchStep.phone ? branchError : null}
            >
              <input
                data-testid="onboarding-branch-phone"
                value={branchStep.phone}
                onChange={(e) =>
                  setBranchStep({ ...branchStep, phone: e.target.value })
                }
                inputMode="tel"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
              />
            </Field>
          </div>
        </fieldset>
      )}

      {step === 3 && (
        <fieldset
          data-testid="onboarding-step-3"
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-6"
        >
          <legend className="sr-only">Super-admin user</legend>
          <h2 className="text-lg font-semibold">Super-admin user</h2>
          <p className="text-xs text-slate-500">
            This user gets Role.ADMIN on the new tenant and can run the
            in-band /dashboard surface. They should change the password on
            first login.
          </p>

          <Field label="Full name">
            <input
              data-testid="onboarding-admin-name"
              value={adminStep.name}
              onChange={(e) =>
                setAdminStep({ ...adminStep, name: e.target.value })
              }
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
              autoComplete="name"
            />
          </Field>

          <Field
            label="Email"
            error={
              serverFieldError?.field === "admin.email"
                ? serverFieldError.message
                : null
            }
          >
            <input
              data-testid="onboarding-admin-email"
              type="email"
              value={adminStep.email}
              onChange={(e) =>
                setAdminStep({ ...adminStep, email: e.target.value })
              }
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
              autoComplete="email"
            />
          </Field>

          <Field label="Phone" error={adminError && adminStep.phone ? adminError : null}>
            <input
              data-testid="onboarding-admin-phone"
              type="tel"
              value={adminStep.phone}
              onChange={(e) =>
                setAdminStep({ ...adminStep, phone: e.target.value })
              }
              inputMode="tel"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
              autoComplete="tel"
            />
          </Field>

          <Field
            label="Temporary password"
            hint="Minimum 8 characters. Admin should change on first login."
            error={
              adminError && adminStep.password && adminStep.password.length < 8
                ? "Password must be at least 8 characters"
                : null
            }
          >
            <input
              data-testid="onboarding-admin-password"
              type="password"
              value={adminStep.password}
              onChange={(e) =>
                setAdminStep({ ...adminStep, password: e.target.value })
              }
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
              autoComplete="new-password"
            />
          </Field>
        </fieldset>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          data-testid="onboarding-back"
          onClick={goBack}
          disabled={step === 1 || submitting}
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Back
        </button>
        {step < 3 ? (
          <button
            type="button"
            data-testid="onboarding-next"
            onClick={goNext}
            disabled={submitting}
            className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next <ArrowRight size={14} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            data-testid="onboarding-submit"
            onClick={submit}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Creating tenant…
              </>
            ) : (
              <>Create tenant</>
            )}
          </button>
        )}
      </div>
    </section>
  );
}

// ─── Tiny shared field renderer (kept local to dodge a dependency on
// the dashboard's Field component, which expects the i18n hook). ────
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {children}
      {error ? (
        <span className="block text-[11px] text-rose-600" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="block text-[11px] text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}
