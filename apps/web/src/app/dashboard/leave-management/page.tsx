"use client";

import { useEffect, useState, useCallback } from "react";
import { api, openPrintEndpoint } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { formatDate } from "@/lib/format";
import { Check, X, PlaneTakeoff, Printer } from "lucide-react";

interface Leave {
  id: string;
  userId: string;
  type: string;
  fromDate: string;
  toDate: string;
  totalDays: number;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  rejectionReason?: string | null;
  approvedAt?: string | null;
  createdAt: string;
  user?: { id: string; name: string; role: string; email: string };
  approver?: { id: string; name: string } | null;
}

type Tab = "PENDING" | "APPROVED" | "REJECTED" | "ALL";

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  APPROVED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-700",
  CANCELLED: "bg-gray-100 text-gray-600",
};

const LEAVE_TYPES = ["CASUAL", "SICK", "EARNED", "MATERNITY", "PATERNITY", "UNPAID"];

export default function LeaveManagementPage() {
  const { user } = useAuthStore();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("PENDING");
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = tab === "ALL" ? "" : `?status=${tab}`;
      const res = await api.get<{ data: Leave[] }>(`/leaves${qs}`);
      setLeaves(res.data);
    } catch {
      setLeaves([]);
    }
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  if (user?.role !== "ADMIN") {
    return (
      <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm">
        Access restricted to administrators.
      </div>
    );
  }

  async function handleApprove(id: string) {
    if (!(await confirm({ title: "Approve this leave request?" }))) return;
    try {
      await api.patch(`/leaves/${id}/approve`, { status: "APPROVED" });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    }
  }

  async function handleRejectSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!rejectId) return;
    try {
      await api.patch(`/leaves/${rejectId}/reject`, {
        rejectionReason: rejectReason,
      });
      setRejectId(null);
      setRejectReason("");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    }
  }

  const filtered = leaves.filter((l) => {
    if (typeFilter !== "ALL" && l.type !== typeFilter) return false;
    if (fromDate && new Date(l.fromDate) < new Date(fromDate)) return false;
    if (toDate && new Date(l.toDate) > new Date(toDate)) return false;
    return true;
  });

  const tabClasses = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  return (
    <div>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <PlaneTakeoff /> Leave Management
        </h1>
        <p className="text-sm text-gray-500">
          Review and approve staff leave requests
        </p>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <button onClick={() => setTab("PENDING")} className={tabClasses("PENDING")}>
          Pending
        </button>
        <button onClick={() => setTab("APPROVED")} className={tabClasses("APPROVED")}>
          Approved
        </button>
        <button onClick={() => setTab("REJECTED")} className={tabClasses("REJECTED")}>
          Rejected
        </button>
        <button onClick={() => setTab("ALL")} className={tabClasses("ALL")}>
          All
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-white p-3 shadow-sm">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Type:</label>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border px-3 py-1.5 text-sm"
          >
            <option value="ALL">All</option>
            {LEAVE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">From:</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="rounded-lg border px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">To:</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="rounded-lg border px-3 py-1.5 text-sm"
          />
        </div>
        {(fromDate || toDate || typeFilter !== "ALL") && (
          <button
            onClick={() => {
              setFromDate("");
              setToDate("");
              setTypeFilter("ALL");
            }}
            className="text-xs text-primary hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No leave requests found.
          </div>
        ) : (
          <table className="w-full min-w-[800px]">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-sm text-gray-600">
                <th className="px-4 py-3">Staff</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Dates</th>
                <th className="px-4 py-3">Days</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium">{l.user?.name}</p>
                    <p className="text-xs text-gray-500">{l.user?.role}</p>
                  </td>
                  <td className="px-4 py-3 text-sm">{l.type}</td>
                  <td className="px-4 py-3 text-sm">
                    {formatDate(l.fromDate)} – {formatDate(l.toDate)}
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold">
                    {l.totalDays}
                  </td>
                  <td className="px-4 py-3 text-sm max-w-[240px]">
                    <p className="truncate" title={l.reason}>
                      {l.reason}
                    </p>
                    {l.rejectionReason && (
                      <p className="text-xs text-red-600">
                        Rejected: {l.rejectionReason}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[l.status]}`}
                    >
                      {l.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {l.status === "PENDING" ? (
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleApprove(l.id)}
                          className="flex items-center gap-1 rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                        >
                          <Check size={12} /> Approve
                        </button>
                        <button
                          onClick={() => {
                            setRejectId(l.id);
                            setRejectReason("");
                          }}
                          className="flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700"
                        >
                          <X size={12} /> Reject
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => openPrintEndpoint(`/leaves/${l.id}/letter`)}
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        title="Print leave letter"
                      >
                        <Printer size={12} /> Letter
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Reject Modal */}
      {rejectId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form
            onSubmit={handleRejectSubmit}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
          >
            <h2 className="mb-4 text-lg font-semibold">Reject Leave Request</h2>
            <div>
              <label className="mb-1 block text-sm font-medium">
                Rejection Reason
              </label>
              <textarea
                required
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                placeholder="Explain why this leave is being rejected..."
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejectId(null)}
                className="rounded-lg border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Reject
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
