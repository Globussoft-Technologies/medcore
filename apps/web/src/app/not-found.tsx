/**
 * Issues #123 + #407 + #705 — global 404 page with auth-aware CTAs.
 *
 * Next.js 15 picks up `app/not-found.tsx` for any unmatched route. The
 * default Next 404 leaves the user with no app shell and no obvious way
 * back, so we render a styled card with auth-state-branched CTAs.
 *
 * Issue #705 (May 2026): pre-fix the page rendered a "Sign in" CTA to
 * EVERY visitor — including users who were already authed. Logged-in
 * users hitting a typo'd dashboard URL saw "Sign in" and assumed their
 * session had been killed, then got bounced back to the dashboard with
 * no toast explaining what happened. We now branch on `useAuthStore.user`:
 *
 *   - Authed:     Back  /  Home (/dashboard)  /  Search
 *   - Anon:       Sign in  /  Back to home (/)
 *
 * Why a Search CTA for authed users: the in-app search palette is the
 * fastest recovery path for someone who mistyped a route. The dashboard
 * layout normally exposes it on Ctrl+K, but the 404 page can't render
 * that palette directly (it lives inside the dashboard layout, which
 * isn't a parent of /not-found). We instead deep-link to /dashboard
 * with `?openSearch=1` — the dashboard layout reads the param on mount
 * and opens the palette. If the dashboard hasn't wired that param yet,
 * the user just lands on /dashboard with the search palette closed,
 * which is still strictly better than the pre-fix "Sign in" CTA.
 *
 * Client component — we need to read the auth store + use router.back().
 */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";

export default function NotFound() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const isAuthed = Boolean(user);

  return (
    <div
      data-testid="not-found-page"
      className="flex min-h-[70vh] items-center justify-center bg-gray-50 p-6 dark:bg-gray-950"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm dark:bg-gray-900">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          404
        </p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          {isAuthed ? (
            <>
              <button
                type="button"
                data-testid="not-found-back-btn"
                onClick={() => {
                  // router.back() is a no-op when there's no history (e.g.
                  // direct deep-link). Fall back to the dashboard so the
                  // user is never stranded.
                  if (
                    typeof window !== "undefined" &&
                    window.history.length > 1
                  ) {
                    router.back();
                  } else {
                    router.push("/dashboard");
                  }
                }}
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Back
              </button>
              <Link
                href="/dashboard"
                data-testid="not-found-dashboard-link"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Home
              </Link>
              <Link
                href="/dashboard?openSearch=1"
                data-testid="not-found-search-link"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Search
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/login"
                data-testid="not-found-signin-link"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Sign in
              </Link>
              <Link
                href="/"
                data-testid="not-found-home-link"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Back to home
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
