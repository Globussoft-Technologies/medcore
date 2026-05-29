// Mandatory-TOTP enrolment-at-login page — Pearl ERP Stage 1 §8.2.
//
// What / which modules / why:
//   - Lands an admin / super-admin who tried to sign in but doesn't
//     yet have 2FA enrolled. The login route returned HTTP 412 with
//     a one-shot enrolToken; the store cached it in sessionStorage
//     before redirecting here.
//   - Calls POST /api/v1/auth/2fa/enrol-setup with the enrolToken
//     to receive { secret, otpauthUri, qrDataUrl, backupCodes }.
//     Renders the PNG QR for an authenticator app to scan + a manual
//     secret fallback + the backup-code grid (download + copy).
//   - On verify, POSTs to /api/v1/auth/2fa/enrol-verify with the
//     6-digit code. Success → flips User.twoFactorEnabled=true on the
//     server and bounces back to /login with a success banner so the
//     operator signs in normally (which routes through the existing
//     verify-login 2FA-code step).
//   - Mounted at /auth/enrol-totp (top-level, not under /dashboard/*)
//     so unauthed callers can reach it. Uses raw `fetch` because the
//     shared `api` helper attaches the auth cookie + CSRF header,
//     neither of which exists in this unauthed window.

"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Shield, Copy, Check, AlertCircle, Loader2 } from "lucide-react";

type SetupData = {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
  backupCodes: string[];
  email: string | null;
};

type Stage = "loading" | "ready" | "verifying" | "expired" | "no-token";

export default function EnrolTotpPage() {
  return (
    <Suspense fallback={null}>
      <EnrolTotpInner />
    </Suspense>
  );
}

