// Shared chrome for the /legal/* surface — privacy, terms, data processing.
//
// Server component so each page can export its own metadata and the route
// works without an auth session (these MUST be reachable to logged-out
// visitors who are signing up). Footer + brand header mirror the patient
// PWA's bare shell so the legal pages feel like part of the same site
// rather than a stripped-down dump.

import type { Metadata } from "next";
import { HeartPulse, Shield } from "lucide-react";

export const metadata: Metadata = {
  title: "Legal — MedCore",
  description:
    "Privacy policy, terms of service, and data processing notice for MedCore Health.",
};

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-white via-blue-50/30 to-white text-gray-900 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-30 border-b border-gray-200/80 bg-white/80 backdrop-blur-md dark:border-gray-800/80 dark:bg-gray-950/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <a href="/" className="group inline-flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-emerald-500 text-white shadow-sm shadow-blue-600/20">
              <HeartPulse className="h-5 w-5" />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-base font-semibold tracking-tight text-gray-900 dark:text-white">
                MedCore
              </span>
              <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Legal
              </span>
            </span>
          </a>
          <nav className="hidden gap-6 text-sm text-gray-600 sm:flex dark:text-gray-300">
            <a href="/legal/privacy" className="hover:text-blue-600 dark:hover:text-blue-400">
              Privacy
            </a>
            <a href="/legal/terms" className="hover:text-blue-600 dark:hover:text-blue-400">
              Terms
            </a>
            <a href="/legal/data-processing" className="hover:text-blue-600 dark:hover:text-blue-400">
              Data processing
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        {children}
      </main>

      <footer className="border-t border-gray-200 bg-white/60 px-4 py-5 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-950/60 dark:text-gray-500">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 sm:flex-row">
          <span className="inline-flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5 text-emerald-500" />
            Secured by your hospital — DPDP Act 2023 compliant.
          </span>
          <span>&copy; {new Date().getFullYear()} MedCore Health.</span>
        </div>
      </footer>
    </div>
  );
}
