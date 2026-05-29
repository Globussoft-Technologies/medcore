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
import {
  User,
  Mail,
  Phone,
  Lock,
  Calendar,
  MapPin,
  UserPlus,
  Shield,
  Sparkles,
  CheckCircle2,
  HeartPulse,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
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
    <section
      className="grid w-full flex-1 items-stretch lg:grid-cols-2"
      data-testid="patient-register-shell"
    >
      {/* LEFT — brand panel */}
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-blue-600 via-blue-700 to-emerald-600 px-10 py-16 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute inset-0 -z-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.18),transparent_60%)]" />
        <div className="relative z-10">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium uppercase tracking-wider backdrop-blur-sm">
            <Sparkles className="h-3.5 w-3.5" />
            New here? It only takes a minute
          </div>
          <h2 className="mt-6 text-4xl font-extrabold leading-tight tracking-tight">
            Create your
            <br />
            <span className="bg-gradient-to-r from-white to-emerald-200 bg-clip-text text-transparent">
              patient account.
            </span>
          </h2>
          <p className="mt-5 max-w-md text-base leading-relaxed text-blue-50/90">
            Book appointments, view prescriptions, download lab reports and pay
            bills — securely linked to your hospital, all in one place.
          </p>
        </div>
        <ul className="relative z-10 mt-10 space-y-3 text-sm text-blue-50/90">
          {[
            "Same record across every visit & department",
            "Tamper-proof prescription QR for the pharmacy",
            "Self-serve DPDP data export",
            "8 Indian languages supported",
          ].map((f) => (
            <li key={f} className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-300" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </aside>

      {/* RIGHT — registration card */}
      <div className="flex items-center justify-center px-4 py-12 sm:px-6 lg:px-12">
        <div className="w-full max-w-lg">
          {/* Mobile-only compact brand banner */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-emerald-500 text-white shadow-sm shadow-blue-600/20">
              <HeartPulse className="h-6 w-6" />
            </span>
            <div>
              <div className="text-base font-semibold tracking-tight text-gray-900 dark:text-white">
                Create your MedCore account
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Takes about a minute
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8 dark:border-gray-800 dark:bg-gray-900">
            <header className="space-y-3">
              <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                Create account
              </h1>
              {/* Step indicator */}
              <ol className="flex items-center gap-2 text-xs font-medium">
                <li
                  className={`flex items-center gap-1.5 ${step === "basics" ? "text-blue-700 dark:text-blue-400" : "text-gray-500 dark:text-gray-500"}`}
                >
                  <span
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                      step === "basics"
                        ? "bg-blue-600 text-white"
                        : "bg-emerald-500 text-white"
                    }`}
                  >
                    {step === "basics" ? "1" : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                  </span>
                  Contact
                </li>
                <span
                  className={`h-px w-8 ${step === "details" ? "bg-emerald-500" : "bg-gray-200 dark:bg-gray-800"}`}
                  aria-hidden
                />
                <li
                  className={`flex items-center gap-1.5 ${step === "details" ? "text-blue-700 dark:text-blue-400" : "text-gray-500 dark:text-gray-500"}`}
                >
                  <span
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                      step === "details"
                        ? "bg-blue-600 text-white"
                        : "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                  >
                    2
                  </span>
                  Details
                </li>
              </ol>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {step === "basics"
                  ? "Your contact details and a password."
                  : "A few extras so we can serve you safely."}
              </p>
            </header>

            <div className="mt-6">
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
                    icon={User}
                    placeholder="Asha Kumari"
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
                    icon={Phone}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="+91 9876543210"
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
                    icon={Mail}
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
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      id="patient-register-password"
                      testid="patient-register-password-input"
                      label="Password"
                      icon={Lock}
                      type="password"
                      autoComplete="new-password"
                      placeholder="12+ chars, 1 digit"
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
                      icon={Lock}
                      type="password"
                      autoComplete="new-password"
                      placeholder="Retype password"
                      value={form.confirmPassword}
                      onChange={(v) => update("confirmPassword", v)}
                      error={fieldErrors.confirmPassword}
                      disabled={busy}
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    data-testid="patient-register-next"
                    disabled={busy}
                    className="group mt-2 inline-flex h-12 w-full min-w-[44px] items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Continue
                    <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
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
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      id="patient-register-dob"
                      testid="patient-register-dob-input"
                      label="Date of birth"
                      icon={Calendar}
                      type="date"
                      autoComplete="bday"
                      value={form.dateOfBirth}
                      onChange={(v) => update("dateOfBirth", v)}
                      error={fieldErrors.dateOfBirth}
                      disabled={busy}
                      required
                    />
                    <div className="space-y-1.5">
                      <label
                        htmlFor="patient-register-gender"
                        className="block text-sm font-medium text-gray-800 dark:text-gray-200"
                      >
                        Gender
                      </label>
                      <select
                        id="patient-register-gender"
                        data-testid="patient-register-gender-input"
                        className="block h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 transition focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
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
                          className="text-xs text-red-700 dark:text-red-400"
                        >
                          {fieldErrors.gender}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <Field
                    id="patient-register-address"
                    testid="patient-register-address-input"
                    label="Home address"
                    icon={MapPin}
                    placeholder="House no., street, city, state"
                    value={form.address}
                    onChange={(v) => update("address", v)}
                    autoComplete="street-address"
                    error={fieldErrors.address}
                    disabled={busy}
                    required
                  />
                  <fieldset className="space-y-3 rounded-xl border border-gray-200 bg-gray-50/50 p-4 dark:border-gray-800 dark:bg-gray-950/40">
                    <legend className="inline-flex items-center gap-1.5 px-1 text-sm font-semibold text-gray-800 dark:text-gray-200">
                      <UserPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                      Emergency contact
                    </legend>
                    <Field
                      id="patient-register-ec-name"
                      testid="patient-register-emergency-name-input"
                      label="Name"
                      icon={User}
                      value={form.emergencyContactName}
                      onChange={(v) => update("emergencyContactName", v)}
                      error={fieldErrors.emergencyContactName}
                      disabled={busy}
                      required
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        id="patient-register-ec-phone"
                        testid="patient-register-emergency-phone-input"
                        label="Phone"
                        icon={Phone}
                        type="tel"
                        inputMode="tel"
                        placeholder="+91 9876543210"
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
                    </div>
                  </fieldset>
                  <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
                    <input
                      type="checkbox"
                      data-testid="patient-register-terms-input"
                      className="mt-0.5 h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
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
                      I agree to the{" "}
                      <Link
                        href="/legal/terms"
                        target="_blank"
                        rel="noopener noreferrer"
                        // The parent <label> hijacks clicks anywhere inside
                        // it to toggle the linked checkbox, which on many
                        // browsers swallows the link navigation. Stop
                        // propagation so the link wins.
                        onClick={(e) => e.stopPropagation()}
                        className="font-semibold text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                      >
                        Terms &amp; Conditions
                      </Link>{" "}
                      and{" "}
                      <Link
                        href="/legal/privacy"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="font-semibold text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                      >
                        Privacy Policy
                      </Link>
                      .
                    </span>
                  </label>
                  {fieldErrors.acceptedTerms ? (
                    <p
                      data-testid="patient-register-field-error-terms"
                      className="text-xs text-red-700 dark:text-red-400"
                    >
                      {fieldErrors.acceptedTerms}
                    </p>
                  ) : null}
                  <button
                    type="submit"
                    data-testid="patient-register-submit"
                    disabled={busy}
                    className="inline-flex h-12 w-full min-w-[44px] items-center justify-center rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
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
                    className="inline-flex h-11 w-full min-w-[44px] items-center justify-center gap-1.5 text-sm text-gray-600 transition hover:text-gray-900 disabled:opacity-60 dark:text-gray-400 dark:hover:text-gray-100"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                </form>
              )}
            </div>

            {error ? (
              <p
                role="alert"
                data-testid="patient-register-error"
                className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
              >
                {error}
              </p>
            ) : null}

            <div className="mt-6 border-t border-gray-100 pt-5 dark:border-gray-800">
              <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                Already have an account?{" "}
                <Link
                  href="/patient/login"
                  data-testid="patient-register-login-link"
                  className="font-semibold text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
                >
                  Sign in
                </Link>
              </p>
            </div>
          </div>

          <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-gray-500 dark:text-gray-500">
            <Shield className="h-3.5 w-3.5 text-emerald-500" />
            Protected by end-to-end encryption. Your data stays in India.
          </p>
        </div>
      </div>
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
  icon?: React.ComponentType<{ className?: string }>;
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
  icon: Icon,
}: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-gray-800 dark:text-gray-200"
      >
        {label}
      </label>
      <div className="relative">
        {Icon ? (
          <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        ) : null}
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
          className={`block h-12 w-full rounded-xl border bg-white pr-3 text-base text-gray-900 placeholder:text-gray-400 transition focus:outline-none focus:ring-4 dark:bg-gray-950 dark:text-white ${
            error
              ? "border-red-300 focus:border-red-500 focus:ring-red-500/15 dark:border-red-900/60"
              : "border-gray-300 focus:border-blue-500 focus:ring-blue-500/15 dark:border-gray-700"
          } ${Icon ? "pl-10" : "pl-3"}`}
        />
      </div>
      {error ? (
        <p
          data-testid={`patient-register-field-error-${id
            .replace("patient-register-", "")
            .replace(/-/g, "")}`}
          className="text-xs text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
