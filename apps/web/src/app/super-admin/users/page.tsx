// Cross-tenant super-admin user roster — Pearl ERP Stage 1 §8.2
// (gap row 208 closure, 2026-05-23).
//
// Lists rows from /api/v1/super-admin/users (Role.ADMIN where
// tenantId == null). Each row exposes a Deactivate / Activate toggle
// (PATCH /:id { active }), gated so the caller can't act on themselves.
// The API enforces the "last active super-admin" guard and returns 409;
// the page surfaces the API error inline so the operator immediately
// understands why the action was refused.
//
// The "Add super-admin" CTA links to /super-admin/users/new — the
// creator flow is a separate piece (out of scope for this gap row); the
// link renders as a stub so the placement is correct when the creator
// ships.
//
// Mobile-first: h-11 (44px) touch targets across filter chips + row
// CTAs.
//
// Defence-in-depth: the layout (apps/web/src/app/super-admin/layout.tsx)
// already gates on Role.ADMIN + tenantId == null. We do NOT re-check
// here — the rendered page is unreachable for forbidden roles. The API
// is the source of truth and double-enforces.

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, ShieldCheck, UserPlus, XCircle } from "lucide-react";
import { useAuthStore } from "@/lib/store";

interface SuperAdminUserRow {
  id: string;
  name: string;
  email: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
}

interface ListResponse {
  success: boolean;
  data: { users: SuperAdminUserRow[] };
  error: string | null;
}

interface PatchResponse {
  success: boolean;
  data: SuperAdminUserRow | null;
  error: string | null;
}

type ActiveFilter = "all" | "true" | "false";

const ACTIVE_CHIPS: Array<{ key: ActiveFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "true", label: "Active" },
  { key: "false", label: "Deactivated" },
];

function formatCreated(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-IN", {
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

export default function SuperAdminUsersPage() {
  const { user: currentUser } = useAuthStore();
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [search, setSearch] = useState("");
  // Debounced search query — the actual value sent to /api?q=.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [rows, setRows] = useState<SuperAdminUserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-row in-flight indicator for the deactivate / activate toggle.
  const [busyById, setBusyById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("active", activeFilter);
    if (debouncedSearch.length > 0) params.set("q", debouncedSearch);
    return params.toString();
  }, [activeFilter, debouncedSearch]);

  async function fetchRows(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/super-admin/users?${queryString}`, {
        credentials: "include",
      });
      const body = (await res.json()) as ListResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setRows(body.data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  async function toggleActive(
    row: SuperAdminUserRow,
    nextActive: boolean,
  ): Promise<void> {
    setBusyById((prev) => ({ ...prev, [row.id]: true }));
    setError(null);
    try {
      const res = await fetch(`/api/v1/super-admin/users/${row.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: nextActive }),
      });
      const body = (await res.json().catch(() => ({}))) as PatchResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      // Optimistic local update + refetch so the active-filter view
      // refreshes (deactivated row falls out of the active view).
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id ? { ...r, isActive: nextActive } : r,
        ),
      );
      await fetchRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyById((prev) => {
        const { [row.id]: _, ...rest } = prev;
        return rest;
      });
    }
  }

  return (
    <section
      data-testid="super-admin-users"
      className="space-y-6 py-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Super-Admin Roster
          </h1>
          <p className="text-sm text-slate-600">
            Users with <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">role = ADMIN</code> AND no tenant
            binding. Deactivating a row prevents login to the Pearl
            console; the last active super-admin cannot be deactivated.
          </p>
        </div>
        <Link
          href="/super-admin/users/new"
          data-testid="super-admin-users-add"
          className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
        >
          <UserPlus size={14} aria-hidden="true" />
          Add super-admin
        </Link>
      </header>

      {/* Filter chip row */}
      <div
        className="flex flex-wrap gap-2"
        data-testid="super-admin-users-filters"
      >
        {ACTIVE_CHIPS.map((chip) => {
          const active = activeFilter === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              data-testid={`super-admin-users-filter-${chip.key}`}
              aria-pressed={active}
              onClick={() => setActiveFilter(chip.key)}
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

      {/* Free-text search */}
      <div>
        <label
          htmlFor="super-admin-users-search"
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          Search (name or email)
        </label>
        <input
          id="super-admin-users-search"
          data-testid="super-admin-users-search"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="e.g. Priya or ops@"
          className="h-11 w-full max-w-md rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
      </div>

      {error ? (
        <div
          role="alert"
          data-testid="super-admin-users-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      <div
        className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm"
        data-testid="super-admin-users-table-wrapper"
      >
        <table
          className="min-w-full text-left text-sm"
          data-testid="super-admin-users-table"
        >
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Name
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Email
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Created
              </th>
              <th scope="col" className="px-4 py-3 font-medium text-right">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && !loading ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  data-testid="super-admin-users-empty"
                >
                  No super-admin users match these filters.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => {
              const isSelf = currentUser?.id === row.id;
              const busy = !!busyById[row.id];
              const nextActive = !row.isActive;
              return (
                <tr
                  key={row.id}
                  data-testid={`super-admin-users-row-${row.id}`}
                  data-is-active={row.isActive ? "true" : "false"}
                >
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <span className="inline-flex items-center gap-2">
                      <ShieldCheck size={14} className="text-slate-400" aria-hidden="true" />
                      {row.name}
                      {isSelf ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] uppercase text-slate-600">
                          You
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {row.email ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {row.isActive ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                        data-testid={`super-admin-users-status-${row.id}`}
                      >
                        <CheckCircle2 size={12} aria-hidden="true" />
                        Active
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-500"
                        data-testid={`super-admin-users-status-${row.id}`}
                      >
                        <XCircle size={12} aria-hidden="true" />
                        Deactivated
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatCreated(row.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      data-testid={`super-admin-users-toggle-${row.id}`}
                      disabled={busy || isSelf}
                      onClick={() => toggleActive(row, nextActive)}
                      title={
                        isSelf
                          ? "You cannot deactivate yourself"
                          : nextActive
                            ? "Reactivate this super-admin"
                            : "Deactivate this super-admin"
                      }
                      className="inline-flex h-11 min-w-[100px] items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
                    >
                      {busy ? (
                        <Loader2
                          size={14}
                          className="animate-spin"
                          aria-hidden="true"
                        />
                      ) : null}
                      {busy
                        ? "Working…"
                        : nextActive
                          ? "Activate"
                          : "Deactivate"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div
        className="text-xs text-slate-500"
        data-testid="super-admin-users-count-summary"
      >
        {rows.length} super-admin user{rows.length === 1 ? "" : "s"} shown
      </div>
    </section>
  );
}
