// Minimal 404 inside the super-admin surface (gap #6 piece 1 of 4).
// Scoped to the super-admin route group so unknown paths don't bounce the
// operator into the staff dashboard's 404 chrome.
import Link from "next/link";

export default function SuperAdminNotFound() {
  return (
    <section
      className="space-y-4 py-8 text-center"
      data-testid="super-admin-not-found"
    >
      <h1 className="text-2xl font-semibold tracking-tight">
        Page not found
      </h1>
      <p className="text-base text-slate-600">
        The super-admin page you&rsquo;re looking for doesn&rsquo;t exist or
        has moved.
      </p>
      <Link
        href="/super-admin"
        className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
        data-testid="super-admin-not-found-home-link"
      >
        Back to console
      </Link>
    </section>
  );
}
