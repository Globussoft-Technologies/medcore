"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { formatDate } from "@/lib/format";
import { PlaneTakeoff, Plus, XCircle } from "lucide-react";

interface Leave {
  id: string;
  type: string;
  fromDate: string;
  toDate: string;
  totalDays: number;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  rejectionReason?: string | null;
  approvedAt?: string | null;
  createdAt: string;
  approver?: { id: string; name: string } | null;
}

interface Summary {
  pending: number;
  approved: number;
  used: Record<string, number>;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  APPROVED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-700",
  CANCELLED: "bg-gray-100 text-gray-600",
};

export default function MyLeavesPage() {
  const confirm = useConfirm();
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    type: "CASUAL",
    fromDate: "",
    toDate: "",
    reason: "",
  });
  // Field-level error messages, keyed by field name. Populated either by
  // client-side checks (date-range) or by backend 400 responses (Zod issues).
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Recompute the To-date error reactively as the user edits either side of
  // the range. This is issue #32's real requirement: show guidance next to
  // the To-date input BEFORE the user hits Submit, instead of a generic alert.
  const toDateError =
    form.fromDate && form.toDate && form.toDate < form.fromDate
      ? "End date must be on or after start date"
      : fieldErrors.toDate || "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{
        data: { leaves: Leave[]; summary: Summary };
      }>("/leaves/my");
      setLeaves(res.data.leaves);
      setSummary(res.data.summary);
    } catch {
      // empty
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submitLeave(e: React.FormEvent) {
    e.preventDefault();
    // Client-side gate: show the same field-level message the server would
    // reject with, instead of submitting and then rendering the 400 as an
    // alert(). Matches issue #32's UX requirement.
    if (form.fromDate && form.toDate && form.toDate < form.fromDate) {
      setFieldErrors({
        toDate: "End date must be on or after start date",
      });
      return;
    }
    setFieldErrors({});
    try {
      await api.post("/leaves", form);
      setShowModal(false);
      setForm({ type: "CASUAL", fromDate: "", toDate: "", reason: "" });
      setFieldErrors({});
      load();
    } catch (err) {
      // If the server returned Zod field-level issues, surface them next to
      // the offending input instead of as a generic alert. The API's
      // errorHandler returns details as [{ field, message }, ...].
      const payload = (err as { payload?: { details?: unknown } })?.payload;
      const details = payload && typeof payload === "object"
        ? (payload as { details?: unknown }).details
        : undefined;
      if (Array.isArray(details) && details.length > 0) {
        const next: Record<string, string> = {};
        for (const issue of details as Array<{ field?: string; message?: string }>) {
          if (issue?.field && issue?.message && !next[issue.field]) {
            next[issue.field] = issue.message;
          }
        }
        if (Object.keys(next).length > 0) {
          setFieldErrors(next);
          return;
        }
      }
      toast.error(err instanceof Error ? err.message : "Request failed");
    }
  }

  async function cancelLeave(id: string) {
    if (!(await confirm({ title: "Cancel this leave request?", danger: true }))) return;
    try {
      await api.patch(`/leaves/${id}/cancel`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  const totalUsed = summary
    ? Object.values(summary.used).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <PlaneTakeoff /> My Leaves
          </h1>
          <p className="text-sm text-gray-500">
            View and manage your leave requests
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} /> Request Leave
        </button>
      </div>

      {/* Summary */}
      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-500">Pending</p>
            <p className="text-3xl font-bold text-yellow-700">
              {summary.pending}
            </p>
          </div>
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-500">Approved (YTD)</p>
            <p className="text-3xl font-bold text-green-700">
              {summary.approved}
            </p>
          </div>
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-500">Days Used (YTD)</p>
            <p className="text-3xl font-bold text-blue-700">{totalUsed}</p>
          </div>
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <p className="mb-1 text-sm text-gray-500">By Type</p>
            <div className="space-y-0.5 text-xs">
              {Object.entries(summary.used)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <span className="text-gray-600">{k}</span>
                    <span className="font-semibold">{v}d</span>
                  </div>
                ))}
              {Object.values(summary.used).every((v) => v === 0) && (
                <p className="text-gray-400">No leaves taken yet</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* List */}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : leaves.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No leave requests yet. Click &quot;Request Leave&quot; to create one.
          </div>
        ) : (
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-sm text-gray-600">
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Dates</th>
                <th className="px-4 py-3">Days</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {leaves.map((l) => (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="px-4 py-3 text-sm font-medium">{l.type}</td>
                  <td className="px-4 py-3 text-sm">
                    {formatDate(l.fromDate)} – {formatDate(l.toDate)}
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold">
                    {l.totalDays}
                  </td>
                  <td className="px-4 py-3 text-sm max-w-[260px]">
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
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {/* Issue #119: prefer the central formatDate helper so a
                        null/invalid createdAt renders as "—". */}
                    {formatDate(l.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    {l.status === "PENDING" ? (
                      <button
                        onClick={() => cancelLeave(l.id)}
                        className="flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200"
                      >
                        <XCircle size={12} /> Cancel
                      </button>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Request Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form
            onSubmit={submitLeave}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
          >
            <h2 className="mb-4 text-lg font-semibold">Request Leave</h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Leave Type
                </label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  <option value="CASUAL">Casual</option>
                  <option value="SICK">Sick</option>
                  <option value="EARNED">Earned</option>
                  <option value="MATERNITY">Maternity</option>
                  <option value="PATERNITY">Paternity</option>
                  <option value="UNPAID">Unpaid</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="leave-from" className="mb-1 block text-sm font-medium">
                    From
                  </label>
                  <input
                    id="leave-from"
                    type="date"
                    required
                    value={form.fromDate}
                    onChange={(e) =>
                      setForm({ ...form, fromDate: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="leave-to" className="mb-1 block text-sm font-medium">
                    To
                  </label>
                  <input
                    id="leave-to"
                    type="date"
                    required
                    value={form.toDate}
                    min={form.fromDate || undefined}
                    onChange={(e) => {
                      setForm({ ...form, toDate: e.target.value });
                      // Clear any server-side error once the user edits.
                      if (fieldErrors.toDate) {
                        setFieldErrors((prev) => {
                          const next = { ...prev };
                          delete next.toDate;
                          return next;
                        });
                      }
                    }}
                    aria-invalid={toDateError ? true : undefined}
                    aria-describedby={toDateError ? "toDate-error" : undefined}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${
                      toDateError ? "border-red-500" : ""
                    }`}
                  />
                  {toDateError && (
                    <p
                      id="toDate-error"
                      role="alert"
                      className="mt-1 text-xs text-red-600"
                    >
                      {toDateError}
                    </p>
                  )}
                </div>
              </div>
              <div>
                <label htmlFor="leave-reason" className="mb-1 block text-sm font-medium">
                  Reason
                </label>
                <textarea
                  id="leave-reason"
                  required
                  rows={3}
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-lg border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Submit Request
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
