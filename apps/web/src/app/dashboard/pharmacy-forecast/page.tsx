"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle,
  ChevronDown,
  Info,
  Loader2,
  Package,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

// ─── Types ─────────────────────────────────────────────

interface ItemForecast {
  inventoryItemId: string;
  medicineName: string;
  currentStock: number;
  avgDailyConsumption: number;
  predictedConsumption7d: number;
  predictedConsumption30d: number;
  daysOfStockLeft: number;
  reorderRecommended: boolean;
  suggestedReorderQty: number;
  urgency: "OK" | "LOW" | "CRITICAL";
}

interface ForecastResponse {
  success: boolean;
  data: {
    forecast: ItemForecast[];
    insights?: string;
    generatedAt: string;
  };
  error: string | null;
}

// ─── Helpers ───────────────────────────────────────────

function urgencyBadge(urgency: ItemForecast["urgency"]) {
  if (urgency === "CRITICAL") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-700">
        <AlertTriangle className="h-3 w-3" />
        CRITICAL
      </span>
    );
  }
  if (urgency === "LOW") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
        <ChevronDown className="h-3 w-3" />
        LOW
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700">
      <CheckCircle className="h-3 w-3" />
      OK
    </span>
  );
}

function rowClass(urgency: ItemForecast["urgency"]) {
  if (urgency === "CRITICAL") return "bg-red-50 hover:bg-red-100";
  if (urgency === "LOW") return "bg-amber-50 hover:bg-amber-100";
  return "hover:bg-gray-50";
}

function daysLeftDisplay(days: number) {
  if (days >= 9999) return "∞";
  return String(Math.floor(days));
}

// ─── Insights renderer ────────────────────────────────

function InsightsText({ text }: { text: string }) {
  // Strip <think>...</think> and any unclosed <think> block client-side
  const clean = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .trim();

  return (
    <div className="space-y-1 text-sm text-blue-900">
      {clean.split("\n").map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-2" />;

        // Numbered section headings: "1. Title" or "1. **Title**"
        const numberedMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
        if (numberedMatch) {
          const title = numberedMatch[2].replace(/\*\*(.+?)\*\*/g, "$1");
          return (
            <p key={i} className="mt-4 font-semibold text-blue-800 first:mt-0">
              {numberedMatch[1]}. {title}
            </p>
          );
        }

        // Bold-only headings: **Heading**
        const headingMatch = trimmed.match(/^\*\*(.+)\*\*$/);
        if (headingMatch) {
          return (
            <p key={i} className="mt-3 font-semibold text-blue-800 first:mt-0">
              {headingMatch[1]}
            </p>
          );
        }

        // Bullet lines: - text or * text
        const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
        if (bulletMatch) {
          const content = bulletMatch[1].replace(/\*\*(.+?)\*\*/g, "$1");
          return (
            <div key={i} className="ml-3 flex gap-2">
              <span className="mt-0.5 shrink-0 text-blue-400">•</span>
              <span>{content}</span>
            </div>
          );
        }

        // Plain line — strip inline bold markers
        return <p key={i}>{trimmed.replace(/\*\*(.+?)\*\*/g, "$1")}</p>;
      })}
    </div>
  );
}

// ─── Page Component ────────────────────────────────────

