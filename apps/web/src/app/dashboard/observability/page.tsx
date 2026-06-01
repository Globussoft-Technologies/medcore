// Operator Observability page — Pearl ERP Stage 1 §8.4
// (per-tenant health + maintenance windows, 2026-05-28).
//
// Two-tab landing under /dashboard/observability (linked from the
// sidebar's super-admin block). Gated by the dashboard layout's
// SUPER_ADMIN_ONLY_ROUTES so tenant ADMINs never see the nav entry;
// the API double-enforces.
//
//   - Health tab — pulls /api/v1/super-admin/health for per-tenant
//     error counts, p95 latency, slow-request volume, and failed-job
//     rollups. Tiles up top show platform totals; below is a sortable
//     per-tenant table + the cross-tenant slow-endpoint leaderboard.
//   - Maintenance tab — CRUD over /api/v1/maintenance-windows. The
//     public /status page consumes the same table to render scheduled
//     downtime to visitors.
//
// No graphs library is pulled in — keeps the bundle lean. Numbers
// land via cards/tables/sparkline-free badges. A Stage-2 follow-up
// can add ECharts when the data volume justifies it.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Edit,
  Gauge,
  Loader2,
  Plus,
  Trash2,
  Wrench,
} from "lucide-react";
import { csrfFetch } from "@/lib/csrf-fetch";
import { toast } from "@/lib/toast";

type HealthTab = "health" | "maintenance";

interface HealthTotals {
  windowHours: number;
  totalInterestingRequests: number;
  totalErrors: number;
  totalSlow: number;
  totalFailedJobs: number;
  tenantsAffected: number;
}
interface PerTenantHealthRow {
  tenantId: string | null;
  tenantName: string | null;
  totalSlowOrErrorRequests: number;
  slowCount: number;
  errorCount: number;
  p95DurationMs: number;
  failedJobsLast24h: number;
}
interface SlowEndpointRow {
  pathTemplate: string;
  method: string;
  count: number;
  p95DurationMs: number;
}
interface HealthResponse {
  success: boolean;
  data: {
    totals: HealthTotals;
    perTenant: PerTenantHealthRow[];
    slowEndpoints: SlowEndpointRow[];
  };
  error: string | null;
}

