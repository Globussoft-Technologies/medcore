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
import { PatientServiceWorkerRegistration } from "@/components/PatientServiceWorkerRegistration";
import { InstallPWAButton } from "@/components/InstallPWAButton";
import DashboardLayout from "@/app/dashboard/layout";

function BarePatientShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="patient-shell"
      className="flex min-h-screen flex-col bg-white text-slate-900"
    >
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
