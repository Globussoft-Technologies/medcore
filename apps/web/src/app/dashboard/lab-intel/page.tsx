"use client";

// Lab Result Intelligence dashboard (Sprint 2 / PRD §7.2).
//
// Surfaces critical-value flags + baseline-deviation trends across the
// doctor's panel. Backed by the live `/api/v1/ai/lab-intel` service.
//
// Role gating (issue #179 pattern):
//   DOCTOR / ADMIN — full access (read + drilldown).
//   NURSE          — read-only (no Action button).
//   everyone else  — redirected to /dashboard/not-authorized?from=...

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ExternalLink,
  FlaskConical,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { DataTable, type Column } from "@/components/DataTable";
import { Skeleton } from "@/components/Skeleton";

// ── Roles ─────────────────────────────────────────────────────────────────────

const ALLOWED_ROLES = new Set(["DOCTOR", "ADMIN", "NURSE"]);
const READONLY_ROLES = new Set(["NURSE"]);

// ── Types ─────────────────────────────────────────────────────────────────────

type Severity = "CRITICAL" | "HIGH";

interface CriticalRow {
  id: string;
  patientId: string;
  patientName: string;
  testName: string;
  result: string;
  unit?: string | null;
  referenceRange: string;
  severity: Severity;
  flaggedAt: string;
  labOrderId?: string;
}

interface DeviationRow {
  patientId: string;
  patientName: string;
  parameter: string;
  recentValues: number[];
  deviationPct: number;
  direction: "up" | "down";
}

interface LabIntelAggregates {
  criticalsThisWeek: number;
  patientsWithTrendConcerns: number;
  testsOutsideRefRange: number;
  averageDeviationPct: number;
}

interface CriticalsListResponse {
  data: CriticalRow[];
  success?: boolean;
  error?: string | null;
}

interface DeviationsListResponse {
  data: DeviationRow[];
  success?: boolean;
  error?: string | null;
}

interface AggregatesResponse {
  data: LabIntelAggregates;
  success?: boolean;
  error?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return isoDate(d);
}

