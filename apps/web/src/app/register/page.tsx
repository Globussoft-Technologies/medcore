"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { LanguageDropdown } from "@/components/LanguageDropdown";
import { PasswordInput } from "@/components/PasswordInput";
import { toast } from "@/lib/toast";
import Image from "next/image";
import logoHorizontal from "../assets/MedCore_Logo1_0001_Layer-3.png";
import logoHorizontalDark from "../assets/MedCore_Logo1_0003_Layer-6.png";
import { Check, X } from "lucide-react";
// Issue #130: surface ALL zod validation errors at once (one inline span per
// field via data-testid="error-{field}") instead of toasting only the first.
import { extractFieldErrors, type FieldErrorMap } from "@/lib/field-errors";

// Issues #706, #708, #713 — schema mirror (Lane A commit f1de292).
// The API now requires:
//   - email matches STRICT_EMAIL_REGEX (#708)
//   - password >= 12 chars, letter + digit, not in common-password denylist (#706)
//   - phone (10-15 digits, optional leading +) for PATIENT (#713)
//   - address 5-500 chars for PATIENT (#713)
//   - emergencyContact { name, phone, relationship } for PATIENT (#713)
//   - age in [0, 130] (#707)
const STRICT_EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE_REGEX = /^[+]?[\d\s-]{10,15}$/;

