"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useRouter } from "next/navigation";
import { Shield } from "lucide-react";

interface AuditEntry {
  id: string;
  timestamp: string;
  userId: string;
  userName: string;
  userEmail: string;
  action: string;
  entity: string;
  entityId: string;
  ipAddress: string;
}

interface AuditResponse {
  data: AuditEntry[];
  meta?: { total: number; page: number; totalPages: number };
}

const entityTypes = [
  "Appointment",
  "Invoice",
  "Payment",
  "Prescription",
  "User",
];

const actionColors: Record<string, string> = {
  LOGIN: "bg-blue-100 text-blue-700",
  REGISTER: "bg-blue-100 text-blue-700",
  LOGOUT: "bg-blue-100 text-blue-700",
  BOOK_APPOINTMENT: "bg-green-100 text-green-700",
  WALK_IN: "bg-green-100 text-green-700",
  UPDATE_APPOINTMENT_STATUS: "bg-yellow-100 text-yellow-700",
  CREATE_INVOICE: "bg-purple-100 text-purple-700",
  RECORD_PAYMENT: "bg-purple-100 text-purple-700",
  CREATE_PRESCRIPTION: "bg-teal-100 text-teal-700",
};

function getActionColor(action: string) {
  return actionColors[action] || "bg-gray-100 text-gray-700";
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
  const [userSearch, setUserSearch] = useState("");

  // Redirect non-admins
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
      if (userSearch.trim()) params.set("userId", userSearch.trim());
      return params.toString();
    },
    [fromDate, toDate, entity, userSearch]
  );

  const loadEntries = useCallback(
    async (pageNum: number, append = false) => {
      setLoading(true);
      try {
        const res = await api.get<AuditResponse>(
          `/audit?${buildQuery(pageNum)}`
        );
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
    [buildQuery]
  );

  useEffect(() => {
    if (user?.role === "ADMIN") {
      setPage(1);
      loadEntries(1);
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
      <div className="mb-6 flex items-center gap-3">
        <Shield size={24} className="text-gray-700" />
        <h1 className="text-2xl font-bold">Audit Log</h1>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            From
          </label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
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
            className="rounded-lg border px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Entity Type
          </label>
          <select
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
          >
            <option value="">All Entities</option>
            {entityTypes.map((et) => (
              <option key={et} value={et}>
                {et}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">
            User (ID or email)
          </label>
          <input
            type="text"
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
            placeholder="Search by user..."
            className="rounded-lg border px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={handleFilter}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          Apply Filters
        </button>
      </div>

      {/* Table */}
      <div className="rounded-xl bg-white shadow-sm">
        {loading && entries.length === 0 ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
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
                      <td className="px-4 py-3 text-sm">{entry.entity}</td>
                      <td className="px-4 py-3">
                        <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                          {entry.entityId}
                        </code>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {entry.ipAddress}
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
