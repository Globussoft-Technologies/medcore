// Cross-tenant super-admin metrics page — Pearl ERP Stage 1 §8.4
// (gap rows 219 + 220 closure, 2026-05-23).
//
// Loads /api/v1/super-admin/metrics on mount and renders:
//   - Top: 7 stat cards for cluster-wide totals (tenants /
//     activeTenants / users / patients / appointmentsLast7d /
//     invoicesLast30d / campaignsActive).
//   - Bottom: a sortable table of perTenant rollup rows (capped at
//     top-20-by-userCount by the API). Default sort is userCount desc
//     (server-side default); the table header buttons re-sort
//     client-side.
//
// Defence-in-depth: the layout (apps/web/src/app/super-admin/layout.tsx)
// already gates on Role.ADMIN + tenantId == null. We do NOT re-check
// here — the rendered page is unreachable for forbidden roles. The API
// double-enforces.

"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  Users as UsersIcon,
  UserRound,
  CalendarDays,
  Receipt,
  Megaphone,
  PowerOff,
  Loader2,
  ArrowUpDown,
} from "lucide-react";

interface PerTenantRow {
  tenantId: string;
  tenantName: string;
  plan: string;
  active: boolean;
  userCount: number;
  patientCount: number;
  appointmentsLast7d: number;
  invoicesLast30d: number;
  createdAt: string;
}

interface MetricsTotals {
  tenants: number;
  activeTenants: number;
  users: number;
  patients: number;
  appointmentsLast7d: number;
  invoicesLast30d: number;
  campaignsActive: number;
}

interface MetricsResponse {
  success: boolean;
  data: {
    totals: MetricsTotals;
    perTenant: PerTenantRow[];
  };
  error: string | null;
}

type SortKey =
  | "tenantName"
  | "userCount"
  | "patientCount"
  | "appointmentsLast7d"
  | "invoicesLast30d"
  | "createdAt";

interface StatCardSpec {
  key: keyof MetricsTotals;
  label: string;
  icon: React.ReactNode;
  accent: string;
}

const STAT_CARDS: StatCardSpec[] = [
  {
    key: "tenants",
    label: "Tenants",
    icon: <Building2 size={16} aria-hidden="true" />,
    accent: "bg-slate-900",
  },
  {
    key: "activeTenants",
    label: "Active tenants",
    icon: <PowerOff size={16} aria-hidden="true" />,
    accent: "bg-emerald-600",
  },
  {
    key: "users",
    label: "Users",
    icon: <UsersIcon size={16} aria-hidden="true" />,
    accent: "bg-sky-600",
  },
  {
    key: "patients",
    label: "Patients",
    icon: <UserRound size={16} aria-hidden="true" />,
    accent: "bg-indigo-600",
  },
  {
    key: "appointmentsLast7d",
    label: "Appointments (7d)",
    icon: <CalendarDays size={16} aria-hidden="true" />,
    accent: "bg-amber-600",
  },
  {
    key: "invoicesLast30d",
    label: "Invoices (30d)",
    icon: <Receipt size={16} aria-hidden="true" />,
    accent: "bg-rose-600",
  },
  {
    key: "campaignsActive",
    label: "Active campaigns",
    icon: <Megaphone size={16} aria-hidden="true" />,
    accent: "bg-violet-600",
  },
];

