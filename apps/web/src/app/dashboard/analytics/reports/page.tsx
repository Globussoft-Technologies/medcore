"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { TenantSelect } from "@/components/TenantSelect";
import {
  ArrowLeft,
  Download,
  Save,
  Trash2,
  RefreshCw,
  ClipboardList,
  FileJson,
} from "lucide-react";
import { SkeletonTable } from "@/components/Skeleton";

// ─── Types ──────────────────────────────────────────

type ReportType =
  | "revenue"
  | "appointments"
  | "patients"
  | "ipd"
  | "pharmacy"
  | "no-show"
  | "tds"
  | "commission"
  | "lead-funnel";
type GroupBy = "day" | "week" | "month";

// Report types that aggregate by entity (not by time period) — the Group By
// selector is meaningless for these.
const NON_PERIOD_TYPES = new Set<ReportType>([
  "no-show",
  "tds",
  "commission",
  "lead-funnel",
]);

interface ReportConfig {
  id: string;
  name: string;
  type: ReportType;
  from: string;
  to: string;
  groupBy: GroupBy;
  filters: {
    doctorId?: string;
    paymentMode?: string;
    appointmentStatus?: string;
    wardId?: string;
    tdsRate?: string;
    source?: string;
  };
  createdAt: number;
}

interface PreviewData {
  rows: Array<Record<string, unknown>>;
  columns: Array<{ key: string; label: string; isCurrency?: boolean }>;
  summary?: Record<string, number | string>;
}

const STORAGE_KEY = "medcore_saved_reports";

const REPORT_TYPES: Array<{ key: ReportType; label: string; description: string }> = [
  { key: "revenue", label: "Revenue Report", description: "Payment transactions grouped by period and mode" },
  { key: "appointments", label: "Appointments Report", description: "Appointments with status breakdown" },
  { key: "patients", label: "Patient Growth", description: "New patient registrations over time" },
  { key: "ipd", label: "IPD Admissions", description: "Admissions, LOS and discharge metrics" },
  { key: "pharmacy", label: "Pharmacy Dispensing", description: "Top dispensed medicines and low stock" },
  { key: "no-show", label: "No-show Rate", description: "No-show rate by doctor" },
  { key: "tds", label: "TDS on Fees", description: "TDS on professional fees per doctor" },
  { key: "commission", label: "Commission Ledger", description: "Referring-doctor commission, paid vs pending" },
  { key: "lead-funnel", label: "Lead Funnel", description: "Lead-to-patient conversion by stage" },
];

// ─── Formatters ────────────────────────────────────

function formatCurrency(n: number): string {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows: Array<Record<string, unknown>>, columns: Array<{ key: string; label: string }>): string {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c.key])).join(","));
  return [header, ...lines].join("\r\n");
}

function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split("T")[0];
}

function today() {
  return new Date().toISOString().split("T")[0];
}

// ─── Page ──────────────────────────────────────────

