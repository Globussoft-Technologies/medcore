// Patient PWA route group layout (Pearl §6.1 / §6.2 — gap #5 piece 1 of 4).
// Deliberately bare: NO dashboard topbar / sidebar / LanguageDropdown / BranchPicker.
// This is the installable PWA surface — mobile-first, 44px touch targets via Tailwind defaults,
// service worker registered client-side so the shell is offline-tolerant (cache strategy lands
// in piece 4). Root `apps/web/src/app/layout.tsx` already provides <html>/<body> + ThemeBootstrap
// + ToastContainer, so this layout is just the patient surface chrome.
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { PatientServiceWorkerRegistration } from "@/components/PatientServiceWorkerRegistration";
import { InstallPWAButton } from "@/components/InstallPWAButton";

export const metadata: Metadata = {
  title: "Patient Portal — MedCore",
  description:
    "Book appointments, view prescriptions, pay bills, and access your records.",
  // Per-segment manifest (Next 14+); see ./manifest.ts.
  manifest: "/patient/manifest.webmanifest",
  appleWebApp: {
    title: "Patient Portal",
    capable: true,
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0f172a",
};

export default function PatientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid="patient-shell"
      className="flex min-h-screen flex-col bg-white text-slate-900"
    >
      <PatientServiceWorkerRegistration />
      <header className="border-b border-slate-200 px-4 py-3">
        <div className="mx-auto flex max-w-screen-md items-center justify-between">
          <Link
            href="/patient"
            className="text-lg font-semibold tracking-tight"
            data-testid="patient-shell-brand"
          >
            Patient Portal
          </Link>
          <div className="flex items-center gap-2">
            <InstallPWAButton />
            <Link
              href="/patient/login"
              className="inline-flex h-11 min-w-[44px] items-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white"
              data-testid="patient-shell-login-link"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-screen-md flex-1 px-4 py-6">
        {children}
      </main>
      <footer className="border-t border-slate-200 px-4 py-4 text-xs text-slate-500">
        <div className="mx-auto max-w-screen-md">
          Patient Portal — secured by your hospital.
        </div>
      </footer>
    </div>
  );
}
