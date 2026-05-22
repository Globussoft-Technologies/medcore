// Super-admin background-job queue — Pearl ERP Stage 1 §8.4
// (gap row 222 closure, 2026-05-22).
//
// Lists ScheduledTaskRun rows (newest first) emitted by the in-process
// cron scheduler in apps/api/src/services/scheduled-tasks.ts. Super-admins
// (Role.ADMIN with no tenantId, OR Role.ADMIN on the default tenant — the
// API enforces this; the client-side layout also gates) can:
//   - Filter by status (Failed default, All, Running)
//   - Filter by window (last 24h default, last 7d)
//   - Retry a FAILED row
//
// Retry is optimistic: the row's status flips to RUNNING with a pending
// badge until the next refresh resolves it to SUCCESS / FAILED. The
// audit row is server-side (SCHEDULED_JOB_RETRIED).
//
// Mobile-first: 44px touch targets on every action; the table degrades
// to a list of cards on narrow screens via Tailwind's lg: utilities.

"use client";

import { useEffect, useMemo, useState } from "react";
import { RotateCcw, AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";

type RunStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

interface ScheduledRun {
  id: string;
  tenantId: string | null;
  taskName: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  recordsProcessed: number | null;
  retryOfRunId: string | null;
}

interface ListResponse {
  success: boolean;
  data: {
    runs: ScheduledRun[];
    nextCursor: string | null;
  };
  error: string | null;
}

type StatusFilter = "ALL" | "RUNNING" | "FAILED";
type WindowFilter = "24H" | "7D";

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: "FAILED", label: "Failed" },
  { key: "RUNNING", label: "Running" },
  { key: "ALL", label: "All" },
];

const WINDOW_CHIPS: Array<{ key: WindowFilter; label: string }> = [
  { key: "24H", label: "Last 24h" },
  { key: "7D", label: "Last 7d" },
];

