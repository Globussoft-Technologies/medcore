"use client";

import { Suspense, use, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { DisplayHeader, DoctorCard, useDisplayData } from "../_shared";

// Focused single-doctor display board — same hospital header + clock as the
// full board, one large doctor card. Public route (no auth) by default; when
// opened with `?scoped=1` (a logged-in staff member drilled in from the
// dashboard board) it fetches the authenticated, tenant-scoped queue and Esc
// returns to the dashboard.
export default function DoctorDisplayPage({
  params,
}: {
  params: Promise<{ doctorId: string }>;
}) {
  const { doctorId } = use(params);
  // useSearchParams() (read inside the inner component) needs a Suspense
  // boundary to avoid bailing the route out of static prerender.
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950" />}>
      <DoctorDisplayInner doctorId={doctorId} />
    </Suspense>
  );
}

function DoctorDisplayInner({ doctorId }: { doctorId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scoped = searchParams.get("scoped") === "1";

  const { doctors, currentTime, connected, offline, lastUpdate } =
    useDisplayData(scoped);

  const doc = doctors.find((d) => d.doctorId === doctorId) ?? null;

  // Esc returns the scoped board to the dashboard (mirrors the full board).
  useEffect(() => {
    if (!scoped) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.push("/dashboard");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scoped, router]);

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
          href={scoped ? "/display?scoped=1" : "/display"}
          className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-400 transition hover:text-white"
        >
          <ArrowLeft size={12} aria-hidden="true" />
          Back to display board
        </Link>
        <span>
          Token Display Board &mdash; Auto-refreshes every{" "}
          {offline ? "30s (offline)" : "10s"}
          {scoped && " · Press Esc to close"}
        </span>
      </footer>
    </div>
  );
}
