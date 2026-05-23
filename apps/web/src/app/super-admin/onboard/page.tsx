// Super-admin onboarding wizard — Pearl ERP Stage 1 §8.1 (gap #6).
//
// 6-step wizard. Steps:
//   1. Tenant basics (name, subdomain, plan)
//   2. First branch (name, code, address, city, state, pincode, phone)
//   3. Super-admin user (name, email, phone, password)
//      → submits the atomic POST /api/v1/tenant-onboarding which
//      provisions Tenant + Branch + Admin in one $transaction.
//   4. WhatsApp Business API (Gupshup) — piece 2b. Optional, deferred.
//      The super-admin caller's session has tenantId=null, so it
//      cannot write to PUT /api/v1/wa/config (which requires
//      req.user.tenantId). Scope-cut: collect the Gupshup fields in
//      sessionStorage as a hint for the new tenant's first ADMIN
//      login, plus a clear CTA linking to /dashboard/settings/whatsapp
//      for the just-created tenant.
//   5. HFR (Healthcare Facility Registry — ABDM M2) — piece 2b step 5.
//      Same shape as step 4: optional, super-admin caller cannot PUT
//      to /api/v1/abdm/* config (tenantId=null), so collect the HFR
//      fields in sessionStorage keyed by tenant id; the first ADMIN
//      finalizes at /dashboard/settings/abdm on first login.
//   6. HPR (Health Professional Registry — ABDM M3) — piece 2b step 6.
//      Same scope-cut as steps 4/5: collect the primary doctor's HPR
//      identity fields (HPR ID + name + specialty + council reg) in
//      sessionStorage keyed by tenant id; per-doctor HPR linking via
//      the existing ABDM M1 flow is finalized by the new tenant's
//      first ADMIN at /dashboard/settings/abdm on first login.
//
// The full PRD calls for 8 steps; Razorpay / post-creation remain
// deferred to subsequent piece 2b ticks — each needs an external
// integration the wizard would validate against.
//
// Auth: relies on the super-admin layout's client-side gate. No
// additional check needed here.
//
// Test ids: onboarding-step-{1,2,3,4,5,6}, onboarding-back, onboarding-next,
// onboarding-submit, onboarding-error-banner, onboarding-wa-skip,
// onboarding-wa-save, onboarding-wa-cta, onboarding-hfr-skip,
// onboarding-hfr-save, onboarding-hfr-cta, onboarding-hpr-skip,
// onboarding-hpr-save, onboarding-hpr-cta, plus per-field
// onboarding-tenant-name / onboarding-branch-name / onboarding-admin-*
// / onboarding-wa-* / onboarding-hfr-* / onboarding-hpr-* for the smoke
// component test.

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

type Plan = "BASIC" | "PRO" | "ENTERPRISE";
type Step = 1 | 2 | 3 | 4 | 5 | 6;
type FacilityType =
  | "HOSPITAL"
  | "CLINIC"
  | "DIAGNOSTIC_CENTER"
  | "PHARMACY"
  | "OTHER";
type Specialty =
  | "GENERAL_PRACTICE"
  | "CARDIOLOGY"
  | "DERMATOLOGY"
  | "PEDIATRICS"
  | "ORTHOPEDICS"
  | "GYNECOLOGY"
  | "ENT"
  | "OTHER";