export default function RegisterPage() {
  const router = useRouter();
  const { login } = useAuthStore();
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
    // Issue #617: confirm-password second input. Validated locally against
    // `password`; never sent to the server (the server only stores the hashed
    // primary password — confirm is purely a typo guard).
    confirmPassword: "",
    // Issue #684: do NOT pre-select MALE — defaulting to a single gender
    // introduces a bias and pre-fills a sensitive field the user never
    // explicitly set. The first option is now an unselectable
    // placeholder ("Select…") and we validate that the user actually
    // picked one before submit.
    gender: "",
    age: "",
    // Issue #617: ISO calendar string (YYYY-MM-DD) — required for PATIENT.
    // Downstream workflows (appointments, prescriptions, billing) all expect
    // a real DOB, so we collect it at signup rather than on a follow-up edit.
    dateOfBirth: "",
    address: "",
    // Issue #713: emergency contact triplet — required for PATIENT.
    emergencyContactName: "",
    emergencyContactPhone: "",
    emergencyContactRelationship: "",
  });
  // Issue #617: T&C / Privacy Policy consent. Submit is blocked until ticked.
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState("");
  // Issue #494: when the server returns a 5xx / network failure (no field
  // breakdown to render inline), surface a top-of-form banner with a "Retry"
  // CTA so the user can re-submit without retyping the whole form. Field
  // values are intentionally preserved across the failed POST.
  const [retryable, setRetryable] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});
  const [loading, setLoading] = useState(false);

  function update(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Issue #130: clear the per-field error as soon as the user edits the
    // input — keeps the inline span in sync with the new value without
    // forcing a server round-trip. Also clears the matching nested
    // emergencyContact.<field> error when the user touches the corresponding
    // emergencyContactName/Phone/Relationship input.
    setFieldErrors((prev) => {
      const next = { ...prev };
      let changed = false;
      if (field in next) {
        delete next[field];
        changed = true;
      }
      // The API surfaces nested emergency-contact errors as
      // "emergencyContact.name" etc. Map our flat field name back to the
      // nested key so editing the input clears the inline error.
      const nestedMap: Record<string, string> = {
        emergencyContactName: "emergencyContact.name",
        emergencyContactPhone: "emergencyContact.phone",
        emergencyContactRelationship: "emergencyContact.relationship",
      };
      const nested = nestedMap[field];
      if (nested && nested in next) {
        delete next[nested];
        changed = true;
      }
      return changed ? next : prev;
    });
  }

  function validateClient(): FieldErrorMap {
    const errs: FieldErrorMap = {};
    if (!form.name.trim()) errs.name = "Name is required";
    if (!form.email.trim()) errs.email = "Email is required";
    else if (!STRICT_EMAIL_REGEX.test(form.email))
      errs.email = "Enter a valid email address";
    if (!form.phone.trim()) errs.phone = "Phone number is required";
    else if (!PHONE_REGEX.test(form.phone.trim()))
      errs.phone = "Phone must be 10–15 digits, optional leading +";
    // Issue #706: register password floor is 12 chars + letter + digit.
    if (!form.password) errs.password = "Password is required";
    else if (form.password.length < 12)
      errs.password = "Password must be at least 12 characters";
    else if (!/[A-Za-z]/.test(form.password))
      errs.password = "Password must contain at least one letter";
    else if (!/\d/.test(form.password))
      errs.password = "Password must contain at least one digit";
    // Issue #617: confirm-password — surface the mismatch inline rather than
    // letting the user submit a typo'd password and lock themselves out.
    if (!form.confirmPassword)
      errs.confirmPassword = "Please confirm your password";
    else if (form.password && form.confirmPassword !== form.password)
      errs.confirmPassword = "Passwords do not match";
    // Issue #617: DOB required. We don't double-validate against `age` — the
    // user can supply both and the server keeps both columns. Reject obviously
    // bogus shapes (future date, > 130 years ago) up front.
    if (!form.dateOfBirth) {
      errs.dateOfBirth = "Date of birth is required";
    } else {
      const dob = new Date(form.dateOfBirth);
      const now = new Date();
      const minDob = new Date();
      minDob.setFullYear(now.getFullYear() - 130);
      if (Number.isNaN(dob.getTime())) {
        errs.dateOfBirth = "Enter a valid date";
      } else if (dob > now) {
        errs.dateOfBirth = "Date of birth cannot be in the future";
      } else if (dob < minDob) {
        errs.dateOfBirth = "Date of birth must be within the last 130 years";
      }
    }
    if (form.age) {
      const n = parseInt(form.age, 10);
      // Issue #707: age range [0, 130].
      if (Number.isNaN(n) || n < 0 || n > 130)
        errs.age = "Enter a valid age between 0 and 130";
    }
    // Issue #684: gender must be a deliberate choice (not the silent
    // pre-selected MALE that introduced bias).
    if (!form.gender) errs.gender = "Please select a gender";
    // Issue #713: address required (PATIENT self-registration is the only
    // role this form supports — staff are created via the dashboard's
    // Users page where the requirements are already enforced).
    if (!form.address.trim()) errs.address = "Address is required";
    else if (form.address.trim().length < 5)
      errs.address = "Address must be at least 5 characters";
    // Issue #713: emergency contact triplet.
    if (!form.emergencyContactName.trim())
      errs["emergencyContact.name"] = "Emergency contact name is required";
    if (!form.emergencyContactPhone.trim())
      errs["emergencyContact.phone"] = "Emergency contact phone is required";
    else if (!PHONE_REGEX.test(form.emergencyContactPhone.trim()))
      errs["emergencyContact.phone"] =
        "Emergency contact phone must be 10–15 digits";
    if (!form.emergencyContactRelationship.trim())
      errs["emergencyContact.relationship"] =
        "Emergency contact relationship is required";
    // Issue #617: T&C / Privacy Policy consent gate. Surfaced inline so the
    // user sees exactly which checkbox to tick rather than a generic banner.
    if (!acceptedTerms)
      errs.acceptedTerms =
        "Please accept the Terms & Conditions and Privacy Policy to continue";
    return errs;
  }

  // Issue #617: lightweight password strength heuristic. No new dependency —
  // we score on length tiers + character-class variety. Surfaces a 4-step
  // bar so the user gets feedback before submit.
  function passwordStrength(pw: string): {
    score: 0 | 1 | 2 | 3 | 4;
    label: string;
  } {
    if (!pw) return { score: 0, label: "" };
    let score = 0;
    if (pw.length >= 12) score++;
    if (pw.length >= 16) score++;
    const classes =
      Number(/[a-z]/.test(pw)) +
      Number(/[A-Z]/.test(pw)) +
      Number(/\d/.test(pw)) +
      Number(/[^A-Za-z0-9]/.test(pw));
    if (classes >= 2) score++;
    if (classes >= 3) score++;
    const clamped = Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
    const labels = ["Too weak", "Weak", "Fair", "Good", "Strong"] as const;
    return { score: clamped, label: labels[clamped] };
  }

  async function submitRegistration() {
    setError("");
    setRetryable(false);
    setLoading(true);
    try {
      await api.post("/auth/register", {
        name: form.name,
        email: form.email,
        phone: form.phone,
        password: form.password,
        gender: form.gender,
        age: form.age ? parseInt(form.age) : undefined,
        // Issue #617: ISO calendar date (YYYY-MM-DD) — server schema accepts
        // it as optional and persists onto Patient.dateOfBirth.
        dateOfBirth: form.dateOfBirth || undefined,
        address: form.address || undefined,
        emergencyContact: {
          name: form.emergencyContactName,
          phone: form.emergencyContactPhone,
          relationship: form.emergencyContactRelationship,
        },
        // Issue #617: T&C consent telemetry — server logs it for compliance,
        // server schema accepts only `true`. Client-side we already gated
        // submit so this is always true at this point.
        acceptedTerms: true,
        role: "PATIENT",
      });

      // Issue #494 / #480 anti-enum note: the server returns 201 for both a
      // brand-new account AND a duplicate-email submission, with no token in
      // the latter case. `login()` will fail on the duplicate path because
      // the password was never actually stored — we surface that as the
      // generic top banner without leaking which case occurred.
      await login(form.email, form.password);
      toast.success("Registered successfully");
      router.push("/dashboard");
    } catch (err) {
      // Issue #494: route the error to the right place.
      //
      //   400 + { details: [...] } → inline per-field errors
      //   408 (timeout)            → top banner + retry CTA
      //   5xx / network            → top banner + retry CTA
      //   other 4xx                → top banner, no retry CTA
      //
      // Form values are NEVER cleared on failure — the user shouldn't have
      // to retype everything because we hiccupped server-side.
      const fields = extractFieldErrors(err);
      if (fields) {
        setFieldErrors(fields);
        setError("");
        setRetryable(false);
        return;
      }
      const status =
        err && typeof err === "object" && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      // 5xx, no status (network/abort), or 408 timeout — all retryable.
      const isRetryable =
        status === undefined || status === 408 || (status !== undefined && status >= 500);
      if (isRetryable) {
        setError(t("register.error.serverRetry"));
        setRetryable(true);
      } else {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : t("register.error.generic");
        setError(msg);
        setRetryable(false);
        toast.error(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setRetryable(false);
    // Issue #130: run client validation against ALL fields up front so the
    // user sees every problem at once, not just the first to trip zod on
    // the server.
    const clientErrs = validateClient();
    if (Object.keys(clientErrs).length > 0) {
      setFieldErrors(clientErrs);
      return;
    }
    setFieldErrors({});
    await submitRegistration();
  }

  async function handleRetry() {
    // Issue #494: re-submit without re-running client validation — the form
    // values are still valid (they passed once already); the server side
    // just hiccupped.
    await submitRegistration();
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";
  const errorInputClass = inputClass.replace(
    "border-gray-300",
    "border-red-500",
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100 dark:from-gray-900 dark:to-gray-950">
      <div className="fixed right-4 top-4">
        <LanguageDropdown />
      </div>
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-xl dark:bg-gray-800">
        <div className="mb-8 text-center">
          <div className="mb-4 flex justify-center">
            {/* Theme-aware logo: Layer-3 for light, Layer-6 for dark. */}
            <Image src={logoHorizontal} alt="MedCore" width={220} height={44} className="h-11 w-auto dark:hidden" priority />
            <Image src={logoHorizontalDark} alt="MedCore" width={220} height={44} className="hidden h-11 w-auto dark:block" priority />
          </div>
          <h1 className="sr-only">{t("app.name")}</h1>
          <p className="mt-2 text-gray-500 dark:text-gray-400">
            {t("register.title")}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4"
          aria-label="Registration form"
          // Issue #130 / #102 / #709: suppress browser native tooltips so all
          // validation feedback lives inline below each input.
          noValidate
        >
          {error && (
            <div
              role="alert"
              data-testid="register-error-banner"
              className="flex items-start justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-danger dark:bg-red-900/30 dark:text-red-300"
            >
              <span>{error}</span>
              {retryable && (
                <button
                  type="button"
                  onClick={handleRetry}
                  disabled={loading}
                  data-testid="register-retry-btn"
                  className="shrink-0 rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
                >
                  {loading
                    ? t("register.submit.loading")
                    : t("register.error.retry")}
                </button>
              )}
            </div>
          )}

          <div>
            <label
              htmlFor="reg-name"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
            >
              {t("register.fullName")}
            </label>
            <input
              id="reg-name"
              type="text"
              aria-required="true"
              autoComplete="name"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              className={fieldErrors.name ? errorInputClass : inputClass}
              placeholder={t("register.fullName.placeholder")}
              aria-invalid={!!fieldErrors.name}
              aria-describedby={fieldErrors.name ? "reg-name-err" : undefined}
            />
            {fieldErrors.name && (
              <p
                id="reg-name-err"
                data-testid="error-name"
                className="mt-1 text-xs text-red-600 dark:text-red-400"
              >
                {fieldErrors.name}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="reg-email"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                {t("register.email")}
              </label>
              <input
                id="reg-email"
                type="email"
                aria-required="true"
                autoComplete="email"
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                className={fieldErrors.email ? errorInputClass : inputClass}
                placeholder="you@example.com"
                aria-invalid={!!fieldErrors.email}
                aria-describedby={fieldErrors.email ? "reg-email-err" : undefined}
              />
              {fieldErrors.email && (
                <p
                  id="reg-email-err"
                  data-testid="error-email"
                  className="mt-1 text-xs text-red-600 dark:text-red-400"
                >
                  {fieldErrors.email}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="reg-phone"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                {t("register.phone")}
              </label>
              <input
                id="reg-phone"
                type="tel"
                aria-required="true"
                autoComplete="tel"
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                className={fieldErrors.phone ? errorInputClass : inputClass}
                placeholder={t("register.phone.placeholder")}
                aria-invalid={!!fieldErrors.phone}
                aria-describedby={fieldErrors.phone ? "reg-phone-err" : undefined}
              />
              {fieldErrors.phone && (
                <p
                  id="reg-phone-err"
                  data-testid="error-phone"
                  className="mt-1 text-xs text-red-600 dark:text-red-400"
                >
                  {fieldErrors.phone}
                </p>
              )}
            </div>
          </div>

          <div>
            <label
              htmlFor="reg-password"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
            >
              {t("register.password")}
            </label>
            <PasswordInput
              id="reg-password"
              aria-required="true"
              autoComplete="new-password"
              minLength={12}
              value={form.password}
              onChange={(e) => update("password", e.target.value)}
              className={fieldErrors.password ? errorInputClass : inputClass}
              placeholder={t("register.password.placeholder")}
              aria-invalid={!!fieldErrors.password}
              aria-describedby={
                fieldErrors.password ? "reg-password-err" : "reg-password-hint"
              }
              hint="At least 12 characters with a letter and a digit."
            />
            {/* Issue #617: 4-step strength meter — shows once the user starts
                typing. Pure heuristic (length tiers + character-class variety),
                no zxcvbn dep. */}
            {form.password && (
              <div
                className="mt-2"
                data-testid="password-strength"
                data-strength={passwordStrength(form.password).score}
              >
                <div className="flex gap-1" aria-hidden="true">
                  {[1, 2, 3, 4].map((tier) => {
                    const score = passwordStrength(form.password).score;
                    const filled = tier <= score;
                    const color =
                      score <= 1
                        ? "bg-red-500"
                        : score === 2
                          ? "bg-yellow-500"
                          : score === 3
                            ? "bg-blue-500"
                            : "bg-green-500";
                    return (
                      <div
                        key={tier}
                        className={`h-1 flex-1 rounded ${
                          filled ? color : "bg-gray-200 dark:bg-gray-700"
                        }`}
                      />
                    );
                  })}
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Strength: {passwordStrength(form.password).label}
                </p>
              </div>
            )}
            {fieldErrors.password && (
              <p
                id="reg-password-err"
                data-testid="error-password"
                className="mt-1 text-xs text-red-600 dark:text-red-400"
              >
                {fieldErrors.password}
              </p>
            )}
          </div>

          {/* Issue #617: confirm-password — second password input bound to
              its own state. Validated against `form.password` in
              validateClient(); inline mismatch surfaced as
              data-testid="error-confirmPassword". A small live indicator
              shows match/mismatch as soon as both fields have content so the
              user catches typos before submit. */}
          <div>
            <label
              htmlFor="reg-confirm-password"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
            >
              Confirm Password
            </label>
            <PasswordInput
              id="reg-confirm-password"
              aria-required="true"
              autoComplete="new-password"
              minLength={12}
              value={form.confirmPassword}
              onChange={(e) => update("confirmPassword", e.target.value)}
              className={
                fieldErrors.confirmPassword ? errorInputClass : inputClass
              }
              placeholder="Re-type your password"
              aria-invalid={!!fieldErrors.confirmPassword}
              aria-describedby={
                fieldErrors.confirmPassword
                  ? "reg-confirm-password-err"
                  : undefined
              }
            />
            {form.password && form.confirmPassword && !fieldErrors.confirmPassword && (
              <p
                className={`mt-1 flex items-center gap-1 text-xs ${
                  form.password === form.confirmPassword
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                }`}
                data-testid="confirm-password-indicator"
              >
                {form.password === form.confirmPassword ? (
                  <>
                    <Check size={12} aria-hidden="true" /> Passwords match
                  </>
                ) : (
                  <>
                    <X size={12} aria-hidden="true" /> Passwords do not match
                  </>
                )}
              </p>
            )}
            {fieldErrors.confirmPassword && (
              <p
                id="reg-confirm-password-err"
                data-testid="error-confirmPassword"
                className="mt-1 text-xs text-red-600 dark:text-red-400"
              >
                {fieldErrors.confirmPassword}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="reg-gender"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                {t("register.gender")}
              </label>
              <select
                id="reg-gender"
                value={form.gender}
                onChange={(e) => update("gender", e.target.value)}
                aria-required="true"
                aria-invalid={!!fieldErrors.gender}
                aria-describedby={
                  fieldErrors.gender ? "reg-gender-err" : undefined
                }
                className={fieldErrors.gender ? errorInputClass : inputClass}
              >
                {/* Issue #684: empty default option so no gender is
                    pre-selected. Marked disabled so the user can't
                    submit without making a deliberate choice. */}
                <option value="" disabled>
                  Select…
                </option>
                <option value="MALE">{t("register.gender.male")}</option>
                <option value="FEMALE">{t("register.gender.female")}</option>
                <option value="OTHER">{t("register.gender.other")}</option>
              </select>
              {fieldErrors.gender && (
                <p
                  id="reg-gender-err"
                  data-testid="error-gender"
                  className="mt-1 text-xs text-red-600 dark:text-red-400"
                >
                  {fieldErrors.gender}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="reg-age"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                {t("register.age")}
              </label>
              <input
                id="reg-age"
                type="number"
                min="0"
                max="130"
                value={form.age}
                onChange={(e) => update("age", e.target.value)}
                className={fieldErrors.age ? errorInputClass : inputClass}
                placeholder={t("register.age.placeholder")}
                aria-invalid={!!fieldErrors.age}
                aria-describedby={fieldErrors.age ? "reg-age-err" : undefined}
              />
              {fieldErrors.age && (
                <p
                  id="reg-age-err"
                  data-testid="error-age"
                  className="mt-1 text-xs text-red-600 dark:text-red-400"
                >
                  {fieldErrors.age}
                </p>
              )}
            </div>
          </div>

          {/* Issue #617: Date of Birth — required for PATIENT. Native
              `type="date"` so the user gets the platform date picker and
              keyboard input both work. Stored as ISO YYYY-MM-DD which is
              exactly what the server schema expects. The native picker's
              max attribute caps at today (no future DOBs). */}
          <div>
            <label
              htmlFor="reg-dob"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
            >
              Date of Birth
            </label>
            <input
              id="reg-dob"
              type="date"
              aria-required="true"
              autoComplete="bday"
              max={new Date().toISOString().slice(0, 10)}
              value={form.dateOfBirth}
              onChange={(e) => update("dateOfBirth", e.target.value)}
              className={
                fieldErrors.dateOfBirth ? errorInputClass : inputClass
              }
              aria-invalid={!!fieldErrors.dateOfBirth}
              aria-describedby={
                fieldErrors.dateOfBirth ? "reg-dob-err" : undefined
              }
            />
            {fieldErrors.dateOfBirth && (
              <p
                id="reg-dob-err"
                data-testid="error-dateOfBirth"
                className="mt-1 text-xs text-red-600 dark:text-red-400"
              >
                {fieldErrors.dateOfBirth}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="reg-address"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
            >
              {t("register.address")}
            </label>
            <input
              id="reg-address"
              type="text"
              aria-required="true"
              autoComplete="street-address"
              value={form.address}
              onChange={(e) => update("address", e.target.value)}
              className={fieldErrors.address ? errorInputClass : inputClass}
              placeholder={t("register.address.placeholder")}
              aria-invalid={!!fieldErrors.address}
              aria-describedby={
                fieldErrors.address ? "reg-address-err" : undefined
              }
            />
            {fieldErrors.address && (
              <p
                id="reg-address-err"
                data-testid="error-address"
                className="mt-1 text-xs text-red-600 dark:text-red-400"
              >
                {fieldErrors.address}
              </p>
            )}
          </div>

          {/* Issue #713 (Lane A commit f1de292) — emergency contact block.
              Required for PATIENT self-registration so the front desk has
              someone to call in an admission emergency. The API rejects
              missing/short fields with details = [{field:"emergencyContact.X",
              message:"..."}]; the inline spans below catch each branch. */}
          <fieldset
            data-testid="reg-emergency-contact"
            className="rounded-lg border border-gray-200 p-4 dark:border-gray-700"
          >
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-200">
              Emergency Contact
            </legend>
            <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
              Someone we can reach if you can&apos;t be reached.
            </p>
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="reg-ec-name"
                  className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
                >
                  Name
                </label>
                <input
                  id="reg-ec-name"
                  type="text"
                  aria-required="true"
                  autoComplete="off"
                  value={form.emergencyContactName}
                  onChange={(e) =>
                    update("emergencyContactName", e.target.value)
                  }
                  className={
                    fieldErrors["emergencyContact.name"]
                      ? errorInputClass
                      : inputClass
                  }
                  placeholder="e.g. Priya Sharma"
                  aria-invalid={!!fieldErrors["emergencyContact.name"]}
                  aria-describedby={
                    fieldErrors["emergencyContact.name"]
                      ? "reg-ec-name-err"
                      : undefined
                  }
                />
                {fieldErrors["emergencyContact.name"] && (
                  <p
                    id="reg-ec-name-err"
                    data-testid="error-emergencyContact.name"
                    className="mt-1 text-xs text-red-600 dark:text-red-400"
                  >
                    {fieldErrors["emergencyContact.name"]}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="reg-ec-phone"
                    className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
                  >
                    Emergency phone
                  </label>
                  <input
                    id="reg-ec-phone"
                    type="tel"
                    aria-required="true"
                    autoComplete="off"
                    value={form.emergencyContactPhone}
                    onChange={(e) =>
                      update("emergencyContactPhone", e.target.value)
                    }
                    className={
                      fieldErrors["emergencyContact.phone"]
                        ? errorInputClass
                        : inputClass
                    }
                    placeholder="+91 98765 43210"
                    aria-invalid={!!fieldErrors["emergencyContact.phone"]}
                    aria-describedby={
                      fieldErrors["emergencyContact.phone"]
                        ? "reg-ec-phone-err"
                        : undefined
                    }
                  />
                  {fieldErrors["emergencyContact.phone"] && (
                    <p
                      id="reg-ec-phone-err"
                      data-testid="error-emergencyContact.phone"
                      className="mt-1 text-xs text-red-600 dark:text-red-400"
                    >
                      {fieldErrors["emergencyContact.phone"]}
                    </p>
                  )}
                </div>
                <div>
                  <label
                    htmlFor="reg-ec-rel"
                    className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
                  >
                    Relationship
                  </label>
                  <input
                    id="reg-ec-rel"
                    type="text"
                    aria-required="true"
                    autoComplete="off"
                    value={form.emergencyContactRelationship}
                    onChange={(e) =>
                      update("emergencyContactRelationship", e.target.value)
                    }
                    className={
                      fieldErrors["emergencyContact.relationship"]
                        ? errorInputClass
                        : inputClass
                    }
                    placeholder="e.g. Spouse, Parent"
                    aria-invalid={
                      !!fieldErrors["emergencyContact.relationship"]
                    }
                    aria-describedby={
                      fieldErrors["emergencyContact.relationship"]
                        ? "reg-ec-rel-err"
                        : undefined
                    }
                  />
                  {fieldErrors["emergencyContact.relationship"] && (
                    <p
                      id="reg-ec-rel-err"
                      data-testid="error-emergencyContact.relationship"
                      className="mt-1 text-xs text-red-600 dark:text-red-400"
                    >
                      {fieldErrors["emergencyContact.relationship"]}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </fieldset>

          {/* Issue #617: T&C / Privacy Policy consent. Submit is blocked
              until the box is ticked (validateClient() surfaces the inline
              error on submit; the button itself stays enabled so screen
              readers / keyboard users can attempt to submit and read the
              error message). Links open `/terms` and `/privacy` in a new
              tab — those routes are tracked separately, this surface only
              owns the consent capture. */}
          <div>
            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input
                type="checkbox"
                id="reg-accept-terms"
                data-testid="reg-accept-terms"
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
                aria-required="true"
                aria-invalid={!!fieldErrors.acceptedTerms}
                aria-describedby={
                  fieldErrors.acceptedTerms
                    ? "reg-accept-terms-err"
                    : undefined
                }
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary focus:ring-2 focus:ring-primary"
              />
              <span>
                I agree to the{" "}
                <Link
                  href="/legal/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  // Parent <label> hijacks inner clicks to toggle the
                  // checkbox; stop propagation so the link navigation wins.
                  onClick={(e) => e.stopPropagation()}
                  className="font-medium text-primary hover:underline"
                >
                  Terms &amp; Conditions
                </Link>{" "}
                and{" "}
                <Link
                  href="/legal/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="font-medium text-primary hover:underline"
                >
                  Privacy Policy
                </Link>
                .
              </span>
            </label>
            {fieldErrors.acceptedTerms && (
              <p
                id="reg-accept-terms-err"
                data-testid="error-acceptedTerms"
                className="mt-1 text-xs text-red-600 dark:text-red-400"
              >
                {fieldErrors.acceptedTerms}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition hover:bg-primary-dark disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          >
            {loading ? t("register.submit.loading") : t("register.submit")}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {t("register.haveAccount")}{" "}
          <Link
            href="/login"
            className="font-medium text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded"
          >
            {t("register.signIn")}
          </Link>
        </p>
      </div>
    </div>
  );
}
