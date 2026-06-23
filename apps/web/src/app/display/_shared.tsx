"use client";

// Shared building blocks for the public Token Display Board:
//   - the data hook (fetch /queue/display + cache + poll + socket + clock)
//   - the header (hospital name + live clock + offline banner)
//   - the per-doctor card + its helpers
// Used by both the full board (/display) and the single-doctor view
// (/display/[doctorId]).

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { api } from "@/lib/api";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
const WS_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const CACHE_KEY = "medcore_display_queue_cache";

export type AppointmentMode = "CALLING" | "TOKEN" | "SLOT";

export interface UpcomingSlot {
  slotStart: string;
  patientLabel: string;
  status: string;
}

export interface DoctorQueue {
  doctorId: string;
  doctorName: string;
  specialization: string | null;
  appointmentMode?: AppointmentMode;
  currentToken: number | null;
  nextToken?: number | null;
  currentArrivalSeq?: number | null;
  // CALLING mode: redacted names of patients being called right now.
  callingNow?: string[];
  upcomingSlots?: UpcomingSlot[];
  waitingCount: number;
}

interface CachedPayload {
  data: DoctorQueue[];
  ts: number;
}

function readCache(): CachedPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(data: DoctorQueue[]) {
  if (typeof window === "undefined") return;
  try {
    const payload: CachedPayload = { data, ts: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota errors
  }
}

// Display-board ordering: doctors with patients float to the top. A doctor
// actively serving (token / arrival seq) or calling someone outranks those
// merely with a waiting queue, which in turn outrank idle (empty) doctors.
export function displayActivity(d: DoctorQueue): number {
  const serving =
    d.currentToken != null || d.currentArrivalSeq != null ? 10000 : 0;
  const calling = (d.callingNow?.length ?? 0) > 0 ? 5000 : 0;
  return serving + calling + (d.waitingCount || 0);
}

// All the live-board state: queue data (with offline cache fallback), the
// clock, socket connection status. Polls every 10s (30s offline) and also
// refreshes on queue/token socket events.
//
// `scoped` controls WHICH board the hook fetches:
//   - false (default): the PUBLIC, unauthenticated /queue/display endpoint —
//     correct for an unattended lobby-TV that has no login. Runs unscoped on
//     the server, so on a multi-tenant deploy it shows every tenant's doctors.
//   - true: the AUTHENTICATED, tenant-scoped /queue endpoint via the `api`
//     helper (which attaches X-Tenant-Id from the logged-in user). Used when a
//     staff member (e.g. a receptionist) opens the board from the dashboard —
//     they only ever see their own hospital's doctors.
export function useDisplayData(scoped = false) {
  const [doctors, setDoctors] = useState<DoctorQueue[]>([]);
  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  const [connected, setConnected] = useState(false);
  const [offline, setOffline] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const socketRef = useRef<any>(null);

  const fetchQueue = useCallback(async () => {
    try {
      let data: DoctorQueue[];
      if (scoped) {
        // Authenticated, tenant-scoped board. `api.get` returns the unwrapped
        // envelope ({ data, ... }); X-Tenant-Id is added by the api helper.
        const json = await api.get<{ data: DoctorQueue[] }>("/queue");
        if (!json?.data) throw new Error("Invalid response");
        data = json.data;
      } else {
        const res = await fetch(`${API_BASE}/queue/display`);
        const json = await res.json();
        if (!json.success || !json.data) throw new Error("Invalid response");
        data = json.data;
      }
      setDoctors(data);
      setOffline(false);
      setLastUpdate(Date.now());
      writeCache(data);
    } catch {
      const cached = readCache();
      if (cached) {
        setDoctors(cached.data);
        setLastUpdate(cached.ts);
      }
      setOffline(true);
    }
  }, [scoped]);

  // Cached data immediately on mount so we never show blank on reload.
  useEffect(() => {
    const cached = readCache();
    if (cached) {
      setDoctors(cached.data);
      setLastUpdate(cached.ts);
    }
  }, []);

  // Clock — set on mount (client only), then tick every second.
  useEffect(() => {
    setCurrentTime(new Date());
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, offline ? 30000 : 10000);
    return () => clearInterval(interval);
  }, [fetchQueue, offline]);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let socket: any = null;
    async function connectSocket() {
      try {
        const { io } = await import("socket.io-client");
        socket = io(WS_URL, { transports: ["websocket"], autoConnect: true });
        socketRef.current = socket;
        socket.on("connect", () => {
          setConnected(true);
          socket.emit("join-display");
        });
        socket.on("disconnect", () => setConnected(false));
        socket.on("queue-update", () => fetchQueue());
        socket.on("token-update", () => fetchQueue());
      } catch {
        // Polling fallback
      }
    }
    connectSocket();
    return () => {
      if (socket) socket.disconnect();
    };
  }, [fetchQueue]);

  return { doctors, currentTime, connected, offline, lastUpdate };
}

