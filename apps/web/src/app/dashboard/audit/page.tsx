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

const actionColors: Record<string, string> = {
  AUTH_LOGIN: "bg-blue-100 text-blue-700",
  USER_REGISTER: "bg-blue-100 text-blue-700",
  AUTH_LOGOUT: "bg-blue-100 text-blue-700",
  APPOINTMENT_CREATE: "bg-green-100 text-green-700",
  WALK_IN_REGISTER: "bg-green-100 text-green-700",
  APPOINTMENT_STATUS_UPDATE: "bg-yellow-100 text-yellow-700",
  INVOICE_CREATE: "bg-purple-100 text-purple-700",
  PAYMENT_CREATE: "bg-purple-100 text-purple-700",
  PRESCRIPTION_CREATE: "bg-teal-100 text-teal-700",
};

function getActionColor(action: string) {
  return actionColors[action] || "bg-gray-100 text-gray-700";
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
        <p className="text-gray-500">Access denied. Admin only.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield size={24} className="text-gray-700" />
          <h1 className="text-2xl font-bold">Audit Log</h1>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Retention banner */}
      {retention && (
        <div className="mb-4 flex items-start gap-3 rounded-xl bg-blue-50 p-4 text-sm text-blue-800">
          <Info size={18} className="mt-0.5 text-blue-600" />
          <div>
            <p className="font-medium">
              Retention: {retention.retentionDays} days ·{" "}
              {retention.totalEntries.toLocaleString()} entries stored
              {retention.oldestEntry
                ? ` · oldest ${new Date(retention.oldestEntry).toLocaleDateString()}`
                : ""}
            </p>
            {retention.byYear.length > 0 && (
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
      <div className="mb-6 grid grid-cols-1 gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            From
          </label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            To
          </label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Entity Type
          </label>
          <select
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
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
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Action
          </label>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {filterOpts?.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            User
          </label>
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {filterOpts?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            IP Contains
          </label>
          <input
            type="text"
            value={ipContains}
            onChange={(e) => setIpContains(e.target.value)}
            placeholder="e.g. 192.168."
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        </div>
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Free-text search (entity, action, details)
          </label>
          <input
            type="text"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Search..."
            className="w-full rounded-lg border px-3 py-2 text-sm"
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
      <div className="rounded-xl bg-white shadow-sm">
        {loading && entries.length === 0 ? (
          <div className="p-4"><SkeletonTable rows={8} columns={6} /></div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No audit entries found
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-gray-500">
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
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                        {formatTimestamp(entry.timestamp)}
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium">{entry.userName}</p>
                        <p className="text-xs text-gray-400">
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
                        {entry.entityId && (
                          <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                            {entry.entityId}
                          </code>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
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
                  className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
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
