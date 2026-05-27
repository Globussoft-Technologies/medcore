// Super-admin audit trail — Pearl ERP Stage 1 §8.2.
//
// Cross-tenant AuditLog viewer filtered to rows authored by super-admins
// (Role.ADMIN, tenantId = null). Each row shows actor / action / entity
// / IP / device with infinite-scroll pagination.
//
// Backed by GET /api/v1/super-admin/audit. Filters: action substring,
// actor, tenantId, date range (from / to).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Shield,
  RefreshCw,
  Search,
  Calendar,
  AlertCircle,
  ArrowLeft,
} from "lucide-react";
import { csrfFetch } from "@/lib/csrf-fetch";

interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  tenantId: string | null;
  ipAddress: string | null;
  device: string | null;
  details: unknown;
  createdAt: string;
  actor: { id: string; name: string; email: string | null } | null;
}

interface ListResponse {
  success: boolean;
  data: { entries: AuditEntry[] };
  error: string | null;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function shortenDevice(ua: string | null): string {
  if (!ua) return "—";
  // Chrome on Mac → "Chrome / macOS"; Firefox on Win → "Firefox / Win"; etc.
  let browser = "Browser";
  if (/Chrome\/\d/.test(ua) && !/Edg\//.test(ua)) browser = "Chrome";
  else if (/Firefox\/\d/.test(ua)) browser = "Firefox";
  else if (/Safari\/\d/.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";
  else if (/Edg\/\d/.test(ua)) browser = "Edge";
  let os = "OS";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  return `${browser} / ${os}`;
}

export default function SuperAdminAuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [visibleCount, setVisibleCount] = useState(50);
  const PAGE_SIZE = 50;

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (actionFilter.trim()) p.set("action", actionFilter.trim());
    if (actorFilter.trim()) p.set("actorId", actorFilter.trim());
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    p.set("limit", "500");
    return p.toString();
  }, [actionFilter, actorFilter, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await csrfFetch(`/api/v1/super-admin/audit?${params}`);
      const body: ListResponse = await res.json();
      if (!res.ok || !body.success) {
        setError(body.error ?? `Failed (HTTP ${res.status})`);
        setEntries([]);
        return;
      }
      setEntries(body.data.entries ?? []);
      setVisibleCount(PAGE_SIZE);
    } catch (err) {
      setError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = entries.slice(0, visibleCount);
  const hasMore = visibleCount < entries.length;

  return (
    <section
      data-testid="super-admin-audit"
      className="space-y-6 py-4"
    >
      <Link
        href="/super-admin"
        className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft size={14} aria-hidden="true" /> Super-admin console
      </Link>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Shield size={22} aria-hidden="true" />
            Super-admin audit trail
          </h1>
          <p className="text-sm text-slate-600">
            Every action taken by a super-admin across all tenants. Pearl §8.2
            — actor, timestamp, IP, and device on every row.
          </p>
        </div>
        <button
          type="button"
          data-testid="super-admin-audit-refresh"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-11 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw
            size={14}
            className={loading ? "animate-spin" : ""}
            aria-hidden="true"
          />
          Refresh
        </button>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg bg-white p-3 shadow-sm">
        <div className="flex-1 min-w-[180px]">
          <label className="mb-1 block text-xs font-medium text-slate-600">
            Action contains
          </label>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              data-testid="super-admin-audit-action-filter"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              placeholder="e.g. TENANT_ or LOGIN"
              className="h-10 w-full rounded-md border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="mb-1 block text-xs font-medium text-slate-600">
            Actor (user id)
          </label>
          <input
            data-testid="super-admin-audit-actor-filter"
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            placeholder="uuid…"
            className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            From
          </label>
          <div className="relative">
            <Calendar
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              data-testid="super-admin-audit-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-10 rounded-md border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            To
          </label>
          <div className="relative">
            <Calendar
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              data-testid="super-admin-audit-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-10 rounded-md border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="super-admin-audit-error"
          className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
        <table
          data-testid="super-admin-audit-table"
          className="min-w-full divide-y divide-slate-200 text-sm"
        >
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Timestamp</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Entity</th>
              <th className="px-4 py-3">Tenant</th>
              <th className="px-4 py-3">IP</th>
              <th className="px-4 py-3">Device</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  data-testid="super-admin-audit-empty"
                >
                  No audit rows match the current filters.
                </td>
              </tr>
            )}
            {visible.map((entry) => (
              <tr
                key={entry.id}
                data-testid={`super-admin-audit-row-${entry.id}`}
                className="hover:bg-slate-50"
              >
                <td
                  className="px-4 py-2 font-mono text-xs text-slate-700"
                  title={entry.createdAt}
                >
                  {formatTimestamp(entry.createdAt)}
                </td>
                <td className="px-4 py-2 text-xs">
                  {entry.actor ? (
                    <Link
                      href={`/super-admin/users/${entry.actor.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {entry.actor.name}
                    </Link>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                  {entry.actor?.email && (
                    <div className="text-[10px] text-slate-500">
                      {entry.actor.email}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                    {entry.action}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-slate-700">
                  <div>{entry.entity}</div>
                  {entry.entityId && (
                    <div className="font-mono text-[10px] text-slate-400">
                      {entry.entityId.slice(0, 12)}…
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-[10px] text-slate-600">
                  {entry.tenantId ? entry.tenantId.slice(0, 12) + "…" : "—"}
                </td>
                <td className="px-4 py-2 font-mono text-[10px] text-slate-600">
                  {entry.ipAddress ?? "—"}
                </td>
                <td className="px-4 py-2 text-xs text-slate-600">
                  {shortenDevice(entry.device)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="super-admin-audit-load-more"
            onClick={() =>
              setVisibleCount((c) =>
                Math.min(c + PAGE_SIZE, entries.length),
              )
            }
            className="inline-flex h-10 items-center gap-1 rounded-md border border-slate-300 bg-white px-4 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Load {Math.min(PAGE_SIZE, entries.length - visibleCount)} more
          </button>
        </div>
      )}
      {!hasMore && entries.length > 0 && (
        <div
          data-testid="super-admin-audit-end"
          className="text-center text-xs text-slate-500"
        >
          Showing all {entries.length} entries
        </div>
      )}
    </section>
  );
}
