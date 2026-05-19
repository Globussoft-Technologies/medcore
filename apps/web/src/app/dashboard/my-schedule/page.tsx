"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { usePrompt } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import {
  CalendarDays,
  Clock,
  LogIn,
  LogOut,
  PlaneTakeoff,
  Plus,
} from "lucide-react";

interface Shift {
  id: string;
  userId: string;
  date: string;
  type: "MORNING" | "AFTERNOON" | "NIGHT" | "ON_CALL";
  startTime: string;
  endTime: string;
  status: "SCHEDULED" | "PRESENT" | "ABSENT" | "LATE" | "LEAVE";
  notes?: string | null;
}

interface LeaveSummary {
  pending: number;
  approved: number;
  used: Record<string, number>;
}

const TYPE_COLORS: Record<string, string> = {
  MORNING:
    "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800",
  AFTERNOON:
    "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-200 dark:border-orange-800",
  NIGHT:
    "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-200 dark:border-indigo-800",
  ON_CALL:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-200 dark:border-purple-800",
};

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  PRESENT: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  ABSENT: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  LATE: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200",
  LEAVE: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
};

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isSameDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10);
}

export default function MySchedulePage() {
  const { user } = useAuthStore();
  const promptUser = usePrompt();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [summary, setSummary] = useState<LeaveSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [leaveForm, setLeaveForm] = useState({
    type: "CASUAL",
    fromDate: "",
    toDate: "",
    reason: "",
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, lRes] = await Promise.all([
        api.get<{ data: Shift[] }>("/shifts/my"),
        api.get<{ data: { leaves: unknown[]; summary: LeaveSummary } }>("/leaves/my"),
      ]);
      setShifts(sRes.data);
      setSummary(lRes.data.summary);
    } catch {
      // empty
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days: Date[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    return d;
  });

  const todayKey = toDateKey(today);

  function shiftsForDay(d: Date): Shift[] {
    const key = toDateKey(d);
    return shifts.filter((s) => isSameDay(s.date, key));
  }

  async function handleCheckIn(shiftId: string) {
    try {
      await api.patch(`/shifts/${shiftId}/check-in`);
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Check-in failed");
    }
  }

  async function handleCheckOut(shiftId: string) {
    const notes = await promptUser({
      title: "Check out",
      label: "Notes (optional)",
      multiline: true,
    });
    if (notes === null) return;
    try {
      await api.patch(`/shifts/${shiftId}/check-out`, { notes: notes || undefined });
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Check-out failed");
    }
  }

  async function submitLeave(e: React.FormEvent) {
    e.preventDefault();
    if (!leaveForm.fromDate || !leaveForm.toDate) {
      toast.error("From and To dates are required");
      return;
    }
    if (!leaveForm.reason.trim()) {
      toast.error("Reason is required");
      return;
    }
    try {
      await api.post("/leaves", leaveForm);
      setShowLeaveModal(false);
      setLeaveForm({ type: "CASUAL", fromDate: "", toDate: "", reason: "" });
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    }
  }

  const totalUsed = summary
    ? Object.values(summary.used).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">My Schedule</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Your upcoming shifts for the next 7 days
          </p>
        </div>
      </div>

      <MyCertificationsPanel userId={user?.id} />

      {loading ? (
        <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
          Loading...
        </div>
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-7">
          {days.map((d) => {
            const key = toDateKey(d);
            const isToday = key === todayKey;
            const dayShifts = shiftsForDay(d);
            return (
              <div
                key={key}
                className={`rounded-xl border bg-white p-4 shadow-sm dark:bg-gray-800 ${
                  isToday
                    ? "border-primary ring-2 ring-primary/20"
                    : "border-gray-200 dark:border-gray-700"
                }`}
              >
                <div className="mb-2">
                  <p className="text-xs uppercase text-gray-500 dark:text-gray-400">
                    {d.toLocaleDateString(undefined, { weekday: "short" })}
                  </p>
                  <p className="text-lg font-bold">
                    {d.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                  {isToday && (
                    <span className="text-xs font-medium text-primary">
                      Today
                    </span>
                  )}
                </div>
                {dayShifts.length === 0 ? (
                  <p className="text-xs text-gray-400">No shifts</p>
                ) : (
                  <div className="space-y-2">
                    {dayShifts.map((s) => (
                      <div
                        key={s.id}
                        className={`rounded-lg border p-2 text-xs ${TYPE_COLORS[s.type]}`}
                      >
                        <div className="mb-1 flex items-center justify-between">
                          <span className="font-semibold">{s.type}</span>
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLORS[s.status]}`}
                          >
                            {s.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-[11px]">
                          <Clock size={10} />
                          {s.startTime} – {s.endTime}
                        </div>
                        {isToday && (
                          <div className="mt-2 flex gap-1">
                            {(s.status === "SCHEDULED" ||
                              s.status === "LATE") && (
                              <button
                                onClick={() => handleCheckIn(s.id)}
                                className="flex flex-1 items-center justify-center gap-1 rounded bg-green-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-green-700"
                              >
                                <LogIn size={10} /> Check In
                              </button>
                            )}
                            {(s.status === "PRESENT" ||
                              s.status === "LATE") && (
                              <button
                                onClick={() => handleCheckOut(s.id)}
                                className="flex flex-1 items-center justify-center gap-1 rounded bg-gray-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-gray-700"
                              >
                                <LogOut size={10} /> Check Out
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Leave Summary */}
      <div className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <PlaneTakeoff size={18} /> My Leave
          </h2>
          <button
            onClick={() => setShowLeaveModal(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Request Leave
          </button>
        </div>

        {summary && (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="rounded-lg bg-yellow-50 p-4 dark:bg-yellow-900/20">
              <p className="text-sm text-gray-600 dark:text-gray-300">Pending</p>
              <p className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">
                {summary.pending}
              </p>
            </div>
            <div className="rounded-lg bg-green-50 p-4 dark:bg-green-900/20">
              <p className="text-sm text-gray-600 dark:text-gray-300">Approved (this year)</p>
              <p className="text-2xl font-bold text-green-700 dark:text-green-300">
                {summary.approved}
              </p>
            </div>
            <div className="rounded-lg bg-blue-50 p-4 dark:bg-blue-900/20">
              <p className="text-sm text-gray-600 dark:text-gray-300">Days Used (YTD)</p>
              <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">{totalUsed}</p>
            </div>
            <div className="rounded-lg bg-gray-50 p-4 text-xs dark:bg-gray-900/40">
              <p className="mb-1 font-medium text-gray-600 dark:text-gray-300">By type (days)</p>
              <div className="space-y-0.5">
                {Object.entries(summary.used)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span>{k}</span>
                      <span className="font-semibold">{v}</span>
                    </div>
                  ))}
                {Object.values(summary.used).every((v) => v === 0) && (
                  <p className="text-gray-400">No leaves taken yet</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Leave Request Modal */}
      {showLeaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form
            onSubmit={submitLeave}
            noValidate
            className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
          >
            <h2 className="mb-4 text-lg font-semibold">Request Leave</h2>
            <div className="space-y-3">
              <div>
                <label htmlFor="my-schedule-leave-type" className="mb-1 block text-sm font-medium">
                  Leave Type
                </label>
                <select
                  id="my-schedule-leave-type"
                  value={leaveForm.type}
                  onChange={(e) =>
                    setLeaveForm({ ...leaveForm, type: e.target.value })
                  }
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
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
                  <label htmlFor="my-schedule-leave-from" className="mb-1 block text-sm font-medium">From</label>
                  <input
                    id="my-schedule-leave-from"
                    type="date"
                    value={leaveForm.fromDate}
                    onChange={(e) =>
                      setLeaveForm({ ...leaveForm, fromDate: e.target.value })
                    }
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label htmlFor="my-schedule-leave-to" className="mb-1 block text-sm font-medium">To</label>
                  <input
                    id="my-schedule-leave-to"
                    type="date"
                    value={leaveForm.toDate}
                    onChange={(e) =>
                      setLeaveForm({ ...leaveForm, toDate: e.target.value })
                    }
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="my-schedule-leave-reason" className="mb-1 block text-sm font-medium">Reason</label>
                <textarea
                  id="my-schedule-leave-reason"
                  rows={3}
                  value={leaveForm.reason}
                  onChange={(e) =>
                    setLeaveForm({ ...leaveForm, reason: e.target.value })
                  }
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowLeaveModal(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-600 dark:text-gray-300"
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

interface MyCert {
  id: string;
  type: string;
  title: string;
  expiryDate: string | null;
  status: string;
}

function MyCertificationsPanel({ userId }: { userId: string | undefined }) {
  const [certs, setCerts] = useState<MyCert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const res = await api.get<{ data: MyCert[] }>(
          `/hr-ops/certifications?userId=${userId}`
        );
        setCerts(res.data || []);
      } catch {
        setCerts([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  if (loading) return null;
  if (certs.length === 0) return null;

  const now = new Date();
  return (
    <div className="mb-6 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <h2 className="text-sm font-semibold mb-3">My Certifications</h2>
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-700">
        {certs.map((c) => {
          const days = c.expiryDate
            ? Math.round(
                (new Date(c.expiryDate).getTime() - now.getTime()) / 86400000
              )
            : null;
          const color =
            days === null
              ? "text-slate-500"
              : days < 0
                ? "text-red-600"
                : days <= 30
                  ? "text-amber-600"
                  : "text-green-700";
          return (
            <li key={c.id} className="py-2 flex items-center justify-between">
              <div>
                <div className="font-medium">{c.title}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {c.type.replace(/_/g, " ")}
                </div>
              </div>
              <div className={`text-xs ${color}`}>
                {c.expiryDate
                  ? days! < 0
                    ? `Expired ${-days!}d ago`
                    : `${days}d left`
                  : "No expiry"}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
