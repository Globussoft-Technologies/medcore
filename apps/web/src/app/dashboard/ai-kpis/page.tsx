"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Download,
  RefreshCw,
  ShieldCheck,
  Target as TargetIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { toast } from "@/lib/toast";

// ─── Types ────────────────────────────────────────────────

type Unit = "pct" | "count" | "seconds" | "minutes" | "rating";

interface KpiResult {
  current: number;
  baseline?: number;
  target: number;
  target_direction: "up" | "down";
  unavailable?: true;
  reason?: string;
  unit?: Unit;
  sampleSize?: number;
}

interface Feature1Bundle {
  misroutedOpdAppointments: KpiResult;
  bookingCompletionRate: KpiResult;
  patientCsatAiFlow: KpiResult;
  top1AcceptanceRate: KpiResult;
  timeToConfirmedAppointment: KpiResult;
  redFlagFalseNegativeRate: KpiResult;
  frontDeskCallVolume: KpiResult;
}

interface Feature2Bundle {
  doctorDocTimeReduction: KpiResult;
  doctorAdoption: KpiResult;
  soapAcceptanceRate: KpiResult;
  drugAlertInducedChanges: KpiResult;
  medicationErrorRateComparison: KpiResult;
  doctorNpsForScribe: KpiResult;
  timeToSignOff: KpiResult;
}

// ─── Helpers ──────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return isoDate(d);
}

function defaultTo(): string {
  return isoDate(new Date());
}

function formatValue(value: number, unit?: Unit): string {
  switch (unit) {
    case "pct":
      return `${(value * 100).toFixed(1)}%`;
    case "seconds":
      if (value >= 60) {
        const m = Math.floor(value / 60);
        const s = Math.round(value % 60);
        return `${m}m ${s}s`;
      }
      return `${Math.round(value)}s`;
    case "minutes":
      return `${value.toFixed(1)}m`;
    case "rating":
      return value.toFixed(2);
    case "count":
    default:
      return Math.round(value).toLocaleString();
  }
}

/**
 * Is the current value meeting the target, considering the direction?
 * "up" target: current >= target is good
 * "down" target: current <= target is good
 */
function isMeetingTarget(r: KpiResult): boolean {
  if (r.unavailable) return false;
  return r.target_direction === "up"
    ? r.current >= r.target
    : r.current <= r.target;
}

// ─── Card component ──────────────────────────────────────

interface KpiCardProps {
  testId: string;
  title: string;
  result: KpiResult;
}