// Shared board header: hospital name + live date/time + offline banner.
export function DisplayHeader({
  currentTime,
  connected,
  offline,
  lastUpdate,
}: {
  currentTime: Date | null;
  connected: boolean;
  offline: boolean;
  lastUpdate: number | null;
}) {
  const dateStr = currentTime
    ? currentTime.toLocaleDateString("en-IN", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : "";
  const timeStr = currentTime
    ? currentTime.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      })
    : "";
  const lastUpdateStr = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
    : "never";

  return (
    <>
      {offline && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-yellow-500/40 bg-yellow-950/50 px-4 py-2 text-center text-sm font-medium text-yellow-300"
        >
          <span aria-hidden="true">📶 </span>
          Offline — showing last update at {lastUpdateStr}. Retrying every 30s.
        </div>
      )}
      <header className="mb-10 text-center">
        <h1 className="mc-title-glow text-6xl font-black tracking-tight md:text-7xl">
          MedCore Hospital
        </h1>
        <div className="mt-4 flex items-center justify-center gap-8 text-2xl text-slate-400">
          <span>{dateStr}</span>
          <span className="rounded-xl bg-slate-900/70 px-4 py-1 font-mono text-4xl font-bold tracking-wider text-white shadow-[0_0_24px_rgba(96,165,250,0.25)]">
            {timeStr}
          </span>
        </div>
        {connected && !offline && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-950/40 px-3 py-1 text-sm font-semibold uppercase tracking-widest text-emerald-400">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.9)]" />
            Live
          </div>
        )}
      </header>
    </>
  );
}

// Scale the "Now Calling" name to fit the card: shorter names get the big hero
// size, longer names step down so the full name always shows (no clipping).
function callingNameSize(name: string): string {
  const len = name.trim().length;
  if (len <= 10) return "text-5xl";
  if (len <= 16) return "text-4xl";
  if (len <= 24) return "text-3xl";
  if (len <= 34) return "text-2xl";
  return "text-xl";
}

// Doctor-card heading size, scaled to the name length so long names (e.g.
// "Dr. Maria Fernandes") fit on a line instead of wrapping and pushing the
// card taller than its row-mates.
function doctorNameSize(name: string): string {
  const len = name.trim().length;
  if (len <= 14) return "text-3xl";
  if (len <= 20) return "text-2xl";
  if (len <= 28) return "text-xl";
  return "text-lg";
}

// "Now Calling" names with a directional transition: when the called patient
// changes, the previous name lifts up and fades while the new one rises in.
function CallingNames({ names }: { names: string[] }) {
  const key = names.join("|");
  const prevRef = useRef<string[]>(names);
  const [exiting, setExiting] = useState<string[] | null>(null);

  useEffect(() => {
    if (prevRef.current.join("|") !== key) {
      setExiting(prevRef.current);
      prevRef.current = names;
      const t = setTimeout(() => setExiting(null), 600);
      return () => clearTimeout(t);
    }
  }, [key, names]);

  const renderName = (n: string) => (
    <p
      key={n}
      className={`font-black leading-tight tracking-tight text-emerald-300 break-words ${callingNameSize(n)}`}
    >
      {n}
    </p>
  );

  return (
    <div className="relative mt-1 overflow-hidden">
      {exiting && (
        <div
          className="mc-call-leave absolute inset-x-0 top-0 space-y-0.5"
          aria-hidden="true"
        >
          {exiting.map(renderName)}
        </div>
      )}
      <div key={key} className="mc-call-enter space-y-0.5">
        {names.map(renderName)}
      </div>
    </div>
  );
}