function statusPill(status: RunStatus) {
  switch (status) {
    case "PENDING":
      return {
        cls: "bg-slate-100 text-slate-700 border-slate-200",
        Icon: Clock,
      };
    case "RUNNING":
      return {
        cls: "bg-blue-50 text-blue-700 border-blue-200",
        Icon: Loader2,
      };
    case "SUCCESS":
      return {
        cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
        Icon: CheckCircle2,
      };
    case "FAILED":
      return {
        cls: "bg-rose-50 text-rose-700 border-rose-200",
        Icon: AlertCircle,
      };
    default:
      return {
        cls: "bg-slate-100 text-slate-700 border-slate-200",
        Icon: Clock,
      };
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function formatStarted(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

export default function SuperAdminJobsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("FAILED");
  const [windowFilter, setWindowFilter] = useState<WindowFilter>("24H");
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-row retry-in-flight indicator so the spinner stays attached even
  // after the optimistic flip-to-RUNNING.
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});

  const fromIso = useMemo(() => {
    const now = Date.now();
    if (windowFilter === "24H") return new Date(now - 24 * 3600_000).toISOString();
    return new Date(now - 7 * 24 * 3600_000).toISOString();
  }, [windowFilter]);

  async function fetchRuns(append = false): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      params.set("from", fromIso);
      params.set("limit", "50");
      if (append && nextCursor) params.set("cursor", nextCursor);
      const res = await fetch(`/api/v1/scheduled-jobs?${params.toString()}`, {
        credentials: "include",
      });
      const body = (await res.json()) as ListResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setRuns((prev) =>
        append ? [...prev, ...body.data.runs] : body.data.runs
      );
      setNextCursor(body.data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // Refetch when filters change. We deliberately do NOT re-fetch on every
  // keystroke / paint — only when the user toggles a chip.
  useEffect(() => {
    void fetchRuns(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, windowFilter]);

  async function retryRun(run: ScheduledRun): Promise<void> {
    if (run.status !== "FAILED") return;
    setRetrying((prev) => ({ ...prev, [run.id]: true }));
    // Optimistic flip — the API call may take a moment.
    setRuns((prev) =>
      prev.map((r) =>
        r.id === run.id ? { ...r, status: "RUNNING" as RunStatus } : r
      )
    );
    try {
      const res = await fetch(`/api/v1/scheduled-jobs/${run.id}/retry`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Retry failed (${res.status})`);
      }
      // Refetch to surface the new RUNNING row + the original (now showing
      // its post-retry state).
      await fetchRuns(false);
    } catch (err) {
      // Roll back the optimistic flip.
      setRuns((prev) =>
        prev.map((r) =>
          r.id === run.id ? { ...r, status: "FAILED" as RunStatus } : r
        )
      );
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying((prev) => {
        const { [run.id]: _, ...rest } = prev;
        return rest;
      });
    }
  }

  return (
    <section
      data-testid="super-admin-jobs"
      className="space-y-6 py-4"
    >
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Background-Job Queue
        </h1>
        <p className="text-sm text-slate-600">
          In-process cron scheduler runs. Failed tasks can be retried; the
          original run is preserved for audit.
        </p>
      </header>

      {/* Filter chip rows */}
      <div className="flex flex-wrap gap-2" data-testid="jobs-status-filters">
        {STATUS_CHIPS.map((chip) => {
          const active = statusFilter === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              data-testid={`jobs-filter-status-${chip.key.toLowerCase()}`}
              aria-pressed={active}
              onClick={() => setStatusFilter(chip.key)}
              className={`inline-flex h-11 min-w-[80px] items-center justify-center rounded-full border px-4 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-slate-900 ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2" data-testid="jobs-window-filters">
        {WINDOW_CHIPS.map((chip) => {
          const active = windowFilter === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              data-testid={`jobs-filter-window-${chip.key.toLowerCase()}`}
              aria-pressed={active}
              onClick={() => setWindowFilter(chip.key)}
              className={`inline-flex h-11 min-w-[80px] items-center justify-center rounded-full border px-4 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-slate-900 ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div
          role="alert"
          data-testid="jobs-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      <div
        className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm"
        data-testid="jobs-table-wrapper"
      >
        <table
          className="min-w-full text-left text-sm"
          data-testid="jobs-table"
        >
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Task
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Started
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Duration
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Records
              </th>
              <th scope="col" className="px-4 py-3 font-medium text-right">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.length === 0 && !loading ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  data-testid="jobs-empty"
                >
                  No job runs in this window.
                </td>
              </tr>
            ) : null}
            {runs.map((run) => {
              const pill = statusPill(run.status);
              const Icon = pill.Icon;
              const isRetrying = !!retrying[run.id];
              return (
                <tr
                  key={run.id}
                  data-testid={`jobs-row-${run.id}`}
                  data-status={run.status}
                >
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">
                    {run.taskName}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${pill.cls}`}
                      data-testid={`jobs-status-pill-${run.id}`}
                    >
                      <Icon
                        size={12}
                        aria-hidden="true"
                        className={
                          run.status === "RUNNING" ? "animate-spin" : ""
                        }
                      />
                      {run.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatStarted(run.startedAt)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatDuration(run.durationMs)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {run.recordsProcessed ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {run.status === "FAILED" ? (
                      <button
                        type="button"
                        data-testid={`jobs-retry-${run.id}`}
                        disabled={isRetrying}
                        onClick={() => retryRun(run)}
                        className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
                      >
                        <RotateCcw
                          size={14}
                          aria-hidden="true"
                          className={isRetrying ? "animate-spin" : ""}
                        />
                        {isRetrying ? "Retrying…" : "Retry"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span
          className="text-xs text-slate-500"
          data-testid="jobs-count-summary"
        >
          {runs.length} run{runs.length === 1 ? "" : "s"} shown
        </span>
        {nextCursor ? (
          <button
            type="button"
            data-testid="jobs-load-more"
            disabled={loading}
            onClick={() => fetchRuns(true)}
            className="inline-flex h-11 min-w-[120px] items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
