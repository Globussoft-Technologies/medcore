"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { LanguageDropdown } from "@/components/LanguageDropdown";
import { toast } from "@/lib/toast";

export default function LoginPage() {
  const router = useRouter();
  const { login, verify2FA } = useAuthStore();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      const result = await login(email, password);
      if (result.twoFactorRequired && result.tempToken) {
        setTempToken(result.tempToken);
        setTwoFAStep(true);
        return;
      }
      toast.success("Welcome back!");
      router.push("/dashboard");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("login.error.generic");
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
      toast.success("Welcome back!");
      router.push("/dashboard");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid 2FA code";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100 dark:from-gray-900 dark:to-gray-950"
    >
      <div className="fixed right-4 top-4">
        <LanguageDropdown />
      </div>
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl dark:bg-gray-800">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-primary">{t("app.name")}</h1>
          <p className="mt-2 text-gray-500 dark:text-gray-400">
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
                Two-Factor Authentication Code
              </label>
              <input
                id="login-2fa"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={twoFACode}
                onChange={(e) => setTwoFACode(e.target.value)}
                required
                placeholder="6-digit code or backup code"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 tracking-widest focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
              <p className="mt-2 text-xs text-gray-500">
                Open your authenticator app and enter the current code. You can also use one of your backup codes.
              </p>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition hover:bg-primary-dark disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
            >
              {loading ? "Verifying..." : "Verify"}
            </button>
            <button
              type="button"
              onClick={() => {
                setTwoFAStep(false);
                setTempToken("");
                setTwoFACode("");
              }}
              className="w-full text-center text-sm text-gray-500 hover:text-gray-700"
            >
              Back to login
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
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={
                "w-full rounded-lg border px-4 py-2.5 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:bg-gray-900 dark:text-gray-100 " +
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

          <div className="flex justify-end">
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
          <p className="font-medium">Demo Accounts:</p>
          <p>Admin: admin@medcore.local / admin123</p>
          <p>Doctor: dr.sharma@medcore.local / doctor123</p>
          <p>Reception: reception@medcore.local / reception123</p>
          <p>Nurse: nurse@medcore.local / nurse123</p>
        </div>
      </div>
    </main>
  );
}
