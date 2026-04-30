"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import {
  DollarSign,
  Receipt,
  AlertCircle,
  TrendingUp,
  History,
  Plus,
  Calendar,
  Download,
} from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const REPORT_TYPES = [
  { value: "DAILY_CENSUS", label: "Daily Census" },
  { value: "WEEKLY_REVENUE", label: "Weekly Revenue" },
  { value: "MONTHLY_SUMMARY", label: "Monthly Summary" },
  { value: "CUSTOM", label: "Custom" },
] as const;

// Map a report type to the analytics CSV export route most useful for it.
// `null` means "no first-class CSV — fall back to JSON snapshot download".
const CSV_EXPORT_FOR_TYPE: Record<string, string | null> = {
  WEEKLY_REVENUE: "/analytics/export/revenue.csv",
  MONTHLY_SUMMARY: "/analytics/export/revenue.csv",
  DAILY_CENSUS: "/analytics/export/appointments.csv",
  CUSTOM: null,
};

interface DailyReport {
  totalCollection: number;
  transactionCount: number;
  pendingInvoices: number;
  paymentModeBreakdown: Record<string, number>;
  recentPayments: Array<{
    id: string;
    amount: number;
    mode: string;
    paidAt: string;
    patient: { user: { name: string } };
  }>;
}

const MODE_COLORS: Record<string, string> = {
  CASH: "bg-green-500",
  CARD: "bg-blue-500",
  UPI: "bg-purple-500",
  ONLINE: "bg-amber-500",
};

const MODE_BG_LIGHT: Record<string, string> = {
  CASH: "bg-green-100 text-green-700",
  CARD: "bg-blue-100 text-blue-700",
  UPI: "bg-purple-100 text-purple-700",
  ONLINE: "bg-amber-100 text-amber-700",
};

interface ReportRun {
  id: string;
  reportType: string;
  generatedAt: string;
  status: string;
  parameters?: unknown;
  snapshot?: unknown;
  scheduledReport?: { id: string; name: string } | null;
  sentTo?: string[] | null;
  error?: string | null;
}

export default function ReportsPage() {
  // Issue #347 — wrap the body in an ErrorBoundary so a single render-time
  // TypeError can't take down the whole client. The inner body keeps its
  // own defensive coercion so happy-path renders are unchanged.
  return (
    <ErrorBoundary testId="reports-page-error">
      <ReportsPageBody />
    </ErrorBoundary>
  );
}