// Indian states + UTs (36). Inlined to keep the wizard free of any
// shared-dep churn — the canonical list is small and stable. If a
// reusable IndianStates component lands later, swap this for it.
const INDIAN_STATES = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Jammu and Kashmir",
  "Ladakh",
  "Lakshadweep",
  "Puducherry",
] as const;

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
interface WhatsAppStepState {
  apiKey: string;
  appName: string;
  sourcePhone: string;
  defaultProductId: string;
  autoReply: boolean;
}
interface HFRStepState {
  facilityName: string;
  hfrId: string;
  facilityType: FacilityType;
  state: string;
  district: string;
}
interface HPRStepState {
  hprId: string;
  doctorName: string;
  specialty: Specialty;
  councilRegNo: string;
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
const E164_REGEX = /^\+\d{7,15}$/;
// HFR IDs as issued by facility.abdm.gov.in are numeric, typically
// 10-12 digits. Accept a slightly wider numeric range to avoid
// rejecting future-format ids; the upstream registry is the source of
// truth — the wizard just stashes a draft.
const HFR_ID_REGEX = /^\d{8,14}$/;
// HPR IDs as issued by doctor.abdm.gov.in are numeric, typically 10-12
// digits. Mirror the HFR rule (8-14 numeric) for the same future-proof
// reason — upstream registry is the source of truth.
const HPR_ID_REGEX = /^\d{8,14}$/;

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

// Validate WhatsApp step only if the operator opted to save (not skip).
// All three Gupshup fields are required together — the server-side
// discriminated union in whatsapp-config.ts insists on it.
function validateWhatsAppStep(s: WhatsAppStepState): string | null {
  if (s.apiKey.trim().length < 1) return "Gupshup API key is required";
  if (s.appName.trim().length < 1) return "Gupshup app name is required";
  if (!E164_REGEX.test(s.sourcePhone.trim()))
    return "Source phone must be E.164 (e.g. +919876543210)";
  return null;
}

// Validate HFR step only if the operator opted to save (not skip).
// Facility name + HFR ID + facility type + state are required together;
// district is encouraged but not load-bearing.
function validateHFRStep(s: HFRStepState): string | null {
  if (s.facilityName.trim().length < 2)
    return "Facility name must be at least 2 characters";
  if (!HFR_ID_REGEX.test(s.hfrId.trim()))
    return "HFR ID must be 10-12 digits (from facility.abdm.gov.in)";
  if (s.state.trim().length < 1) return "State is required";
  return null;
}

// Validate HPR step only if the operator opted to save (not skip).
// HPR ID + doctor name + specialty + council reg are required together;
// the wizard captures only the *primary* doctor's identity — per-doctor
// HPR linking happens later via the existing ABDM M1 flow at
// /dashboard/settings/abdm.
function validateHPRStep(s: HPRStepState): string | null {
  if (!HPR_ID_REGEX.test(s.hprId.trim()))
    return "HPR ID must be 10-12 digits (from doctor.abdm.gov.in)";
  if (s.doctorName.trim().length < 2)
    return "Doctor name must be at least 2 characters";
  if (s.councilRegNo.trim().length < 2)
    return "Council registration number is required";
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

  // Captures the newly-created tenant after step-3 submit so step 4
  // (WhatsApp) and the success card can link into it.
  const [createdTenant, setCreatedTenant] = useState<{
    id: string;
    name: string;
    subdomain: string;
  } | null>(null);
  const [waSaved, setWaSaved] = useState(false);
  const [hfrSaved, setHfrSaved] = useState(false);
  const [hprSaved, setHprSaved] = useState(false);

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
  const [waStep, setWaStep] = useState<WhatsAppStepState>({
    apiKey: "",
    appName: "",
    sourcePhone: "",
    defaultProductId: "",
    autoReply: true,
  });
  const [hfrStep, setHfrStep] = useState<HFRStepState>({
    facilityName: "",
    hfrId: "",
    facilityType: "HOSPITAL",
    state: "",
    district: "",
  });
  const [hprStep, setHprStep] = useState<HPRStepState>({
    hprId: "",
    doctorName: "",
    specialty: "GENERAL_PRACTICE",
    councilRegNo: "",
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
    // Don't allow stepping back from 4 / 5 / 6 since the tenant has
    // already been created at that point. The operator dismisses
    // post-create steps via their respective "Skip for now" / "Save"
    // buttons.
    if (step > 1 && step < 4) setStep((step - 1) as Step);
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
        data: {
          tenant: { id: string; name: string; subdomain: string };
        } | null;
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

      // Tenant is created. Advance to step 4 (WhatsApp config) so the
      // operator can either skip or stash the Gupshup creds for the
      // new tenant's first login.
      if (json.data?.tenant) {
        setCreatedTenant({
          id: json.data.tenant.id,
          name: json.data.tenant.name,
          subdomain: json.data.tenant.subdomain,
        });
      }
      setStep(4);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBanner(`Network error: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  // Step 4 — WhatsApp. The super-admin caller cannot write to
  // /api/v1/wa/config directly (the route requires req.user.tenantId,
  // which is null for the tenant-less super-admin). Scope-cut for
  // piece 2b first wizard step: stash the Gupshup fields in
  // sessionStorage keyed by tenant id, mark the wizard step "saved",
  // and surface a deferred-config CTA so the new tenant's first ADMIN
  // can paste the creds into /dashboard/settings/whatsapp on first
  // login. A future piece 2b tick will swap this for a direct PUT
  // once the wizard has a way to mint a session as the new admin
  // (mint-and-redirect, or token-issued-by-tenant-onboarding response).
  function saveWhatsApp() {
    setErrorBanner(null);
    const e = validateWhatsAppStep(waStep);
    if (e) {
      setErrorBanner(e);
      return;
    }
    if (!createdTenant) {
      setErrorBanner("Tenant context missing — please retry from step 1");
      return;
    }
    try {
      const draft = {
        credentials: {
          provider: "GUPSHUP" as const,
          apiKey: waStep.apiKey.trim(),
          appName: waStep.appName.trim(),
          sourcePhone: waStep.sourcePhone.trim(),
        },
        defaultProductId: waStep.defaultProductId.trim() || null,
        autoReply: waStep.autoReply,
      };
      sessionStorage.setItem(
        `medcore_wa_draft:${createdTenant.id}`,
        JSON.stringify(draft),
      );
    } catch {
      // SessionStorage can throw in some private-browse modes.
      // Continue anyway — the CTA still points the operator at the
      // settings page; the draft hint is best-effort.
    }
    setWaSaved(true);
  }

  function skipWhatsApp() {
    // Advance to step 5 (HFR) — the wizard now has an additional
    // optional post-create step. Both WhatsApp and HFR write
    // sessionStorage drafts; the new tenant's first ADMIN finalizes
    // each at /dashboard/settings/{whatsapp,abdm} on first login.
    setErrorBanner(null);
    setStep(5);
  }

  function finishAfterWaSave() {
    setErrorBanner(null);
    setStep(5);
  }

  // Step 5 — HFR (Healthcare Facility Registry, ABDM M2). Mirrors the
  // WhatsApp step's "stash a draft, ADMIN finalizes on first login"
  // shape because the super-admin caller has tenantId=null and cannot
  // write to per-tenant ABDM config rows. Draft is keyed by tenant id
  // exactly like the WhatsApp draft (same medcore_<area>_draft:<id>
  // convention). A future piece 2b tick will swap this for a direct
  // PUT once the wizard mints a session as the new admin.
  function saveHFR() {
    setErrorBanner(null);
    const e = validateHFRStep(hfrStep);
    if (e) {
      setErrorBanner(e);
      return;
    }
    if (!createdTenant) {
      setErrorBanner("Tenant context missing — please retry from step 1");
      return;
    }
    try {
      const draft = {
        facilityName: hfrStep.facilityName.trim(),
        hfrId: hfrStep.hfrId.trim(),
        facilityType: hfrStep.facilityType,
        state: hfrStep.state.trim(),
        district: hfrStep.district.trim() || null,
      };
      sessionStorage.setItem(
        `medcore_hfr_draft:${createdTenant.id}`,
        JSON.stringify(draft),
      );
    } catch {
      // SessionStorage can throw in some private-browse modes.
      // Continue anyway — the CTA still points the operator at the
      // settings page; the draft hint is best-effort.
    }
    setHfrSaved(true);
  }

  function skipHFR() {
    // Advance to step 6 (HPR) — wizard now has a further optional
    // post-create step for the Health Professional Registry. The
    // wizard only completes after the HPR step's skip / finish.
    setErrorBanner(null);
    prefillHprDoctorName();
    setStep(6);
  }

  function finishAfterHfrSave() {
    setErrorBanner(null);
    prefillHprDoctorName();
    setStep(6);
  }

  // Prefill the HPR step's doctor-name field from the step-3 super-
  // admin name, but only if the user hasn't already typed something.
  // Called on transition into step 6 from either the HFR skip or the
  // HFR finish path.
  function prefillHprDoctorName() {
    if (!hprStep.doctorName && adminStep.name.trim().length > 0) {
      setHprStep((prev) => ({ ...prev, doctorName: adminStep.name.trim() }));
    }
  }

  // Step 6 — HPR (Health Professional Registry, ABDM M3). Mirrors the
  // HFR step's "stash a draft, ADMIN finalizes on first login" shape
  // because the super-admin caller has tenantId=null and cannot write
  // to per-tenant ABDM config rows. Draft is keyed by tenant id
  // exactly like the WhatsApp + HFR drafts (same
  // medcore_<area>_draft:<id> convention). Per-doctor HPR linking
  // continues to flow through the existing ABDM M1 surface at
  // /dashboard/settings/abdm; this step just captures the *primary*
  // doctor's HPR identity as a deferred-config hint.
  function saveHPR() {
    setErrorBanner(null);
    const e = validateHPRStep(hprStep);
    if (e) {
      setErrorBanner(e);
      return;
    }
    if (!createdTenant) {
      setErrorBanner("Tenant context missing — please retry from step 1");
      return;
    }
    try {
      const draft = {
        hprId: hprStep.hprId.trim(),
        doctorName: hprStep.doctorName.trim(),
        specialty: hprStep.specialty,
        councilRegNo: hprStep.councilRegNo.trim(),
      };
      sessionStorage.setItem(
        `medcore_hpr_draft:${createdTenant.id}`,
        JSON.stringify(draft),
      );
    } catch {
      // SessionStorage can throw in some private-browse modes.
      // Continue anyway — the CTA still points the operator at the
      // settings page; the draft hint is best-effort.
    }
    setHprSaved(true);
  }

  function skipHPR() {
    setSuccess(true);
    setTimeout(() => {
      router.push("/super-admin");
    }, 1200);
  }

  function finishAfterHprSave() {
    setSuccess(true);
    setTimeout(() => {
      router.push("/super-admin");
    }, 1200);
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
          6-step wizard. Steps 1-3 create the tenant, its first branch, and
          the super-admin user atomically. Steps 4 (WhatsApp), 5 (HFR), and
          6 (HPR) are optional — Razorpay / post-creation steps land in
          subsequent piece 2b ticks.
        </p>
      </header>

      {/* Step indicator */}
      <ol
        className="flex items-center gap-2 text-xs"
        data-testid="onboarding-step-indicator"
        aria-label="Onboarding progress"
      >
        {([1, 2, 3, 4, 5, 6] as const).map((n) => (
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
              {n === 1
                ? "Tenant"
                : n === 2
                  ? "First branch"
                  : n === 3
                    ? "Super-admin"
                    : n === 4
                      ? "WhatsApp"
                      : n === 5
                        ? "HFR"
                        : "HPR"}
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

      {step === 4 && (
        <fieldset
          data-testid="onboarding-step-4"
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-6"
        >
          <legend className="sr-only">WhatsApp Business API</legend>
          <h2 className="text-lg font-semibold">
            WhatsApp Business API (Gupshup)
          </h2>
          <p className="text-xs text-slate-500">
            Optional — can be configured later from Settings → WhatsApp.
            The new tenant&apos;s ADMIN can finish this step from
            /dashboard/settings/whatsapp on first login.
          </p>

          {waSaved && createdTenant ? (
            <div
              data-testid="onboarding-wa-saved-banner"
              className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
              role="status"
            >
              <p className="font-medium">
                WhatsApp draft saved for {createdTenant.name}
                {waStep.sourcePhone
                  ? ` (Gupshup, ${waStep.sourcePhone.trim()})`
                  : ""}
                .
              </p>
              <p className="mt-1 text-xs">
                The new tenant&apos;s ADMIN will be prompted to finalize the
                configuration on first login at{" "}
                <a
                  data-testid="onboarding-wa-cta"
                  href="/dashboard/settings/whatsapp"
                  className="font-medium underline"
                >
                  /dashboard/settings/whatsapp
                </a>
                .
              </p>
            </div>
          ) : (
            <>
              <Field
                label="Gupshup API key"
                hint="From the Gupshup partner dashboard."
              >
                <input
                  data-testid="onboarding-wa-apikey"
                  type="password"
                  value={waStep.apiKey}
                  onChange={(e) =>
                    setWaStep({ ...waStep, apiKey: e.target.value })
                  }
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
                  autoComplete="off"
                />
              </Field>

              <Field
                label="Gupshup app name"
                hint="The named app inside your Gupshup account."
              >
                <input
                  data-testid="onboarding-wa-appname"
                  value={waStep.appName}
                  onChange={(e) =>
                    setWaStep({ ...waStep, appName: e.target.value })
                  }
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
                />
              </Field>

              <Field
                label="Source phone (E.164)"
                hint="The WhatsApp number messages send from — e.g. +919876543210."
              >
                <input
                  data-testid="onboarding-wa-sourcephone"
                  value={waStep.sourcePhone}
                  onChange={(e) =>
                    setWaStep({ ...waStep, sourcePhone: e.target.value })
                  }
                  inputMode="tel"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-base focus:border-slate-500 focus:outline-none"
                  autoComplete="off"
                />
              </Field>

              <Field
                label="Default product id (optional)"
                hint="Used to scope outbound campaign routing — leave blank if unsure."
              >
                <input
                  data-testid="onboarding-wa-productid"
                  value={waStep.defaultProductId}
                  onChange={(e) =>
                    setWaStep({ ...waStep, defaultProductId: e.target.value })
                  }
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
                  autoComplete="off"
                />
              </Field>

              <label className="flex items-center gap-2 text-sm">
                <input
                  data-testid="onboarding-wa-autoreply"
                  type="checkbox"
                  checked={waStep.autoReply}
                  onChange={(e) =>
                    setWaStep({ ...waStep, autoReply: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>Enable auto-reply for inbound messages</span>
              </label>
            </>
          )}
        </fieldset>
      )}

      {step === 5 && (
        <fieldset
          data-testid="onboarding-step-5"
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-6"
        >
          <legend className="sr-only">HFR (Healthcare Facility Registry)</legend>
          <h2 className="text-lg font-semibold">
            HFR (Healthcare Facility Registry)
          </h2>
          <p className="text-xs text-slate-500">
            Optional — ABDM M2 facility registration. Can be configured later
            from Settings &rarr; ABDM. The new tenant&apos;s ADMIN will
            finalize this step from /dashboard/settings/abdm on first login.
          </p>

          {hfrSaved && createdTenant ? (
            <div
              data-testid="onboarding-hfr-saved-banner"
              className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
              role="status"
            >
              <p className="font-medium">
                HFR draft saved for {createdTenant.name}
                {hfrStep.hfrId
                  ? ` (HFR ID ${hfrStep.hfrId.trim()})`
                  : ""}
                .
              </p>
              <p className="mt-1 text-xs">
                After tenant onboarding, the first ADMIN will finalize ABDM
                HFR registration at{" "}
                <a
                  data-testid="onboarding-hfr-cta"
                  href="/dashboard/settings/abdm"
                  className="font-medium underline"
                >
                  /dashboard/settings/abdm
                </a>
                .
              </p>
            </div>
          ) : (
            <>
              <Field
                label="Facility name"
                hint="The facility name as registered (or to be registered) with ABDM."
              >
                <input
                  data-testid="onboarding-hfr-facilityname"
                  value={hfrStep.facilityName}
                  onChange={(e) =>
                    setHfrStep({ ...hfrStep, facilityName: e.target.value })
                  }
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
                  autoComplete="organization"
                />
              </Field>

              <Field
                label="HFR ID"
                hint="10-12 digit ID from facility.abdm.gov.in."
              >
                <input
                  data-testid="onboarding-hfr-id"
                  value={hfrStep.hfrId}
                  onChange={(e) =>
                    setHfrStep({
                      ...hfrStep,
                      hfrId: e.target.value.replace(/[^0-9]/g, ""),
                    })
                  }
                  inputMode="numeric"
                  maxLength={14}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-base focus:border-slate-500 focus:outline-none"
                  autoComplete="off"
                />
              </Field>

              <Field label="Facility type">
                <select
                  data-testid="onboarding-hfr-facilitytype"
                  value={hfrStep.facilityType}
                  onChange={(e) =>
                    setHfrStep({
                      ...hfrStep,
                      facilityType: e.target.value as FacilityType,
                    })
                  }
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
                >
                  <option value="HOSPITAL">HOSPITAL</option>
                  <option value="CLINIC">CLINIC</option>
                  <option value="DIAGNOSTIC_CENTER">DIAGNOSTIC_CENTER</option>
                  <option value="PHARMACY">PHARMACY</option>
                  <option value="OTHER">OTHER</option>
                </select>
              </Field>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="State">
                  <select
                    data-testid="onboarding-hfr-state"
                    value={hfrStep.state}
                    onChange={(e) =>
                      setHfrStep({ ...hfrStep, state: e.target.value })
                    }
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
                  >
                    <option value="">Select state…</option>
                    {INDIAN_STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="District">
                  <input
                    data-testid="onboarding-hfr-district"
                    value={hfrStep.district}
                    onChange={(e) =>
                      setHfrStep({ ...hfrStep, district: e.target.value })
                    }
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
                    autoComplete="off"
                  />
                </Field>
              </div>
            </>
          )}
        </fieldset>
      )}

      {step === 6 && (
        <fieldset
          data-testid="onboarding-step-6"
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-6"
        >
          <legend className="sr-only">HPR (Health Professional Registry)</legend>
          <h2 className="text-lg font-semibold">
            HPR (Health Professional Registry)
          </h2>
          <p className="text-xs text-slate-500">
            Optional — ABDM M3 captures the primary doctor&apos;s HPR
            identity. Can be configured later from Settings &rarr; ABDM. The
            new tenant&apos;s ADMIN will finalize per-doctor HPR linking on
            first login.
          </p>

          {hprSaved && createdTenant ? (
            <div
              data-testid="onboarding-hpr-saved-banner"
              className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
              role="status"
            >
              <p className="font-medium">
                HPR draft saved for {createdTenant.name}
                {hprStep.hprId
                  ? ` (HPR ID ${hprStep.hprId.trim()})`
                  : ""}
                .
              </p>
              <p className="mt-1 text-xs">
                After tenant onboarding, the first ADMIN will finalize
                per-doctor HPR linking at{" "}
                <a
                  data-testid="onboarding-hpr-cta"
                  href="/dashboard/settings/abdm"
                  className="font-medium underline"
                >
                  /dashboard/settings/abdm
                </a>
                .
              </p>
            </div>
          ) : (
            <>
              <Field
                label="Primary Doctor's HPR ID"
                hint="10-12 digit ID from doctor.abdm.gov.in."
              >
                <input
                  data-testid="onboarding-hpr-id"
                  value={hprStep.hprId}
                  onChange={(e) =>
                    setHprStep({
                      ...hprStep,
                      hprId: e.target.value.replace(/[^0-9]/g, ""),
                    })
                  }
                  inputMode="numeric"
                  maxLength={14}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-base focus:border-slate-500 focus:outline-none"
                  autoComplete="off"
                />
              </Field>

              <Field
                label="Primary Doctor's Name"
                hint="Defaults to the step-3 super-admin name; override if a different doctor is the HPR holder."
              >
                <input
                  data-testid="onboarding-hpr-doctorname"
                  value={hprStep.doctorName}
                  onChange={(e) =>
                    setHprStep({ ...hprStep, doctorName: e.target.value })
                  }
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
                  autoComplete="name"
                />
              </Field>

              <Field label="Specialty">
                <select
                  data-testid="onboarding-hpr-specialty"
                  value={hprStep.specialty}
                  onChange={(e) =>
                    setHprStep({
                      ...hprStep,
                      specialty: e.target.value as Specialty,
                    })
                  }
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
                >
                  <option value="GENERAL_PRACTICE">GENERAL_PRACTICE</option>
                  <option value="CARDIOLOGY">CARDIOLOGY</option>
                  <option value="DERMATOLOGY">DERMATOLOGY</option>
                  <option value="PEDIATRICS">PEDIATRICS</option>
                  <option value="ORTHOPEDICS">ORTHOPEDICS</option>
                  <option value="GYNECOLOGY">GYNECOLOGY</option>
                  <option value="ENT">ENT</option>
                  <option value="OTHER">OTHER</option>
                </select>
              </Field>

              <Field
                label="Council Registration No."
                hint='State medical council registration — e.g. "MMC-12345" for Maharashtra Medical Council.'
              >
                <input
                  data-testid="onboarding-hpr-councilreg"
                  value={hprStep.councilRegNo}
                  onChange={(e) =>
                    setHprStep({ ...hprStep, councilRegNo: e.target.value })
                  }
                  className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-base focus:border-slate-500 focus:outline-none"
                  autoComplete="off"
                />
              </Field>
            </>
          )}
        </fieldset>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          data-testid="onboarding-back"
          onClick={goBack}
          disabled={
            step === 1 ||
            step === 4 ||
            step === 5 ||
            step === 6 ||
            submitting
          }
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          style={{ minHeight: 44 }}
        >
          <ArrowLeft size={14} aria-hidden="true" /> Back
        </button>
        {step < 3 && (
          <button
            type="button"
            data-testid="onboarding-next"
            onClick={goNext}
            disabled={submitting}
            className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ minHeight: 44 }}
          >
            Next <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
        {step === 3 && (
          <button
            type="button"
            data-testid="onboarding-submit"
            onClick={submit}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ minHeight: 44 }}
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
        {step === 4 && !waSaved && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="onboarding-wa-skip"
              onClick={skipWhatsApp}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              style={{ minHeight: 44 }}
            >
              Skip for now
            </button>
            <button
              type="button"
              data-testid="onboarding-wa-save"
              onClick={saveWhatsApp}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
              style={{ minHeight: 44 }}
            >
              Configure WhatsApp
            </button>
          </div>
        )}
        {step === 4 && waSaved && (
          <button
            type="button"
            data-testid="onboarding-wa-finish"
            onClick={finishAfterWaSave}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            style={{ minHeight: 44 }}
          >
            Continue
          </button>
        )}
        {step === 5 && !hfrSaved && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="onboarding-hfr-skip"
              onClick={skipHFR}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              style={{ minHeight: 44 }}
            >
              Skip for now
            </button>
            <button
              type="button"
              data-testid="onboarding-hfr-save"
              onClick={saveHFR}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
              style={{ minHeight: 44 }}
            >
              Configure HFR
            </button>
          </div>
        )}
        {step === 5 && hfrSaved && (
          <button
            type="button"
            data-testid="onboarding-hfr-finish"
            onClick={finishAfterHfrSave}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            style={{ minHeight: 44 }}
          >
            Continue
          </button>
        )}
        {step === 6 && !hprSaved && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="onboarding-hpr-skip"
              onClick={skipHPR}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              style={{ minHeight: 44 }}
            >
              Skip for now
            </button>
            <button
              type="button"
              data-testid="onboarding-hpr-save"
              onClick={saveHPR}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
              style={{ minHeight: 44 }}
            >
              Configure HPR
            </button>
          </div>
        )}
        {step === 6 && hprSaved && (
          <button
            type="button"
            data-testid="onboarding-hpr-finish"
            onClick={finishAfterHprSave}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            style={{ minHeight: 44 }}
          >
            Finish
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