function defaultTo(): string {
  return isoDate(new Date());
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function severityClasses(s: Severity): string {
  if (s === "CRITICAL") {
    return "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-200 dark:border-red-800";
  }
  return "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800";
}

// ── KPI tile ──────────────────────────────────────────────────────────────────

interface KpiTileProps {
  testId: string;
  title: string;
  value: number | null | undefined;
  loading: boolean;
  icon: React.ReactNode;
  format?: "count" | "pct";
}

function KpiTile({ testId, title, value, loading, icon, format = "count" }: KpiTileProps) {
  const display = (() => {
    if (loading) return null;
    if (value == null) return "—";
    if (format === "pct") return `${value.toFixed(1)}%`;
    return Number.isFinite(value) ? Math.round(value).toLocaleString() : "—";
  })();

  return (
    <div
      data-testid={testId}
      className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm dark:bg-gray-800 dark:border-gray-700"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {title}
        </p>
        <span className="inline-flex items-center justify-center rounded-lg bg-indigo-50 p-1.5 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300">
          {icon}
        </span>
      </div>
      <div className="mt-3">
        {loading ? (
          <Skeleton variant="text" width="50%" height={32} />
        ) : (
          <p className="text-3xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
            {display}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Sparkline (small, dependency-free SVG) ────────────────────────────────────

function Sparkline({ values }: { values: number[] }) {
  if (!values || values.length < 2) {
    return (
      <span className="text-xs text-gray-400 dark:text-gray-500">
        {values && values.length === 1 ? values[0] : "—"}
      </span>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 80;
  const H = 20;
  const step = W / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = H - ((v - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="text-indigo-500 dark:text-indigo-300"
      aria-hidden="true"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        points={points}
      />
    </svg>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LabIntelPage() {
  const { token, user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  const [from, setFrom] = useState<string>(defaultFrom);
  const [to, setTo] = useState<string>(defaultTo);
  const [severity, setSeverity] = useState<"" | Severity>("");

  const [aggregates, setAggregates] = useState<LabIntelAggregates | null>(null);
  const [criticals, setCriticals] = useState<CriticalRow[]>([]);
  const [deviations, setDeviations] = useState<DeviationRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Issue #179 pattern: redirect disallowed roles to the not-authorized page.
  useEffect(() => {
    if (!isLoading && user && !ALLOWED_ROLES.has(user.role)) {
      toast.error("Lab Result Intelligence is restricted to clinical staff.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(
          pathname || "/dashboard/lab-intel"
        )}`
      );
    }
  }, [user, isLoading, router, pathname]);

  const readOnly = user ? READONLY_ROLES.has(user.role) : false;

  const fetchAll = useCallback(async () => {
    if (!token || !user || !ALLOWED_ROLES.has(user.role)) return;
    setLoading(true);
    setError(null);

    const sevQs = severity ? `&severity=${severity}` : "";
    const range = `from=${from}&to=${to}`;

    try {
      const [aggRes, listRes, devRes] = await Promise.all([
        api
          .get<AggregatesResponse>(`/ai/lab-intel/aggregates?${range}`, { token })
          .catch(() => null),
        api
          .get<CriticalsListResponse>(
            `/ai/lab-intel/critical?${range}${sevQs}`,
            { token }
          )
          .catch(() => null),
        api
          .get<DeviationsListResponse>(`/ai/lab-intel/deviations?${range}`, {
            token,
          })
          .catch(() => null),
      ]);

      setAggregates(aggRes?.data ?? null);
      setCriticals(listRes?.data ?? []);
      setDeviations(devRes?.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load lab intel");
    } finally {
      setLoading(false);
    }
  }, [from, to, severity, token, user]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ── Critical Values columns ───────────────────────────────────────────────

  const criticalColumns: Column<CriticalRow>[] = useMemo(
    () => [
      {
        key: "patientName",
        label: "Patient",
        sortable: true,
        filterable: true,
        render: (row) => (
          <Link
            href={`/dashboard/patients/${row.patientId}`}
            className="font-medium text-indigo-600 hover:underline dark:text-indigo-300"
            data-testid={`lab-intel-row-${row.id}`}
          >
            {row.patientName}
          </Link>
        ),
      },
      {
        key: "testName",
        label: "Test",
        sortable: true,
        filterable: true,
        render: (row) => (
          <span className="text-gray-800 dark:text-gray-200">{row.testName}</span>
        ),
      },
      {
        key: "result",
        label: "Result",
        render: (row) => (
          <span className="font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
            {row.result}
            {row.unit ? (
              <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">
                {row.unit}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "referenceRange",
        label: "Reference Range",
        render: (row) => (
          <span className="text-xs text-gray-600 dark:text-gray-400">
            {row.referenceRange || "—"}
          </span>
        ),
      },
      {
        key: "severity",
        label: "Severity",
        sortable: true,
        render: (row) => (
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${severityClasses(
              row.severity
            )}`}
          >
            {row.severity}
          </span>
        ),
      },
      {
        key: "flaggedAt",
        label: "Flagged At",
        sortable: true,
        render: (row) => (
          <span className="text-xs text-gray-600 dark:text-gray-400">
            {formatDateTime(row.flaggedAt)}
          </span>
        ),
      },
      {
        key: "actions",
        label: "Actions",
        render: (row) =>
          readOnly ? (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              View only
            </span>
          ) : row.labOrderId ? (
            <Link
              href={`/dashboard/lab/${row.labOrderId}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-300"
            >
              <ExternalLink className="h-3 w-3" /> View Order
            </Link>
          ) : (
            <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
          ),
      },
    ],
    [readOnly]
  );

  // ── Auth gate states ──────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div
        data-testid="lab-intel-page"
        className="min-h-screen bg-gray-50 dark:bg-gray-900"
      >
        <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
          <Skeleton variant="text" width="40%" height={28} />
          <Skeleton variant="card" />
        </div>
      </div>
    );
  }

  if (user && !ALLOWED_ROLES.has(user.role)) {
    // Redirect effect already running — render nothing (avoid flash).
    return null;
  }

  return (
    <div
      data-testid="lab-intel-page"
      className="min-h-screen bg-gray-50 dark:bg-gray-900"
    >
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <FlaskConical className="h-7 w-7 text-indigo-600 dark:text-indigo-300" />
            <div>
              <h1
                className="text-2xl font-bold text-gray-900 dark:text-gray-100"
                data-testid="lab-intel-title"
              >
                Lab Result Intelligence
              </h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Critical lab values + per-patient trend deviations across your
                panel.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
              From
            </label>
            <input
              type="date"
              data-testid="lab-intel-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            />
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">
              To
            </label>
            <input
              type="date"
              data-testid="lab-intel-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            />
            <select
              data-testid="lab-intel-severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as "" | Severity)}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              <option value="">All severities</option>
              <option value="CRITICAL">Critical only</option>
              <option value="HIGH">High only</option>
            </select>
            <button
              type="button"
              data-testid="lab-intel-refresh"
              onClick={fetchAll}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>
        </div>

        {/* Read-only banner for nurses */}
        {readOnly && (
          <div
            data-testid="lab-intel-readonly-banner"
            className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
          >
            You have read-only access. Order actions are limited to doctors and
            admins.
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            data-testid="lab-intel-error"
            className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* KPI tiles */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            testId="lab-intel-kpi-criticals"
            title="Critical Values This Week"
            value={aggregates?.criticalsThisWeek ?? 0}
            loading={loading && !aggregates}
            icon={<AlertTriangle className="h-4 w-4" />}
          />
          <KpiTile
            testId="lab-intel-kpi-deviations"
            title="Patients with Trend Concerns"
            value={aggregates?.patientsWithTrendConcerns ?? 0}
            loading={loading && !aggregates}
            icon={<TrendingDown className="h-4 w-4" />}
          />
          <KpiTile
            testId="lab-intel-kpi-outside-range"
            title="Tests Outside Reference Range"
            value={aggregates?.testsOutsideRefRange ?? 0}
            loading={loading && !aggregates}
            icon={<Activity className="h-4 w-4" />}
          />
          <KpiTile
            testId="lab-intel-kpi-avg-deviation"
            title="Average Deviation %"
            value={aggregates?.averageDeviationPct ?? 0}
            loading={loading && !aggregates}
            icon={<TrendingUp className="h-4 w-4" />}
            format="pct"
          />
        </div>

        {/* Critical Values list */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Critical Values
            </h2>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {criticals.length}{" "}
              {criticals.length === 1 ? "result" : "results"}
            </span>
          </div>
          <DataTable<CriticalRow>
            data={criticals}
            columns={criticalColumns}
            keyField="id"
            loading={loading}
            csvName="lab-intel-criticals"
            empty={{
              icon: <FlaskConical size={28} aria-hidden="true" />,
              title: "No critical values flagged",
              description:
                "Adjust the date range or severity filter to see other results.",
            }}
          />
          {/* Empty-state hook for tests/automation */}
          {!loading && criticals.length === 0 && (
            <div data-testid="lab-intel-empty" className="sr-only">
              No critical values
            </div>
          )}
        </section>

        {/* Baseline-Deviation trends */}
        <section
          data-testid="lab-intel-deviations-section"
          className="space-y-3"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Baseline-Deviation Trends
            </h2>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Patients deviating &gt; 2&sigma; from their own baseline
            </span>
          </div>
          {loading && deviations.length === 0 ? (
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <Skeleton variant="text" width="60%" />
              <div className="mt-2">
                <Skeleton variant="text" width="40%" />
              </div>
            </div>
          ) : deviations.length === 0 ? (
            <div
              data-testid="lab-intel-deviations-empty"
              className="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
            >
              No baseline deviations detected for this window.
            </div>
          ) : (
            <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white shadow-sm dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
              {deviations.map((d) => (
                <li
                  key={`${d.patientId}-${d.parameter}`}
                  data-testid={`lab-intel-deviation-${d.patientId}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/dashboard/patients/${d.patientId}`}
                      className="text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-300"
                    >
                      {d.patientName}
                    </Link>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {d.parameter}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Sparkline values={d.recentValues} />
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                        d.direction === "up"
                          ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-200"
                          : "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200"
                      }`}
                    >
                      {d.direction === "up" ? (
                        <TrendingUp className="h-3 w-3" />
                      ) : (
                        <TrendingDown className="h-3 w-3" />
                      )}
                      {d.deviationPct.toFixed(1)}%
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
