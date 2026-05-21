// Patient PWA landing page (Pearl §6.1 — gap #5 piece 1 of 4).
// Placeholder welcome surface: just two CTAs. No data fetching, no auth — that's piece 2.
// "Book an appointment" is intentionally aria-disabled until sign-in lands in piece 2.
import Link from "next/link";

export default function PatientLandingPage() {
  return (
    <section className="space-y-6 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to your Patient Portal
        </h1>
        <p className="text-base text-slate-600">
          Sign in to your account to view appointments, prescriptions, bills,
          and medical records — all in one place.
        </p>
      </header>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          href="/patient/login"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="patient-landing-signin"
        >
          Sign in
        </Link>
        <a
          href="#"
          aria-disabled="true"
          title="Available after sign in"
          onClick={(e) => e.preventDefault()}
          className="inline-flex h-11 min-w-[44px] cursor-not-allowed items-center justify-center rounded-md border border-slate-300 px-6 text-sm font-medium text-slate-400"
          data-testid="patient-landing-book"
        >
          Book an appointment
        </a>
      </div>
    </section>
  );
}