function EnrolTotpInner() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("loading");
  const [setup, setSetup] = useState<SetupData | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [enrolMeta, setEnrolMeta] = useState<{
    token: string;
    role?: string;
    email?: string | null;
  } | null>(null);

  // Pull the one-shot enrolToken out of sessionStorage where /login
  // stashed it. If it isn't there the user navigated here directly
  // (refresh, deep link) — bounce them back to /login.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem("medcore_enrol_totp");
    } catch {
      raw = null;
    }
    if (!raw) {
      setStage("no-token");
      return;
    }
    let parsed: { token?: string; role?: string; email?: string | null };
    try {
      parsed = JSON.parse(raw);
    } catch {
      setStage("no-token");
      return;
    }
    if (!parsed.token) {
      setStage("no-token");
      return;
    }
    setEnrolMeta({
      token: parsed.token,
      role: parsed.role,
      email: parsed.email ?? null,
    });
  }, []);

  // Once we have the enrolToken, fetch the QR + secret + backup codes.
  useEffect(() => {
    if (!enrolMeta) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/v1/auth/2fa/enrol-setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enrolToken: enrolMeta.token }),
        });
        if (cancelled) return;
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStage("expired");
          // Prefer the friendlier `message` field (CSRF + some other
          // middlewares set it); fall back to `error`, then a generic.
          setError(
            body?.message ??
              body?.error ??
              "Your enrolment link has expired. Please sign in again.",
          );
          return;
        }
        setSetup(body.data as SetupData);
        setStage("ready");
      } catch {
        if (cancelled) return;
        setStage("expired");
        setError("Something went wrong loading your enrolment. Try signing in again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enrolMeta]);

  const roleCopy = useMemo(() => {
    const r = enrolMeta?.role;
    if (r === "SUPER_ADMIN" || r === "ADMIN") {
      return r === "SUPER_ADMIN"
        ? "Two-factor authentication is required for every super-admin account."
        : "Your hospital requires admins to use two-factor authentication.";
    }
    return "Two-factor authentication is required for this account.";
  }, [enrolMeta]);

  async function verify() {
    if (!enrolMeta) return;
    const trimmed = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(trimmed)) {
      setError("Enter the 6-digit code shown in your authenticator app.");
      return;
    }
    setStage("verifying");
    setError("");
    try {
      const res = await fetch("/api/v1/auth/2fa/enrol-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrolToken: enrolMeta.token, code: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStage("ready");
        setError(
          body?.message ??
            body?.error ??
            "That code didn't match. Try the next 6-digit code.",
        );
        return;
      }
      // Success — drop the cached enrolToken + flash a banner the
      // /login page picks up.
      try {
        sessionStorage.removeItem("medcore_enrol_totp");
        sessionStorage.setItem(
          "medcore_enrol_done",
          "Two-factor authentication is set up. Please sign in to continue.",
        );
      } catch {
        /* sessionStorage disabled — banner just won't show */
      }
      router.push("/login");
    } catch {
      setStage("ready");
      setError("Couldn't reach the server. Check your connection and retry.");
    }
  }

  function downloadBackupCodes() {
    if (!setup) return;
    const blob = new Blob([setup.backupCodes.join("\n") + "\n"], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "medcore-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 dark:bg-slate-900">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-slate-800">
        {/* Header */}
        <div className="border-b border-slate-200 px-6 py-5 dark:border-slate-700">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
              <Shield size={18} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Set up two-factor authentication
              </h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {roleCopy}
              </p>
              {enrolMeta?.email && (
                <p className="mt-1 truncate text-xs text-slate-400 dark:text-slate-500">
                  Account: {enrolMeta.email}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {stage === "loading" && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500 dark:text-slate-400">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              Generating your authenticator setup…
            </div>
          )}

          {stage === "no-token" && (
            <div className="space-y-3 py-8 text-center text-sm">
              <AlertCircle
                size={32}
                className="mx-auto text-amber-500"
                aria-hidden="true"
              />
              <p className="text-slate-700 dark:text-slate-200">
                Your sign-in session timed out before two-factor setup could
                finish.
              </p>
              <Link
                href="/login"
                className="inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Back to sign in
              </Link>
            </div>
          )}

          {stage === "expired" && (
            <div className="space-y-3 py-8 text-center text-sm">
              <AlertCircle
                size={32}
                className="mx-auto text-rose-500"
                aria-hidden="true"
              />
              <p className="text-slate-700 dark:text-slate-200">{error}</p>
              <Link
                href="/login"
                className="inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Back to sign in
              </Link>
            </div>
          )}

          {(stage === "ready" || stage === "verifying") && setup && (
            <div className="space-y-5">
              {/* Step 1 — scan */}
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Step 1 · Scan with an authenticator app
                </p>
                <div className="flex flex-col items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/40 sm:flex-row sm:items-start">
                  <img
                    src={setup.qrDataUrl}
                    alt="Two-factor authentication QR code"
                    className="h-44 w-44 rounded-md border border-slate-200 bg-white p-1 dark:border-slate-700"
                  />
                  <div className="min-w-0 flex-1 text-xs text-slate-600 dark:text-slate-300">
                    <p className="mb-2 leading-relaxed">
                      Open Google Authenticator, Authy, 1Password, or any TOTP
                      app and tap <strong>Add account</strong> →{" "}
                      <strong>Scan QR code</strong>.
                    </p>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Or enter this secret by hand
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="break-all rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        {setup.secret}
                      </code>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard
                            .writeText(setup.secret)
                            .catch(() => undefined);
                          setCopiedSecret(true);
                          setTimeout(() => setCopiedSecret(false), 1500);
                        }}
                        className="rounded p-1 text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
                        title="Copy secret"
                      >
                        {copiedSecret ? (
                          <Check size={13} aria-hidden="true" />
                        ) : (
                          <Copy size={13} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Step 2 — backup codes */}
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Step 2 · Save your backup codes
                </p>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                  <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-200">
                    Keep these somewhere safe — they let you sign in if you lose
                    your phone. They're shown only once.
                  </p>
                  <div className="grid grid-cols-2 gap-2 rounded-md bg-white p-2 font-mono text-xs text-slate-700 dark:bg-slate-900/60 dark:text-slate-200 sm:grid-cols-5">
                    {setup.backupCodes.map((c) => (
                      <div key={c} className="text-center">
                        {c}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={downloadBackupCodes}
                    className="mt-2 text-xs font-medium text-amber-700 hover:underline dark:text-amber-300"
                  >
                    Download as .txt
                  </button>
                </div>
              </div>

              {/* Step 3 — verify */}
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Step 3 · Enter the 6-digit code from your app
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/[^0-9]/g, ""))
                    }
                    placeholder="123456"
                    disabled={stage === "verifying"}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-center text-lg tracking-[0.4em] focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 sm:w-40"
                    data-testid="enrol-totp-code"
                  />
                  <button
                    type="button"
                    onClick={verify}
                    disabled={stage === "verifying" || code.length !== 6}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
                    data-testid="enrol-totp-verify"
                  >
                    {stage === "verifying" ? (
                      <>
                        <Loader2
                          size={14}
                          className="animate-spin"
                          aria-hidden="true"
                        />
                        Verifying…
                      </>
                    ) : (
                      "Verify & finish"
                    )}
                  </button>
                </div>
                {error && (
                  <p
                    role="alert"
                    className="mt-2 text-xs text-rose-600 dark:text-rose-400"
                  >
                    {error}
                  </p>
                )}
              </div>

              <p className="border-t border-slate-200 pt-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                Lost your authenticator?{" "}
                <Link
                  href="/login"
                  className="font-medium text-primary hover:underline"
                >
                  Back to sign in
                </Link>{" "}
                — you can ask the main super-admin to reset your enrolment.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
