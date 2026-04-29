/**
 * Issue #123 — global 404 page with navigation back into the app.
 *
 * Next.js 15 picks up `app/not-found.tsx` for any unmatched route. The
 * default Next 404 leaves the user with no app shell and no obvious way
 * back, so we render a styled card with a context-aware CTA:
 *   • Logged-in users → "Back to dashboard"
 *   • Logged-out users → "Sign in"  (issue #407 — we used to send them to
 *     /dashboard which silently 401-bounced them to /login anyway, but the
 *     extra hop felt like the page was broken)
 *
 * The "Back to home" CTA is always available as a low-key escape hatch.
 *
 * Client component (issue #407) — we need to read the auth store to decide
 * which CTA to show. The page is small enough that the extra JS cost is
 * irrelevant.
 */

"use client";

import Link from "next/link";
import { useAuthStore } from "@/lib/store";

export default function NotFound() {
  const user = useAuthStore((s) => s.user);
  const isAuthed = Boolean(user);
  const primaryHref = isAuthed ? "/dashboard" : "/login";
  const primaryLabel = isAuthed ? "Back to dashboard" : "Sign in";

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
          <Link
            href={primaryHref}
            data-testid="not-found-dashboard-link"
            className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            {primaryLabel}
          </Link>
          <Link
            href="/"
            data-testid="not-found-home-link"
            className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
