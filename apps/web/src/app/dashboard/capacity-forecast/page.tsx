"use client";

// Capacity forecasting dashboard (PRD §7.3).  Admin/Nurse-facing view with
// 24/48/72h toggle, three resource tabs (beds / ICU / OT) and a ward heatmap
// coloured by expected occupancy %.

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bed,
  Building2,
  HeartPulse,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

// ─── Types ─────────────────────────────────────────────

interface ForecastRow {
  resourceId: string;
  resourceName: string;
  resourceType: "ward" | "ot";
  capacityUnits: number;
  currentlyInUse: number;
  plannedReleases: number;
  predictedInflow: number;
  predictedInflowUpper: number;
  expectedOccupancyPct: number;
  expectedStockout: boolean;
  confidence: "low" | "medium" | "high";
  method: "holt-winters" | "fallback-moving-average";
  insufficientData: boolean;
}

interface ForecastData {
  horizonHours: 24 | 48 | 72;
  generatedAt: string;
  forecasts: ForecastRow[];
  summary: {
    totalCapacity: number;
    totalCurrentlyInUse: number;
    totalPredictedInflow: number;
    totalPredictedInflowUpper: number;
    aggregateOccupancyPct: number;
    anyStockoutRisk: boolean;
    wardsAtRisk: number;
  };
}

type Tab = "beds" | "icu" | "ot";
type Horizon = 24 | 48 | 72;

function heatClass(pct: number): string {
  if (pct >= 100) return "bg-red-200 text-red-900 border-red-400";
  if (pct >= 85) return "bg-orange-100 text-orange-900 border-orange-300";
  if (pct >= 70) return "bg-amber-100 text-amber-900 border-amber-300";
  if (pct >= 50) return "bg-yellow-50 text-yellow-800 border-yellow-200";
  return "bg-green-50 text-green-800 border-green-200";
}

function confidenceChip(c: ForecastRow["confidence"]) {
  const tone =
    c === "high"
      ? "bg-green-100 text-green-800"
      : c === "medium"
      ? "bg-amber-100 text-amber-800"
      : "bg-gray-100 text-gray-700";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${tone}`}>
      {c}
    </span>
  );
}

export default function CapacityForecastPage() {
  const { token } = useAuthStore();
  const [tab, setTab] = useState<Tab>("beds");
  const [horizon, setHorizon] = useState<Horizon>(72);
  const [data, setData] = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const path = `/ai/capacity/${tab}?horizon=${horizon}`;
      const res = await api.get<{ success: boolean; data: ForecastData; error: string | null }>(
        path,
        { token: token ?? undefined }
      );
      if (res.success) setData(res.data);
      else setError(res.error ?? "Failed to load forecast");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load forecast");
    } finally {
      setLoading(false);
    }
  }, [tab, horizon, token]);

  useEffect(() => {
    load();
  }, [load]);

  const tabIcon = {
    beds: <Bed className="h-4 w-4" />,
    icu: <HeartPulse className="h-4 w-4" />,
    ot: <Building2 className="h-4 w-4" />,
  } as const;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Capacity Forecast</h1>
          <p className="text-sm text-gray-500">
            Holt-Winters demand forecast for beds, ICU and operating theatres
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-gray-200 bg-white">
            {([24, 48, 72] as Horizon[]).map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`px-3 py-1.5 text-sm font-medium ${
                  horizon === h ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                {h}h
              </button>
            ))}
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </div>

      <div className="flex gap-2 border-b border-gray-200" role="tablist">
        {(["beds", "icu", "ot"] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            data-testid={`capacity-tab-${t}`}
            onClick={() => setTab(t)}
            className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold ${
              tab === t
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            {tabIcon[t]}
            {t === "beds" ? "Beds" : t === "icu" ? "ICU" : "Operating Theatres"}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong>Error:</strong> {error}
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase text-gray-500">Aggregate Occupancy</div>
              <div className="mt-1 text-2xl font-bold text-gray-900">
                {data.summary.aggregateOccupancyPct}%
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase text-gray-500">Currently In Use</div>
              <div className="mt-1 text-2xl font-bold text-gray-900">
                {data.summary.totalCurrentlyInUse} / {data.summary.totalCapacity}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs uppercase text-gray-500">Predicted Inflow</div>
              <div className="mt-1 text-2xl font-bold text-gray-900">
                {data.summary.totalPredictedInflow}
                <span className="ml-1 text-xs text-gray-500">
                  (upper {data.summary.totalPredictedInflowUpper})
                </span>
              </div>
            </div>
            <div
              className={`rounded-lg border p-4 ${
                data.summary.anyStockoutRisk
                  ? "border-red-200 bg-red-50"
                  : "border-green-200 bg-green-50"
              }`}
            >
              <div className="text-xs uppercase text-gray-500">Stockout Risk</div>
              <div className="mt-1 text-2xl font-bold text-gray-900">
                {data.summary.wardsAtRisk} unit{data.summary.wardsAtRisk === 1 ? "" : "s"}
              </div>
            </div>
          </div>

          {/* Heatmap */}
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">
              {tab === "ot" ? "OT utilisation heatmap" : "Ward occupancy heatmap"}
            </h2>
            {data.forecasts.length === 0 ? (
              <div className="text-sm text-gray-500">No resources to display.</div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {data.forecasts.map((f) => (
                  <div
                    key={f.resourceId}
                    className={`rounded-md border p-3 text-sm ${heatClass(
                      f.expectedOccupancyPct
                    )}`}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="font-semibold">{f.resourceName}</div>
                      {f.expectedStockout && (
                        <AlertTriangle className="h-4 w-4 text-red-700" aria-label="stockout risk" />
                      )}
                    </div>
                    <div className="mt-1 text-lg font-bold">{f.expectedOccupancyPct}%</div>
                    <div className="text-[11px]">
                      {f.currentlyInUse}/{f.capacityUnits} in use · +{f.predictedInflow}
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      {confidenceChip(f.confidence)}
                      {f.insufficientData && (
                        <span
                          title="data insufficient — 7-day moving average"
                          className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-600"
                        >
                          <Info className="h-3 w-3" /> MA
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="text-right text-xs text-gray-400">
            Generated {new Date(data.generatedAt).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}