// Pearl ERP Stage 1 §2.1.5 — three card layouts in one screen. The TOKEN
// layout shows the current/next token; CALLING shows the patient being called
// now (or a neutral placeholder); SLOT shows the next 3 booked slots.
export function DoctorCard({ doc }: { doc: DoctorQueue }) {
  const mode: AppointmentMode = doc.appointmentMode ?? "TOKEN";
  // CALLING boards only light up for an active CALL. While a consult is in
  // progress (no one being called) the board stays neutral.
  const isActive =
    mode === "CALLING"
      ? (doc.callingNow?.length ?? 0) > 0
      : doc.currentToken !== null || doc.currentArrivalSeq !== null;

  return (
    <div
      data-testid={`display-card-${mode.toLowerCase()}`}
      className={`relative flex h-full flex-col overflow-hidden rounded-3xl border-2 p-8 transition-all duration-500 ${
        isActive
          ? "mc-card-active mc-shimmer border-emerald-400/80 bg-gradient-to-br from-emerald-900/60 via-emerald-950/40 to-slate-900"
          : "mc-float border-slate-700/80 bg-gradient-to-br from-slate-900/80 to-slate-950/70 shadow-[0_0_24px_rgba(2,6,23,0.6)]"
      }`}
    >
      {/* Top accent bar — emerald when active, cool blue/violet when idle. */}
      <div
        className={`absolute inset-x-0 top-0 h-1.5 ${
          isActive
            ? "bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-400"
            : "bg-gradient-to-r from-blue-500/60 via-violet-500/60 to-cyan-500/60"
        }`}
      />
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2
            className={`font-extrabold leading-tight ${doctorNameSize(
              formatDoctorName(doc.doctorName),
            )} ${isActive ? "text-white drop-shadow-[0_0_12px_rgba(16,185,129,0.5)]" : "text-slate-200"}`}
          >
            {formatDoctorName(doc.doctorName)}
          </h2>
          {doc.specialization && (
            <p className="mt-1.5 text-base font-medium text-slate-400">
              {doc.specialization}
            </p>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest ${
            isActive
              ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/40"
              : "bg-slate-800/80 text-slate-400 ring-1 ring-slate-700"
          }`}
        >
          {mode}
        </span>
      </div>

      {mode === "TOKEN" && (
        <>
          <div className="mb-4 text-center">
            <p
              className={`text-sm font-bold uppercase tracking-[0.2em] ${
                isActive ? "text-emerald-400" : "text-slate-600"
              }`}
            >
              {isActive ? "Now Serving" : "No Patient"}
            </p>
            <p
              className={`mt-2 font-mono font-black leading-none ${
                isActive
                  ? "text-8xl text-emerald-400 drop-shadow-[0_0_24px_rgba(16,185,129,0.6)]"
                  : "text-7xl text-slate-700"
              }`}
            >
              {isActive ? doc.currentToken : "--"}
            </p>
          </div>
          {doc.nextToken != null && (
            <div className="mb-4 text-center">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
                Next
              </p>
              <p className="mt-1 font-mono text-4xl font-bold text-slate-300">
                {doc.nextToken}
              </p>
            </div>
          )}
          <div
            className={`mt-auto rounded-xl px-4 py-3 text-center text-base font-semibold ${
              isActive
                ? "bg-emerald-900/50 text-emerald-300 ring-1 ring-emerald-500/30"
                : "bg-slate-800/80 text-slate-500"
            }`}
          >
            {doc.waitingCount > 0
              ? `${doc.waitingCount} patient${doc.waitingCount > 1 ? "s" : ""} waiting`
              : "No patients waiting"}
          </div>
        </>
      )}

      {mode === "CALLING" && (
        <>
          {doc.callingNow && doc.callingNow.length > 0 ? (
            <div className="mb-4 p-1 text-center">
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-emerald-400">
                Now Calling
              </p>
              <CallingNames names={doc.callingNow} />
            </div>
          ) : (
            <div className="mb-4 text-center">
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-slate-600">
                Arrival Queue
              </p>
              <p className="mt-2 font-mono text-7xl font-black leading-none text-slate-700">
                --
              </p>
            </div>
          )}
          <div
            className={`mt-auto rounded-xl px-4 py-3 text-center text-base font-semibold ${
              isActive
                ? "bg-emerald-900/50 text-emerald-300 ring-1 ring-emerald-500/30"
                : "bg-slate-800/80 text-slate-500"
            }`}
          >
            {doc.waitingCount > 0
              ? `${doc.waitingCount} in arrival queue`
              : "Queue empty"}
          </div>
        </>
      )}

      {mode === "SLOT" && (
        <>
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
            Next 3 Slots
          </p>
          {!doc.upcomingSlots || doc.upcomingSlots.length === 0 ? (
            <p className="rounded-xl bg-slate-800/80 px-4 py-4 text-center text-base text-slate-500">
              No upcoming slots today
            </p>
          ) : (
            <ul className="space-y-2.5" data-testid="display-slot-strip">
              {doc.upcomingSlots.map((s, i) => (
                <li
                  key={`${s.slotStart}-${i}`}
                  className={`grid grid-cols-[1fr_auto_1fr] items-center rounded-xl px-4 py-3 text-lg ${
                    i === 0
                      ? "bg-emerald-900/50 text-emerald-200 ring-1 ring-emerald-500/30"
                      : "bg-slate-800/70 text-slate-300"
                  }`}
                >
                  <span className="justify-self-start font-mono text-xl font-bold">
                    {s.slotStart}
                  </span>
                  {/* Patient name centred in the row. */}
                  <span className="justify-self-center text-center text-2xl font-semibold text-slate-100">
                    {s.patientLabel}
                  </span>
                  {/* Spacer to balance the grid so the name stays truly centred. */}
                  <span aria-hidden="true" />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
