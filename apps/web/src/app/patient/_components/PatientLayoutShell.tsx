// Picks the right chrome for a /patient/* route based on pathname.
//
// Why this exists: /patient/dashboard is owned by the patient surface
// URL-wise but UX-wise should live inside the same sidebar+topbar shell
// that powers /dashboard for staff — that surface is already PATIENT-aware
// (apps/web/src/app/dashboard/layout.tsx has a PATIENT entry in
// navByRole + bottomNavByRole, gated by useAuthStore().user.role). For
// every OTHER /patient/* route (login, register, appointments, bills,
// records, prescriptions, profile, book) we keep the bare mobile-first
// PWA shell — those pages were built for the installable PWA form factor
// and the staff chrome would crowd them on a phone.
//
// SW registration sits at the top so it runs regardless of which chrome
// is active. Otherwise a patient who launches the PWA directly into
// /patient/dashboard would never install the worker → offline support
// breaks.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HeartPulse, Shield } from "lucide-react";
import { PatientServiceWorkerRegistration } from "@/components/PatientServiceWorkerRegistration";
import { InstallPWAButton } from "@/components/InstallPWAButton";
import DashboardLayout from "@/app/dashboard/layout";

function BarePatientShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="patient-shell"
      className="flex min-h-screen flex-col bg-gradient-to-b from-white via-blue-50/30 to-white text-gray-900 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 dark:text-gray-100"
    >
      <header className="sticky top-0 z-30 border-b border-gray-200/80 bg-white/80 backdrop-blur-md dark:border-gray-800/80 dark:bg-gray-950/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/patient"
            className="group inline-flex items-center gap-2.5"
            data-testid="patient-shell-brand"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-emerald-500 text-white shadow-sm shadow-blue-600/20 transition group-hover:shadow-blue-600/30">
              <HeartPulse className="h-5 w-5" />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-base font-semibold tracking-tight text-gray-900 dark:text-white">
                MedCore
              </span>
              <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Patient Portal
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <InstallPWAButton />
            <Link
              href="/patient/login"
              className="inline-flex h-10 min-w-[44px] items-center justify-center rounded-full bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700"
              data-testid="patient-shell-login-link"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>
      <main className="flex w-full flex-1 items-stretch">{children}</main>
      <footer className="border-t border-gray-200 bg-white/60 px-4 py-8 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-950/60 dark:text-gray-500">
        <div className="mx-auto max-w-6xl">
          {/* Legal column — mirrors the standard footer "Legal" group with
              the three statutory documents linked. These pages live at
              /legal/* and are accessible without an auth session so a
              prospective patient can read them before signing up. */}
          <div className="mb-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
            <div>
              <p className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-200">
                Legal
              </p>
              {/* Plain <a> tags (not next/link) so the navigation is a
                  full-page load that the patient route-group's client
                  layout can't intercept. The legal pages live in a
                  separate route segment with its own layout — soft-nav
                  was failing because Next was trying to keep the patient
                  shell mounted while swapping in a sibling layout. */}
              <ul className="space-y-1.5">
                <li>
                  <a
                    href="/legal/privacy"
                    className="hover:text-blue-600 dark:hover:text-blue-400"
                  >
                    Privacy
                  </a>
                </li>
                <li>
                  <a
                    href="/legal/terms"
                    className="hover:text-blue-600 dark:hover:text-blue-400"
                  >
                    Terms
                  </a>
                </li>
                <li>
                  <a
                    href="/legal/data-processing"
                    className="hover:text-blue-600 dark:hover:text-blue-400"
                  >
                    Data processing
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="flex flex-col items-center justify-between gap-2 border-t border-gray-200/70 pt-4 sm:flex-row dark:border-gray-800/70">
            <span className="inline-flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5 text-emerald-500" />
              Secured by your hospital — DPDP Act 2023 compliant.
            </span>
            <span>&copy; {new Date().getFullYear()} MedCore Health.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function PatientLayoutShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // Deny-list — pages that MUST stay on the bare PWA shell. These are the
  // unauth surfaces: the staff DashboardLayout requires an auth session and
  // would bounce a logged-out visitor to /login before they could see the
  // form. Includes:
  //   • /patient (landing) — exact match: unauthed marketing CTA. Authed
  //     visitors get bounced to /patient/dashboard by the page itself, so
  //     the bare-shell render only happens for the brief marketing surface.
  //   • /patient/login + /patient/register — prefix match (covers future
  //     sub-routes like /patient/login/verify if added).
  // Everything else under /patient/* (including dynamic routes like
  // /patient/bills/[id]/pay) gets the staff chrome so the patient has one
  // consistent sidebar/topbar after sign-in.
  const path = pathname ?? "";
  const isBareShell =
    path === "/patient" ||
    path.startsWith("/patient/login") ||
    path.startsWith("/patient/register");
  const useStaffChrome = !isBareShell;

  return (
    <>
      <PatientServiceWorkerRegistration />
      {useStaffChrome ? (
        <DashboardLayout>{children}</DashboardLayout>
      ) : (
        <BarePatientShell>{children}</BarePatientShell>
      )}
    </>
  );
}