export default function PharmacyForecastPage() {
  const { token } = useAuthStore();
  const [daysAhead, setDaysAhead] = useState(30);
  const [withInsights, setWithInsights] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [forecast, setForecast] = useState<ItemForecast[] | null>(null);
  const [insights, setInsights] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadForecast() {
    setLoading(true);
    setError(null);
    setForecast(null);
    setInsights(null);
    setGeneratedAt(null);

    try {
      // Load forecast data first (fast)
      const forecastParams = new URLSearchParams({ days: String(daysAhead) });
      const res = await api.get<ForecastResponse>(
        `/ai/pharmacy/forecast?${forecastParams.toString()}`,
        { token: token ?? undefined }
      );

      if (!res.success) {
        setError(res.error ?? "Failed to load forecast");
        return;
      }

      setForecast(res.data.forecast);
      setGeneratedAt(res.data.generatedAt);

      // Then load AI insights separately so table appears immediately
      if (withInsights) {
        setLoadingInsights(true);
        try {
          const insightsParams = new URLSearchParams({
            days: String(daysAhead),
            insights: "true",
          });
          const insightsRes = await api.get<ForecastResponse>(
            `/ai/pharmacy/forecast?${insightsParams.toString()}`,
            { token: token ?? undefined }
          );
          if (insightsRes.success) {
            setInsights(insightsRes.data.insights ?? null);
          }
        } catch {
          // insights are non-critical — don't block the table
        } finally {
          setLoadingInsights(false);
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load forecast");
    } finally {
      setLoading(false);
    }
  }

  // Summary counts
  const criticalCount = forecast?.filter((f) => f.urgency === "CRITICAL").length ?? 0;
  const lowCount = forecast?.filter((f) => f.urgency === "LOW").length ?? 0;
  const okCount = forecast?.filter((f) => f.urgency === "OK").length ?? 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600 text-white">
            <Package className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Inventory Forecast</h1>
            <p className="text-sm text-gray-500">
              Demand forecasting based on 90-day consumption history
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Days ahead selector */}
          <div className="flex items-center gap-2">
            <label htmlFor="days-select" className="text-sm font-medium text-gray-700">
              Days ahead:
            </label>
            <select
              id="days-select"
              value={daysAhead}
              onChange={(e) => setDaysAhead(Number(e.target.value))}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
            </select>
          </div>

          {/* AI Insights toggle */}
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={withInsights}
              onChange={(e) => setWithInsights(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <Bot className="h-4 w-4 text-blue-600" />
            Get AI Insights
          </label>

          {/* Load button */}
          <button
            onClick={loadForecast}
            disabled={loading || loadingInsights}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {loading ? "Loading..." : "Load Forecast"}
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Summary pills */}
      {forecast && (
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 rounded-full bg-red-100 px-4 py-2 text-sm font-semibold text-red-700">
            <AlertTriangle className="h-4 w-4" />
            {criticalCount} Critical
          </div>
          <div className="flex items-center gap-2 rounded-full bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-700">
            <ChevronDown className="h-4 w-4" />
            {lowCount} Low Stock
          </div>
          <div className="flex items-center gap-2 rounded-full bg-green-100 px-4 py-2 text-sm font-semibold text-green-700">
            <CheckCircle className="h-4 w-4" />
            {okCount} OK
          </div>
          {generatedAt && (
            <span className="ml-auto self-center text-xs text-gray-400">
              Generated at {new Date(generatedAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* AI Insights panel */}
      {(loadingInsights || insights) && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-blue-800">
            <Info className="h-4 w-4" />
            AI Pharmacy Insights
            {loadingInsights && (
              <Loader2 className="ml-1 h-4 w-4 animate-spin text-blue-500" />
            )}
          </div>
          {loadingInsights && !insights && (
            <p className="text-sm text-blue-500 italic">
              Analysing inventory with Sarvam AI…
            </p>
          )}
          {insights && <InsightsText text={insights} />}
        </div>
      )}

      {/* Forecast table */}
      {forecast && forecast.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 shadow-sm">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-gray-600">Medicine</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-600">Current Stock</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-600">Avg Daily Use</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-600">Days Left</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-600">7-day Need</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-600">{daysAhead}-day Need</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-600">Urgency</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-600">Reorder Qty</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {forecast.map((item) => (
                <tr key={item.inventoryItemId} className={rowClass(item.urgency)}>
                  <td className="px-4 py-3 font-medium text-gray-900">{item.medicineName}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{item.currentStock}</td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {item.avgDailyConsumption.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {daysLeftDisplay(item.daysOfStockLeft)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {item.predictedConsumption7d}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {item.predictedConsumption30d}
                  </td>
                  <td className="px-4 py-3 text-center">{urgencyBadge(item.urgency)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">
                    {item.suggestedReorderQty > 0 ? (
                      <span className="text-blue-700">{item.suggestedReorderQty}</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {forecast && forecast.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 py-16 text-center">
          <Package className="h-10 w-10 text-gray-300" />
          <p className="text-gray-500">No inventory items found for forecasting.</p>
        </div>
      )}

      {/* Initial prompt */}
      {!forecast && !loading && !error && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-gray-300 bg-gray-50 py-16 text-center">
          <Package className="h-10 w-10 text-gray-300" />
          <p className="text-gray-500">
            Select the days ahead and click <strong>Load Forecast</strong> to view inventory demand
            predictions.
          </p>
        </div>
      )}
    </div>
  );
}