function KpiCard({ testId, title, result }: KpiCardProps) {
  const { t } = useTranslation();
  const meeting = isMeetingTarget(result);
  const arrowUp = result.target_direction === "up";
  // Issue #191: when sampleSize is 0 the headline number ("0.0%", "0s",
  // "0.00") looks like a real measurement instead of "no data yet". Surface
  // the unavailable card with a clear reason rather than rendering 0 + a
  // bogus on-target arrow.
  const noSamples = result.sampleSize !== undefined && result.sampleSize === 0;

  if (result.unavailable || noSamples) {
    return (
      <div
        data-testid={testId}
        data-state="unavailable"
        title={result.reason || t("aiKpis.unavailable")}
        className="bg-gray-50 border border-gray-200 rounded-xl p-4 shadow-sm opacity-70 cursor-help dark:bg-gray-800/40 dark:border-gray-700"
      >
        <div className="flex items-start justify-between">
          <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide">
            {title}
          </p>
          <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 font-medium dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800">
            {t("aiKpis.unavailable")}
          </span>
        </div>
        <p className="text-2xl font-bold text-gray-400 mt-3">—</p>
        <p className="text-xs text-gray-500 mt-2 line-clamp-3">
          {result.reason ||
            (noSamples
              ? t(
                  "aiKpis.noSamples",
                  "No data yet — KPI will populate once events accrue."
                )
              : null)}
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid={testId}
      data-state={meeting ? "on-target" : "off-target"}
      className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm dark:bg-gray-800 dark:border-gray-700"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide dark:text-gray-400">
          {title}
        </p>
        <span
          data-testid={`${testId}-direction`}
          className={`inline-flex items-center rounded-full p-1 ${
            meeting
              ? "bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-300"
              : "bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300"
          }`}
        >
          {arrowUp ? (
            <ArrowUp className="w-3.5 h-3.5" />
          ) : (
            <ArrowDown className="w-3.5 h-3.5" />
          )}
        </span>
      </div>

      <p
        data-testid={`${testId}-current`}
        className="text-3xl font-bold text-gray-900 mt-3 dark:text-gray-100"
      >
        {formatValue(result.current, result.unit)}
      </p>

      <div className="mt-3 space-y-1 text-xs">
        <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
          <span className="inline-flex items-center gap-1">
            <TargetIcon className="w-3 h-3" />
            {t("aiKpis.target")}
          </span>
          <span
            data-testid={`${testId}-target`}
            className="font-medium text-gray-700 dark:text-gray-300"
          >
            {result.target_direction === "up" ? "≥ " : "≤ "}
            {formatValue(result.target, result.unit)}
          </span>
        </div>
        {result.baseline !== undefined && (
          <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
            <span>{t("aiKpis.baseline")}</span>
            <span
              data-testid={`${testId}-baseline`}
              className="font-medium text-gray-700 dark:text-gray-300"
            >
              {formatValue(result.baseline, result.unit)}
            </span>
          </div>
        )}
        {result.sampleSize !== undefined && (
          <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
            <span>{t("aiKpis.sampleSize")}</span>
            <span
              data-testid={`${testId}-sample`}
              className="font-medium text-gray-600 dark:text-gray-400"
            >
              n = {result.sampleSize.toLocaleString()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────

export default function AIKpisPage() {
  const { token, user } = useAuthStore();
  const { t } = useTranslation();

  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [activeTab, setActiveTab] = useState<
    "booking" | "scribe" | "export"
  >("booking");

  const [f1, setF1] = useState<Feature1Bundle | null>(null);
  const [f2, setF2] = useState<Feature2Bundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBundles = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [r1, r2] = await Promise.all([
        api.get<{ data: { bundle: Feature1Bundle } }>(
          `/ai/kpis/feature1?from=${from}&to=${to}`,
          { token },
        ),
        api.get<{ data: { bundle: Feature2Bundle } }>(
          `/ai/kpis/feature2?from=${from}&to=${to}`,
          { token },
        ),
      ]);
      setF1(r1.data.bundle);
      setF2(r2.data.bundle);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || "Failed to load KPIs");
    } finally {
      setLoading(false);
    }
  }, [from, to, token]);

  useEffect(() => {
    if (user?.role === "ADMIN") fetchBundles();
  }, [user, fetchBundles]);

  async function handleExport() {
    if (!token) return;
    try {
      const API_BASE =
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
      const res = await fetch(
        `${API_BASE}/ai/kpis/export?from=${from}&to=${to}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ai-kpis-${from}_to_${to}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("CSV downloaded");
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error(e.message || "Export failed");
    }
  }

  if (user && user.role !== "ADMIN") {
    return (
      <div
        data-testid="ai-kpis-admin-gate"
        className="p-8 text-center text-gray-500 dark:text-gray-400"
      >
        <ShieldCheck className="mx-auto mb-2 h-10 w-10 text-gray-400" />
        {t("aiKpis.adminOnly")}
      </div>
    );
  }

  const tabs: Array<{ id: "booking" | "scribe" | "export"; label: string }> = [
    { id: "booking", label: t("aiKpis.tab.booking") },
    { id: "scribe", label: t("aiKpis.tab.scribe") },
    { id: "export", label: t("aiKpis.tab.export") },
  ];

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <BarChart3 className="w-7 h-7 text-indigo-600" />
            <div>
              <h1
                data-testid="ai-kpis-title"
                className="text-2xl font-bold text-gray-900 dark:text-gray-100"
              >
                {t("aiKpis.title")}
              </h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t("aiKpis.subtitle")}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-medium text-gray-500">
              {t("aiKpis.from")}
            </label>
            <input
              data-testid="ai-kpis-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200"
            />
            <label className="text-xs font-medium text-gray-500">
              {t("aiKpis.to")}
            </label>
            <input
              data-testid="ai-kpis-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200"
            />
            <button
              data-testid="ai-kpis-refresh"
              onClick={fetchBundles}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg"
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
              />
              {t("aiKpis.refresh")}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl w-fit shadow-sm dark:bg-gray-800 dark:border-gray-700"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              data-testid={`ai-kpis-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.id
                  ? "bg-indigo-600 text-white shadow"
                  : "text-gray-600 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div
            data-testid="ai-kpis-error"
            className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3"
          >
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && !f1 && !f2 && (
          <div
            data-testid="ai-kpis-loading"
            className="text-sm text-gray-500 dark:text-gray-400 py-10 text-center"
          >
            {t("aiKpis.loading")}
          </div>
        )}

        {/* Feature 1 */}
        {activeTab === "booking" && f1 && (
          <div
            data-testid="ai-kpis-feature1-panel"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            <KpiCard
              testId="kpi-misrouted"
              title={t("aiKpis.f1.misrouted")}
              result={f1.misroutedOpdAppointments}
            />
            <KpiCard
              testId="kpi-booking-completion"
              title={t("aiKpis.f1.booking")}
              result={f1.bookingCompletionRate}
            />
            <KpiCard
              testId="kpi-csat"
              title={t("aiKpis.f1.csat")}
              result={f1.patientCsatAiFlow}
            />
            <KpiCard
              testId="kpi-top1-acceptance"
              title={t("aiKpis.f1.top1")}
              result={f1.top1AcceptanceRate}
            />
            <KpiCard
              testId="kpi-time-to-confirm"
              title={t("aiKpis.f1.timeToConfirm")}
              result={f1.timeToConfirmedAppointment}
            />
            <KpiCard
              testId="kpi-red-flag-fn"
              title={t("aiKpis.f1.redFlagFN")}
              result={f1.redFlagFalseNegativeRate}
            />
            <KpiCard
              testId="kpi-front-desk"
              title={t("aiKpis.f1.frontDesk")}
              result={f1.frontDeskCallVolume}
            />
          </div>
        )}

        {/* Feature 2 */}
        {activeTab === "scribe" && f2 && (
          <div
            data-testid="ai-kpis-feature2-panel"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            <KpiCard
              testId="kpi-doc-time"
              title={t("aiKpis.f2.docTime")}
              result={f2.doctorDocTimeReduction}
            />
            <KpiCard
              testId="kpi-doctor-adoption"
              title={t("aiKpis.f2.adoption")}
              result={f2.doctorAdoption}
            />
            <KpiCard
              testId="kpi-soap-acceptance"
              title={t("aiKpis.f2.soap")}
              result={f2.soapAcceptanceRate}
            />
            <KpiCard
              testId="kpi-rx-changes"
              title={t("aiKpis.f2.rxChanges")}
              result={f2.drugAlertInducedChanges}
            />
            <KpiCard
              testId="kpi-med-err"
              title={t("aiKpis.f2.medErr")}
              result={f2.medicationErrorRateComparison}
            />
            <KpiCard
              testId="kpi-doctor-nps"
              title={t("aiKpis.f2.nps")}
              result={f2.doctorNpsForScribe}
            />
            <KpiCard
              testId="kpi-time-to-signoff"
              title={t("aiKpis.f2.signOff")}
              result={f2.timeToSignOff}
            />
          </div>
        )}

        {/* Export */}
        {activeTab === "export" && (
          <div
            data-testid="ai-kpis-export-panel"
            className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm dark:bg-gray-800 dark:border-gray-700"
          >
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              {t("aiKpis.export.description")}
            </p>
            <button
              data-testid="ai-kpis-export-btn"
              onClick={handleExport}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg"
            >
              <Download className="w-4 h-4" />
              {t("aiKpis.download")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
