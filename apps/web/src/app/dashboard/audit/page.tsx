"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useRouter } from "next/navigation";
import { Shield, Download, Info } from "lucide-react";
import { SkeletonTable } from "@/components/Skeleton";

interface AuditEntry {
  id: string;
  timestamp: string;
  userId: string | null;
  userName: string;
  userEmail: string;
  action: string;
  entity: string;
  entityId: string | null;
  // Issue #192 (Apr 30 2026): server-resolved human-readable label for the
  // entity (e.g. `User: Dr. Sharma`, `Patient: ... (MR: MR-1234)`). When
  // the row references a deleted record (or an unresolved entity type) the
  // server returns `null` and the table falls back to the bare UUID.
  entityLabel?: string | null;
  ipAddress: string | null;
  details?: unknown;
}

interface AuditFilters {
  actions: string[];
  users: Array<{ id: string; name: string; email: string }>;
}

interface RetentionStats {
  totalEntries: number;
  byYear: Array<{ year: string; count: number }>;
  retentionDays: number;
  oldestEntry: string | null;
}

interface AuditResponse {
  data: AuditEntry[];
  meta?: { total: number; page: number; totalPages: number };
}

// Issue #79: entity types now use canonical Capital case across the dropdown.
// Historical rows in the audit_logs table are mixed-case ("patient" vs
// "Patient", "scheduled_report" vs "ScheduledReport") because different
// writers wrote them inconsistently. The backend filter is case-insensitive,
// so a single canonical label here matches all historical variants.
const entityTypes = [
  "Appointment",
  "Invoice",
  "Payment",
  "Prescription",
  "User",
  "Patient",
  "Admission",
  "Vitals",
  "ScheduledReport",
  "EmergencyCase",
  "Bed",
  "LabOrder",
  "LabResult",
];

// Issue #830: action badges previously used pastel `bg-*-100 text-*-700` only,
// which renders as a barely-visible low-contrast pill on the dark-mode table
// surface. Pairing every base colour with a `dark:bg-*-900/40 dark:text-*-300`
// variant keeps the WCAG AA contrast on both themes without changing the
// visual language (still soft / chip-style).
const actionColors: Record<string, string> = {
  AUTH_LOGIN: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  USER_REGISTER: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  AUTH_LOGOUT: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  APPOINTMENT_CREATE: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  WALK_IN_REGISTER: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  APPOINTMENT_STATUS_UPDATE: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  INVOICE_CREATE: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  PAYMENT_CREATE: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  PRESCRIPTION_CREATE: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
};

function getActionColor(action: string) {
  return actionColors[action] || "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200";
}