interface MaintenanceWindow {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  affectsComponents: string[];
  status: "scheduled" | "in_progress" | "completed" | "cancelled";
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface WindowsResponse {
  success: boolean;
  data: { windows: MaintenanceWindow[] };
  error: string | null;
}

const HOURS_OPTIONS = [
  { value: 1, label: "Last 1 h" },
  { value: 24, label: "Last 24 h" },
  { value: 72, label: "Last 3 d" },
  { value: 168, label: "Last 7 d" },
];

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const STATUS_BADGE: Record<
  MaintenanceWindow["status"],
  { cls: string; label: string }
> = {
  scheduled: {
    cls: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300",
    label: "Scheduled",
  },
  in_progress: {
    cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
    label: "In progress",
  },
  completed: {
    cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
    label: "Completed",
  },
  cancelled: {
    cls: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
    label: "Cancelled",
  },
};

export default function ObservabilityPage() {
  const [tab, setTab] = useState<HealthTab>("health");

  // ── Health state ────────────────────────────────────────────────
  const [hours, setHours] = useState<number>(24);
  const [health, setHealth] = useState<HealthResponse["data"] | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const res = await fetch(
        `/api/v1/super-admin/health?hours=${hours}`,
        { credentials: "include" },
      );
      const body = (await res.json()) as HealthResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setHealth(body.data);
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : String(err));
    } finally {
      setHealthLoading(false);
    }
  }, [hours]);

  // ── Maintenance state ───────────────────────────────────────────
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const [windowsLoading, setWindowsLoading] = useState(false);
  const [editingWindow, setEditingWindow] = useState<
    Partial<MaintenanceWindow> & { mode: "create" | "edit" } | null
  >(null);

  const fetchWindows = useCallback(async () => {
    setWindowsLoading(true);
    try {
      const res = await fetch("/api/v1/maintenance-windows", {
        credentials: "include",
      });
      const body = (await res.json()) as WindowsResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setWindows(body.data.windows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setWindowsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "health") void fetchHealth();
    else void fetchWindows();
  }, [tab, fetchHealth, fetchWindows]);

  async function saveWindow(): Promise<void> {
    if (!editingWindow) return;
    const isCreate = editingWindow.mode === "create";
    const body = {
      title: editingWindow.title ?? "",
      description: editingWindow.description ?? "",
      startsAt: editingWindow.startsAt ?? "",
      endsAt: editingWindow.endsAt ?? "",
      affectsComponents: editingWindow.affectsComponents ?? [],
      status: editingWindow.status ?? "scheduled",
    };
    try {
      const url = isCreate
        ? "/api/v1/maintenance-windows"
        : `/api/v1/maintenance-windows/${editingWindow.id}`;
      const res = await csrfFetch(url, {
        method: isCreate ? "POST" : "PATCH",
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        success: boolean;
        error: string | null;
      };
      if (!res.ok || !payload.success) {
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      toast.success(isCreate ? "Window created" : "Window updated");
      setEditingWindow(null);
      void fetchWindows();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function deleteWindow(id: string): Promise<void> {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Delete this maintenance window?")
    )
      return;
    try {
      const res = await csrfFetch(`/api/v1/maintenance-windows/${id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => ({}))) as {
          error: string | null;
        };
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      toast.success("Window deleted");
      void fetchWindows();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const totals = health?.totals;
  const errorRatePct = useMemo(() => {
    if (!totals || totals.totalInterestingRequests === 0) return 0;
    return Math.round(
      (totals.totalErrors / totals.totalInterestingRequests) * 100,
    );
  }, [totals]);

  return (
    <section className="space-y-6 py-4" data-testid="observability-page">
      {/* Hero */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-primary/5 via-white to-white p-5 shadow-sm dark:border-gray-700 dark:from-primary/10 dark:via-gray-800 dark:to-gray-800">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary dark:bg-primary/20">
            <Gauge size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              Observability
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Per-tenant API health, slow endpoints, failed background jobs,
              and scheduled maintenance windows surfaced on the public
              status page.
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div
        className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-gray-700"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "health"}
          data-testid="observability-tab-health"
          onClick={() => setTab("health")}
          className={`-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 ${
            tab === "health"
              ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
              : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          <Activity size={14} />
          Health
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "maintenance"}
          data-testid="observability-tab-maintenance"
          onClick={() => setTab("maintenance")}
          className={`-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 ${
            tab === "maintenance"
              ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
              : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          <Wrench size={14} />
          Maintenance windows
        </button>
      </div>

      {/* HEALTH */}
      {tab === "health" ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Window
            </label>
            <select
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100"
              data-testid="observability-hours-select"
            >
              {HOURS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void fetchHealth()}
              disabled={healthLoading}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:border-gray-500"
            >
              {healthLoading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : null}
              Refresh
            </button>
          </div>

          {healthError ? (
            <div
              role="alert"
              className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
            >
              {healthError}
            </div>
          ) : null}

          {/* KPI tiles */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile
              label="Errors (5xx)"
              value={totals?.totalErrors ?? 0}
              tone="rose"
              Icon={AlertTriangle}
              sub={`${errorRatePct}% of logged requests`}
            />
            <KpiTile
              label="Slow (≥ 1s)"
              value={totals?.totalSlow ?? 0}
              tone="amber"
              Icon={Clock}
            />
            <KpiTile
              label="Failed jobs"
              value={totals?.totalFailedJobs ?? 0}
              tone="violet"
              Icon={Wrench}
            />
            <KpiTile
              label="Tenants affected"
              value={totals?.tenantsAffected ?? 0}
              tone="sky"
              Icon={CheckCircle2}
            />
          </div>

          {/* Per-tenant table */}
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-gray-700 dark:text-slate-200">
              Per-tenant breakdown
            </div>
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Tenant</th>
                  <th className="px-4 py-2 font-medium text-right">5xx errors</th>
                  <th className="px-4 py-2 font-medium text-right">Slow ≥ 1s</th>
                  <th className="px-4 py-2 font-medium text-right">p95 (ms)</th>
                  <th className="px-4 py-2 font-medium text-right">Failed jobs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-700">
                {(health?.perTenant ?? []).length === 0 && !healthLoading ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400"
                    >
                      No slow or errored requests in the selected window.
                    </td>
                  </tr>
                ) : null}
                {(health?.perTenant ?? []).map((t) => (
                  <tr key={t.tenantId ?? "platform"}>
                    <td className="px-4 py-2 font-medium text-slate-900 dark:text-slate-100">
                      {t.tenantName}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {t.errorCount > 0 ? (
                        <span className="text-rose-700 dark:text-rose-400">{t.errorCount}</span>
                      ) : (
                        <span className="text-slate-400 dark:text-slate-500">0</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {t.slowCount}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {t.p95DurationMs.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {t.failedJobsLast24h}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Slow-endpoint leaderboard */}
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-gray-700 dark:text-slate-200">
              Slow endpoint leaderboard (top 20 by p95)
            </div>
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Method</th>
                  <th className="px-4 py-2 font-medium">Path</th>
                  <th className="px-4 py-2 font-medium text-right">Hits</th>
                  <th className="px-4 py-2 font-medium text-right">p95 (ms)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-700">
                {(health?.slowEndpoints ?? []).length === 0 && !healthLoading ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400"
                    >
                      Nothing slow enough to surface here yet.
                    </td>
                  </tr>
                ) : null}
                {(health?.slowEndpoints ?? []).map((e) => (
                  <tr key={`${e.method} ${e.pathTemplate}`}>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600 dark:text-slate-400">
                      {e.method}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-900 dark:text-slate-100">
                      {e.pathTemplate}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {e.count}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium">
                      {e.p95DurationMs.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {/* MAINTENANCE */}
      {tab === "maintenance" ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Scheduled + in-progress windows appear on the public status
              page so visitors see expected downtime.
            </p>
            <button
              type="button"
              onClick={() =>
                setEditingWindow({
                  mode: "create",
                  title: "",
                  description: "",
                  startsAt: new Date().toISOString().slice(0, 16),
                  endsAt: new Date(Date.now() + 60 * 60 * 1000)
                    .toISOString()
                    .slice(0, 16),
                  affectsComponents: [],
                  status: "scheduled",
                })
              }
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-white hover:bg-primary-dark"
              data-testid="observability-window-new"
            >
              <Plus size={14} /> New window
            </button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Starts</th>
                  <th className="px-4 py-2 font-medium">Ends</th>
                  <th className="px-4 py-2 font-medium">Components</th>
                  <th className="px-4 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-700">
                {windows.length === 0 && !windowsLoading ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400"
                    >
                      No maintenance windows yet.
                    </td>
                  </tr>
                ) : null}
                {windows.map((w) => {
                  const badge = STATUS_BADGE[w.status];
                  return (
                    <tr key={w.id}>
                      <td className="px-4 py-2 font-medium text-slate-900 dark:text-slate-100">
                        {w.title}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">
                        {formatDateTime(w.startsAt)}
                      </td>
                      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">
                        {formatDateTime(w.endsAt)}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-600 dark:text-slate-400">
                        {w.affectsComponents.join(", ") || "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              setEditingWindow({
                                ...w,
                                mode: "edit",
                                startsAt: w.startsAt.slice(0, 16),
                                endsAt: w.endsAt.slice(0, 16),
                              })
                            }
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-gray-700"
                            aria-label="Edit"
                          >
                            <Edit size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteWindow(w.id)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                            aria-label="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Edit modal */}
          {editingWindow ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
              role="dialog"
              aria-modal="true"
              onClick={() => setEditingWindow(null)}
            >
              <div
                className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-slate-100"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {editingWindow.mode === "create"
                    ? "New maintenance window"
                    : "Edit maintenance window"}
                </h2>
                <div className="mt-4 space-y-3">
                  <Field label="Title">
                    <input
                      type="text"
                      value={editingWindow.title ?? ""}
                      onChange={(e) =>
                        setEditingWindow({
                          ...editingWindow,
                          title: e.target.value,
                        })
                      }
                      className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                    />
                  </Field>
                  <Field label="Description (optional)">
                    <textarea
                      value={editingWindow.description ?? ""}
                      onChange={(e) =>
                        setEditingWindow({
                          ...editingWindow,
                          description: e.target.value,
                        })
                      }
                      rows={2}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Starts at">
                      <input
                        type="datetime-local"
                        value={editingWindow.startsAt ?? ""}
                        onChange={(e) =>
                          setEditingWindow({
                            ...editingWindow,
                            startsAt: e.target.value,
                          })
                        }
                        className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                      />
                    </Field>
                    <Field label="Ends at">
                      <input
                        type="datetime-local"
                        value={editingWindow.endsAt ?? ""}
                        onChange={(e) =>
                          setEditingWindow({
                            ...editingWindow,
                            endsAt: e.target.value,
                          })
                        }
                        className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                      />
                    </Field>
                  </div>
                  <Field label="Affects components (comma-separated)">
                    <input
                      type="text"
                      value={(editingWindow.affectsComponents ?? []).join(", ")}
                      onChange={(e) =>
                        setEditingWindow({
                          ...editingWindow,
                          affectsComponents: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="api, database, whatsapp"
                      className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                    />
                  </Field>
                  <Field label="Status">
                    <select
                      value={editingWindow.status ?? "scheduled"}
                      onChange={(e) =>
                        setEditingWindow({
                          ...editingWindow,
                          status: e.target
                            .value as MaintenanceWindow["status"],
                        })
                      }
                      className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                    >
                      <option value="scheduled">Scheduled</option>
                      <option value="in_progress">In progress</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </Field>
                </div>
                <div className="mt-6 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingWindow(null)}
                    className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveWindow()}
                    className="inline-flex h-10 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

const TONE_CLS: Record<
  "rose" | "amber" | "violet" | "sky",
  { bg: string; text: string }
> = {
  rose: { bg: "bg-rose-100 dark:bg-rose-900/40", text: "text-rose-700 dark:text-rose-300" },
  amber: { bg: "bg-amber-100 dark:bg-amber-900/40", text: "text-amber-700 dark:text-amber-300" },
  violet: { bg: "bg-violet-100 dark:bg-violet-900/40", text: "text-violet-700 dark:text-violet-300" },
  sky: { bg: "bg-sky-100 dark:bg-sky-900/40", text: "text-sky-700 dark:text-sky-300" },
};

function KpiTile({
  label,
  value,
  tone,
  Icon,
  sub,
}: {
  label: string;
  value: string | number;
  tone: keyof typeof TONE_CLS;
  Icon: React.ElementType;
  sub?: string;
}) {
  const c = TONE_CLS[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${c.bg} ${c.text}`}
        >
          <Icon size={16} />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {label}
          </p>
          <p className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">
            {value}
          </p>
          {sub ? <p className="text-[11px] text-slate-500 dark:text-slate-400">{sub}</p> : null}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
        {label}
      </label>
      {children}
    </div>
  );
}
