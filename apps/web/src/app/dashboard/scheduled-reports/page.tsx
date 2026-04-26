"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { Clock, Plus, Play, History, Trash2, Power, X } from "lucide-react";

interface ScheduledReport {
  id: string;
  name: string;
  reportType: string;
  frequency: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  timeOfDay: string;
  recipients: string[];
  active: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
}

interface ReportRun {
  id: string;
  reportType: string;
  status: string;
  generatedAt: string;
  sentTo?: string[] | null;
  error?: string | null;
  scheduledReport?: { id: string; name: string } | null;
}

const REPORT_TYPES = [
  { value: "DAILY_CENSUS", label: "Daily Census" },
  { value: "WEEKLY_REVENUE", label: "Weekly Revenue" },
  { value: "MONTHLY_SUMMARY", label: "Monthly Summary" },
  { value: "CUSTOM", label: "Custom" },
];

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"];
const DAYS_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ScheduledReportsPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const confirm = useConfirm();

  const [tab, setTab] = useState<"schedules" | "runs">("schedules");
  const [reports, setReports] = useState<ScheduledReport[]>([]);
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [reportType, setReportType] = useState("DAILY_CENSUS");
  const [frequency, setFrequency] = useState("DAILY");
  const [dayOfWeek, setDayOfWeek] = useState<number>(1);
  const [dayOfMonth, setDayOfMonth] = useState<number>(1);
  const [timeOfDay, setTimeOfDay] = useState("08:00");
  const [recipients, setRecipients] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "schedules") {
        const res = await api.get<{ data: ScheduledReport[] }>(
          "/scheduled-reports"
        );
        setReports(res.data || []);
      } else {
        const res = await api.get<{ data: ReportRun[] }>(
          "/scheduled-reports/runs"
        );
        setRuns(res.data || []);
      }
    } catch {
      setReports([]);
      setRuns([]);
    }
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    if (user?.role === "ADMIN") load();
  }, [user, load]);

  if (!user || user.role !== "ADMIN") {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-gray-500">Access denied. Admin only.</p>
      </div>
    );
  }

  function resetForm() {
    setName("");
    setReportType("DAILY_CENSUS");
    setFrequency("DAILY");
    setDayOfWeek(1);
    setDayOfMonth(1);
    setTimeOfDay("08:00");
    setRecipients("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const recipientList = recipients
        .split(/[,\n]/)
        .map((r) => r.trim())
        .filter(Boolean);

      const body: Record<string, unknown> = {
        name,
        reportType,
        frequency,
        timeOfDay,
        recipients: recipientList,
      };
      if (frequency === "WEEKLY") body.dayOfWeek = dayOfWeek;
      if (frequency === "MONTHLY") body.dayOfMonth = dayOfMonth;

      await api.post("/scheduled-reports", body);
      resetForm();
      setShowForm(false);
      load();
    } catch (e) {
      toast.error((e as Error).message || "Failed to create");
    }
    setSubmitting(false);
  }

  async function handleRunNow(id: string) {
    if (!(await confirm({ title: "Run this report now?", message: "This will email to all recipients." }))) return;
    try {
      await api.post(`/scheduled-reports/${id}/run-now`);
      toast.success("Report queued. Check Run History tab for status.");
      load();
    } catch (e) {
      toast.error((e as Error).message || "Failed");
    }
  }

  async function handleToggle(id: string, active: boolean) {
    try {
      await api.patch(`/scheduled-reports/${id}`, { active: !active });
      load();
    } catch {
      // empty
    }
  }

  async function handleDelete(id: string) {
    if (!(await confirm({ title: "Delete this scheduled report?", danger: true }))) return;
    try {
      await api.delete(`/scheduled-reports/${id}`);
      load();
    } catch (e) {
      toast.error((e as Error).message || "Failed");
    }
  }

  // Issue #80 — "Next Run" was rendered with the browser's local timezone but
  // labelled as IST, so users on UTC/server-time saw a 5h30m skew. Force the
  // formatter to Asia/Kolkata so the displayed time always matches the IST
  // schedule the cron job actually fires on.
  function formatNextRun(iso?: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Clock size={24} className="text-gray-700" />
          <h1 className="text-2xl font-bold">Scheduled Reports</h1>
        </div>
        {tab === "schedules" && (
          <button
            onClick={() => setShowForm((s) => !s)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            {showForm ? <X size={16} /> : <Plus size={16} />}
            {showForm ? "Cancel" : "New Report"}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b">
        <button
          onClick={() => setTab("schedules")}
          className={`px-4 py-2 text-sm font-medium ${
            tab === "schedules"
              ? "border-b-2 border-primary text-primary"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Schedules
        </button>
        <button
          onClick={() => setTab("runs")}
          className={`px-4 py-2 text-sm font-medium ${
            tab === "runs"
              ? "border-b-2 border-primary text-primary"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <History size={14} className="mr-1 inline" /> Run History
        </button>
      </div>

      {/* Create Form */}
      {showForm && tab === "schedules" && (
        <form
          onSubmit={handleCreate}
          className="mb-6 grid grid-cols-1 gap-4 rounded-xl bg-white p-6 shadow-sm md:grid-cols-2"
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-lg border px-3 py-2 text-sm"
              placeholder="Weekly Revenue Email"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Report Type
            </label>
            <select
              value={reportType}
              onChange={(e) => setReportType(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            >
              {REPORT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Frequency
            </label>
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            >
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Time (HH:MM)
            </label>
            <input
              type="time"
              value={timeOfDay}
              onChange={(e) => setTimeOfDay(e.target.value)}
              required
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          {frequency === "WEEKLY" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Day of Week
              </label>
              <select
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(parseInt(e.target.value, 10))}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              >
                {DAYS_OF_WEEK.map((d, i) => (
                  <option key={i} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
          {frequency === "MONTHLY" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Day of Month
              </label>
              <input
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(parseInt(e.target.value, 10))}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
          )}
          <div className="md:col-span-2">
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Recipients (comma or newline separated emails)
            </label>
            <textarea
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              required
              rows={2}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              placeholder="admin@example.com, director@example.com"
            />
          </div>
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create Schedule"}
            </button>
          </div>
        </form>
      )}

      {/* Tab Content */}
      {tab === "schedules" ? (
        <div className="rounded-xl bg-white shadow-sm">
          {loading ? (
            <div className="p-8 text-center text-gray-500">Loading...</div>
          ) : reports.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No scheduled reports yet
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-gray-500">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Frequency</th>
                    <th className="px-4 py-3">Next Run</th>
                    <th className="px-4 py-3">Recipients</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-4 py-3 font-medium">{r.name}</td>
                      <td className="px-4 py-3 text-sm">{r.reportType}</td>
                      <td className="px-4 py-3 text-sm">
                        {r.frequency} @ {r.timeOfDay}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {formatNextRun(r.nextRunAt)}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {(r.recipients as string[]).join(", ")}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            r.active
                              ? "bg-green-100 text-green-700"
                              : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {r.active ? "Active" : "Paused"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleRunNow(r.id)}
                            title="Run now"
                            className="rounded p-1 text-blue-600 hover:bg-blue-50"
                          >
                            <Play size={16} />
                          </button>
                          <button
                            onClick={() => handleToggle(r.id, r.active)}
                            title={r.active ? "Pause" : "Resume"}
                            className="rounded p-1 text-gray-600 hover:bg-gray-100"
                          >
                            <Power size={16} />
                          </button>
                          <button
                            onClick={() => handleDelete(r.id)}
                            title="Delete"
                            className="rounded p-1 text-red-600 hover:bg-red-50"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-white shadow-sm">
          {loading ? (
            <div className="p-8 text-center text-gray-500">Loading...</div>
          ) : runs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No run history yet
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-gray-500">
                    <th className="px-4 py-3">Generated</th>
                    <th className="px-4 py-3">Schedule</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Recipients</th>
                    <th className="px-4 py-3">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {/* Issue #80 — render generated time in IST too */}
                        {new Date(r.generatedAt).toLocaleString("en-IN", {
                          timeZone: "Asia/Kolkata",
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: true,
                        })}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {r.scheduledReport?.name ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-sm">{r.reportType}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            r.status === "SUCCESS"
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {(r.sentTo as string[] | undefined)?.join(", ") ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-red-500">
                        {r.error ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
