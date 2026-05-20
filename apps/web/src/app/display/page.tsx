"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { formatDoctorName } from "@/lib/format-doctor-name";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
const WS_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const CACHE_KEY = "medcore_display_queue_cache";

// Pearl ERP Stage 1 §2.1.5 — mode-aware display board. The /queue
// endpoint now returns appointmentMode + per-mode fields; cards
// branch their layout below.
type AppointmentMode = "CALLING" | "TOKEN" | "SLOT";

interface UpcomingSlot {
  slotStart: string;
  patientLabel: string;
  status: string;
}

interface DoctorQueue {
  doctorId: string;
  doctorName: string;
  specialization: string | null;
  appointmentMode?: AppointmentMode;
  currentToken: number | null;
  nextToken?: number | null;
  currentArrivalSeq?: number | null;
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

export default function TokenDisplayPage() {
  const [doctors, setDoctors] = useState<DoctorQueue[]>([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [hospitalName] = useState("MedCore Hospital");
  const [connected, setConnected] = useState(false);
  const [offline, setOffline] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const socketRef = useRef<any>(null);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/queue`);
      const json = await res.json();
      if (json.success && json.data) {
        setDoctors(json.data);
        setOffline(false);
        setLastUpdate(Date.now());
        writeCache(json.data);
      } else {
        throw new Error("Invalid response");
      }
    } catch {
      // Fall back to cache
      const cached = readCache();
      if (cached) {
        setDoctors(cached.data);
        setLastUpdate(cached.ts);
      }
      setOffline(true);
    }
  }, []);

  // Load cached data immediately on mount so we never show blank on reload
  useEffect(() => {
    const cached = readCache();
    if (cached) {
      setDoctors(cached.data);
      setLastUpdate(cached.ts);
    }
  }, []);

  // Clock
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Initial + offline retry polling (every 30s when offline, 10s when online)
  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, offline ? 30000 : 10000);
    return () => clearInterval(interval);
  }, [fetchQueue, offline]);

  // WebSocket (unchanged)
  useEffect(() => {
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

  const dateStr = currentTime.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const timeStr = currentTime.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  const lastUpdateStr = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
    : "never";

  return (
    <div className="flex min-h-screen flex-col px-8 py-6">
      {/* Offline banner */}
      {offline && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-yellow-500/40 bg-yellow-950/50 px-4 py-2 text-center text-sm font-medium text-yellow-300"
        >
          <span aria-hidden="true">📶 </span>
          Offline — showing last update at {lastUpdateStr}. Retrying every 30s.
        </div>
      )}

      {/* Header */}
      <header className="mb-8 text-center">
        <h1
          className="text-5xl font-bold tracking-tight"
          style={{ color: "#2563eb" }}
        >
          {hospitalName}
        </h1>
        <div className="mt-3 flex items-center justify-center gap-6 text-xl text-slate-400">
          <span>{dateStr}</span>
          <span className="text-3xl font-semibold text-white">{timeStr}</span>
        </div>
        {connected && !offline && (
          <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </div>
        )}
      </header>

      <main className="flex-1">
        {doctors.length === 0 ? (
          <div className="flex h-64 items-center justify-center">
            <p className="text-2xl text-slate-500">
              {offline ? "No cached data available" : "No doctors on duty today"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {doctors.map((doc) => (
              <DoctorCard key={doc.doctorId} doc={doc} />
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

// Pearl ERP Stage 1 §2.1.5 — three card layouts in one screen. The
// existing TOKEN layout is preserved; CALLING and SLOT branches render
// arrival counters and an upcoming-slots strip respectively. Doctors
// without an appointmentMode (legacy data) fall back to TOKEN.
function DoctorCard({ doc }: { doc: DoctorQueue }) {
  const mode: AppointmentMode = doc.appointmentMode ?? "TOKEN";
  const isActive = doc.currentToken !== null || doc.currentArrivalSeq !== null;

  return (
    <div
      data-testid={`display-card-${mode.toLowerCase()}`}
      className={`rounded-2xl border-2 p-6 transition-all ${
        isActive
          ? "border-emerald-500/50 bg-emerald-950/40 shadow-lg shadow-emerald-500/10"
          : "border-slate-700 bg-slate-900/60"
      }`}
    >
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h2 className={`text-2xl font-bold ${isActive ? "text-white" : "text-slate-400"}`}>
            {formatDoctorName(doc.doctorName)}
          </h2>
          {doc.specialization && (
            <p className="mt-1 text-sm text-slate-500">{doc.specialization}</p>
          )}
        </div>
        <span className="rounded-full bg-slate-800/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          {mode}
        </span>
      </div>

      {mode === "TOKEN" && (
        <>
          <div className="mb-3 text-center">
            <p
              className={`text-xs font-semibold uppercase tracking-widest ${
                isActive ? "text-emerald-400" : "text-slate-600"
              }`}
            >
              {isActive ? "Now Serving" : "No Patient"}
            </p>
            <p
              className={`mt-1 font-mono font-black leading-none ${
                isActive ? "text-7xl text-emerald-400" : "text-6xl text-slate-700"
              }`}
            >
              {isActive ? doc.currentToken : "--"}
            </p>
          </div>
          {doc.nextToken != null && (
            <div className="mb-3 text-center">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                Next
              </p>
              <p className="mt-0.5 font-mono text-3xl font-bold text-slate-300">
                {doc.nextToken}
              </p>
            </div>
          )}
          <div
            className={`rounded-lg px-3 py-2 text-center text-sm font-medium ${
              isActive ? "bg-emerald-900/50 text-emerald-300" : "bg-slate-800 text-slate-500"
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
          <div className="mb-3 text-center">
            <p
              className={`text-xs font-semibold uppercase tracking-widest ${
                isActive ? "text-emerald-400" : "text-slate-600"
              }`}
            >
              {isActive ? "Now Serving Arrival #" : "Arrival Queue"}
            </p>
            <p
              className={`mt-1 font-mono font-black leading-none ${
                isActive ? "text-7xl text-emerald-400" : "text-6xl text-slate-700"
              }`}
            >
              {isActive ? doc.currentArrivalSeq : "--"}
            </p>
          </div>
          <div
            className={`rounded-lg px-3 py-2 text-center text-sm font-medium ${
              isActive ? "bg-emerald-900/50 text-emerald-300" : "bg-slate-800 text-slate-500"
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
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
            Next 3 Slots
          </p>
          {!doc.upcomingSlots || doc.upcomingSlots.length === 0 ? (
            <p className="rounded-lg bg-slate-800 px-3 py-3 text-center text-sm text-slate-500">
              No upcoming slots today
            </p>
          ) : (
            <ul className="space-y-1.5" data-testid="display-slot-strip">
              {doc.upcomingSlots.map((s, i) => (
                <li
                  key={`${s.slotStart}-${i}`}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
                    i === 0
                      ? "bg-emerald-900/50 text-emerald-200"
                      : "bg-slate-800/70 text-slate-300"
                  }`}
                >
                  <span className="font-mono font-semibold">{s.slotStart}</span>
                  <span className="text-xs text-slate-400">{s.patientLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