export default function ReportsPage() {
  const { user } = useAuthStore();
  const router = useRouter();

  const [type, setType] = useState<ReportType>("revenue");
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(today());
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [filters, setFilters] = useState<ReportConfig["filters"]>({});
  const [saved, setSaved] = useState<ReportConfig[]>([]);
  const [configName, setConfigName] = useState("");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(false);

  // Super-admin tenant filter. A super-admin (actualRole SUPER_ADMIN, or the
  // legacy tenant-less ADMIN) bypasses tenant scoping; the /analytics router
  // middleware scopes every analytics endpoint to `?tenantId` for them. The
  // dropdown below lets them narrow to one tenant. Hidden for tenant-bound
  // staff (already scoped to their own).
  const isSuperAdmin =
    user?.actualRole === "SUPER_ADMIN" ||
    (user?.role === "ADMIN" && !user?.tenantId);
  const [tenants, setTenants] = useState<
    Array<{ id: string; name: string; subdomain: string }>
  >([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");

  // Guard
  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard/analytics");
    }
  }, [user, router]);

  // Load saved configs
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const persistSaved = useCallback((list: ReportConfig[]) => {
    setSaved(list);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }
  }, []);

  // Load the tenant list for the super-admin filter dropdown (GET /tenants is
  // super-admin-only, so we only call it for super-admins; others 403 silently).
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{
          data: Array<{ id: string; name: string; subdomain: string }>;
        }>("/tenants");
        if (!cancelled) setTenants(res.data || []);
      } catch {
        // non-super-admin / endpoint unavailable — leave the list empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin]);

  // Shared query string for the period-based report fetches. Super-admins
  // append `?tenantId` to scope every /analytics endpoint to one tenant.
  const tenantQ =
    isSuperAdmin && selectedTenantId
      ? `&tenantId=${encodeURIComponent(selectedTenantId)}`
      : "";
  const qs = useMemo(
    () => `from=${from}&to=${to}${tenantQ}`,
    [from, to, tenantQ],
  );

  // Build preview
  const runPreview = useCallback(async () => {
    setLoading(true);
    setPreview(null);

    try {
      if (type === "revenue") {
        const res = await api
          .get<{ data: Array<Record<string, number | string>> }>(
            `/analytics/revenue?${qs}&groupBy=${groupBy}`
          )
          .catch(() => null);
        const data = res?.data || [];
        setPreview({
          columns: [
            { key: "date", label: "Period" },
            { key: "total", label: "Total", isCurrency: true },
            { key: "cash", label: "Cash", isCurrency: true },
            { key: "card", label: "Card", isCurrency: true },
            { key: "upi", label: "UPI", isCurrency: true },
            { key: "online", label: "Online", isCurrency: true },
            { key: "insurance", label: "Insurance", isCurrency: true },
          ],
          rows: data,
          summary: {
            "Total Periods": data.length,
            "Grand Total": formatCurrency(
              data.reduce((s, r) => s + Number(r.total || 0), 0)
            ),
          },
        });
      } else if (type === "appointments") {
        const res = await api
          .get<{ data: Array<Record<string, number | string>> }>(
            `/analytics/appointments?${qs}&groupBy=${groupBy}`
          )
          .catch(() => null);
        const data = res?.data || [];
        setPreview({
          columns: [
            { key: "date", label: "Period" },
            { key: "count", label: "Total" },
            { key: "scheduled", label: "Scheduled" },
            { key: "walkin", label: "Walk-in" },
          ],
          rows: data,
          summary: {
            "Total Periods": data.length,
            "Total Appointments": data.reduce((s, r) => s + Number(r.count || 0), 0),
          },
        });
      } else if (type === "patients") {
        const res = await api
          .get<{ data: Array<Record<string, number | string>> }>(
            `/analytics/patients/growth?${qs}&groupBy=${groupBy}`
          )
          .catch(() => null);
        const data = res?.data || [];
        setPreview({
          columns: [
            { key: "date", label: "Period" },
            { key: "count", label: "New Patients" },
            { key: "cumulative", label: "Cumulative" },
          ],
          rows: data,
          summary: {
            "Total New": data.reduce((s, r) => s + Number(r.count || 0), 0),
          },
        });
      } else if (type === "ipd") {
        const [trendsRes, occRes] = await Promise.all([
          api
            .get<{ data: Record<string, unknown> }>(`/analytics/ipd/discharge-trends?${qs}`)
            .catch(() => null),
          api
            .get<{ data: { byWard: Array<{ wardName: string; total: number; occupied: number }> } }>(
              `/analytics/ipd/occupancy${tenantQ ? `?${tenantQ.slice(1)}` : ""}`
            )
            .catch(() => null),
        ]);
        const trends = (trendsRes?.data || {}) as Record<string, unknown>;
        const wards = occRes?.data?.byWard || [];
        const rows: Array<Record<string, unknown>> = [
          { metric: "Total Admissions", value: String(trends.totalAdmissions ?? 0) },
          { metric: "Discharged", value: String(trends.discharged ?? 0) },
          { metric: "Avg LOS (days)", value: String(trends.avgLengthOfStayDays ?? 0) },
          { metric: "Readmission Rate", value: `${trends.readmissionRate ?? 0}%` },
          { metric: "Mortality Rate", value: `${trends.mortalityRate ?? 0}%` },
          ...wards.map((w) => ({
            metric: `Ward: ${w.wardName}`,
            value: `${w.occupied}/${w.total}`,
          })),
        ];
        setPreview({
          columns: [
            { key: "metric", label: "Metric" },
            { key: "value", label: "Value" },
          ],
          rows,
          summary: {
            Admissions: String(trends.totalAdmissions ?? 0),
            "Avg LOS": String(trends.avgLengthOfStayDays ?? 0) + " days",
          },
        });
      } else if (type === "pharmacy") {
        const [topRes, lowRes] = await Promise.all([
          api
            .get<{ data: Array<Record<string, number | string>> }>(
              `/analytics/pharmacy/top-dispensed?limit=25${tenantQ}`
            )
            .catch(() => null),
          api
            .get<{ data: { count: number; items: Array<{ medicineName: string; quantity: number; reorderLevel: number }> } }>(
              `/analytics/pharmacy/low-stock${tenantQ ? `?${tenantQ.slice(1)}` : ""}`
            )
            .catch(() => null),
        ]);
        const top = topRes?.data || [];
        const low = lowRes?.data?.items || [];
        const rows: Array<Record<string, unknown>> = [
          ...top.map((t, i) => ({
            rank: i + 1,
            medicineName: t.medicineName,
            dispensed: t.dispensed,
            status: "Top Dispensed",
          })),
          ...low.map((l) => ({
            rank: "",
            medicineName: l.medicineName,
            dispensed: `${l.quantity}/${l.reorderLevel}`,
            status: "Low Stock",
          })),
        ];
        setPreview({
          columns: [
            { key: "rank", label: "#" },
            { key: "medicineName", label: "Medicine" },
            { key: "dispensed", label: "Quantity" },
            { key: "status", label: "Status" },
          ],
          rows,
          summary: {
            "Top Dispensed Items": top.length,
            "Low Stock Items": low.length,
          },
        });
      } else if (type === "no-show") {
        const p = new URLSearchParams({ from, to });
        if (isSuperAdmin && selectedTenantId) p.set("tenantId", selectedTenantId);
        const res = await api
          .get<{
            data: {
              totals: { totalAppointments: number; totalNoShows: number };
              byDoctor: Array<{
                doctorName: string;
                totalAppointments: number;
                noShowCount: number;
              }>;
            };
          }>(`/analytics/no-show-report?${p.toString()}`)
          .catch(() => null);
        const d = res?.data;
        const rate = (ns: number, t: number) =>
          t ? `${((ns / t) * 100).toFixed(1)}%` : "—";
        setPreview({
          columns: [
            { key: "doctor", label: "Doctor" },
            { key: "appointments", label: "Appointments" },
            { key: "noShows", label: "No-shows" },
            { key: "rate", label: "Rate" },
          ],
          rows: (d?.byDoctor || []).map((r) => ({
            doctor: r.doctorName,
            appointments: r.totalAppointments,
            noShows: r.noShowCount,
            rate: rate(r.noShowCount, r.totalAppointments),
          })),
          summary: {
            Appointments: d?.totals.totalAppointments ?? 0,
            "No-shows": d?.totals.totalNoShows ?? 0,
            "Overall rate": rate(
              d?.totals.totalNoShows ?? 0,
              d?.totals.totalAppointments ?? 0,
            ),
          },
        });
      } else if (type === "tds") {
        const p = new URLSearchParams({ from, to });
        if (filters.tdsRate) p.set("tdsRate", filters.tdsRate);
        const res = await api
          .get<{
            data: {
              totals: { totalGrossFees: number; totalTds: number; totalNet: number };
              byDoctor: Array<{
                doctorName: string;
                totalGrossFees: number;
                tdsRate: number;
                tdsAmount: number;
                netPayable: number;
                invoiceCount: number;
              }>;
            };
          }>(`/billing/tds-report?${p.toString()}`)
          .catch(() => null);
        const d = res?.data;
        setPreview({
          columns: [
            { key: "doctor", label: "Doctor" },
            { key: "gross", label: "Gross Fees", isCurrency: true },
            { key: "tdsRate", label: "TDS %" },
            { key: "tds", label: "TDS Amount", isCurrency: true },
            { key: "net", label: "Net Payable", isCurrency: true },
            { key: "invoices", label: "Invoices" },
          ],
          rows: (d?.byDoctor || []).map((r) => ({
            doctor: r.doctorName,
            gross: r.totalGrossFees,
            tdsRate: `${r.tdsRate}%`,
            tds: r.tdsAmount,
            net: r.netPayable,
            invoices: r.invoiceCount,
          })),
          summary: {
            "Gross Fees": formatCurrency(d?.totals.totalGrossFees ?? 0),
            "TDS Withheld": formatCurrency(d?.totals.totalTds ?? 0),
            "Net Payable": formatCurrency(d?.totals.totalNet ?? 0),
          },
        });
      } else if (type === "commission") {
        const p = new URLSearchParams({ from, to });
        const res = await api
          .get<{
            data: {
              totals: { totalAmount: number; paidAmount: number; pendingAmount: number };
              byDoctor: Array<{
                referringDoctorName: string;
                branchName: string | null;
                count: number;
                totalAmount: number;
                paidAmount: number;
                pendingAmount: number;
                voidedAmount: number;
              }>;
            };
          }>(`/referral-commissions/ledger?${p.toString()}`)
          .catch(() => null);
        const d = res?.data;
        setPreview({
          columns: [
            { key: "doctor", label: "Referring Doctor" },
            { key: "branch", label: "Branch" },
            { key: "entries", label: "Entries" },
            { key: "total", label: "Total", isCurrency: true },
            { key: "paid", label: "Paid", isCurrency: true },
            { key: "pending", label: "Pending", isCurrency: true },
            { key: "voided", label: "Voided", isCurrency: true },
          ],
          rows: (d?.byDoctor || []).map((r) => ({
            doctor: r.referringDoctorName,
            branch: r.branchName ?? "—",
            entries: r.count,
            total: r.totalAmount,
            paid: r.paidAmount,
            pending: r.pendingAmount,
            voided: r.voidedAmount,
          })),
          summary: {
            "Total Commission": formatCurrency(d?.totals.totalAmount ?? 0),
            Paid: formatCurrency(d?.totals.paidAmount ?? 0),
            Pending: formatCurrency(d?.totals.pendingAmount ?? 0),
          },
        });
      } else if (type === "lead-funnel") {
        const p = new URLSearchParams({ from, to });
        if (isSuperAdmin && selectedTenantId) p.set("tenantId", selectedTenantId);
        if (filters.source) p.set("source", filters.source);
        const res = await api
          .get<{
            data: {
              totals: { totalLeads: number; convertedLeads: number };
              byStage: Array<{ stage: string; count: number }>;
            };
          }>(`/analytics/lead-funnel-report?${p.toString()}`)
          .catch(() => null);
        const d = res?.data;
        const total = d?.totals.totalLeads ?? 0;
        setPreview({
          columns: [
            { key: "stage", label: "Stage" },
            { key: "count", label: "Count" },
            { key: "pctOfTotal", label: "% of Total" },
          ],
          rows: (d?.byStage || []).map((r) => ({
            stage: r.stage,
            count: r.count,
            pctOfTotal: total ? `${((r.count / total) * 100).toFixed(1)}%` : "—",
          })),
          summary: {
            "Total Leads": total,
            Converted: d?.totals.convertedLeads ?? 0,
            "Conversion rate": total
              ? `${(((d?.totals.convertedLeads ?? 0) / total) * 100).toFixed(1)}%`
              : "—",
          },
        });
      }
    } finally {
      setLoading(false);
    }
  }, [type, qs, groupBy, from, to, filters, tenantQ, isSuperAdmin, selectedTenantId]);

  useEffect(() => {
    runPreview();
  }, [runPreview]);

  function saveConfig() {
    if (!configName.trim()) {
      toast.error("Please provide a name for the report configuration");
      return;
    }
    const cfg: ReportConfig = {
      id: `cfg-${Date.now()}`,
      name: configName.trim(),
      type,
      from,
      to,
      groupBy,
      filters,
      createdAt: Date.now(),
    };
    persistSaved([cfg, ...saved]);
    setConfigName("");
  }

  function loadConfig(cfg: ReportConfig) {
    setType(cfg.type);
    setFrom(cfg.from);
    setTo(cfg.to);
    setGroupBy(cfg.groupBy);
    setFilters(cfg.filters || {});
    setConfigName(cfg.name);
  }

  function deleteConfig(id: string) {
    persistSaved(saved.filter((c) => c.id !== id));
  }

  function exportCsv() {
    if (!preview) return;
    const csv = rowsToCsv(preview.rows, preview.columns);
    const name = `${type}-report-${from}_${to}.csv`;
    downloadFile(name, csv, "text/csv");
  }

  function exportJson() {
    if (!preview) return;
    const payload = {
      report: {
        type,
        from,
        to,
        groupBy,
        filters,
        generatedAt: new Date().toISOString(),
      },
      summary: preview.summary,
      data: preview.rows,
    };
    downloadFile(
      `${type}-report-${from}_${to}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );
  }

  if (user && user.role !== "ADMIN") return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {/* Normal text link (breadcrumb-style) above the title. */}
          <button
            onClick={() => router.push("/dashboard/analytics")}
            className="mb-2 flex items-center gap-1 text-sm font-medium text-primary hover:underline dark:text-blue-400"
          >
            <ArrowLeft size={14} /> Back to Analytics
          </button>
          <h1 className="flex items-center gap-2 text-2xl font-bold dark:text-gray-100">
            <ClipboardList size={22} /> Report Builder
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Configure, preview, and export custom reports
          </p>
        </div>
        {isSuperAdmin && (
          <TenantSelect
            tenants={tenants}
            value={selectedTenantId}
            onChange={setSelectedTenantId}
            allLabel="All tenants"
            className="w-full sm:w-64"
            testId="report-builder-tenant-filter"
          />
        )}
      </div>

      {/* Configuration panel */}
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          1. Select report type
        </h2>
        <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-5">
          {REPORT_TYPES.map((t) => (
            <button
              key={t.key}
              onClick={() => setType(t.key)}
              className={`rounded-lg border p-3 text-left transition ${
                type === t.key
                  ? "border-primary bg-primary/5 shadow-sm dark:bg-primary/10"
                  : "border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-700"
              }`}
            >
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{t.label}</p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t.description}</p>
            </button>
          ))}
        </div>

        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          2. Configure parameters
        </h2>
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
          <div>
            <label htmlFor="report-builder-from" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">From</label>
            <input
              id="report-builder-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <div>
            <label htmlFor="report-builder-to" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">To</label>
            <input
              id="report-builder-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          {!NON_PERIOD_TYPES.has(type) && (
            <div>
              <label htmlFor="report-builder-group-by" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Group By</label>
              <select
                id="report-builder-group-by"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </div>
          )}
          <div className="flex items-end">
            <button
              onClick={runPreview}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              <RefreshCw size={14} /> Run
            </button>
          </div>
        </div>

        {/* Filters row (type-specific) */}
        <div className="mb-2 grid grid-cols-1 gap-4 md:grid-cols-3">
          {type === "revenue" && (
            <div>
              <label htmlFor="report-builder-payment-mode" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Payment Mode</label>
              <select
                id="report-builder-payment-mode"
                value={filters.paymentMode || ""}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, paymentMode: e.target.value || undefined }))
                }
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="">All Modes</option>
                <option value="CASH">Cash</option>
                <option value="CARD">Card</option>
                <option value="UPI">UPI</option>
                <option value="ONLINE">Online</option>
                <option value="INSURANCE">Insurance</option>
              </select>
            </div>
          )}
          {type === "appointments" && (
            <div>
              <label htmlFor="report-builder-appt-status" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Status</label>
              <select
                id="report-builder-appt-status"
                value={filters.appointmentStatus || ""}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, appointmentStatus: e.target.value || undefined }))
                }
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="">All</option>
                <option value="BOOKED">Booked</option>
                <option value="COMPLETED">Completed</option>
                <option value="CANCELLED">Cancelled</option>
                <option value="NO_SHOW">No Show</option>
              </select>
            </div>
          )}
          {type === "tds" && (
            <div>
              <label htmlFor="report-builder-tds-rate" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">TDS %</label>
              <input
                id="report-builder-tds-rate"
                type="number"
                min={0}
                max={30}
                step="0.5"
                value={filters.tdsRate ?? "10"}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, tdsRate: e.target.value }))
                }
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          )}
          {type === "lead-funnel" && (
            <div>
              <label htmlFor="report-builder-lead-source" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Source</label>
              <select
                id="report-builder-lead-source"
                value={filters.source || ""}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, source: e.target.value || undefined }))
                }
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="">All sources</option>
                {["WEB", "WALK_IN", "PHONE", "WHATSAPP", "REFERRAL", "OTHER"].map(
                  (s) => (
                    <option key={s} value={s}>
                      {s.replace("_", " ")}
                    </option>
                  ),
                )}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Preview */}
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Preview
            </h2>
            {preview?.summary && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {Object.entries(preview.summary).map(([k, v], i) => (
                  <span key={k}>
                    {i > 0 && <span className="mx-2">•</span>}
                    <span className="font-medium text-gray-700 dark:text-gray-200">{k}:</span> {v}
                  </span>
                ))}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={exportCsv}
              disabled={!preview || preview.rows.length === 0}
              className="flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              <Download size={14} /> CSV
            </button>
            <button
              onClick={exportJson}
              disabled={!preview || preview.rows.length === 0}
              className="flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              <FileJson size={14} /> JSON
            </button>
          </div>
        </div>

        {loading ? (
          // Pearl §7.2 wave 11: skeleton table while the preview rows fetch
          // so the page footprint matches the eventual table layout.
          <div
            className="py-4"
            data-testid="analytics-reports-loading"
            aria-busy="true"
          >
            <SkeletonTable rows={6} columns={5} />
          </div>
        ) : !preview || preview.rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">
            No data for this configuration
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  {preview.columns.map((c) => (
                    <th key={c.key} className="px-3 py-2 font-medium">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700">
                    {preview.columns.map((c) => {
                      const val = row[c.key];
                      return (
                        <td key={c.key} className="px-3 py-2 text-gray-700 dark:text-gray-300">
                          {c.isCurrency && typeof val === "number"
                            ? formatCurrency(val)
                            : String(val ?? "")}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Save / Load configs */}
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Saved Configurations
        </h2>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-60">
            <label htmlFor="report-builder-config-name" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Configuration Name</label>
            <input
              id="report-builder-config-name"
              type="text"
              value={configName}
              onChange={(e) => setConfigName(e.target.value)}
              placeholder="e.g. Monthly Revenue Q4"
              className="w-full rounded-lg border px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <button
            onClick={saveConfig}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Save size={14} /> Save Current
          </button>
        </div>

        {saved.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">No saved configurations yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Range</th>
                  <th className="px-3 py-2">Group</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {saved.map((cfg) => (
                  <tr key={cfg.id} className="border-b last:border-0 dark:border-gray-700">
                    <td className="px-3 py-2 font-medium text-gray-800 dark:text-gray-100">{cfg.name}</td>
                    <td className="px-3 py-2 dark:text-gray-300">
                      {REPORT_TYPES.find((t) => t.key === cfg.type)?.label || cfg.type}
                    </td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                      {cfg.from} → {cfg.to}
                    </td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{cfg.groupBy}</td>
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
                      {new Date(cfg.createdAt).toLocaleDateString("en-IN")}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => loadConfig(cfg)}
                        className="mr-2 rounded border px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700"
                      >
                        Load
                      </button>
                      <button
                        onClick={() => deleteConfig(cfg.id)}
                        className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-600 hover:bg-red-100 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
                      >
                        <Trash2 size={12} className="inline" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
