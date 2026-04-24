"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { DollarSign, Receipt, AlertCircle, TrendingUp, History } from "lucide-react";

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

  useEffect(() => {
    if (user && user.role !== "ADMIN" && user.role !== "RECEPTION") {
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
          <div className="mb-4 flex gap-3">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded-lg border px-3 py-2 text-sm"
            >
              <option value="">All Types</option>
              <option value="DAILY_CENSUS">Daily Census</option>
              <option value="WEEKLY_REVENUE">Weekly Revenue</option>
              <option value="MONTHLY_SUMMARY">Monthly Summary</option>
              <option value="CUSTOM">Custom</option>
            </select>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="col-span-2 rounded-xl bg-white shadow-sm">
              {runsLoading ? (
                <div className="p-8 text-center text-gray-500">Loading...</div>
              ) : runs.length === 0 ? (
                <div className="p-8 text-center text-gray-500">No report runs yet</div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-left text-sm text-gray-500">
                      <th className="px-4 py-3">Generated</th>
                      <th className="px-4 py-3">Schedule</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
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
