// Bare layout for /status (Pearl ERP Stage 1 §8.4, gap row 221).
//
// Renders the public status page WITHOUT the dashboard chrome — no
// sidebar, no LanguageDropdown, no auth gate. Mirrors the minimal
// statuspage.io / status.github.com style. The root layout
// (apps/web/src/app/layout.tsx) still wraps every request with <html>
// + <body> + ThemeBootstrap; this layout adds only a slim header.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "MedCore Status",
  description: "Real-time operational status of MedCore services.",
};

export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="mx-auto max-w-3xl px-4 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100 touch-target inline-flex items-center"
            aria-label="MedCore home"
          >
            MedCore Status
          </Link>
        </div>
      </header>
      <main id="main-content" className="mx-auto max-w-3xl px-4 py-8">
        {children}
      </main>
    </div>
  );
}
