// Public system-status page — Pearl ERP Stage 1 §8.4 (gap row 221).
//
// Renders the same payload that GET /api/v1/status emits: a global
// status pill (operational / degraded / down), a list of probed
// components with optional response times, and a maintenance-windows
// section (empty for Stage 1).
//
// Auth: NONE. The page is reachable by any browser at /status without
// a session — anchor for public uptime communication.
//
// Refresh cadence: a 30-second polling timer keeps the page fresh
// without WebSockets. The endpoint sets Cache-Control: public,
// max-age=15 so successive polls within that window hit the CDN /
// browser cache instead of the DB.
//
// Style: minimal, professional, mobile-first. No dashboard chrome
// (the bare layout in ./layout.tsx renders only the header).

"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from "lucide-react";

type ComponentStatus = "operational" | "degraded" | "down";

interface StatusComponent {
  name: string;
  status: ComponentStatus;
  responseTimeMs?: number;
}

interface StatusPayload {
  service: "MedCore";
  status: ComponentStatus;
  checkedAt: string;
  components: StatusComponent[];
  maintenanceWindows: Array<{
    id: string;
    title: string;
    scheduledStart: string;
    scheduledEnd: string;
  }>;
}

function statusPill(status: ComponentStatus) {
  switch (status) {
    case "operational":
      return {
        label: "Operational",
        cls: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
        Icon: CheckCircle2,
      };
    case "degraded":
      return {
        label: "Degraded",
        cls: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
        Icon: AlertTriangle,
      };
    case "down":
      return {
        label: "Down",
        cls: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900",
        Icon: XCircle,
      };
  }
}

function overallHeadline(status: ComponentStatus): string {
  switch (status) {
    case "operational":
      return "All systems operational";
    case "degraded":
      return "Some systems are degraded";
    case "down":
      return "One or more systems are down";
  }
}

function formatChecked(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function StatusPage() {
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/status", {
        // Always bypass HTTP cache on manual reload to surface the
        // most-recent probe. Periodic polls fall back to the
        // Cache-Control header on the response.
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as StatusPayload;
      setPayload(json);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // 30s auto-refresh; cleared on unmount.
    const id = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const overall = payload?.status ?? "operational";
  const pill = statusPill(overall);
  const HeadlineIcon = pill.Icon;

  return (
    <div className="space-y-6">
      {/* ─── Overall status banner ────────────────────────── */}
      <section
        data-testid="status-overall"
        className={`rounded-lg border ${pill.cls} px-5 py-4 flex items-start gap-3`}
        role="status"
      >
        <HeadlineIcon className="h-6 w-6 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold">{overallHeadline(overall)}</h1>
          <p className="text-sm opacity-80 mt-0.5">
            Last checked: <span data-testid="status-checked-at">{formatChecked(payload?.checkedAt ?? null)}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="touch-target inline-flex items-center gap-1.5 rounded-md border border-current/20 px-3 py-2 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/5"
          aria-label="Refresh status now"
          data-testid="status-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </section>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 px-4 py-3 text-sm dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900"
          data-testid="status-error"
        >
          Could not reach the status endpoint: {error}
        </div>
      )}

      {/* ─── Components ──────────────────────────────────── */}
      <section aria-labelledby="components-heading">
        <h2 id="components-heading" className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
          Components
        </h2>
        <ul
          className="divide-y divide-gray-200 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
          data-testid="status-components"
        >
          {(payload?.components ?? []).map((c) => {
            const cp = statusPill(c.status);
            const Icon = cp.Icon;
            return (
              <li
                key={c.name}
                className="flex items-center justify-between gap-3 px-4 py-3"
                data-testid="status-component"
                data-component-name={c.name}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{c.name}</p>
                  {typeof c.responseTimeMs === "number" && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Response time: {c.responseTimeMs} ms
                    </p>
                  )}
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${cp.cls}`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {cp.label}
                </span>
              </li>
            );
          })}
          {(!payload || payload.components.length === 0) && !loading && (
            <li className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">
              No component data available.
            </li>
          )}
          {loading && !payload && (
            <li className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">
              Loading current status…
            </li>
          )}
        </ul>
      </section>

      {/* ─── Maintenance windows ─────────────────────────── */}
      <section aria-labelledby="maintenance-heading">
        <h2 id="maintenance-heading" className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
          Scheduled maintenance
        </h2>
        <div
          className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-6"
          data-testid="status-maintenance"
        >
          {payload && payload.maintenanceWindows.length > 0 ? (
            <ul className="space-y-3">
              {payload.maintenanceWindows.map((w) => (
                <li key={w.id} className="text-sm">
                  <p className="font-medium text-gray-900 dark:text-gray-100">{w.title}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {formatChecked(w.scheduledStart)} → {formatChecked(w.scheduledEnd)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
              No scheduled maintenance.
            </p>
          )}
        </div>
      </section>

      <p className="text-xs text-gray-500 dark:text-gray-400 text-center pt-2">
        Status refreshes automatically every 30 seconds.
      </p>
    </div>
  );
}
