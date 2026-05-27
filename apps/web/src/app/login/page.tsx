"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { LanguageDropdown } from "@/components/LanguageDropdown";
import { PasswordInput } from "@/components/PasswordInput";
import { toast } from "@/lib/toast";
import Image from "next/image";
import logoHorizontal from "../assets/MedCore_Logo1_0001_Layer-3.png";
import logoHorizontalDark from "../assets/MedCore_Logo1_0003_Layer-6.png";
import { sanitizeNextPath } from "@/lib/utils";
import {
  Activity,
  QrCode,
  Receipt,
  Smartphone,
  CheckCircle2,
} from "lucide-react";

/**
 * Issue #33 + Lane A (2026-05-08, commit f1de292): post-login destination.
 *
 * Reads `?next=` first (the canonical name shared with the API's
 * `sanitizeNextPath`) and falls back to the legacy `?redirect=` param so any
 * existing session-expired toast or bookmark keeps working. The actual
 * sanitisation lives in `@/lib/utils#sanitizeNextPath` — same logic as the
 * server helper so an attacker can't slip an open-redirect past the
 * frontend ahead of a server-side check.
 */
function safeRedirectTarget(
  next: string | null | undefined,
  legacy: string | null | undefined,
): string {
  // Prefer ?next=, fall back to ?redirect= for backwards compatibility.
  return sanitizeNextPath(next ?? legacy ?? null);
}

/**
 * Map an auth-endpoint error to a user-facing message, branching on the
 * HTTP status attached by `lib/api.ts`. Previously the login page treated
 * every non-2xx as "Invalid email or password" which hid the 429 rate-limit
 * from users (Issue #15).
 *
 * Status mapping:
 *  - 429 → "too many attempts" copy
 *  - 401 / 403 → invalid credentials
 *  - other → backend's error text, else the provided fallback
 */
