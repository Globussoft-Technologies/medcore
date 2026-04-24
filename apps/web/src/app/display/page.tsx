"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { formatDoctorName } from "@/lib/format-doctor-name";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
const WS_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const CACHE_KEY = "medcore_display_queue_cache";

interface DoctorQueue {
  doctorId: string;
  doctorName: string;
  specialization: string | null;
  currentToken: number | null;
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
            {doctors.map((doc) => {
              const isActive = doc.currentToken !== null;
              return (
                <div
                  key={doc.doctorId}
                  className={`rounded-2xl border-2 p-6 transition-all ${
                    isActive
                      ? "border-emerald-500/50 bg-emerald-950/40 shadow-lg shadow-emerald-500/10"
                      : "border-slate-700 bg-slate-900/60"
                  }`}
                >
                  <div className="mb-4">
                    <h2
                      className={`text-2xl font-bold ${
                        isActive ? "text-white" : "text-slate-400"
                      }`}
                    >
                      {formatDoctorName(doc.doctorName)}
                    </h2>
                    {doc.specialization && (
                      <p className="mt-1 text-sm text-slate-500">
                        {doc.specialization}
                      </p>
                    )}
                  </div>

                  <div className="mb-4 text-center">
                    <p
                      className={`text-xs font-semibold uppercase tracking-widest ${
                        isActive ? "text-emerald-400" : "text-slate-600"
                      }`}
                    >
                      {isActive ? "Now Serving" : "No Patient"}
                    </p>
                    <p
                      className={`mt-1 font-mono font-black leading-none ${
                        isActive
                          ? "text-8xl text-emerald-400"
                          : "text-7xl text-slate-700"
                      }`}
                    >
                      {isActive ? doc.currentToken : "--"}
                    </p>
                  </div>

                  <div
                    className={`rounded-lg px-3 py-2 text-center text-sm font-medium ${
                      isActive
                        ? "bg-emerald-900/50 text-emerald-300"
                        : "bg-slate-800 text-slate-500"
                    }`}
                  >
                    {doc.waitingCount > 0
                      ? `${doc.waitingCount} patient${doc.waitingCount > 1 ? "s" : ""} waiting`
                      : "No patients waiting"}
                  </div>
                </div>
              );
            })}
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
