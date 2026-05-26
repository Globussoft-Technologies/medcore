"use client";

// Patient self-register UI (Pearl §6.3 — closes audit over-claim #2,
// PEARL_STAGE1_VERIFICATION_AUDIT_2026-05-25 row 32).
//
// Closes the PRD §6.3 hard acceptance bullet "new patient self-registers +
// books first appointment in <90s" by giving brand-new patients a
// mobile-first signup surface that drives the existing
// POST /api/v1/auth/register endpoint. On success the API sets the
// httpOnly auth cookies in the same response, so we redirect straight to
// /patient/dashboard — no second call required.
//
// Two-step UX (mobile-first, keeps each viewport short on a phone screen):
//   Step 1 ("basics")     — name + phone + email + password (+ confirm).
//   Step 2 ("details")    — DOB + gender + address + emergency contact
//                           triplet + T&C consent → POST /auth/register.
//
// Scope-cut: this is NOT an OTP-first registration flow. The existing
// patient-OTP endpoints (/patient-auth/otp-request, /otp-verify) are the
// LOGIN surface — they require an existing User row to mint a challenge
// against, and /otp-request returns 200 even for unknown phones (anti-
// enumeration). There is no separate "create-user-from-OTP" endpoint
// today. Building one is an API change outside this tick's allowlist
// (other agents may also be touching routes). The current /auth/register
// endpoint sets cookies on the 201 response, which is equivalent for the
// "<90s register + book first appt" acceptance bullet — the patient lands
// at /patient/dashboard authenticated and can immediately tap "Book an
// appointment".
//
// Touch targets: every interactive control is h-11 (44px) per Pearl §6.2.
// Errors render inline near `data-testid="patient-register-error"` so a
// future e2e can assert on a specific element rather than a toast.
//
// Mirrors apps/web/src/app/patient/login/page.tsx for visual + a11y style
// (the patient PWA route group's bare chrome — no LanguageDropdown, no
// BranchPicker).

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";

type Step = "basics" | "details";

interface RegisterResponse {
  success: boolean;
  data?: {
    user?: { id: string; name: string; role: string };
    tokens?: { accessToken?: string };
    message?: string;
  } | null;
  error?: string | null;
}