function ReportsPageBody() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [date, setDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"daily" | "history">("daily");

  // Report history
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [selectedRun, setSelectedRun] = useState<ReportRun | null>(null);
  const [typeFilter, setTypeFilter] = useState("");

  // Issue #301 — Generate / Schedule modal state. The Report History tab used
  // to be a dead-end (no actions). We now wire three controls:
  //   • Generate  → POST /analytics/report-runs
  //   • Schedule  → POST /scheduled-reports  (then run-now to create a run)
  //   • Export    → window-open authed CSV export for that report type
  // Modals live in-DOM (per project rule: never window.prompt/alert/confirm).
  const [genOpen, setGenOpen] = useState(false);
  const [genType, setGenType] = useState<string>("WEEKLY_REVENUE");
  const [genFrom, setGenFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split("T")[0];
  });
  const [genTo, setGenTo] = useState<string>(() => new Date().toISOString().split("T")[0]);
  const [genSubmitting, setGenSubmitting] = useState(false);

  const [schedOpen, setSchedOpen] = useState(false);
  const [schedName, setSchedName] = useState<string>("");
  const [schedType, setSchedType] = useState<string>("WEEKLY_REVENUE");
  const [schedFreq, setSchedFreq] = useState<"DAILY" | "WEEKLY" | "MONTHLY">("WEEKLY");
  const [schedTime, setSchedTime] = useState<string>("09:00");
  const [schedEmail, setSchedEmail] = useState<string>("");
  const [schedSubmitting, setSchedSubmitting] = useState(false);

  // Issue #90: Reports surface "Today's Revenue" + collection KPIs. RECEPTION
  // must NOT see financial KPIs — this page is now ADMIN-only.
  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
      return;
    }
  }, [user, router]);

  const loadReport = useCallback(async () => {
    setLoading(true);
    try {
      // The API returns { byMode, payments, ... } — normalize to the shape
      // this component expects. Also defensively default every collection so
      // render never crashes on `.map`/`.length` / `Object.values`.
      const res = await api.get<{ data: Record<string, unknown> }>(
        `/billing/reports/daily?date=${date}`
      );
      const raw = (res?.data ?? {}) as Record<string, unknown>;
      const modeBreakdown =
        (raw.paymentModeBreakdown as Record<string, number> | undefined) ??
        (raw.byMode as Record<string, number> | undefined) ??
        {};
      const recents =
        (raw.recentPayments as DailyReport["recentPayments"] | undefined) ??
        (raw.payments as DailyReport["recentPayments"] | undefined) ??
        [];
      setReport({
        totalCollection: Number(raw.totalCollection ?? 0),
        transactionCount: Number(raw.transactionCount ?? 0),
        pendingInvoices: Number(raw.pendingInvoices ?? 0),
        paymentModeBreakdown: modeBreakdown ?? {},
        recentPayments: Array.isArray(recents) ? recents : [],
      });
    } catch {
      setReport({
        totalCollection: 0,
        transactionCount: 0,
        pendingInvoices: 0,
        paymentModeBreakdown: {},
        recentPayments: [],
      });
    }
    setLoading(false);
  }, [date]);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", "100");
      if (typeFilter) qs.set("type", typeFilter);
      const res = await api.get<{ data: ReportRun[] }>(
        `/analytics/report-runs?${qs.toString()}`
      );
      setRuns(Array.isArray(res?.data) ? res.data : []);
    } catch {
      setRuns([]);
    }
    setRunsLoading(false);
  }, [typeFilter]);

  useEffect(() => {
    if (tab === "daily") {
      loadReport();
    } else {
      loadRuns();
    }
  }, [tab, loadReport, loadRuns]);

  // ── Generate handler ─────────────────────────────────
  const submitGenerate = useCallback(async () => {
    if (!genFrom || !genTo) {
      toast.error("Please select a from/to date range");
      return;
    }
    if (new Date(genFrom) > new Date(genTo)) {
      toast.error("'From' date must be before 'To' date");
      return;
    }
    setGenSubmitting(true);
    try {
      // POST /analytics/report-runs creates a run record. The server snapshot
      // is built when run via /scheduled-reports/:id/run-now, but for ad-hoc
      // generates we just record the parameters and a stub snapshot — the
      // backend keeps it simple per the existing route shape.
      await api.post("/analytics/report-runs", {
        reportType: genType,
        parameters: { from: genFrom, to: genTo },
        snapshot: { from: genFrom, to: genTo, generatedAdHoc: true },
        status: "SUCCESS",
      });
      toast.success("Report generated");
      setGenOpen(false);
      loadRuns();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate report");
    } finally {
      setGenSubmitting(false);
    }
  }, [genType, genFrom, genTo, loadRuns]);

  // ── Schedule handler ─────────────────────────────────
  const submitSchedule = useCallback(async () => {
    const trimmedName = schedName.trim();
    const trimmedEmail = schedEmail.trim();
    if (!trimmedName) {
      toast.error("Please enter a name for the schedule");
      return;
    }
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error("Please enter a valid recipient email");
      return;
    }
    setSchedSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name: trimmedName,
        reportType: schedType,
        frequency: schedFreq,
        timeOfDay: schedTime,
        recipients: [trimmedEmail],
        active: true,
      };
      // Default schedule axes the backend requires for non-DAILY frequencies.
      if (schedFreq === "WEEKLY") payload.dayOfWeek = 1; // Monday
      if (schedFreq === "MONTHLY") payload.dayOfMonth = 1;
      await api.post("/scheduled-reports", payload);
      toast.success("Schedule created");
      setSchedOpen(false);
      setSchedName("");
      setSchedEmail("");
      loadRuns();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to schedule report");
    } finally {
      setSchedSubmitting(false);
    }
  }, [schedName, schedEmail, schedType, schedFreq, schedTime, loadRuns]);

  // ── Export CSV handler (per row) ─────────────────────
  // The CSV endpoints are authed (Bearer token) so we fetch+blob+download
  // instead of a raw <a href>. A null mapping means there's no first-class
  // CSV — we fall back to a JSON download of the run snapshot itself.
  const exportRunCsv = useCallback(async (run: ReportRun) => {
    try {
      const apiBase =
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
      const token =
        typeof window !== "undefined"
          ? localStorage.getItem("medcore_token")
          : null;
      const csvPath = CSV_EXPORT_FOR_TYPE[run.reportType] ?? null;

      if (csvPath) {
        const params = (run.parameters as { from?: string; to?: string } | undefined) ?? {};
        const qs = new URLSearchParams();
        if (params.from) qs.set("from", params.from);
        if (params.to) qs.set("to", params.to);
        const url = `${apiBase}${csvPath}${qs.toString() ? "?" + qs.toString() : ""}`;
        const res = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`Export failed (${res.status})`);
        const blob = await res.blob();
        const dl = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = dl;
        a.download = `report-${run.reportType.toLowerCase()}-${run.id}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(dl);
        return;
      }

      // Fallback: download the raw snapshot JSON for CUSTOM / unmapped types.
      const json = JSON.stringify(run.snapshot ?? {}, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const dl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = dl;
      a.download = `report-${run.reportType.toLowerCase()}-${run.id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(dl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to export report");
    }
  }, []);

  if (user && user.role !== "ADMIN" && user.role !== "RECEPTION") return null;

  const modeBreakdown = report?.paymentModeBreakdown ?? {};
  const modeValues = Object.values(modeBreakdown);
  const maxModeAmount =
    modeValues.length > 0 ? Math.max(...modeValues, 1) : 1;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Billing Reports</h1>
          <p className="text-sm text-gray-500">Daily collection summary and generation history</p>
        </div>
        {tab === "daily" && (
          <input
            type="date"
            value={date}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border px-4 py-2 text-sm"
          />
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b">
        <button
          onClick={() => setTab("daily")}
          className={`px-4 py-2 text-sm font-medium ${
            tab === "daily"
              ? "border-b-2 border-primary text-primary"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Daily Collection
        </button>
        <button
          onClick={() => setTab("history")}
          className={`px-4 py-2 text-sm font-medium ${
            tab === "history"
              ? "border-b-2 border-primary text-primary"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <History size={14} className="mr-1 inline" /> Report History
        </button>
      </div>

      {tab === "history" && (
        <div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded-lg border px-3 py-2 text-sm"
              data-testid="report-type-filter"
            >
              <option value="">All Types</option>
              <option value="DAILY_CENSUS">Daily Census</option>
              <option value="WEEKLY_REVENUE">Weekly Revenue</option>
              <option value="MONTHLY_SUMMARY">Monthly Summary</option>
              <option value="CUSTOM">Custom</option>
            </select>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setGenOpen(true)}
                data-testid="report-generate-btn"
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90"
              >
                <Plus size={14} /> Generate
              </button>
              <button
                type="button"
                onClick={() => setSchedOpen(true)}
                data-testid="report-schedule-btn"
                className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50"
              >
                <Calendar size={14} /> Schedule
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="col-span-2 rounded-xl bg-white shadow-sm">
              {runsLoading ? (
                <div className="p-8 text-center text-gray-500">Loading...</div>
              ) : (Array.isArray(runs) ? runs : []).length === 0 ? (
                <div className="p-8 text-center text-gray-500">No report runs yet</div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-left text-sm text-gray-500">
                      <th className="px-4 py-3">Generated</th>
                      <th className="px-4 py-3">Schedule</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(Array.isArray(runs) ? runs : []).map((r) => (
                      <tr
                        key={r.id}
                        onClick={() => setSelectedRun(r)}
                        className={`cursor-pointer border-b last:border-0 hover:bg-gray-50 ${
                          selectedRun?.id === r.id ? "bg-blue-50" : ""
                        }`}
                      >
                        <td className="px-4 py-3 text-sm">
                          {new Date(r.generatedAt).toLocaleString("en-IN")}
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
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              exportRunCsv(r);
                            }}
                            data-testid={`report-export-${r.id}`}
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-gray-50"
                            title="Export CSV"
                          >
                            <Download size={12} /> Export
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <h3 className="mb-3 text-sm font-semibold">Run Detail</h3>
              {selectedRun ? (
                <div className="space-y-2 text-xs">
                  <p>
                    <strong>Type:</strong> {selectedRun.reportType}
                  </p>
                  <p>
                    <strong>Generated:</strong>{" "}
                    {new Date(selectedRun.generatedAt).toLocaleString("en-IN")}
                  </p>
                  <p>
                    <strong>Status:</strong> {selectedRun.status}
                  </p>
                  {selectedRun.sentTo && selectedRun.sentTo.length > 0 && (
                    <p>
                      <strong>Sent to:</strong> {selectedRun.sentTo.join(", ")}
                    </p>
                  )}
                  {selectedRun.error && (
                    <p className="text-red-600">
                      <strong>Error:</strong> {selectedRun.error}
                    </p>
                  )}
                  {selectedRun.parameters ? (
                    <div>
                      <p className="mb-1 font-semibold">Parameters</p>
                      <pre className="max-h-40 overflow-auto rounded bg-gray-50 p-2">
                        {JSON.stringify(selectedRun.parameters, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  {selectedRun.snapshot ? (
                    <div>
                      <p className="mb-1 font-semibold">Snapshot</p>
                      <pre className="max-h-60 overflow-auto rounded bg-gray-50 p-2">
                        {JSON.stringify(selectedRun.snapshot, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-gray-400">Select a row to view details</p>
              )}
            </div>
          </div>

          {/* Generate modal */}
          {genOpen && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              data-testid="report-generate-modal"
              role="dialog"
              aria-modal="true"
            >
              <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
                <h3 className="mb-4 text-lg font-semibold">Generate Report</h3>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">
                      Report Type
                    </label>
                    <select
                      value={genType}
                      onChange={(e) => setGenType(e.target.value)}
                      data-testid="report-generate-type"
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    >
                      {REPORT_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600">
                        From
                      </label>
                      <input
                        type="date"
                        value={genFrom}
                        onChange={(e) => setGenFrom(e.target.value)}
                        data-testid="report-generate-from"
                        className="w-full rounded-lg border px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600">
                        To
                      </label>
                      <input
                        type="date"
                        value={genTo}
                        onChange={(e) => setGenTo(e.target.value)}
                        data-testid="report-generate-to"
                        className="w-full rounded-lg border px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setGenOpen(false)}
                    data-testid="report-generate-cancel"
                    className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submitGenerate}
                    disabled={genSubmitting}
                    data-testid="report-generate-submit"
                    className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
                  >
                    {genSubmitting ? "Generating..." : "Generate"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Schedule modal */}
          {schedOpen && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              data-testid="report-schedule-modal"
              role="dialog"
              aria-modal="true"
            >
              <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
                <h3 className="mb-4 text-lg font-semibold">Schedule Report</h3>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">
                      Name
                    </label>
                    <input
                      type="text"
                      value={schedName}
                      onChange={(e) => setSchedName(e.target.value)}
                      placeholder="e.g. Weekly Revenue Summary"
                      data-testid="report-schedule-name"
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">
                      Report Type
                    </label>
                    <select
                      value={schedType}
                      onChange={(e) => setSchedType(e.target.value)}
                      data-testid="report-schedule-type"
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    >
                      {REPORT_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600">
                        Frequency
                      </label>
                      <select
                        value={schedFreq}
                        onChange={(e) =>
                          setSchedFreq(e.target.value as "DAILY" | "WEEKLY" | "MONTHLY")
                        }
                        data-testid="report-schedule-frequency"
                        className="w-full rounded-lg border px-3 py-2 text-sm"
                      >
                        <option value="DAILY">Daily</option>
                        <option value="WEEKLY">Weekly</option>
                        <option value="MONTHLY">Monthly</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600">
                        Time
                      </label>
                      <input
                        type="time"
                        value={schedTime}
                        onChange={(e) => setSchedTime(e.target.value)}
                        data-testid="report-schedule-time"
                        className="w-full rounded-lg border px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">
                      Recipient Email
                    </label>
                    <input
                      type="email"
                      value={schedEmail}
                      onChange={(e) => setSchedEmail(e.target.value)}
                      placeholder="ops@example.com"
                      data-testid="report-schedule-email"
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    />
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setSchedOpen(false)}
                    data-testid="report-schedule-cancel"
                    className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submitSchedule}
                    disabled={schedSubmitting}
                    data-testid="report-schedule-submit"
                    className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
                  >
                    {schedSubmitting ? "Saving..." : "Create Schedule"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "daily" && (
        <div>

      {loading ? (
        <div className="p-8 text-center text-gray-500">Loading...</div>
      ) : report ? (
        <>
          {/* Summary Cards */}
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
                  <DollarSign size={20} className="text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Total Collection</p>
                  <p className="text-xl font-bold">
                    Rs. {Number(report.totalCollection ?? 0).toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
                  <Receipt size={20} className="text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Transactions</p>
                  <p className="text-xl font-bold">{report.transactionCount}</p>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100">
                  <AlertCircle size={20} className="text-amber-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Pending Invoices</p>
                  <p className="text-xl font-bold">{report.pendingInvoices}</p>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100">
                  <TrendingUp size={20} className="text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Avg Transaction</p>
                  <p className="text-xl font-bold">
                    Rs.{" "}
                    {report.transactionCount > 0
                      ? (
                          report.totalCollection / report.transactionCount
                        ).toFixed(2)
                      : "0.00"}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Payment Mode Breakdown */}
          <div className="mb-6 rounded-xl bg-white p-6 shadow-sm">
            <h2 className="mb-4 font-semibold">Payment Mode Breakdown</h2>
            {Object.keys(modeBreakdown).length === 0 ? (
              <p className="text-sm text-gray-400">No payments recorded</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(modeBreakdown).map(([mode, amount]) => {
                  const amt = Number(amount ?? 0);
                  return (
                    <div key={mode}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="font-medium">{mode}</span>
                        <span className="text-gray-600">
                          Rs. {amt.toFixed(2)}
                        </span>
                      </div>
                      <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
                        <div
                          className={`h-full rounded-full transition-all ${MODE_COLORS[mode] || "bg-gray-400"}`}
                          style={{
                            width: `${(amt / maxModeAmount) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent Payments */}
          <div className="rounded-xl bg-white shadow-sm">
            <div className="border-b px-6 py-4">
              <h2 className="font-semibold">Recent Payments</h2>
            </div>
            {(report.recentPayments ?? []).length === 0 ? (
              <div className="p-8 text-center text-gray-400">
                No payments for this date
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-gray-500">
                    <th className="px-4 py-3">Patient</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Mode</th>
                    <th className="px-4 py-3">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {(report.recentPayments ?? []).map((p: any) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="px-4 py-3 font-medium">
                        {p?.patient?.user?.name ||
                          p?.invoice?.patient?.user?.name ||
                          "---"}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium">
                        Rs. {Number(p?.amount ?? 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${MODE_BG_LIGHT[p.mode] || "bg-gray-100 text-gray-600"}`}
                        >
                          {p.mode}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {new Date(p.paidAt).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
        </div>
      )}
    </div>
  );
}
