"use client";

// Issue #179: Restricted admin pages used to bounce non-admin users to a
// chromeless / generic Next.js 404 (no sidebar, no app shell). The role-gate
// hooks on individual pages now redirect here instead, so the dashboard
// layout (sidebar + nav) is preserved and the user gets a clear "Access
// Denied" message + a way back.
//
// File location matters: living under /dashboard/* means Next.js wraps this
// page with the existing dashboard layout automatically.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { useAuthStore } from "@/lib/store";

export default function NotAuthorizedPage() {
  const user = useAuthStore((s) => s.user);
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "";

  return (
    <div
      data-testid="access-denied-page"
      className="mx-auto flex max-w-2xl flex-col items-center py-12 text-center"
    >
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
        <ShieldAlert size={32} aria-hidden="true" />
      </div>
      <h1 className="mb-3 text-2xl font-bold text-gray-900 dark:text-gray-100">
        Access Denied
      </h1>
      <p className="mb-2 text-gray-700 dark:text-gray-300">
        {user?.role
          ? `Your role (${user.role}) doesn't have access to this page.`
          : "Your account doesn't have access to this page."}
      </p>
      {from && (
        <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
          Requested page:{" "}
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
            {from}
          </code>
        </p>
      )}
      {!from && <div className="mb-6" />}
      <div className="flex flex-col items-center gap-3 sm:flex-row">
        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
        >
          Back to Dashboard
        </Link>
        <Link
          href="/login"
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          Sign in as a different user
        </Link>
      </div>
    </div>
  );
}