function messageForAuthError(
  err: unknown,
  t: (key: string, fallback?: string) => string,
  fallback?: string,
): string {
  const status =
    err && typeof err === "object" && "status" in err
      ? (err as { status?: number }).status
      : undefined;

  if (status === 429) {
    return t(
      "login.error.rateLimited",
      "Too many login attempts. Please wait a minute and try again.",
    );
  }
  if (status === 401 || status === 403) {
    return t("login.error.invalidCredentials", "Invalid email or password.");
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback ?? t("login.error.generic");
}

// Top-level wrapper: useSearchParams() must be inside a Suspense boundary
// or prerender fails. Issue #33 requires reading ?redirect=<path> on first
// paint, so we wrap the actual page body.
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = safeRedirectTarget(
    searchParams.get("next"),
    searchParams.get("redirect"),
  );
  // Track whether the redirect target was EXPLICITLY supplied by the URL
  // (session-expired bounce, deep link) vs. fell back to the safe default.
  // We override the fallback for PATIENTs so they land on /patient/dashboard,
  // but if the caller asked for a specific page (e.g. ?redirect=/patient/profile
  // after a session expiry on that page), we honour it.
  const nextRaw = searchParams.get("next") ?? searchParams.get("redirect");
  const hasExplicitRedirect = Boolean(nextRaw && nextRaw.trim().length > 0);
  const { login, verify2FA } = useAuthStore();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Issue #1: Remember-me preference. Unchecked = session-only (refresh
  // token cookie/DB row lives ~7 days, the default). Checked = 30-day
  // refresh window. Default is FALSE so existing security posture is
  // preserved for anyone who does not opt in.
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
  }>({});
  const [loading, setLoading] = useState(false);
  const [twoFAStep, setTwoFAStep] = useState(false);
  const [tempToken, setTempToken] = useState("");
  const [twoFACode, setTwoFACode] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    // Issue #537: trim leading/trailing whitespace before validation so that
    // a whitespace-only submission (the user pressed space N times) fails the
    // "required" check instead of silently hitting the API. We also enforce
    // sensible length caps client-side so a 1,000-char paste is rejected
    // before it reaches the wire — the server is authoritative but a fast
    // client error is the right UX. Caps mirror the server schema:
    // email <= 254 (RFC 5321), password <= 200.
    const trimmedEmail = email.trim();
    const fe: { email?: string; password?: string } = {};
    if (!trimmedEmail) fe.email = "Email is required";
    else if (trimmedEmail.length > 254)
      fe.email = "Email is too long (max 254 characters)";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail))
      fe.email = "Enter a valid email address";
    if (!password) fe.password = "Password is required";
    else if (password.trim().length === 0)
      // Issue #537: whitespace-only passwords must not be accepted.
      fe.password = "Password is required";
    else if (password.length < 4) fe.password = "Password is too short";
    else if (password.length > 200)
      fe.password = "Password is too long (max 200 characters)";
    setFieldErrors(fe);
    if (Object.keys(fe).length > 0) return;
    setLoading(true);

    try {
      // Issue #1: forward rememberMe so the API can decide the refresh-token TTL.
      // Pass the trimmed email so leading/trailing spaces never reach the API.
      const result = await login(trimmedEmail, password, rememberMe);
      if (result.twoFactorRequired && result.tempToken) {
        setTempToken(result.tempToken);
        setTwoFAStep(true);
        return;
      }
      toast.success(t("login.welcome"));
      // Issue #33: honour the `?redirect=` param set by the dashboard auth
      // gate so users land back on the page they originally tried to open.
      // PATIENT override: when no explicit redirect was requested, send the
      // patient to /patient/dashboard instead of the staff /dashboard.
      const role = useAuthStore.getState().user?.role;
      const dest =
        !hasExplicitRedirect && role === "PATIENT"
          ? "/patient/dashboard"
          : redirectTo;
      router.push(dest);
    } catch (err) {
      // Issue #15: distinguish 429 (rate-limit) from 401/403 (bad creds) so
      // users never see "Invalid email or password" when they're simply
      // throttled. `lib/api.ts` attaches `.status` to the thrown Error.
      const msg = messageForAuthError(err, t);
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handle2FA(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await verify2FA(tempToken, twoFACode.trim());
      toast.success(t("login.welcome"));
      // Issue #33: honour ?redirect= after successful 2FA as well.
      // PATIENT override (same logic as the password path).
      const role = useAuthStore.getState().user?.role;
      const dest =
        !hasExplicitRedirect && role === "PATIENT"
          ? "/patient/dashboard"
          : redirectTo;
      router.push(dest);
    } catch (err) {
      // Issue #15: same status-aware handling for the 2FA step. A throttled
      // verify must not read as "Invalid 2FA code".
      const fallback = t("login.2fa.error.generic", "Invalid 2FA code");
      const msg = messageForAuthError(err, t, fallback);
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  const features = [
    { icon: Activity, text: t("login.marketing.feature1") },
    { icon: QrCode, text: t("login.marketing.feature2") },
    { icon: Receipt, text: t("login.marketing.feature3") },
    { icon: Smartphone, text: t("login.marketing.feature4") },
  ];

  return (
    <main
      id="main-content"
      className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-blue-100 dark:from-gray-900 dark:via-gray-950 dark:to-gray-900"
    >
      <div className="fixed right-4 top-4 z-10">
        <LanguageDropdown />
      </div>

      <div className="mx-auto grid min-h-screen max-w-6xl grid-cols-1 items-center gap-8 px-4 py-10 md:grid-cols-2 md:gap-12 md:px-8">
        {/* Marketing column */}
        <section
          aria-labelledby="marketing-heading"
          className="order-1 text-center md:order-none md:text-left"
        >
          <div className="mb-6 -mt-10 flex justify-center md:justify-start">
            {/* Theme-aware logo: Layer-3 for light, Layer-6 for dark. Both
                pinned to the same responsive height so neither variant
                renders smaller than the other. */}
            <Image
              src={logoHorizontal}
              alt="MedCore"
              height={56}
              width={220}
              className="h-8 w-auto sm:h-10 md:h-12 lg:h-14 dark:hidden"
            />
            <Image
              src={logoHorizontalDark}
              alt="MedCore"
              height={56}
              width={220}
              className="hidden h-8 w-auto dark:block sm:h-10 md:h-12 lg:h-14"
            />
          </div>
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-primary dark:bg-primary/20">
            <span
              className="h-2 w-2 rounded-full bg-primary"
              aria-hidden="true"
            />
            Hospital Management System
          </div>
          <h1 id="marketing-heading" className="sr-only">
            {t("app.name")}
          </h1>
          <p className="mt-3 text-base text-gray-600 dark:text-gray-300 md:text-lg">
            {t("login.marketing.tagline")}
          </p>

          {/* Full feature list on md+ */}
          <ul
            className="mt-8 hidden space-y-4 md:block"
            aria-label="Core features"
          >
            {features.map(({ icon: Icon, text }, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary dark:bg-primary/20">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="pt-2 text-sm text-gray-700 dark:text-gray-200">
                  {text}
                </span>
              </li>
            ))}
          </ul>

          {/* Condensed paragraph on mobile */}
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400 md:hidden">
            {t("login.marketing.short")}
          </p>
        </section>

        {/* Form column */}
        <section
          aria-labelledby="login-heading"
          className="order-2 md:order-none"
        >
          <div className="mx-auto w-full max-w-md rounded-2xl bg-white p-8 shadow-xl ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
            <div className="mb-6 text-center">
              <h2
                id="login-heading"
                className="text-2xl font-bold text-gray-900 dark:text-white"
              >
                {t("login.title")}
              </h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {t("app.tagline")}
              </p>
            </div>

            {twoFAStep ? (
              <form
                onSubmit={handle2FA}
                // Issue #709: same noValidate convention as the email/password
                // form so the 2FA step never surfaces the native validation
                // tooltip either.
                noValidate
                className="space-y-5"
                aria-label="2FA form"
              >
                {error && (
                  <div
                    role="alert"
                    className="rounded-lg bg-red-50 p-3 text-sm text-danger dark:bg-red-900/30 dark:text-red-300"
                  >
                    {error}
                  </div>
                )}
                <div>
                  <label
                    htmlFor="login-2fa"
                    className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
                  >
                    {t("login.2fa.title")}
                  </label>
                  <input
                    id="login-2fa"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={twoFACode}
                    onChange={(e) => setTwoFACode(e.target.value)}
                    aria-required="true"
                    placeholder={t("login.2fa.placeholder")}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 tracking-widest focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  />
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {t("login.2fa.hint")}
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition hover:bg-primary-dark disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                >
                  {loading ? t("login.2fa.verifying") : t("login.2fa.verify")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTwoFAStep(false);
                    setTempToken("");
                    setTwoFACode("");
                  }}
                  className="w-full text-center text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  {t("login.2fa.back")}
                </button>
              </form>
            ) : (
              <form
                onSubmit={handleSubmit}
                // Issue #102: suppress the browser's native email/required
                // validation tooltip — it positioned itself over the Password
                // label on Chromium. We render our own per-field error spans
                // (data-testid="error-email" / "error-password") below.
                noValidate
                className="space-y-5"
                aria-label="Login form"
              >
                {/* Issue #548: reserve vertical space for the error banner
                    even when no error is present. Without this, the banner
                    pops in BETWEEN render passes and shifts the email input
                    downward — combined with the on-screen keyboard appearing
                    on mobile, that relayout race could cause a keystroke
                    intended for the Password field to land in Email (the
                    wrong input took focus mid-keystroke). The fixed-height
                    container removes the layout jump entirely. */}
                <div className="min-h-[3rem]" data-testid="login-error-slot">
                  {error && (
                    <div
                      role="alert"
                      className="rounded-lg bg-red-50 p-3 text-sm text-danger dark:bg-red-900/30 dark:text-red-300"
                    >
                      {error}
                    </div>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="login-email"
                    className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
                  >
                    {t("login.email")}
                  </label>
                  <input
                    id="login-email"
                    // Issue #528: explicit `name` so password managers
                    // (1Password / Bitwarden / browser autofill) can target
                    // the field reliably. Without `name` some bridges
                    // .value-set the wrong input or skip the field entirely.
                    name="email"
                    type="email"
                    autoComplete="email"
                    // Issue #537: hard-cap input length at the field level so
                    // the user physically cannot paste a 1,000-char string.
                    // RFC 5321 puts email at <= 254 chars; the server schema
                    // matches. Client cap = belt + braces with the validator.
                    maxLength={254}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    // Issue #528: belt-and-braces — some autofill bridges
                    // dispatch only `input` events (not React's synthetic
                    // change), or .value-set without dispatching anything.
                    // Mirroring onChange via onInput catches every variant of
                    // input event browsers emit. onBlur re-syncs from the DOM
                    // as a final fallback for the .value-set-without-event
                    // case (rare, but observed with some accessibility tools).
                    onInput={(e) =>
                      setEmail((e.target as HTMLInputElement).value)
                    }
                    onBlur={(e) => setEmail(e.target.value)}
                    // Issue #709: do NOT set `required`. The form has
                    // `noValidate` but some browsers (Safari notably) still
                    // surface the native "Please fill out this field"
                    // tooltip on submit if the input itself declares
                    // `required`. We render the inline `<p data-testid=
                    // "error-email">` below instead. `aria-required` keeps
                    // assistive tech aware that the field is mandatory.
                    aria-required="true"
                    className={
                      "w-full rounded-lg border px-4 py-2.5 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:bg-gray-900 dark:text-gray-100 " +
                      (fieldErrors.email
                        ? "border-red-500"
                        : "border-gray-300 dark:border-gray-700")
                    }
                    placeholder={t("login.email.placeholder")}
                    aria-invalid={!!fieldErrors.email}
                    aria-describedby={
                      fieldErrors.email ? "login-email-err" : undefined
                    }
                  />
                  {/* Issue #548: reserve a fixed line of space for the error
                      message so the password input below never shifts when
                      the error toggles on/off. role="alert" is only set when
                      an error is actually present so empty paragraphs don't
                      announce on initial render. */}
                  <p
                    id="login-email-err"
                    data-testid="error-email"
                    role={fieldErrors.email ? "alert" : undefined}
                    className="mt-1 min-h-[1rem] text-xs text-red-600 dark:text-red-400"
                  >
                    {fieldErrors.email ?? ""}
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="login-password"
                    className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
                  >
                    {t("login.password")}
                  </label>
                  <PasswordInput
                    id="login-password"
                    // Issue #528: explicit `name` so password managers can
                    // target this field by name; mirrors the email input.
                    name="password"
                    autoComplete="current-password"
                    // Issue #537: cap at 200 chars to mirror the server
                    // password schema and reject a 1,000-char paste at the
                    // field level. Real passwords never need this much.
                    maxLength={200}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    // Issue #528: same belt-and-braces as the email field —
                    // mirror onChange via onInput / onBlur so paste, autofill,
                    // and programmatic .value sets all reach React state.
                    onInput={(e) =>
                      setPassword((e.target as HTMLInputElement).value)
                    }
                    onBlur={(e) => setPassword(e.target.value)}
                    // Issue #709: see above — inline error span replaces
                    // the native required tooltip.
                    aria-required="true"
                    className={
                      "rounded-lg border px-4 py-2.5 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:bg-gray-900 dark:text-gray-100 " +
                      (fieldErrors.password
                        ? "border-red-500"
                        : "border-gray-300 dark:border-gray-700")
                    }
                    placeholder={t("login.password.placeholder")}
                    aria-invalid={!!fieldErrors.password}
                    aria-describedby={
                      fieldErrors.password ? "login-password-err" : undefined
                    }
                  />
                  {/* Issue #548: reserved space for the password error so the
                      submit button never shifts when the error toggles. */}
                  <p
                    id="login-password-err"
                    data-testid="error-password"
                    role={fieldErrors.password ? "alert" : undefined}
                    className="mt-1 min-h-[1rem] text-xs text-red-600 dark:text-red-400"
                  >
                    {fieldErrors.password ?? ""}
                  </p>
                </div>

                {/* Issue #1: Remember-me checkbox. Unchecked = session-only
                    (7d refresh token), checked = 30-day refresh token. */}
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="remember-me"
                    className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-200"
                  >
                    <input
                      id="remember-me"
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                      data-testid="login-remember-me"
                      className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-2 focus:ring-primary/40 dark:border-gray-600 dark:bg-gray-900"
                    />
                    <span>{t("login.rememberMe")}</span>
                  </label>
                  <Link
                    href="/forgot-password"
                    className="text-sm font-medium text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded"
                  >
                    {t("login.forgot")}
                  </Link>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition hover:bg-primary-dark disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                >
                  {loading ? t("login.submit.loading") : t("login.submit")}
                </button>
              </form>
            )}

            <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
              {t("login.patientLogin")}{" "}
              <Link
                href="/patient/login"
                data-testid="patient-login-link"
                className="font-medium text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded"
              >
                {t("login.patientLoginCta")}
              </Link>
            </p>
            <p className="mt-2 text-center text-sm text-gray-500 dark:text-gray-400">
              {t("login.newPatient")}{" "}
              <Link
                href="/register"
                className="font-medium text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded"
              >
                {t("login.register")}
              </Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
