"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { PasswordInput } from "@/components/PasswordInput";

type Step = "email" | "reset" | "done";

/**
 * Issue #15: match the login page's status-aware error mapping so that a
 * throttled /auth/forgot-password or /auth/reset-password does not render
 * as the backend's raw "Request failed" message.
 */
function authErrorMessage(err: unknown, fallback: string): string {
  const status =
    err && typeof err === "object" && "status" in err
      ? (err as { status?: number }).status
      : undefined;
  if (status === 429) {
    return "Too many attempts. Please wait a minute and try again.";
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export default function ForgotPasswordPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await api.post("/auth/forgot-password", { email });
      setStep("reset");
    } catch (err) {
      setError(authErrorMessage(err, "Something went wrong"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await api.post("/auth/reset-password", { email, code, newPassword });
      setStep("done");
    } catch (err) {
      setError(authErrorMessage(err, "Something went wrong"));
    } finally {
      setLoading(false);
    }
  }

  // Issue #127: page used to be hardcoded to a light gradient + white card,
  // which broke visual consistency for users on the dark theme. We now mirror
  // the login page — light gradient with `dark:` siblings, no `data-theme`
  // override or `forceLight` prop — so the global ThemeBootstrap drives both
  // states uniformly.
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100 dark:from-gray-900 dark:via-gray-950 dark:to-gray-900">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-primary">MedCore</h1>
          <p className="mt-2 text-gray-500 dark:text-gray-400">Reset Your Password</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-danger dark:bg-red-900/30 dark:text-red-300">
            {error}
          </div>
        )}

        {step === "email" && (
          <form onSubmit={handleRequestCode} className="space-y-5">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Enter your email address and we will send you a reset code.
            </p>
            <div>
              <label
                htmlFor="forgot-password-email"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                Email
              </label>
              <input
                id="forgot-password-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-gray-900 placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                placeholder="Enter your email"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition hover:bg-primary-dark disabled:opacity-50"
            >
              {loading ? "Sending..." : "Send Reset Code"}
            </button>
          </form>
        )}

        {step === "reset" && (
          <form onSubmit={handleResetPassword} className="space-y-5">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              A 6-digit code has been sent to <strong>{email}</strong>. Enter it
              below along with your new password.
            </p>
            <div>
              <label
                htmlFor="forgot-password-code"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                Reset Code
              </label>
              <input
                id="forgot-password-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
                maxLength={6}
                className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-center text-2xl tracking-widest text-gray-900 placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                placeholder="000000"
              />
            </div>
            <div>
              <label
                htmlFor="forgot-password-new-password"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                New Password
              </label>
              <PasswordInput
                id="forgot-password-new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
                className="rounded-lg border border-gray-300 px-4 py-2.5 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                placeholder="Enter new password"
              />
            </div>
            <button
              type="submit"
              disabled={loading || code.length !== 6}
              className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition hover:bg-primary-dark disabled:opacity-50"
            >
              {loading ? "Resetting..." : "Reset Password"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStep("email");
                setError("");
              }}
              className="w-full text-sm text-gray-500 hover:text-primary dark:text-gray-400"
            >
              Use a different email
            </button>
          </form>
        )}

        {step === "done" && (
          <div className="space-y-5 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40">
              <svg
                className="h-8 w-8 text-green-600 dark:text-green-300"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">
              Password Reset Successful
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Your password has been updated. You can now sign in with your new
              password.
            </p>
            <Link
              href="/login"
              className="inline-block w-full rounded-lg bg-primary py-2.5 font-medium text-white transition hover:bg-primary-dark"
            >
              Back to Sign In
            </Link>
          </div>
        )}

        {step !== "done" && (
          <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
            Remember your password?{" "}
            <Link
              href="/login"
              className="font-medium text-primary hover:underline"
            >
              Sign In
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
