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
import { HeartPulse } from "lucide-react";
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
            className="group inline-flex h-11 items-center gap-2.5"
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
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-full bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700"
              data-testid="patient-shell-login-link"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>
      <main className="flex w-full flex-1 items-stretch">{children}</main>
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