// Mirror of the strict server-side rules (apps/api/src/routes/auth.ts
// strictRegisterSchema) — kept client-side so the patient sees a fast
// inline error before round-tripping.
const STRICT_EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE_REGEX = /^[+]?[\d\s-]{10,15}$/;
// PATIENT_NAME_REGEX — Latin + Devanagari + spaces + . - ' (per CLAUDE.md
// gotcha #8). Digits, parens, semicolons, etc. are rejected by the server,
// so we surface that as an inline error too.
const PATIENT_NAME_REGEX = /^[A-Za-zऀ-ॿ\s.\-']{1,100}$/;

export default function PatientRegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("basics");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    password: "",
    confirmPassword: "",
    dateOfBirth: "",
    gender: "",
    address: "",
    emergencyContactName: "",
    emergencyContactPhone: "",
    emergencyContactRelationship: "",
  });
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  function update(field: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function validateBasics(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Name is required";
    else if (!PATIENT_NAME_REGEX.test(form.name.trim()))
      errs.name =
        "Name contains invalid characters — letters, spaces, '.', '-' and \"'\" only";
    if (!form.phone.trim()) errs.phone = "Phone number is required";
    else if (!PHONE_REGEX.test(form.phone.trim()))
      errs.phone = "Phone must be 10–15 digits, optional leading +";
    if (!form.email.trim()) errs.email = "Email is required";
    else if (!STRICT_EMAIL_REGEX.test(form.email.trim()))
      errs.email = "Enter a valid email address";
    if (!form.password) errs.password = "Password is required";
    else if (form.password.length < 12)
      errs.password = "Password must be at least 12 characters";
    else if (!/[A-Za-z]/.test(form.password))
      errs.password = "Password must contain at least one letter";
    else if (!/\d/.test(form.password))
      errs.password = "Password must contain at least one digit";
    if (!form.confirmPassword)
      errs.confirmPassword = "Please confirm your password";
    else if (form.confirmPassword !== form.password)
      errs.confirmPassword = "Passwords do not match";
    return errs;
  }

  function validateDetails(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!form.dateOfBirth) errs.dateOfBirth = "Date of birth is required";
    else {
      const dob = new Date(form.dateOfBirth);
      const now = new Date();
      const minDob = new Date();
      minDob.setFullYear(now.getFullYear() - 130);
      if (Number.isNaN(dob.getTime())) errs.dateOfBirth = "Enter a valid date";
      else if (dob > now)
        errs.dateOfBirth = "Date of birth cannot be in the future";
      else if (dob < minDob)
        errs.dateOfBirth = "Date of birth must be within the last 130 years";
    }
    if (!form.gender) errs.gender = "Please select a gender";
    if (!form.address.trim()) errs.address = "Address is required";
    else if (form.address.trim().length < 5)
      errs.address = "Address must be at least 5 characters";
    if (!form.emergencyContactName.trim())
      errs.emergencyContactName = "Emergency contact name is required";
    if (!form.emergencyContactPhone.trim())
      errs.emergencyContactPhone = "Emergency contact phone is required";
    else if (!PHONE_REGEX.test(form.emergencyContactPhone.trim()))
      errs.emergencyContactPhone =
        "Emergency contact phone must be 10–15 digits";
    if (!form.emergencyContactRelationship.trim())
      errs.emergencyContactRelationship =
        "Emergency contact relationship is required";
    if (!acceptedTerms)
      errs.acceptedTerms = "Please accept the Terms & Privacy Policy";
    return errs;
  }

  function nextStep(): void {
    setError(null);
    const errs = validateBasics();
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setStep("details");
  }

  async function submitRegister(): Promise<void> {
    if (busy) return;
    setError(null);
    const errs = validateDetails();
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      const res = await api.post<RegisterResponse>("/auth/register", {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        password: form.password,
        gender: form.gender,
        dateOfBirth: form.dateOfBirth,
        address: form.address.trim(),
        emergencyContact: {
          name: form.emergencyContactName.trim(),
          phone: form.emergencyContactPhone.trim(),
          relationship: form.emergencyContactRelationship.trim(),
        },
        acceptedTerms: true,
        role: "PATIENT",
      });
      if (res?.success) {
        // The server sets httpOnly auth cookies (medcore_at / medcore_rt /
        // medcore_csrf) on the 201 response so we're authenticated by the
        // time this resolves. Bounce to the dashboard.
        //
        // Anti-enumeration note (#480): the server returns 201 + success:true
        // for BOTH a brand-new account AND a duplicate-email submission, but
        // the duplicate path returns no token / no cookie — the /auth/me
        // probe on the landing page will then 401 and the dashboard will
        // bounce us to /patient/login. From the patient's perspective both
        // cases land them in the right place to recover.
        router.push("/patient/dashboard");
        return;
      }
      setError(res?.error || "Couldn't complete registration — please try again.");
    } catch (err) {
      // Bubble field-shaped 400s into inline errors when present.
      const details =
        err && typeof err === "object" && "details" in err
          ? (err as { details?: Array<{ field?: string; message?: string }> })
              .details
          : undefined;
      if (Array.isArray(details) && details.length > 0) {
        const inline: Record<string, string> = {};
        for (const d of details) {
          if (d.field && d.message) {
            // Map nested emergencyContact.<x> back to flat keys.
            const f = d.field
              .replace(/^emergencyContact\.name$/, "emergencyContactName")
              .replace(/^emergencyContact\.phone$/, "emergencyContactPhone")
              .replace(
                /^emergencyContact\.relationship$/,
                "emergencyContactRelationship",
              );
            inline[f] = d.message;
          }
        }
        setFieldErrors(inline);
        const firstInBasics = ["name", "phone", "email", "password"].find(
          (f) => f in inline,
        );
        if (firstInBasics) setStep("basics");
      }
      const msg =
        err instanceof Error ? err.message : "Couldn't complete registration";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-sm space-y-6 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
        <p className="text-sm text-slate-600">
          {step === "basics"
            ? "Step 1 of 2 — your contact details and a password."
            : "Step 2 of 2 — a few extras so we can serve you safely."}
        </p>
      </header>

      {step === "basics" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            nextStep();
          }}
          className="space-y-4"
        >
          <Field
            id="patient-register-name"
            testid="patient-register-name-input"
            label="Full name"
            value={form.name}
            onChange={(v) => update("name", v)}
            autoComplete="name"
            error={fieldErrors.name}
            disabled={busy}
            required
          />
          <Field
            id="patient-register-phone"
            testid="patient-register-phone-input"
            label="Phone number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+919876543210"
            value={form.phone}
            onChange={(v) => update("phone", v)}
            error={fieldErrors.phone}
            disabled={busy}
            required
          />
          <Field
            id="patient-register-email"
            testid="patient-register-email-input"
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={form.email}
            onChange={(v) => update("email", v)}
            error={fieldErrors.email}
            disabled={busy}
            required
          />
          <Field
            id="patient-register-password"
            testid="patient-register-password-input"
            label="Password"
            type="password"
            autoComplete="new-password"
            placeholder="12+ characters with a digit"
            value={form.password}
            onChange={(v) => update("password", v)}
            error={fieldErrors.password}
            disabled={busy}
            required
          />
          <Field
            id="patient-register-confirm-password"
            testid="patient-register-confirm-password-input"
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={(v) => update("confirmPassword", v)}
            error={fieldErrors.confirmPassword}
            disabled={busy}
            required
          />
          <button
            type="submit"
            data-testid="patient-register-next"
            disabled={busy}
            className="inline-flex h-11 w-full min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Continue
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitRegister();
          }}
          className="space-y-4"
        >
          <Field
            id="patient-register-dob"
            testid="patient-register-dob-input"
            label="Date of birth"
            type="date"
            autoComplete="bday"
            value={form.dateOfBirth}
            onChange={(v) => update("dateOfBirth", v)}
            error={fieldErrors.dateOfBirth}
            disabled={busy}
            required
          />
          <div className="space-y-1">
            <label
              htmlFor="patient-register-gender"
              className="block text-sm font-medium text-slate-800"
            >
              Gender
            </label>
            <select
              id="patient-register-gender"
              data-testid="patient-register-gender-input"
              className="block h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base"
              value={form.gender}
              onChange={(e) => update("gender", e.target.value)}
              disabled={busy}
              required
            >
              <option value="">Select…</option>
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
              <option value="OTHER">Other</option>
            </select>
            {fieldErrors.gender ? (
              <p
                data-testid="patient-register-field-error-gender"
                className="text-xs text-red-700"
              >
                {fieldErrors.gender}
              </p>
            ) : null}
          </div>
          <Field
            id="patient-register-address"
            testid="patient-register-address-input"
            label="Home address"
            value={form.address}
            onChange={(v) => update("address", v)}
            autoComplete="street-address"
            error={fieldErrors.address}
            disabled={busy}
            required
          />
          <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-sm font-medium text-slate-800">
              Emergency contact
            </legend>
            <Field
              id="patient-register-ec-name"
              testid="patient-register-emergency-name-input"
              label="Name"
              value={form.emergencyContactName}
              onChange={(v) => update("emergencyContactName", v)}
              error={fieldErrors.emergencyContactName}
              disabled={busy}
              required
            />
            <Field
              id="patient-register-ec-phone"
              testid="patient-register-emergency-phone-input"
              label="Phone"
              type="tel"
              inputMode="tel"
              value={form.emergencyContactPhone}
              onChange={(v) => update("emergencyContactPhone", v)}
              error={fieldErrors.emergencyContactPhone}
              disabled={busy}
              required
            />
            <Field
              id="patient-register-ec-rel"
              testid="patient-register-emergency-rel-input"
              label="Relationship"
              placeholder="e.g. spouse, parent"
              value={form.emergencyContactRelationship}
              onChange={(v) =>
                update("emergencyContactRelationship", v)
              }
              error={fieldErrors.emergencyContactRelationship}
              disabled={busy}
              required
            />
          </fieldset>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              data-testid="patient-register-terms-input"
              className="mt-1 h-5 w-5 rounded border-slate-300"
              checked={acceptedTerms}
              onChange={(e) => {
                setAcceptedTerms(e.target.checked);
                if (e.target.checked) {
                  setFieldErrors((prev) => {
                    if (!("acceptedTerms" in prev)) return prev;
                    const next = { ...prev };
                    delete next.acceptedTerms;
                    return next;
                  });
                }
              }}
              disabled={busy}
            />
            <span>
              I agree to the Terms &amp; Conditions and Privacy Policy.
            </span>
          </label>
          {fieldErrors.acceptedTerms ? (
            <p
              data-testid="patient-register-field-error-terms"
              className="text-xs text-red-700"
            >
              {fieldErrors.acceptedTerms}
            </p>
          ) : null}
          <button
            type="submit"
            data-testid="patient-register-submit"
            disabled={busy}
            className="inline-flex h-11 w-full min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Creating account…" : "Create account"}
          </button>
          <button
            type="button"
            data-testid="patient-register-back"
            onClick={() => {
              setStep("basics");
              setError(null);
            }}
            disabled={busy}
            className="inline-flex h-11 w-full min-w-[44px] items-center justify-center text-sm text-slate-700 underline-offset-2 hover:underline disabled:opacity-60"
          >
            Back
          </button>
        </form>
      )}

      {error ? (
        <p
          role="alert"
          data-testid="patient-register-error"
          className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      <p className="text-center text-sm text-slate-600">
        Already have an account?{" "}
        <Link
          href="/patient/login"
          data-testid="patient-register-login-link"
          className="font-medium text-slate-900 underline-offset-2 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </section>
  );
}

interface FieldProps {
  id: string;
  testid: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  inputMode?:
    | "search"
    | "text"
    | "email"
    | "tel"
    | "url"
    | "none"
    | "numeric"
    | "decimal";
  autoComplete?: string;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
}

function Field({
  id,
  testid,
  label,
  value,
  onChange,
  type = "text",
  inputMode,
  autoComplete,
  placeholder,
  error,
  disabled,
  required,
}: FieldProps) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        data-testid={testid}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        className="block h-11 w-full rounded-md border border-slate-300 px-3 text-base"
      />
      {error ? (
        <p
          data-testid={`patient-register-field-error-${id
            .replace("patient-register-", "")
            .replace(/-/g, "")}`}
          className="text-xs text-red-700"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
