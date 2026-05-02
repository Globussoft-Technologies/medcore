"use client";

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  CheckCircle,
  Clock,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
  TrendingUp,
  User,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AppointmentSummary {
  id: string;
  slotStart: string | null;
  slotEnd: string | null;
  date: string;
  patientName: string;
  patientId: string;
  doctorName: string;
  doctorId: string;
}

interface PredictionRow {
  appointmentId: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  factors: string[];
  recommendation: string;
  appointment: AppointmentSummary;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoToday(): string {
  return new Date().toISOString().split("T")[0];
}

function pct(score: number): string {
  return Math.round(score * 100) + "%";
}

// ─── Risk Badge ───────────────────────────────────────────────────────────────

function RiskBadge({ level }: { level: "low" | "medium" | "high" }) {
  const styles: Record<"low" | "medium" | "high", string> = {
    low: "bg-green-100 text-green-700 border border-green-200",
    medium: "bg-amber-100 text-amber-700 border border-amber-200",
    high: "bg-red-100 text-red-700 border border-red-200",
  };
  const labels: Record<"low" | "medium" | "high", string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${styles[level]}`}
    >
      {labels[level]}
    </span>
  );
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <RefreshCw className="w-7 h-7 text-indigo-500 animate-spin" />
    </div>
  );
}

// ─── Summary Stats ────────────────────────────────────────────────────────────

interface SummaryStatsProps {
  rows: PredictionRow[];
}

function SummaryStats({ rows }: SummaryStatsProps) {
  const total = rows.length;
  const highCount = rows.filter((r) => r.riskLevel === "high").length;
  const mediumCount = rows.filter((r) => r.riskLevel === "medium").length;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-start gap-3 shadow-sm">
        <Calendar className="w-5 h-5 text-indigo-500 mt-0.5" />
        <div>
          <p className="text-xs text-gray-500 font-medium">Total Appointments</p>
          <p className="text-2xl font-bold text-gray-800 mt-0.5">{total}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-start gap-3 shadow-sm">
        <ShieldAlert className="w-5 h-5 text-red-500 mt-0.5" />
        <div>
          <p className="text-xs text-gray-500 font-medium">High Risk</p>
          <p className="text-2xl font-bold text-red-600 mt-0.5">{highCount}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-start gap-3 shadow-sm">
        <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5" />
        <div>
          <p className="text-xs text-gray-500 font-medium">Medium Risk</p>
          <p className="text-2xl font-bold text-amber-600 mt-0.5">{mediumCount}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Predictions Table ────────────────────────────────────────────────────────

function PredictionsTable({ rows }: { rows: PredictionRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col items-center justify-center py-16 gap-3">
        <CheckCircle className="w-10 h-10 text-gray-300" />
        <p className="text-sm text-gray-400">No booked appointments found for this date.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100">
              <th className="px-4 py-3 text-left font-medium">Patient</th>
              <th className="px-4 py-3 text-left font-medium">Doctor</th>
              <th className="px-4 py-3 text-left font-medium">Slot</th>
              <th className="px-4 py-3 text-left font-medium">Risk Level</th>
              <th className="px-4 py-3 text-left font-medium">Score</th>
              <th className="px-4 py-3 text-left font-medium">Risk Factors</th>
              <th className="px-4 py-3 text-left font-medium">Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr
                key={row.appointmentId}
                className={`border-t border-gray-100 hover:bg-gray-50 transition-colors ${
                  idx % 2 === 0 ? "" : "bg-gray-50/50"
                }`}
              >
                {/* Patient */}
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <User className="w-4 h-4 text-gray-400 shrink-0" />
                    <span className="font-medium text-gray-800">
                      {row.appointment.patientName}
                    </span>
                  </div>
                </td>

                {/* Doctor */}
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Stethoscope className="w-4 h-4 text-gray-400 shrink-0" />
                    <span className="text-gray-700">{row.appointment.doctorName}</span>
                  </div>
                </td>

                {/* Slot */}
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1 text-gray-700">
                    <Clock className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    {row.appointment.slotStart ?? "—"}
                    {row.appointment.slotEnd ? ` – ${row.appointment.slotEnd}` : ""}
                  </div>
                </td>

                {/* Risk Level */}
                <td className="px-4 py-3">
                  <RiskBadge level={row.riskLevel} />
                </td>

                {/* Score */}
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          row.riskLevel === "high"
                            ? "bg-red-500"
                            : row.riskLevel === "medium"
                            ? "bg-amber-400"
                            : "bg-green-500"
                        }`}
                        style={{ width: pct(row.riskScore) }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-gray-700 tabular-nums">
                      {pct(row.riskScore)}
                    </span>
                  </div>
                </td>

                {/* Risk Factors */}
                <td className="px-4 py-3 max-w-xs">
                  {row.factors.length === 0 ? (
                    <span className="text-gray-400 text-xs">None</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {row.factors.map((f, i) => (
                        <li key={i} className="text-xs text-gray-600 flex items-start gap-1">
                          <span className="mt-0.5 shrink-0 text-gray-400">•</span>
                          {f}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>

                {/* Recommendation */}
                <td className="px-4 py-3">
                  <div className="flex items-start gap-1.5">
                    <TrendingUp
                      className={`w-4 h-4 shrink-0 mt-0.5 ${
                        row.riskLevel === "high"
                          ? "text-red-500"
                          : row.riskLevel === "medium"
                          ? "text-amber-500"
                          : "text-green-500"
                      }`}
                    />
                    <span className="text-xs text-gray-700">{row.recommendation}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PredictionsPage() {
  const { token } = useAuthStore();
  const [date, setDate] = useState<string>(isoToday);
  const [rows, setRows] = useState<PredictionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadPredictions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ success: boolean; data: PredictionRow[] }>(
        `/ai/predictions/no-show/batch?date=${date}`,
        token ? { token } : undefined
      );
      // Already sorted by riskScore desc from the API, but ensure it here too
      const sorted = (res.data ?? []).sort((a, b) => b.riskScore - a.riskScore);
      setRows(sorted);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load predictions");
    } finally {
      setLoading(false);
    }
  }, [date, token]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ShieldAlert className="w-7 h-7 text-indigo-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">No-Show Predictions</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Daily risk analysis for OPD appointments
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500 whitespace-nowrap">
                Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setLoaded(false);
                }}
                className="text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
            <button
              onClick={loadPredictions}
              disabled={loading}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {loading ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <TrendingUp className="w-4 h-4" />
              )}
              Load Predictions
            </button>
          </div>
        </div>

        {/* Loading */}
        {loading && <Spinner />}

        {/* Error */}
        {!loading && error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Results */}
        {!loading && !error && loaded && (
          <div className="space-y-4">
            <SummaryStats rows={rows} />
            <PredictionsTable rows={rows} />
          </div>
        )}

        {/* Initial state prompt */}
        {!loading && !error && !loaded && (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col items-center justify-center py-20 gap-3">
            <Calendar className="w-10 h-10 text-gray-300" />
            <p className="text-sm text-gray-400">
              Select a date and click &quot;Load Predictions&quot; to begin.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
