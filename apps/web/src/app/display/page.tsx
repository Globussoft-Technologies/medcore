"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import {
  DisplayHeader,
  DoctorCard,
  displayActivity,
  useDisplayData,
} from "./_shared";

// useSearchParams() must sit inside a Suspense boundary or Next bails the
// whole route out of static prerender at build time.
export default function TokenDisplayPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950" />}>
      <TokenDisplayInner />
    </Suspense>
  );
}

function TokenDisplayInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `?scoped=1` is set when a logged-in staff member (e.g. a receptionist)
  // opens the board from the dashboard. In that mode the board fetches the
  // authenticated, tenant-scoped queue (their own hospital only) and gains a
  // close affordance (Esc key + the X button) that returns to the dashboard.
  // The public lobby-TV path (/display with no param) is unscoped and has no
  // close button — it's meant to run unattended full-screen.
  const scoped = searchParams.get("scoped") === "1";

  const { doctors, currentTime, connected, offline, lastUpdate } =
    useDisplayData(scoped);

  // Esc closes the scoped board and returns to the dashboard.
  useEffect(() => {
    if (!scoped) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.push("/dashboard");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scoped, router]);

  return (
    // The board is a dark waiting-area display. The root app/layout's light
    // <body> wins over the display layout, so we set the dark theme on the page
    // container itself to guarantee readable contrast.
    <div className="relative flex min-h-screen flex-col bg-slate-950 px-8 py-6 text-white">
      {scoped && (
        <button
          type="button"
          onClick={() => router.push("/dashboard")}
          aria-label="Close token board"
          data-testid="display-close-button"
          className="absolute right-4 top-4 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full border border-slate-700 bg-slate-900/80 text-slate-300 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          <X size={22} />
        </button>
      )}

      <DisplayHeader
        currentTime={currentTime}
        connected={connected}
        offline={offline}
        lastUpdate={lastUpdate}
      />

      <main className="flex-1">
        {doctors.length === 0 ? (
          <div className="flex h-64 items-center justify-center">
            <p className="text-2xl text-slate-500">
              {offline ? "No cached data available" : "No doctors on duty today"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 xl:grid-cols-3">
            {[...doctors]
              .sort((a, b) => displayActivity(b) - displayActivity(a))
              .map((doc) => (
                // Click a card → focused single-doctor view at its own route.
                // Preserve the scoped flag so the focused view stays tenant-
                // scoped + keeps its close affordances.
                <Link
                  key={doc.doctorId}
                  href={
                    scoped
                      ? `/display/${doc.doctorId}?scoped=1`
                      : `/display/${doc.doctorId}`
                  }
                  aria-label={`Open ${doc.doctorName}'s board`}
                  className="block h-full rounded-2xl transition hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  <DoctorCard doc={doc} />
                </Link>
              ))}
          </div>
        )}
      </main>

      <footer className="mt-8 text-center text-sm text-slate-600">
        Token Display Board &mdash; Auto-refreshes every{" "}
        {offline ? "30s (offline)" : "10s"}
        {scoped && " · Press Esc to close"}
      </footer>
    </div>
  );
}
