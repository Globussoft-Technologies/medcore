"use client";

/**
 * AI Letters page.
 *
 * Renamed from `/dashboard/letters` to `/dashboard/ai-letters` (Issue #83) so
 * the URL pattern is consistent with the other AI pages (`/dashboard/ai-
 * analytics`, `/dashboard/ai-booking`, `/dashboard/ai-radiology`, …). The old
 * path is preserved as a redirect — see
 * `apps/web/src/app/dashboard/letters/page.tsx`.
 *
 * Issue #84: replaced "paste a Scribe Session ID" / "paste an Admission ID"
 * raw-UUID inputs with the shared `<EntityPicker>` component so users can
 * type a search term and pick the entity from a dropdown.
 */

import { useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { EntityPicker } from "@/components/EntityPicker";
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

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/^---+$/gm, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function LetterPreview({
  content,
  generatedAt,
}: {
  content: string;
  generatedAt: string;
}) {
  const cleanContent = stripMarkdown(content);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanContent);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy");
    }
  };

  const handlePrint = () => {
    const win = window.open("", "_blank", "width=800,height=600");
    if (!win) return;
    win.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>Letter</title>
  <style>
    body { font-family: monospace; font-size: 12pt; line-height: 1.6; padding: 2cm; color: #000; }
    pre { white-space: pre-wrap; word-wrap: break-word; }
  </style>
</head>
<body><pre>${cleanContent.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre></body>
</html>`);
    win.document.close();
    win.focus();
    win.print();
    win.close();
  };

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400 dark:text-gray-500">
          Generated at {new Date(generatedAt).toLocaleString()}
        </span>
        <div className="flex gap-2">
          <button
            onClick={handleCopy}
            data-testid="ai-letters-copy"
            className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            <Copy className="w-4 h-4" />
            Copy
          </button>
          <button
            onClick={handlePrint}
            data-testid="ai-letters-print"
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <Printer className="w-4 h-4" />
            Print
          </button>
        </div>
      </div>

      <div
        id="letter-print-content"
        className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-8 shadow-sm font-mono text-sm leading-relaxed whitespace-pre-wrap text-gray-800 dark:text-gray-100"
      >
        {cleanContent}
      </div>

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
      toast.error("Please pick a Scribe Session");
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
        {/* Scribe Session — searchable picker (Issue #84). */}
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Scribe Session <span className="text-red-500">*</span>
          </label>
          <EntityPicker
            endpoint="/ai/scribe"
            labelField="patient.user.name"
            subtitleField="status"
            hintField="appointmentId"
            value={scribeSessionId}
            onChange={(id) => setScribeSessionId(id)}
            searchPlaceholder="Search by patient name or session id..."
            testIdPrefix="ai-letters-scribe-picker"
            required
          />
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            The AI scribe session must have a finalised SOAP note.
          </p>
        </div>

        <div>
          <label htmlFor="ai-letters-specialty" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Refer To Specialty <span className="text-red-500">*</span>
          </label>
          <select
            id="ai-letters-specialty"
            value={toSpecialty}
            onChange={(e) => setToSpecialty(e.target.value)}
            data-testid="ai-letters-specialty"
            className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          >
            {SPECIALTIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="ai-letters-to-doctor" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            To Doctor Name <span className="text-gray-400 dark:text-gray-500 font-normal">(optional)</span>
          </label>
          <input
            id="ai-letters-to-doctor"
            type="text"
            value={toDoctorName}
            onChange={(e) => setToDoctorName(e.target.value)}
            placeholder="e.g. Dr. Priya Sharma"
            className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
          />
        </div>

        <div>
          <label htmlFor="ai-letters-urgency" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Urgency</label>
          <select
            id="ai-letters-urgency"
            value={urgency}
            onChange={(e) => setUrgency(e.target.value as Urgency)}
            className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
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
          data-testid="ai-letters-generate-referral"
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
      toast.error("Please pick an Admission");
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
        {/* Admission — searchable picker (Issue #84). */}
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Admission <span className="text-red-500">*</span>
          </label>
          <EntityPicker
            endpoint="/admissions"
            labelField="admissionNumber"
            subtitleField="patient.user.name"
            hintField="status"
            value={admissionId}
            onChange={(id) => setAdmissionId(id)}
            searchPlaceholder="Search by admission number or patient..."
            testIdPrefix="ai-letters-admission-picker"
            required
          />
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Diagnosis, medications, and follow-up instructions will be fetched from the admission record.
          </p>
        </div>
      </div>

      <div className="mt-5">
        <button
          onClick={handleGenerate}
          disabled={loading}
          data-testid="ai-letters-generate-discharge"
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

export default function AILettersPage() {
  const [tab, setTab] = useState<Tab>("referral");

  return (
    <div id="letter-print-root" className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg">
          <FileText className="w-5 h-5 text-indigo-600 dark:text-indigo-300" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">AI Letter Generator</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Generate referral letters and discharge summaries using AI</p>
        </div>
      </div>

      <div className="flex border-b border-gray-200 dark:border-gray-700 mb-6">
        <button
          onClick={() => setTab("referral")}
          data-testid="ai-letters-tab-referral"
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === "referral"
              ? "border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400"
              : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          }`}
        >
          <Mail className="w-4 h-4" />
          Referral Letter
        </button>
        <button
          onClick={() => setTab("discharge")}
          data-testid="ai-letters-tab-discharge"
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === "discharge"
              ? "border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400"
              : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          }`}
        >
          <ClipboardList className="w-4 h-4" />
          Discharge Summary
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 shadow-sm">
        {tab === "referral" ? <ReferralTab /> : <DischargeTab />}
      </div>
    </div>
  );
}
