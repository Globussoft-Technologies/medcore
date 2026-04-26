"use client";

/**
 * Issue #65 — Friendly route-segment error UI.
 *
 * Next.js 15 App Router renders this component when an unhandled exception
 * bubbles up from a route under `/(*)`. It does NOT render when the upstream
 * Next.js process itself is down — in that case nginx serves its own 502
 * page and we need an `error_page` directive on the proxy. See
 * `docs/DEPLOY.md` (nginx error_page) for the required nginx-side change.
 *
 * The intent of this component is purely UX: replace the white-screen-of-
 * stack-trace (or the raw 500 JSON) with a polite, MedCore-branded message
 * so users understand the system is degraded but recoverable, and offer a
 * one-click retry via the `reset` callback Next provides.
 */

import { useEffect } from "react";
import Link from "next/link";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Best-effort client-side log. Server-side logs already capture the full
    // stack via Next.js' built-in error reporting.
    if (typeof window !== "undefined" && (window as any).console) {
      console.error("[medcore] route error", error);
    }
  }, [error]);

  return (
    <div
      data-testid="route-error-boundary"
      className="flex min-h-[50vh] w-full flex-col items-center justify-center px-6 text-center"
    >
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 text-red-600">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-7 w-7"
          aria-hidden="true"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <h1 className="mb-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
        We&apos;re experiencing issues
      </h1>
      <p className="mb-6 max-w-md text-sm text-gray-600 dark:text-gray-300">
        MedCore couldn&apos;t complete that request. Our team has been notified.
        Please try again in a few minutes — if the problem keeps happening,
        contact your administrator.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          data-testid="route-error-retry"
          onClick={() => reset()}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          Back to dashboard
        </Link>
      </div>
      {error?.digest && (
        <p className="mt-6 text-[11px] text-gray-400">
          Reference: <code className="rounded bg-gray-100 px-1.5 py-0.5">{error.digest}</code>
        </p>
      )}
    </div>
  );
}
