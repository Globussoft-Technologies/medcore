"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  Stethoscope,
  Search,
  Loader2,
  AlertTriangle,
  FlaskConical,
  BookOpen,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────

interface DifferentialItem {
  diagnosis: string;
  icd10?: string;
  probability: "high" | "medium" | "low";
  reasoning: string;
  recommendedTests: string[];
  redFlags: string[];
}

interface DifferentialResult {
  differentials: DifferentialItem[];
  guidelineReferences: string[];
}

interface PatientSearchResult {
  id: string;
  mrNumber: string;
  user: { name: string };
}

// ─── Probability badge ──────────────────────────────────────

const PROB_CFG: Record<string, { cls: string; label: string }> = {
  high: { cls: "bg-red-100 text-red-700", label: "High" },
  medium: { cls: "bg-orange-100 text-orange-700", label: "Medium" },
  low: { cls: "bg-blue-100 text-blue-700", label: "Low" },
};

function ProbabilityBadge({ p }: { p: string }) {
  const cfg = PROB_CFG[p] ?? { cls: "bg-gray-100 text-gray-700", label: p };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

// ─── Page ───────────────────────────────────────────────────

export default function AIDifferentialPage() {
  const [patientId, setPatientId] = useState("");
  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<PatientSearchResult[]>([]);
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [relevantHistory, setRelevantHistory] = useState("");
  const [vitalsBp, setVitalsBp] = useState("");
  const [vitalsPulse, setVitalsPulse] = useState("");
  const [vitalsTemp, setVitalsTemp] = useState("");
  const [vitalsSpo2, setVitalsSpo2] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DifferentialResult | null>(null);

  async function searchPatients() {
    if (!patientSearch.trim()) return;
    try {
      const res = await api.get<any>(
        `/api/v1/patients?search=${encodeURIComponent(patientSearch)}&limit=5`
      );
      setPatientResults(res.data?.patients ?? res.data ?? []);
    } catch {
      toast.error("Patient search failed");
    }
  }

  async function runAnalysis() {
    if (!patientId || !chiefComplaint.trim()) {
      toast.error("Patient and chief complaint are required");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const vitals: Record<string, string | number> = {};
      if (vitalsBp) vitals.bp = vitalsBp;
      if (vitalsPulse) vitals.pulse = Number(vitalsPulse);
      if (vitalsTemp) vitals.temp = Number(vitalsTemp);
      if (vitalsSpo2) vitals.spo2 = Number(vitalsSpo2);

      const res = await api.post<any>("/api/v1/ai/differential", {
        patientId,
        chiefComplaint,
        vitals: Object.keys(vitals).length ? vitals : undefined,
        relevantHistory: relevantHistory || undefined,
      });
      setResult(res.data as DifferentialResult);
    } catch (err: any) {
      toast.error(err?.message ?? "Analysis failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <header className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center">
          <Stethoscope className="w-6 h-6 text-indigo-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">AI Differential Diagnosis</h1>
          <p className="text-sm text-gray-500">
            Clinical decision support — always verify suggestions before acting.
          </p>
        </div>
      </header>

      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
        {/* Patient picker */}
        <div>
          <label className="text-sm font-medium text-gray-700">Patient</label>
          <div className="mt-1 flex gap-2">
            <input
              data-testid="differential-patient-input"
              className="flex-1 border rounded-lg px-3 py-2 text-sm"
              placeholder="Search by name or MR number..."
              value={patientSearch}
              onChange={(e) => setPatientSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchPatients()}
            />
            <button
              className="px-3 py-2 rounded-lg border text-sm hover:bg-gray-50"
              onClick={searchPatients}
            >
              <Search className="w-4 h-4" />
            </button>
          </div>
          {patientResults.length > 0 && (
            <ul className="mt-2 border rounded-lg divide-y">
              {patientResults.map((p) => (
                <li
                  key={p.id}
                  className={`px-3 py-2 text-sm cursor-pointer hover:bg-indigo-50 ${patientId === p.id ? "bg-indigo-50" : ""}`}
                  onClick={() => {
                    setPatientId(p.id);
                    setPatientResults([]);
                    setPatientSearch(`${p.user.name} — ${p.mrNumber}`);
                  }}
                >
                  <strong>{p.user.name}</strong>{" "}
                  <span className="text-gray-500">({p.mrNumber})</span>
                </li>
              ))}
            </ul>
          )}
          {patientId && (
            <p className="text-xs text-gray-500 mt-1">Selected patientId: {patientId}</p>
          )}
        </div>

        {/* Chief complaint */}
        <div>
          <label className="text-sm font-medium text-gray-700">Chief Complaint</label>
          <textarea
            className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
            rows={3}
            placeholder="e.g. Productive cough and fever for 3 days"
            value={chiefComplaint}
            onChange={(e) => setChiefComplaint(e.target.value)}
          />
        </div>

        {/* Vitals (optional) */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            className="border rounded-lg px-3 py-2 text-sm"
            placeholder="BP (e.g. 130/85)"
            value={vitalsBp}
            onChange={(e) => setVitalsBp(e.target.value)}
          />
          <input
            className="border rounded-lg px-3 py-2 text-sm"
            placeholder="Pulse"
            value={vitalsPulse}
            onChange={(e) => setVitalsPulse(e.target.value)}
          />
          <input
            className="border rounded-lg px-3 py-2 text-sm"
            placeholder="Temp (C)"
            value={vitalsTemp}
            onChange={(e) => setVitalsTemp(e.target.value)}
          />
          <input
            className="border rounded-lg px-3 py-2 text-sm"
            placeholder="SpO2 (%)"
            value={vitalsSpo2}
            onChange={(e) => setVitalsSpo2(e.target.value)}
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700">Relevant History (optional)</label>
          <textarea
            className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
            rows={2}
            placeholder="Smoker, diabetic, recent travel..."
            value={relevantHistory}
            onChange={(e) => setRelevantHistory(e.target.value)}
          />
        </div>

        <button
          data-testid="differential-submit"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
          onClick={runAnalysis}
          disabled={loading || !patientId || !chiefComplaint.trim()}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Stethoscope className="w-4 h-4" />}
          Suggest Differentials
        </button>
      </section>

      {result && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Suggested Differentials</h2>
          {result.differentials.length === 0 && (
            <div className="text-sm text-gray-500">No differentials returned.</div>
          )}
          <div className="space-y-3">
            {result.differentials.map((d, i) => (
              <article
                key={i}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-900">
                      {d.diagnosis}
                      {d.icd10 && (
                        <span className="ml-2 text-xs text-gray-500 font-normal">
                          [{d.icd10}]
                        </span>
                      )}
                    </h3>
                    <p className="text-sm text-gray-600 mt-1">{d.reasoning}</p>
                  </div>
                  <ProbabilityBadge p={d.probability} />
                </div>

                {d.recommendedTests.length > 0 && (
                  <div className="mt-3">
                    <div className="flex items-center gap-1 text-xs font-medium text-gray-600">
                      <FlaskConical className="w-3.5 h-3.5" /> Recommended Tests
                    </div>
                    <ul className="text-sm text-gray-800 list-disc list-inside mt-1">
                      {d.recommendedTests.map((t, j) => (
                        <li key={j}>{t}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {d.redFlags.length > 0 && (
                  <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3">
                    <div className="flex items-center gap-1 text-xs font-medium text-red-700">
                      <AlertTriangle className="w-3.5 h-3.5" /> Red Flags
                    </div>
                    <ul className="text-sm text-red-800 list-disc list-inside mt-1">
                      {d.redFlags.map((r, j) => (
                        <li key={j}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            ))}
          </div>

          {result.guidelineReferences.length > 0 && (
            <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center gap-1 text-sm font-semibold text-gray-700">
                <BookOpen className="w-4 h-4" /> Guideline References
              </div>
              <ul className="text-sm text-gray-700 list-disc list-inside mt-2">
                {result.guidelineReferences.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </section>
          )}
        </section>
      )}
    </div>
  );
}