// Issue #79: historical rows write entity in inconsistent casing
// ("patient", "Patient", "scheduled_report"). Render a canonical
// Capital-camelcase label for the table cell so the column is uniform.
function canonicalEntity(raw: string | null | undefined): string {
  if (!raw) return "";
  // snake_case → CapitalCamel
  if (raw.includes("_")) {
    return raw
      .split("_")
      .filter(Boolean)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
      .join("");
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export default function AuditPage() {
  const { user } = useAuthStore();
  const router = useRouter();

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  // Filters
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [entity, setEntity] = useState("");
  const [action, setAction] = useState("");
  const [userId, setUserId] = useState("");
  const [ipContains, setIpContains] = useState("");
  const [freeText, setFreeText] = useState("");

  const [filterOpts, setFilterOpts] = useState<AuditFilters | null>(null);
  const [retention, setRetention] = useState<RetentionStats | null>(null);

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, router]);

  const buildQuery = useCallback(
    (pageNum: number) => {
      const params = new URLSearchParams();
      params.set("page", String(pageNum));
      params.set("limit", "50");
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      if (entity) params.set("entity", entity);
      if (action) params.set("action", action);
      if (userId) params.set("userId", userId);
      if (ipContains.trim()) params.set("ipContains", ipContains.trim());
      if (freeText.trim()) params.set("q", freeText.trim());
      return params.toString();
    },
    [fromDate, toDate, entity, action, userId, ipContains, freeText]
  );

  const loadEntries = useCallback(
    async (pageNum: number, append = false) => {
      setLoading(true);
      try {
        const endpoint = freeText.trim() ? "/audit/search" : "/audit";
        const res = await api.get<AuditResponse>(`${endpoint}?${buildQuery(pageNum)}`);
        if (append) {
          setEntries((prev) => [...prev, ...res.data]);
        } else {
          setEntries(res.data);
        }
        if (res.meta) {
          setHasMore(pageNum < res.meta.totalPages);
        }
      } catch {
        // empty
      }
      setLoading(false);
    },
    [buildQuery, freeText]
  );

  // Initial load + filter options + retention stats
  useEffect(() => {
    if (user?.role === "ADMIN") {
      setPage(1);
      loadEntries(1);

      api
        .get<{ data: AuditFilters }>("/audit/filters")
        .then((r) => setFilterOpts(r.data))
        .catch(() => undefined);

      api
        .get<{ data: RetentionStats }>("/audit/retention-stats")
        .then((r) => setRetention(r.data))
        .catch(() => undefined);
    }
  }, [user, loadEntries]);

  function handleFilter() {
    setPage(1);
    loadEntries(1);
  }

  function loadMore() {
    const next = page + 1;
    setPage(next);
    loadEntries(next, true);
  }

  function handleExport() {
    const token = localStorage.getItem("medcore_token");
    const qs = buildQuery(1);
    const API_BASE =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
    // Fetch CSV with auth header
    fetch(`${API_BASE}/audit/export.csv?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `audit-${new Date().toISOString().split("T")[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      });
  }

  function formatTimestamp(dateStr: string) {
    const d = new Date(dateStr);
    return d.toLocaleString();
  }

  if (!user || user.role !== "ADMIN") {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400">Access denied. Admin only.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield size={24} className="text-gray-700 dark:text-gray-200" />
          <h1 className="text-2xl font-bold">Audit Log</h1>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Retention banner — Issue #829: the original `bg-blue-50 text-blue-800`
          combo fails AA on dark backgrounds (light-blue surface against the
          near-black app shell, with mid-blue text). Pair with a dark-tinted
          surface + readable foreground so the same shape works on both
          themes. */}
      {retention && (
        <div className="mb-4 flex items-start gap-3 rounded-xl bg-blue-50 p-4 text-sm text-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
          <Info size={18} className="mt-0.5 text-blue-600 dark:text-blue-300" />
          <div>
            <p className="font-medium">
              Retention: {retention.retentionDays} days ·{" "}
              {(retention.totalEntries ?? 0).toLocaleString()} entries stored
              {retention.oldestEntry
                ? ` · oldest ${new Date(retention.oldestEntry).toLocaleDateString()}`
                : ""}
            </p>
            {retention.byYear && retention.byYear.length > 0 && (
              <p className="mt-1 text-xs">
                By year:{" "}
                {retention.byYear
                  .map((b) => `${b.year}: ${b.count.toLocaleString()}`)
                  .join(" · ")}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mb-6 grid grid-cols-1 gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-4 dark:bg-gray-800">
        <div>
          <label htmlFor="audit-filter-from" className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            From
          </label>
          <input
            id="audit-filter-from"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:scheme-dark"
          />
        </div>
        <div>
          <label htmlFor="audit-filter-to" className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            To
          </label>
          <input
            id="audit-filter-to"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:scheme-dark"
          />
        </div>
        <div>
          <label htmlFor="audit-filter-entity" className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            Entity Type
          </label>
          <select
            id="audit-filter-entity"
            data-testid="audit-entity-filter"
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:scheme-dark"
          >
            <option value="">All</option>
            {entityTypes.map((et) => (
              <option key={et} value={et}>
                {et}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-filter-action" className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            Action
          </label>
          <select
            id="audit-filter-action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:scheme-dark"
          >
            <option value="">All</option>
            {filterOpts?.actions?.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-filter-user" className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            User
          </label>
          <select
            id="audit-filter-user"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:scheme-dark"
          >
            <option value="">All</option>
            {filterOpts?.users?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-filter-ip" className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            IP Contains
          </label>
          <input
            id="audit-filter-ip"
            type="text"
            value={ipContains}
            onChange={(e) => setIpContains(e.target.value)}
            placeholder="e.g. 192.168."
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:scheme-dark"
          />
        </div>
        <div className="md:col-span-2">
          <label htmlFor="audit-filter-q" className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            Free-text search (entity, action, details)
          </label>
          <input
            id="audit-filter-q"
            type="text"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Search..."
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:scheme-dark"
          />
        </div>
        <div className="md:col-span-4 flex justify-end">
          <button
            onClick={handleFilter}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            Apply Filters
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
        {loading && entries.length === 0 ? (
          <div className="p-4"><SkeletonTable rows={8} columns={6} /></div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            No audit entries found
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <th className="whitespace-nowrap px-4 py-3">Timestamp</th>
                    <th className="whitespace-nowrap px-4 py-3">User</th>
                    <th className="whitespace-nowrap px-4 py-3">Action</th>
                    <th className="whitespace-nowrap px-4 py-3">Entity</th>
                    <th className="whitespace-nowrap px-4 py-3">Entity ID</th>
                    <th className="whitespace-nowrap px-4 py-3">IP Address</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className="border-b last:border-0">
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                        {formatTimestamp(entry.timestamp)}
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium">{entry.userName}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">
                          {entry.userEmail}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${getActionColor(
                            entry.action
                          )}`}
                        >
                          {entry.action.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">{canonicalEntity(entry.entity)}</td>
                      <td className="px-4 py-3">
                        {/* Issue #192: render the human-readable entityLabel
                            in the cell and surface the UUID only on hover
                            (and as a small monospace caption underneath).
                            When the resolver returned null (deleted row,
                            unknown entity type) we fall back to the UUID. */}
                        {entry.entityLabel ? (
                          <div
                            data-testid={`audit-entity-${entry.id}`}
                            title={entry.entityId ?? ""}
                          >
                            <p className="text-sm text-gray-800 dark:text-gray-100">
                              {entry.entityLabel}
                            </p>
                            {entry.entityId && (
                              <code className="text-[10px] text-gray-400 dark:text-gray-500">
                                {entry.entityId}
                              </code>
                            )}
                          </div>
                        ) : entry.entityId ? (
                          <code
                            data-testid={`audit-entity-${entry.id}`}
                            className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                          >
                            {entry.entityId}
                          </code>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                        {entry.ipAddress ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {hasMore && (
              <div className="border-t p-4 text-center">
                <button
                  onClick={loadMore}
                  disabled={loading}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  {loading ? "Loading..." : "Load More"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
