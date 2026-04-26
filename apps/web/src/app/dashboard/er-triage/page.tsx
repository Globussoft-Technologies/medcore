"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Activity,
  ChevronDown,
  ChevronUp,
  Loader2,
  Stethoscope,
  ClipboardList,
  Zap,
  ShieldAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

// ── Types ─────────────────────────────────────────────────

interface ERTriageAssessment {
  suggestedTriageLevel: number;
  triageLevelLabel: string;
  disposition: string;
  immediateActions: string[];
  suggestedInvestigations: string[];
  redFlags: string[];
  calculatedMEWS: number | null;
  aiReasoning: string;
  disclaimer: string;
}

interface FormState {
  chiefComplaint: string;
  bp: string;
  pulse: string;
  resp: string;
  spO2: string;
  temp: string;
  gcs: string;
  patientAge: string;
  briefHistory: string;
}

// ── Triage level config ───────────────────────────────────

const TRIAGE_CONFIG: Record<
  number,
  { label: string; color: string; bg: string; border: string; dot: string }
> = {
  1: {
    label: "Resuscitation",
    color: "text-white",
    bg: "bg-red-600",
    border: "border-red-600",
    dot: "bg-red-600",
  },
  2: {
    label: "Emergent",
    color: "text-white",
    bg: "bg-orange-500",
    border: "border-orange-500",
    dot: "bg-orange-500",
  },
  3: {
    label: "Urgent",
    color: "text-white",
    bg: "bg-yellow-500",
    border: "border-yellow-500",
    dot: "bg-yellow-500",
  },
  4: {
    label: "Semi-Urgent",
    color: "text-white",
    bg: "bg-green-500",
    border: "border-green-500",
    dot: "bg-green-500",
  },
  5: {
    label: "Non-Urgent",
    color: "text-white",
    bg: "bg-blue-500",
    border: "border-blue-500",
    dot: "bg-blue-500",
  },
};

const MEWS_COLOR = (score: number) => {
  if (score >= 5) return "text-red-700 bg-red-100";
  if (score >= 3) return "text-orange-700 bg-orange-100";
  return "text-green-700 bg-green-100";
};

// ── Component ─────────────────────────────────────────────

