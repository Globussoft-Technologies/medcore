"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

type Step = "email" | "reset" | "done";

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
      setError(err instanceof Error ? err.message : "Something went wrong");
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
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-primary">MedCore</h1>
          <p className="mt-2 text-gray-500">Reset Your Password</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-danger">
            {error}
          </div>
        )}

        {step === "email" && (
          <form onSubmit={handleRequestCode} className="space-y-5">
            <p className="text-sm text-gray-600">
              Enter your email address and we will send you a reset code.
            </p>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
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
            <p className="text-sm text-gray-600">
              A 6-digit code has been sent to <strong>{email}</strong>. Enter it
              below along with your new password.
            </p>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Reset Code
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
                maxLength={6}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-center text-2xl tracking-widest focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="000000"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                New Password
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={6}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
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
              className="w-full text-sm text-gray-500 hover:text-primary"
            >
              Use a different email
            </button>
          </form>
        )}

        {step === "done" && (
          <div className="space-y-5 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <svg
                className="h-8 w-8 text-green-600"
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
            <p className="text-lg font-semibold text-gray-800">
              Password Reset Successful
            </p>
            <p className="text-sm text-gray-600">
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
          <p className="mt-6 text-center text-sm text-gray-500">
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
