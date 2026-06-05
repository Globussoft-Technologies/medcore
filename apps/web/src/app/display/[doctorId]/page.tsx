"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { DisplayHeader, DoctorCard, useDisplayData } from "../_shared";

// Focused single-doctor display board — same hospital header + clock as the
// full board, one large doctor card. Public route (no auth), powered by the
// same /queue/display data.
export default function DoctorDisplayPage({
  params,
}: {
  params: Promise<{ doctorId: string }>;
}) {
  const { doctorId } = use(params);
  const { doctors, currentTime, connected, offline, lastUpdate } =
    useDisplayData();

  const doc = doctors.find((d) => d.doctorId === doctorId) ?? null;

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 px-8 py-6 text-white">
      <DisplayHeader
        currentTime={currentTime}
        connected={connected}
        offline={offline}
        lastUpdate={lastUpdate}
      />

      <main className="flex flex-1 items-stretch justify-center pb-4">
        {doc ? (
          // Single-doctor focus view: the card STRETCHES to fill the whole
          // board area (full width + height), content vertically centred, with
          // much larger internal type so it reads across the room.
          <div className="flex w-full max-w-6xl items-stretch text-3xl [&>div]:flex [&>div]:w-full [&>div]:flex-col [&>div]:justify-center [&_.text-2xl]:text-5xl [&_.text-3xl]:text-6xl [&_.text-4xl]:text-7xl [&_.text-5xl]:text-8xl [&_.text-6xl]:text-9xl [&_.text-7xl]:text-9xl">
            <DoctorCard doc={doc} />
          </div>
        ) : (
          <div className="flex h-64 items-center justify-center">
            <p className="text-2xl text-slate-500">
              {doctors.length === 0
                ? offline
                  ? "No cached data available"
                  : "Loading…"
                : "Doctor not found"}
            </p>
          </div>
        )}
      </main>

      <footer className="mt-8 flex flex-col items-center gap-2 pt-8 text-center text-sm text-slate-600">
        <Link
          href="/display"
          className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-400 transition hover:text-white"
        >
          <ArrowLeft size={12} aria-hidden="true" />
          Back to display board
        </Link>
        <span>
          Token Display Board &mdash; Auto-refreshes every{" "}
          {offline ? "30s (offline)" : "10s"}
        </span>
      </footer>
    </div>
  );
}