export default function ERTriagePage() {
  const { token } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [assessment, setAssessment] = useState<ERTriageAssessment | null>(null);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  // Issue #81: previously a backend 500/503 surfaced as a fire-and-forget
  // toast that disappeared in 4 seconds. We also show a persistent banner
  // with a Retry button so the doctor can re-run the assessment without
  // re-entering vitals.
  const [assessError, setAssessError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>({
    chiefComplaint: "",
    bp: "",
    pulse: "",
    resp: "",
    spO2: "",
    temp: "",
    gcs: "",
    patientAge: "",
    briefHistory: "",
  });

  const set = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleAssess = async () => {
    if (!form.chiefComplaint.trim()) {
      toast.error("Chief complaint is required");
      return;
    }

    setLoading(true);
    setAssessment(null);
    setAssessError(null);

    try {
      const vitals: Record<string, string | number> = {};
      if (form.bp.trim()) vitals.bp = form.bp.trim();
      if (form.pulse.trim()) vitals.pulse = Number(form.pulse);
      if (form.resp.trim()) vitals.resp = Number(form.resp);
      if (form.spO2.trim()) vitals.spO2 = Number(form.spO2);
      if (form.temp.trim()) vitals.temp = Number(form.temp);
      if (form.gcs.trim()) vitals.gcs = Number(form.gcs);

      const body: Record<string, unknown> = {
        chiefComplaint: form.chiefComplaint.trim(),
        vitals,
      };
      if (form.patientAge.trim()) body.patientAge = Number(form.patientAge);
      if (form.briefHistory.trim()) body.briefHistory = form.briefHistory.trim();

      const res = await api.post<{ success: boolean; data: ERTriageAssessment }>(
        "/ai/er-triage/assess",
        body,
        token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
      );

      setAssessment(res.data);
      setAssessError(null);
      setReasoningOpen(false);
    } catch (err: any) {
      // Issue #81: surface the backend's friendly error string (the route now
      // returns 503 with a human message when Sarvam is unreachable). Keep
      // the toast for accessibility (announced to screen readers) AND show a
      // persistent banner so the doctor can hit Retry without re-entering
      // vitals. Auth failures get a clearer message than the raw
      // "Unauthorized" string the API used to bleed straight into the toast.
      let msg = err?.message || "Assessment failed. Please try again.";
      if (err?.status === 401) {
        msg = "Your session has expired. Please sign in again.";
      } else if (err?.status === 403) {
        msg = "You don't have permission to run an ER triage assessment.";
      } else if (err?.payload?.error) {
        msg = String(err.payload.error);
      }
      setAssessError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const cfg = assessment ? TRIAGE_CONFIG[assessment.suggestedTriageLevel] ?? TRIAGE_CONFIG[3] : null;
  const isHighAcuity = assessment ? assessment.suggestedTriageLevel <= 2 : false;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center">
          <Activity className="w-5 h-5 text-red-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">ER Triage Assistant</h1>
          <p className="text-sm text-gray-500">AI-assisted ESI triage — for clinical use only</p>
        </div>
      </div>

      {/* Form card */}
      <div className="bg-white rounded-2xl shadow border border-gray-100 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-gray-400" />
          Patient Presentation
        </h2>

        <div className="grid grid-cols-1 gap-4">
          {/* Chief Complaint */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Chief Complaint <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.chiefComplaint}
              onChange={set("chiefComplaint")}
              placeholder="e.g. Sudden onset chest pain, radiating to left arm"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
            />
          </div>

          {/* Vitals row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">BP (mmHg)</label>
              <input
                type="text"
                value={form.bp}
                onChange={set("bp")}
                placeholder="e.g. 120/80"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Pulse (bpm)</label>
              <input
                type="number"
                value={form.pulse}
                onChange={set("pulse")}
                placeholder="e.g. 88"
                min={0}
                max={300}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Resp Rate (/min)</label>
              <input
                type="number"
                value={form.resp}
                onChange={set("resp")}
                placeholder="e.g. 18"
                min={0}
                max={100}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">SpO2 (%)</label>
              <input
                type="number"
                value={form.spO2}
                onChange={set("spO2")}
                placeholder="e.g. 98"
                min={0}
                max={100}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Temperature (°C)</label>
              <input
                type="number"
                value={form.temp}
                onChange={set("temp")}
                placeholder="e.g. 37.2"
                step="0.1"
                min={30}
                max={45}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">GCS (3–15)</label>
              <input
                type="number"
                value={form.gcs}
                onChange={set("gcs")}
                placeholder="e.g. 15"
                min={3}
                max={15}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
              />
            </div>
          </div>

          {/* Demographics */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Patient Age (years)</label>
            <input
              type="number"
              value={form.patientAge}
              onChange={set("patientAge")}
              placeholder="e.g. 45"
              min={0}
              max={120}
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
            />
          </div>

          {/* Brief history */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Brief History</label>
            <textarea
              value={form.briefHistory}
              onChange={set("briefHistory")}
              rows={3}
              placeholder="Known conditions, relevant history, onset, medications..."
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 resize-none"
            />
          </div>
        </div>

        {/* Issue #81: persistent error banner with Retry. Stays visible until
            the user retries successfully or fixes the underlying issue. */}
        {assessError && (
          <div
            data-testid="er-triage-error-banner"
            role="alert"
            className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-medium">Couldn&apos;t complete the assessment</p>
                <p className="mt-0.5 text-xs">{assessError}</p>
              </div>
              <button
                type="button"
                data-testid="er-triage-retry"
                onClick={handleAssess}
                disabled={loading || !form.chiefComplaint.trim()}
                className="rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          </div>
        )}
        <button
          onClick={handleAssess}
          disabled={loading || !form.chiefComplaint.trim()}
          className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Assessing...
            </>
          ) : (
            <>
              <Stethoscope className="w-4 h-4" />
              Assess Patient
            </>
          )}
        </button>
      </div>

      {/* Results panel */}
      {assessment && cfg && (
        <div className="space-y-4">
          {/* Triage level badge + MEWS + disposition */}
          <div className="bg-white rounded-2xl shadow border border-gray-100 p-6">
            <div className="flex flex-wrap items-center gap-4">
              {/* Level badge */}
              <div
                className={`flex items-center gap-3 px-5 py-3 rounded-xl ${cfg.bg} ${cfg.color} shadow-sm`}
              >
                <span className="text-3xl font-black">{assessment.suggestedTriageLevel}</span>
                <div>
                  <p className="text-xs font-medium opacity-80">ESI Level</p>
                  <p className="text-lg font-bold leading-tight">{assessment.triageLevelLabel}</p>
                </div>
              </div>

              {/* MEWS */}
              {assessment.calculatedMEWS !== null && (
                <div
                  className={`flex flex-col items-center px-4 py-3 rounded-xl font-semibold ${MEWS_COLOR(
                    assessment.calculatedMEWS
                  )}`}
                >
                  <span className="text-2xl font-black">{assessment.calculatedMEWS}</span>
                  <span className="text-xs font-medium">MEWS Score</span>
                </div>
              )}

              {/* Disposition */}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-500 font-medium">Disposition</p>
                <p className="text-base font-semibold text-gray-800">{assessment.disposition}</p>
              </div>
            </div>
          </div>

          {/* Immediate actions */}
          {assessment.immediateActions.length > 0 && (
            <div
              className={`rounded-2xl border p-5 ${
                isHighAcuity
                  ? "bg-red-50 border-red-200"
                  : "bg-white border-gray-100 shadow"
              }`}
            >
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 mb-3">
                <Zap className={`w-4 h-4 ${isHighAcuity ? "text-red-500" : "text-amber-500"}`} />
                Immediate Actions
              </h3>
              <ul className="space-y-1.5">
                {assessment.immediateActions.map((action, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-bold ${
                        isHighAcuity ? "bg-red-500 text-white" : "bg-amber-400 text-white"
                      }`}
                    >
                      {i + 1}
                    </span>
                    {action}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Investigations */}
          {assessment.suggestedInvestigations.length > 0 && (
            <div className="bg-white rounded-2xl shadow border border-gray-100 p-5">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 mb-3">
                <Activity className="w-4 h-4 text-blue-500" />
                Suggested Investigations
              </h3>
              <ul className="flex flex-wrap gap-2">
                {assessment.suggestedInvestigations.map((inv, i) => (
                  <li
                    key={i}
                    className="px-3 py-1 bg-blue-50 text-blue-700 text-xs font-medium rounded-full border border-blue-100"
                  >
                    {inv}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Red flags */}
          {assessment.redFlags.length > 0 && (
            <div className="bg-white rounded-2xl shadow border border-red-100 p-5">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-red-700 mb-3">
                <ShieldAlert className="w-4 h-4 text-red-500" />
                Red Flags Identified
              </h3>
              <ul className="space-y-1">
                {assessment.redFlags.map((flag, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm text-red-700">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                    {flag}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* AI Reasoning — collapsible */}
          <div className="bg-white rounded-2xl shadow border border-gray-100 overflow-hidden">
            <button
              onClick={() => setReasoningOpen((o) => !o)}
              className="w-full flex items-center justify-between px-5 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <span className="flex items-center gap-2">
                <Stethoscope className="w-4 h-4 text-gray-400" />
                AI Reasoning
              </span>
              {reasoningOpen ? (
                <ChevronUp className="w-4 h-4 text-gray-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-gray-400" />
              )}
            </button>
            {reasoningOpen && (
              <div className="px-5 pb-4 text-sm text-gray-600 leading-relaxed border-t border-gray-100 pt-3">
                {assessment.aiReasoning}
              </div>
            )}
          </div>

          {/* Disclaimer */}
          <p className="text-xs italic text-gray-400 text-center px-2">{assessment.disclaimer}</p>
        </div>
      )}
    </div>
  );
}
