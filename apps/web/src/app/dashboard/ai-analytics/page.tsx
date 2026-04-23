"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Brain,
  CalendarDays,
  CheckCircle,
  ClipboardList,
  Languages,
  RefreshCw,
  Stethoscope,
  TrendingUp,
  UserCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

// ─── Types ─────────────────────────────────────────────

interface TriageData {
  totalSessions: number;
  completedSessions: number;
  completionRate: number;
  emergencyDetected: number;
  bookingConversions: number;
  conversionRate: number;
  avgTurnsToRecommendation: number;
  avgConfidence: number;
  topChiefComplaints: Array<{ complaint: string; count: number }>;
  specialtyDistribution: Array<{ specialty: string; count: number }>;
  languageBreakdown: Array<{ language: string; count: number }>;
  statusBreakdown: Array<{ status: string; count: number }>;
}

interface ScribeData {
  totalSessions: number;
  completedSessions: number;
  consentWithdrawnSessions: number;
  avgDoctorEditRate: number;
  drugAlertRate: number;
  totalDrugAlerts: number;
  statusBreakdown: Array<{ status: string; count: number }>;
}

// ─── Helpers ───────────────────────────────────────────

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

function pct(rate: number): string {
  return (rate * 100).toFixed(1) + "%";
}

// ─── Stat Card ─────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
}