function formatCreated(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function compareRows(
  a: PerTenantRow,
  b: PerTenantRow,
  key: SortKey,
  dir: "asc" | "desc",
): number {
  let raw = 0;
  if (key === "tenantName") {
    raw = a.tenantName.localeCompare(b.tenantName);
  } else if (key === "createdAt") {
    raw = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  } else {
    raw = (a[key] as number) - (b[key] as number);
  }
  return dir === "asc" ? raw : -raw;
}

export default function SuperAdminMetricsPage() {
  const [totals, setTotals] = useState<MetricsTotals | null>(null);
  const [rows, setRows] = useState<PerTenantRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("userCount");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  async function fetchMetrics(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/super-admin/metrics", {
        credentials: "include",
      });
      const body = (await res.json()) as MetricsResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setTotals(body.data.totals);
      setRows(body.data.perTenant);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchMetrics();
  }, []);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => compareRows(a, b, sortKey, sortDir));
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey): void {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      // Numeric columns default to desc (biggest first); name/date asc.
      setSortDir(
        key === "tenantName" || key === "createdAt" ? "asc" : "desc",
      );
      return key;
    });
  }

  return (
    <section
      data-testid="super-admin-metrics"
      className="space-y-6 py-4"
    >
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Cross-tenant metrics
        </h1>
        <p className="text-sm text-slate-600">
          Cluster-wide totals + per-tenant rollup. Capped at top-20 by
          user count so payload stays bounded as the tenant fleet grows.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          data-testid="super-admin-metrics-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      {loading && !totals ? (
        <div
          data-testid="super-admin-metrics-loading"
          className="flex items-center gap-2 text-sm text-slate-500"
        >
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          Loading metrics…
        </div>
      ) : null}

      {/* Totals cards */}
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="super-admin-metrics-totals"
      >
        {STAT_CARDS.map((card) => {
          const value = totals?.[card.key];
          return (
            <div
              key={card.key}
              data-testid={`super-admin-metrics-card-${card.key}`}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <span
                className={`inline-flex h-10 w-10 items-center justify-center rounded-lg text-white ${card.accent}`}
              >
                {card.icon}
              </span>
              <div className="flex-1">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  {card.label}
                </p>
                <p
                  className="text-2xl font-semibold text-slate-900"
                  data-testid={`super-admin-metrics-value-${card.key}`}
                >
                  {value == null ? "—" : value.toLocaleString("en-IN")}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Per-tenant rollup table */}
      <div
        className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm"
        data-testid="super-admin-metrics-table-wrapper"
      >
        <table
          className="min-w-full text-left text-sm"
          data-testid="super-admin-metrics-table"
        >
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <SortableTh
                label="Tenant"
                sortKey="tenantName"
                currentKey={sortKey}
                currentDir={sortDir}
                onToggle={toggleSort}
              />
              <SortableTh
                label="Users"
                sortKey="userCount"
                currentKey={sortKey}
                currentDir={sortDir}
                onToggle={toggleSort}
              />
              <SortableTh
                label="Patients"
                sortKey="patientCount"
                currentKey={sortKey}
                currentDir={sortDir}
                onToggle={toggleSort}
              />
              <SortableTh
                label="Appts (7d)"
                sortKey="appointmentsLast7d"
                currentKey={sortKey}
                currentDir={sortDir}
                onToggle={toggleSort}
              />
              <SortableTh
                label="Invoices (30d)"
                sortKey="invoicesLast30d"
                currentKey={sortKey}
                currentDir={sortDir}
                onToggle={toggleSort}
              />
              <SortableTh
                label="Created"
                sortKey="createdAt"
                currentKey={sortKey}
                currentDir={sortDir}
                onToggle={toggleSort}
              />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sortedRows.length === 0 && !loading ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  data-testid="super-admin-metrics-empty"
                >
                  No tenants to display.
                </td>
              </tr>
            ) : null}
            {sortedRows.map((row) => (
              <tr
                key={row.tenantId}
                data-testid={`super-admin-metrics-row-${row.tenantId}`}
              >
                <td className="px-4 py-3 font-medium text-slate-900">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{row.tenantName}</span>
                    <span
                      className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] uppercase text-slate-600"
                      data-testid={`super-admin-metrics-plan-${row.tenantId}`}
                    >
                      {row.plan}
                    </span>
                    {row.active ? (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] uppercase text-emerald-700">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] uppercase text-slate-500">
                        Inactive
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums text-slate-800">
                  {row.userCount.toLocaleString("en-IN")}
                </td>
                <td className="px-4 py-3 tabular-nums text-slate-800">
                  {row.patientCount.toLocaleString("en-IN")}
                </td>
                <td className="px-4 py-3 tabular-nums text-slate-800">
                  {row.appointmentsLast7d.toLocaleString("en-IN")}
                </td>
                <td className="px-4 py-3 tabular-nums text-slate-800">
                  {row.invoicesLast30d.toLocaleString("en-IN")}
                </td>
                <td className="px-4 py-3 text-slate-700">
                  {formatCreated(row.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        className="text-xs text-slate-500"
        data-testid="super-admin-metrics-count-summary"
      >
        {sortedRows.length} tenant{sortedRows.length === 1 ? "" : "s"} shown
        (top-20 by user count)
      </div>
    </section>
  );
}

function SortableTh({
  label,
  sortKey,
  currentKey,
  currentDir,
  onToggle,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: "asc" | "desc";
  onToggle: (key: SortKey) => void;
}): React.ReactElement {
  const active = currentKey === sortKey;
  return (
    <th scope="col" className="px-4 py-3 font-medium">
      <button
        type="button"
        data-testid={`super-admin-metrics-sort-${sortKey}`}
        onClick={() => onToggle(sortKey)}
        aria-sort={
          active ? (currentDir === "asc" ? "ascending" : "descending") : "none"
        }
        className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-slate-500 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
      >
        {label}
        <ArrowUpDown
          size={12}
          className={active ? "text-slate-900" : "text-slate-400"}
          aria-hidden="true"
        />
      </button>
    </th>
  );
}
