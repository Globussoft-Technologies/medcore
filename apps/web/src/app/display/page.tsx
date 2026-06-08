"use client";

import Link from "next/link";
import {
  DisplayHeader,
  DoctorCard,
  displayActivity,
  useDisplayData,
} from "./_shared";

export default function TokenDisplayPage() {
  const { doctors, currentTime, connected, offline, lastUpdate } =
    useDisplayData();

  return (
    // The board is a dark waiting-area display. The root app/layout's light
    // <body> wins over the display layout, so we set the dark theme on the page
    // container itself to guarantee readable contrast.
    <div className="flex min-h-screen flex-col bg-slate-950 px-8 py-6 text-white">
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
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[...doctors]
              .sort((a, b) => displayActivity(b) - displayActivity(a))
              .map((doc) => (
                // Click a card → focused single-doctor view at its own route.
                <Link
                  key={doc.doctorId}
                  href={`/display/${doc.doctorId}`}
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
      </footer>
    </div>
  );
}
