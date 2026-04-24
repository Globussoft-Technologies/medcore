"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { LanguageDropdown } from "@/components/LanguageDropdown";
import { PasswordInput } from "@/components/PasswordInput";
import { toast } from "@/lib/toast";
import { Activity, QrCode, Receipt, Smartphone, CheckCircle2 } from "lucide-react";

/**
 * Issue #33: return the post-login destination. Honours `?redirect=...` if
 * the dashboard auth gate forwarded the user here after session expiry, but
 * guards against:
 *  - external URLs (open-redirect risk)
 *  - redirecting to /login itself (would loop)
 *  - empty/missing params
 */
function safeRedirectTarget(param: string | null | undefined): string {
  if (!param) return "/dashboard";
  // Only allow same-origin, leading-slash paths to block open redirects.
  if (!param.startsWith("/") || param.startsWith("//")) return "/dashboard";
  if (param.startsWith("/login")) return "/dashboard";
  return param;
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
  fallback?: string
): string {
  const status =
    err && typeof err === "object" && "status" in err
      ? (err as { status?: number }).status
      : undefined;

  if (status === 429) {
    return t(
      "login.error.rateLimited",
      "Too many login attempts. Please wait a minute and try again."
    );
  }
  if (status === 401 || status === 403) {
    return t("login.error.invalidCredentials", "Invalid email or password.");
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback ?? t("login.error.generic");
}

// Force dynamic rendering — useSearchParams() cannot be statically prerendered
// without a Suspense boundary, and the login page needs ?redirect=<path> from
// the URL on first paint (Issue #33 session-expiry flow).
export const dynamic = "force-dynamic";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = safeRedirectTarget(searchParams.get("redirect"));
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
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);
  const [twoFAStep, setTwoFAStep] = useState(false);
  const [tempToken, setTempToken] = useState("");
  const [twoFACode, setTwoFACode] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const fe: { email?: string; password?: string } = {};
    if (!email.trim()) fe.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      fe.email = "Enter a valid email address";
    if (!password) fe.password = "Password is required";
    else if (password.length < 4) fe.password = "Password is too short";
    setFieldErrors(fe);
    if (Object.keys(fe).length > 0) return;
    setLoading(true);

    try {
      // Issue #1: forward rememberMe so the API can decide the refresh-token TTL.
      const result = await login(email, password, rememberMe);
      if (result.twoFactorRequired && result.tempToken) {
        setTempToken(result.tempToken);
        setTwoFAStep(true);
        return;
      }
      toast.success(t("login.welcome"));
      // Issue #33: honour the `?redirect=` param set by the dashboard auth
      // gate so users land back on the page they originally tried to open.
      router.push(redirectTo);
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
      router.push(redirectTo);
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
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-primary dark:bg-primary/20">
            <span className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
            Hospital Management System
          </div>
          <h1
            id="marketing-heading"
            className="mt-4 text-4xl font-bold tracking-tight text-gray-900 dark:text-white md:text-5xl"
          >
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
              <form onSubmit={handle2FA} className="space-y-5" aria-label="2FA form">
                {error && (
                  <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-danger dark:bg-red-900/30 dark:text-red-300">
                    {error}
                  </div>
                )}
                <div>
                  <label htmlFor="login-2fa" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
                    {t("login.2fa.title")}
                  </label>
                  <input
                    id="login-2fa"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={twoFACode}
                    onChange={(e) => setTwoFACode(e.target.value)}
                    required
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
              <form onSubmit={handleSubmit} className="space-y-5" aria-label="Login form">
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
                    htmlFor="login-email"
                    className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
                  >
                    {t("login.email")}
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className={
                      "w-full rounded-lg border px-4 py-2.5 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:bg-gray-900 dark:text-gray-100 " +
                      (fieldErrors.email ? "border-red-500" : "border-gray-300 dark:border-gray-700")
                    }
                    placeholder={t("login.email.placeholder")}
                    aria-invalid={!!fieldErrors.email}
                    aria-describedby={fieldErrors.email ? "login-email-err" : undefined}
                  />
                  {fieldErrors.email && (
                    <p id="login-email-err" className="mt-1 text-xs text-red-600">
                      {fieldErrors.email}
                    </p>
                  )}
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
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className={
                      "rounded-lg border px-4 py-2.5 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:bg-gray-900 dark:text-gray-100 " +
                      (fieldErrors.password ? "border-red-500" : "border-gray-300 dark:border-gray-700")
                    }
                    placeholder={t("login.password.placeholder")}
                    aria-invalid={!!fieldErrors.password}
                    aria-describedby={fieldErrors.password ? "login-password-err" : undefined}
                  />
                  {fieldErrors.password && (
                    <p id="login-password-err" className="mt-1 text-xs text-red-600">
                      {fieldErrors.password}
                    </p>
                  )}
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
              {t("login.newPatient")}{" "}
              <Link
                href="/register"
                className="font-medium text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded"
              >
                {t("login.register")}
              </Link>
            </p>

            <div className="mt-4 rounded-lg bg-gray-50 p-4 text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <p className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                {t("login.demo.title")}
              </p>
              <p>Admin: admin@medcore.local / admin123</p>
              <p>Doctor: dr.sharma@medcore.local / doctor123</p>
              <p>Reception: reception@medcore.local / reception123</p>
              <p>Nurse: nurse@medcore.local / nurse123</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
