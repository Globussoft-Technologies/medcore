"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { FileText, Printer, Copy, Loader2, Mail, ClipboardList } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "referral" | "discharge";

type Urgency = "ROUTINE" | "URGENT" | "EMERGENCY";

interface ReferralResponse {
  success: boolean;
  data: { letter: string; generatedAt: string } | null;
  error: string | null;
}

interface DischargeResponse {
  success: boolean;
  data: { summary: string; generatedAt: string } | null;
  error: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SPECIALTIES = [
  "Cardiologist",
  "Neurologist",
  "Pulmonologist",
  "Gastroenterologist",
  "Orthopedic",
  "Dermatologist",
  "ENT",
  "Ophthalmologist",
  "Gynecologist",
  "Urologist",
  "Endocrinologist",
  "Psychiatrist",
  "Oncologist",
  "Nephrologist",
];

const URGENCY_OPTIONS: { value: Urgency; label: string; color: string }[] = [
  { value: "ROUTINE", label: "Routine", color: "text-green-700" },
  { value: "URGENT", label: "Urgent", color: "text-amber-700" },
  { value: "EMERGENCY", label: "Emergency", color: "text-red-700" },
];

// ── LetterPreview ─────────────────────────────────────────────────────────────

function LetterPreview({
  content,
  generatedAt,
}: {
  content: string;
  generatedAt: string;
}) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy");
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400">
          Generated at {new Date(generatedAt).toLocaleString()}
        </span>
        <div className="flex gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Copy className="w-4 h-4" />
            Copy
          </button>
          <button
            onClick={handlePrint}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <Printer className="w-4 h-4" />
            Print
          </button>
        </div>
      </div>

      {/* Preview card — shown on screen, also used for print */}
      <div
        id="letter-print-content"
        className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm font-mono text-sm leading-relaxed whitespace-pre-wrap text-gray-800"
      >
        {content}
      </div>

      <style>{`
        @media print {
          body > *:not(#letter-print-root) {
            display: none !important;
          }
          #letter-print-content {
            border: none !important;
            box-shadow: none !important;
            padding: 0 !important;
            font-size: 12pt;
            line-height: 1.6;
          }
        }
      `}</style>
    </div>
  );
}

// ── ReferralTab ───────────────────────────────────────────────────────────────

function ReferralTab() {
  const [scribeSessionId, setScribeSessionId] = useState("");
  const [toSpecialty, setToSpecialty] = useState("Cardiologist");
  const [toDoctorName, setToDoctorName] = useState("");
  const [urgency, setUrgency] = useState<Urgency>("ROUTINE");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ letter: string; generatedAt: string } | null>(null);

  const handleGenerate = async () => {
    if (!scribeSessionId.trim()) {
      toast.error("Please enter a Scribe Session ID");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const resp = await api.post<ReferralResponse>("/ai/letters/referral", {
        scribeSessionId: scribeSessionId.trim(),
        toSpecialty,
        toDoctorName: toDoctorName.trim() || undefined,
        urgency,
      });
      if (resp.success && resp.data) {
        setResult(resp.data);
        toast.success("Referral letter generated");
      } else {
        toast.error(resp.error ?? "Failed to generate letter");
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to generate letter");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Scribe Session ID */}
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Scribe Session ID <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={scribeSessionId}
            onChange={(e) => setScribeSessionId(e.target.value)}
            placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="text-xs text-gray-400 mt-1">
            The AI scribe session must have a finalised SOAP note.
          </p>
        </div>

        {/* To Specialty */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Refer To Specialty <span className="text-red-500">*</span>
          </label>
          <select
            value={toSpecialty}
            onChange={(e) => setToSpecialty(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
          >
            {SPECIALTIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {/* To Doctor Name (optional) */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            To Doctor Name <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={toDoctorName}
            onChange={(e) => setToDoctorName(e.target.value)}
            placeholder="e.g. Dr. Priya Sharma"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        {/* Urgency */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Urgency</label>
          <select
            value={urgency}
            onChange={(e) => setUrgency(e.target.value as Urgency)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
          >
            {URGENCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-5">
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium text-sm"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Mail className="w-4 h-4" />
          )}
          {loading ? "Generating..." : "Generate Letter"}
        </button>
      </div>

      {result && <LetterPreview content={result.letter} generatedAt={result.generatedAt} />}
    </div>
  );
}

// ── DischargeTab ──────────────────────────────────────────────────────────────

function DischargeTab() {
  const [admissionId, setAdmissionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ summary: string; generatedAt: string } | null>(null);

  const handleGenerate = async () => {
    if (!admissionId.trim()) {
      toast.error("Please enter an Admission ID");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const resp = await api.post<DischargeResponse>("/ai/letters/discharge", {
        admissionId: admissionId.trim(),
      });
      if (resp.success && resp.data) {
        setResult(resp.data);
        toast.success("Discharge summary generated");
      } else {
        toast.error(resp.error ?? "Failed to generate summary");
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to generate summary");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Admission ID */}
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Admission ID <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={admissionId}
            onChange={(e) => setAdmissionId(e.target.value)}
            placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="text-xs text-gray-400 mt-1">
            Diagnosis, medications, and follow-up instructions will be fetched from the admission record.
          </p>
        </div>
      </div>

      <div className="mt-5">
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium text-sm"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <ClipboardList className="w-4 h-4" />
          )}
          {loading ? "Generating..." : "Generate Summary"}
        </button>
      </div>

      {result && <LetterPreview content={result.summary} generatedAt={result.generatedAt} />}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LettersPage() {
  const [tab, setTab] = useState<Tab>("referral");

  return (
    <div id="letter-print-root" className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-indigo-100 rounded-lg">
          <FileText className="w-5 h-5 text-indigo-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">AI Letter Generator</h1>
          <p className="text-sm text-gray-500">Generate referral letters and discharge summaries using AI</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-6">
        <button
          onClick={() => setTab("referral")}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === "referral"
              ? "border-indigo-600 text-indigo-600"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          <Mail className="w-4 h-4" />
          Referral Letter
        </button>
        <button
          onClick={() => setTab("discharge")}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === "discharge"
              ? "border-indigo-600 text-indigo-600"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          <ClipboardList className="w-4 h-4" />
          Discharge Summary
        </button>
      </div>

      {/* Tab content card */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
        {tab === "referral" ? <ReferralTab /> : <DischargeTab />}
      </div>
    </div>
  );
}
