// Minimal 404 inside the patient PWA surface (gap #5 piece 1 of 4).
// Scoped to the patient route group so we don't bounce users into the staff
// dashboard's 404 chrome.
import Link from "next/link";

export default function PatientNotFound() {
  return (
    <section
      className="space-y-4 py-8 text-center"
      data-testid="patient-not-found"
    >
      <h1 className="text-2xl font-semibold tracking-tight">
        Page not found
      </h1>
      <p className="text-base text-slate-600">
        The page you&rsquo;re looking for doesn&rsquo;t exist or has moved.
      </p>
      <Link
        href="/patient"
        className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
        data-testid="patient-not-found-home-link"
      >
        Back to home
      </Link>
    </section>
  );
}