function StatCard({ label, value, icon, accent = "text-indigo-500" }: StatCardProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-start gap-3 shadow-sm">
      <div className={`mt-0.5 ${accent}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 font-medium truncate">{label}</p>
        <p className="text-xl font-bold text-gray-800 mt-0.5">{value}</p>
      </div>
    </div>
  );
}

// ─── Loading Spinner ───────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <RefreshCw className="w-7 h-7 text-indigo-500 animate-spin" />
    </div>
  );
}

// ─── Triage Tab ────────────────────────────────────────

function TriageTab({ data }: { data: TriageData }) {
  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard
          label="Total Sessions"
          value={data.totalSessions.toLocaleString()}
          icon={<Bot className="w-5 h-5" />}
          accent="text-indigo-500"
        />
        <StatCard
          label="Completion Rate"
          value={pct(data.completionRate)}
          icon={<CheckCircle className="w-5 h-5" />}
          accent="text-green-500"
        />
        <StatCard
          label="Emergency Detections"
          value={data.emergencyDetected.toLocaleString()}
          icon={<AlertTriangle className="w-5 h-5" />}
          accent="text-red-500"
        />
        <StatCard
          label="Booking Conversions"
          value={data.bookingConversions.toLocaleString()}
          icon={<CalendarDays className="w-5 h-5" />}
          accent="text-blue-500"
        />
        <StatCard
          label="Avg Turns to Recommendation"
          value={data.avgTurnsToRecommendation.toLocaleString()}
          icon={<TrendingUp className="w-5 h-5" />}
          accent="text-purple-500"
        />
        <StatCard
          label="Avg Confidence"
          value={pct(data.avgConfidence)}
          icon={<Brain className="w-5 h-5" />}
          accent="text-teal-500"
        />
      </div>

      {/* Tables */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top Chief Complaints */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-700">Top Chief Complaints</h3>
          </div>
          {data.topChiefComplaints.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No data</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                  <th className="px-4 py-2 text-left font-medium">Complaint</th>
                  <th className="px-4 py-2 text-right font-medium">Count</th>
                </tr>
              </thead>
              <tbody>
                {data.topChiefComplaints.map((row, i) => (
                  <tr key={i} className="border-t border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2 text-gray-700 capitalize">{row.complaint}</td>
                    <td className="px-4 py-2 text-right font-medium text-gray-800">
                      {row.count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Specialty Distribution */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <Stethoscope className="w-4 h-4 text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-700">Specialty Distribution</h3>
          </div>
          {data.specialtyDistribution.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No data</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                  <th className="px-4 py-2 text-left font-medium">Specialty</th>
                  <th className="px-4 py-2 text-right font-medium">Count</th>
                </tr>
              </thead>
              <tbody>
                {data.specialtyDistribution.map((row, i) => (
                  <tr key={i} className="border-t border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2 text-gray-700">{row.specialty}</td>
                    <td className="px-4 py-2 text-right font-medium text-gray-800">
                      {row.count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Language breakdown pills */}
      {data.languageBreakdown.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="flex items-center gap-2 mb-3">
            <Languages className="w-4 h-4 text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-700">Language Breakdown</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.languageBreakdown.map((row, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 text-sm font-medium border border-indigo-100"
              >
                <span className="uppercase font-bold text-xs">{row.language}</span>
                <span className="text-indigo-500">:</span>
                <span>{row.count.toLocaleString()}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Scribe Tab ────────────────────────────────────────

function ScribeTab({ data }: { data: ScribeData }) {
  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard
          label="Total Sessions"
          value={data.totalSessions.toLocaleString()}
          icon={<Activity className="w-5 h-5" />}
          accent="text-indigo-500"
        />
        <StatCard
          label="Completed Sessions"
          value={data.completedSessions.toLocaleString()}
          icon={<CheckCircle className="w-5 h-5" />}
          accent="text-green-500"
        />
        <StatCard
          label="Consent Withdrawn"
          value={data.consentWithdrawnSessions.toLocaleString()}
          icon={<UserCheck className="w-5 h-5" />}
          accent="text-amber-500"
        />
        <StatCard
          label="Avg Doctor Edits / Session"
          value={data.avgDoctorEditRate.toLocaleString()}
          icon={<ClipboardList className="w-5 h-5" />}
          accent="text-blue-500"
        />
        <StatCard
          label="Drug Alert Rate"
          value={pct(data.drugAlertRate)}
          icon={<AlertTriangle className="w-5 h-5" />}
          accent="text-red-500"
        />
        <StatCard
          label="Total Drug Alerts"
          value={data.totalDrugAlerts.toLocaleString()}
          icon={<AlertTriangle className="w-5 h-5" />}
          accent="text-orange-500"
        />
      </div>

      {/* Status breakdown */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">Status Breakdown</h3>
        </div>
        {data.statusBreakdown.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">No data</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Count</th>
              </tr>
            </thead>
            <tbody>
              {data.statusBreakdown.map((row, i) => (
                <tr key={i} className="border-t border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-2 text-gray-700">{row.status}</td>
                  <td className="px-4 py-2 text-right font-medium text-gray-800">
                    {row.count.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────

export default function AIAnalyticsPage() {
  const { token } = useAuthStore();

  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [activeTab, setActiveTab] = useState<"triage" | "scribe">("triage");

  const [triageData, setTriageData] = useState<TriageData | null>(null);
  const [scribeData, setScribeData] = useState<ScribeData | null>(null);
  const [triageLoading, setTriageLoading] = useState(false);
  const [scribeLoading, setScribeLoading] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null);
  const [scribeError, setScribeError] = useState<string | null>(null);

  const fetchTriage = useCallback(async () => {
    setTriageLoading(true);
    setTriageError(null);
    try {
      const res = await api.get<{ success: boolean; data: TriageData }>(
        `/analytics/ai/triage?from=${from}&to=${to}`,
        token ? { token } : undefined
      );
      setTriageData(res.data);
    } catch (err) {
      setTriageError(err instanceof Error ? err.message : "Failed to load triage data");
    } finally {
      setTriageLoading(false);
    }
  }, [from, to, token]);

  const fetchScribe = useCallback(async () => {
    setScribeLoading(true);
    setScribeError(null);
    try {
      const res = await api.get<{ success: boolean; data: ScribeData }>(
        `/analytics/ai/scribe?from=${from}&to=${to}`,
        token ? { token } : undefined
      );
      setScribeData(res.data);
    } catch (err) {
      setScribeError(err instanceof Error ? err.message : "Failed to load scribe data");
    } finally {
      setScribeLoading(false);
    }
  }, [from, to, token]);

  // Fetch both on mount and when date range changes
  useEffect(() => {
    fetchTriage();
    fetchScribe();
  }, [fetchTriage, fetchScribe]);

  function handleRefresh() {
    fetchTriage();
    fetchScribe();
  }

  const tabs: Array<{ id: "triage" | "scribe"; label: string }> = [
    { id: "triage", label: "Triage" },
    { id: "scribe", label: "Scribe" },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Brain className="w-7 h-7 text-indigo-600" />
            <h1 className="text-2xl font-bold text-gray-900">AI Analytics</h1>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500 whitespace-nowrap">From</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500 whitespace-nowrap">To</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl w-fit shadow-sm">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.id
                  ? "bg-indigo-600 text-white shadow"
                  : "text-gray-600 hover:text-gray-800 hover:bg-gray-100"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "triage" && (
          <>
            {triageLoading && <Spinner />}
            {!triageLoading && triageError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
                {triageError}
              </div>
            )}
            {!triageLoading && !triageError && triageData && (
              <TriageTab data={triageData} />
            )}
          </>
        )}

        {activeTab === "scribe" && (
          <>
            {scribeLoading && <Spinner />}
            {!scribeLoading && scribeError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
                {scribeError}
              </div>
            )}
            {!scribeLoading && !scribeError && scribeData && (
              <ScribeTab data={scribeData} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
