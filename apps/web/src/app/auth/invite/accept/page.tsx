// Public staff-invite acceptance page — Pearl ERP Stage 1 §8.2
// (gap row 213 closure, 2026-05-23).
//
// What / which modules / why:
//   - Lands the recipient of a /api/v1/user-invites email at
//     /auth/invite/accept?token=<rawNonce>. The page hits the public
//     GET /api/v1/user-invites/:token to render {email, role,
//     tenantName} as read-only context, then collects a password and
//     POSTs to /api/v1/user-invites/:token/accept to materialise the
//     User row.
//   - Mounted at /auth/invite/accept (top-level, not under
//     /dashboard/* or /super-admin/*) so the recipient — who has no
//     session — can reach it without being bounced by the dashboard
//     auth gate.
//   - Uses raw `fetch` (not the shared `api` helper) because the
//     shared helper attaches the auth cookie + CSRF header, neither of
//     which apply on this unauthed surface.

"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

type LoadState = "loading" | "invalid" | "ready" | "submitting" | "done";

interface InviteMetadata {
  email: string;
  role: string;
  tenantName: string | null;
  expiresAt: string;
}

export default function InviteAcceptPage() {
  // Next 16 requires useSearchParams() consumers to sit under a Suspense
  // boundary so the page can statically prerender the shell. Without this
  // wrapper the page crashes at build time with "should be wrapped in a
  // suspense boundary" — surfaced in commit f23f2f6 CI.
  return (
    <Suspense fallback={null}>
      <InviteAcceptPageInner />
    </Suspense>
  );
}

function InviteAcceptPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params?.get("token") ?? "";

  const [state, setState] = useState<LoadState>("loading");
  const [invite, setInvite] = useState<InviteMetadata | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>("");

  // ── Fetch metadata on mount ─────────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setState("invalid");
      setError("This invitation link is missing its token.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/v1/user-invites/${encodeURIComponent(token)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setState("invalid");
          setError(
            res.status === 410
              ? "This invitation link is invalid or has expired."
              : "We couldn't load this invitation. Please try again.",
          );
          return;
        }
        const body = await res.json();
        if (cancelled) return;
        setInvite(body.data as InviteMetadata);
        setState("ready");
      } catch {
        if (cancelled) return;
        setState("invalid");
        setError("We couldn't reach the server. Please try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || state !== "ready") return;
    setError("");
    setState("submitting");
    try {
      const res = await fetch(
        `/api/v1/user-invites/${encodeURIComponent(token)}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          body?.error ??
            "We couldn't accept your invitation. Please try again.",
        );
        setState("ready");
        return;
      }
      setState("done");
      // Brief pause so the success state is visible, then bounce to login.
      setTimeout(() => router.push("/login?invited=1"), 1200);
    } catch {
      setError("We couldn't reach the server. Please try again.");
      setState("ready");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100 p-6 dark:from-gray-900 dark:via-gray-950 dark:to-gray-900">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
        <h1 className="mb-2 text-center text-xl font-semibold text-gray-900 dark:text-gray-100">
          Set Your Password
        </h1>
        <p className="mb-6 text-center text-sm text-gray-500 dark:text-gray-400">
          Finish creating your MedCore account.
        </p>

        {state === "loading" && (
          <p
            data-testid="invite-loading"
            className="text-center text-sm text-gray-500 dark:text-gray-400"
          >
            Validating invitation…
          </p>
        )}

        {state === "invalid" && (
          <div
            data-testid="invite-invalid"
            role="alert"
            className="space-y-4 rounded-lg bg-rose-50 p-4 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
          >
            <p className="font-medium">{error || "Invalid invitation"}</p>
            <p>
              Please contact the administrator who invited you for a fresh
              link.
            </p>
            <Link
              href="/login"
              className="inline-block w-full rounded-lg bg-primary py-2.5 text-center font-medium text-white transition hover:bg-primary-dark"
            >
              Back to Sign In
            </Link>
          </div>
        )}

        {(state === "ready" || state === "submitting") && invite && (
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            <div
              data-testid="invite-metadata"
              className="space-y-2 rounded-lg bg-blue-50 p-4 text-sm text-blue-900 dark:bg-blue-900/30 dark:text-blue-100"
            >
              <p>
                <span className="font-medium">Email:</span>{" "}
                <span data-testid="invite-email">{invite.email}</span>
              </p>
              <p>
                <span className="font-medium">Role:</span>{" "}
                <span data-testid="invite-role">{invite.role}</span>
              </p>
              {invite.tenantName && (
                <p>
                  <span className="font-medium">Workspace:</span>{" "}
                  <span data-testid="invite-tenant">{invite.tenantName}</span>
                </p>
              )}
            </div>

            {error && (
              <div
                role="alert"
                data-testid="invite-error"
                className="rounded-lg bg-red-50 p-3 text-sm text-danger dark:bg-red-900/30 dark:text-red-300"
              >
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor="invite-password"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
              >
                New Password
              </label>
              <input
                id="invite-password"
                data-testid="invite-password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                aria-required="true"
                minLength={8}
                className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-gray-900 placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                placeholder="At least 8 characters, with a letter and a digit"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Use at least 8 characters with a letter and a digit. Avoid
                common passwords.
              </p>
            </div>

            <button
              type="submit"
              data-testid="invite-submit"
              disabled={state === "submitting" || password.length < 8}
              className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition hover:bg-primary-dark disabled:opacity-50"
            >
              {state === "submitting" ? "Saving…" : "Set Password & Continue"}
            </button>
          </form>
        )}

        {state === "done" && (
          <div
            data-testid="invite-done"
            className="space-y-4 rounded-lg bg-green-50 p-4 text-center text-sm text-green-800 dark:bg-green-900/30 dark:text-green-200"
          >
            <p className="font-medium">Password set!</p>
            <p>Redirecting you to sign in…</p>
          </div>
        )}
      </div>
    </div>
  );
}
