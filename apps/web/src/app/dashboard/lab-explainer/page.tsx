"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import {
  FlaskConical,
  CheckCircle,
  Clock,
  Send,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  User,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────

interface FlaggedValue {
  parameter: string;
  value: string;
  flag: string;
  plainLanguage: string;
}

interface LabReportExplanation {
  id: string;
  labOrderId: string;
  patientId: string;
  explanation: string;
  flaggedValues: FlaggedValue[];
  language: string;
  status: "PENDING_REVIEW" | "APPROVED" | "SENT";
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Flag badge config ────────────────────────────────────

const FLAG_CONFIG: Record<string, { label: string; cls: string }> = {
  NORMAL: { label: "Normal", cls: "bg-green-100 text-green-700" },
  HIGH: { label: "High", cls: "bg-orange-100 text-orange-700" },
  LOW: { label: "Low", cls: "bg-blue-100 text-blue-700" },
  CRITICAL_HIGH: { label: "Critical High", cls: "bg-red-100 text-red-700" },
  CRITICAL_LOW: { label: "Critical Low", cls: "bg-red-100 text-red-700" },
  ABNORMAL: { label: "Abnormal", cls: "bg-yellow-100 text-yellow-700" },
};

function FlagBadge({ flag }: { flag: string }) {
  const cfg = FLAG_CONFIG[flag] ?? { label: flag, cls: "bg-gray-100 text-gray-600" };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

// ─── Status badge ──────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  PENDING_REVIEW: {
    label: "Pending Review",
    cls: "bg-yellow-100 text-yellow-700",
    icon: <Clock className="w-3.5 h-3.5" />,
  },
  APPROVED: {
    label: "Approved",
    cls: "bg-blue-100 text-blue-700",
    icon: <CheckCircle className="w-3.5 h-3.5" />,
  },
  SENT: {
    label: "Sent to Patient",
    cls: "bg-green-100 text-green-700",
    icon: <Send className="w-3.5 h-3.5" />,
  },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? {
    label: status,
    cls: "bg-gray-100 text-gray-600",
    icon: null,
  };
  return (
    <span className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${cfg.cls}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

// ─── Explanation Card ──────────────────────────────────────

function ExplanationCard({
  item,
  onApprove,
  approving,
}: {
  item: LabReportExplanation;
  onApprove: (id: string) => Promise<void>;
  approving: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const flaggedValues = Array.isArray(item.flaggedValues) ? item.flaggedValues : [];
  const hasAbnormal = flaggedValues.some((fv) => fv.flag !== "NORMAL");

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Card header */}
      <div className="flex items-start justify-between px-5 py-4 border-b border-gray-50">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
            <FlaskConical className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-sm text-gray-800">
                Lab Order
              </p>
              <code className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded font-mono">
                {item.labOrderId.slice(0, 8)}...
              </code>
              <StatusBadge status={item.status} />
            </div>
            <div className="flex items-center gap-3 mt-1">
              <span className="flex items-center gap-1 text-xs text-gray-500">
                <User className="w-3.5 h-3.5" />
                Patient ID: <code className="font-mono">{item.patientId.slice(0, 8)}...</code>
              </span>
              <span className="text-xs text-gray-400">
                {new Date(item.createdAt).toLocaleDateString("en-IN", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
              </span>
              <span className="text-xs text-gray-400 uppercase tracking-wide">
                {item.language === "hi" ? "Hindi" : "English"}
              </span>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 ml-2">
          {item.status === "PENDING_REVIEW" && (
            <button
              onClick={() => onApprove(item.id)}
              disabled={approving}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-xl text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {approving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              Approve &amp; Send to Patient
            </button>
          )}
          {(item.status === "APPROVED" || item.status === "SENT") && (
            <div className="text-xs text-gray-500">
              {item.sentAt
                ? `Sent ${new Date(item.sentAt).toLocaleString("en-IN")}`
                : item.approvedAt
                ? `Approved ${new Date(item.approvedAt).toLocaleString("en-IN")}`
                : null}
            </div>
          )}
        </div>
      </div>

      {/* Flagged values highlight strip */}
      {hasAbnormal && (
        <div className="px-5 py-3 bg-amber-50 border-b border-amber-100">
          <div className="flex items-center gap-1.5 mb-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <p className="text-xs font-semibold text-amber-700">
              {flaggedValues.filter((fv) => fv.flag !== "NORMAL").length} Abnormal{" "}
              {flaggedValues.filter((fv) => fv.flag !== "NORMAL").length === 1 ? "Value" : "Values"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {flaggedValues
              .filter((fv) => fv.flag !== "NORMAL")
              .map((fv, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 bg-white border border-amber-200 rounded-lg px-2.5 py-1.5"
                >
                  <span className="text-xs font-medium text-gray-800">{fv.parameter}</span>
                  <span className="text-xs text-gray-600">{fv.value}</span>
                  <FlagBadge flag={fv.flag} />
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Explanation text */}
      <div className="px-5 py-4">
        <p className="text-sm text-gray-700 leading-relaxed line-clamp-3">
          {item.explanation}
        </p>
        {(item.explanation.length > 200 || flaggedValues.length > 0) && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1 mt-2 text-xs text-blue-600 hover:text-blue-700 font-medium"
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" /> Show less
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" /> Show full explanation
              </>
            )}
          </button>
        )}
      </div>

      {/* Expanded view */}
      {expanded && (
        <div className="px-5 pb-5 space-y-4">
          <div className="bg-gray-50 rounded-xl p-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Full AI Explanation
            </p>
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
              {item.explanation}
            </p>
          </div>

          {flaggedValues.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                All Result Details
              </p>
              <div className="space-y-2">
                {flaggedValues.map((fv, i) => (
                  <div
                    key={i}
                    className={`rounded-xl border p-3 ${
                      fv.flag === "NORMAL"
                        ? "bg-green-50 border-green-100"
                        : fv.flag.startsWith("CRITICAL")
                        ? "bg-red-50 border-red-100"
                        : "bg-amber-50 border-amber-100"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-gray-800">{fv.parameter}</span>
                      <span className="text-sm text-gray-600">{fv.value}</span>
                      <FlagBadge flag={fv.flag} />
                    </div>
                    {fv.plainLanguage && (
                      <p className="text-xs text-gray-600">{fv.plainLanguage}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────

export default function LabExplainerPage() {
  const { token } = useAuthStore();
  const [explanations, setExplanations] = useState<LabReportExplanation[]>([]);
  const [loading, setLoading] = useState(true);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const fetchPending = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ success: boolean; data: LabReportExplanation[] }>(
        "/ai/reports/pending",
        { token: token ?? undefined }
      );
      setExplanations(res.data ?? []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load pending explanations";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchPending();
  }, [fetchPending]);

  const handleApprove = async (explanationId: string) => {
    setApprovingId(explanationId);
    try {
      await api.patch<{ success: boolean; data: LabReportExplanation }>(
        `/ai/reports/${explanationId}/approve`,
        {},
        { token: token ?? undefined }
      );
      toast.success("Explanation approved and sent to patient");
      // Remove the approved item from the pending list
      setExplanations((prev) => prev.filter((e) => e.id !== explanationId));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to approve explanation";
      toast.error(message);
    } finally {
      setApprovingId(null);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <FlaskConical className="w-6 h-6 text-blue-600" />
            AI Lab Report Explainer
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Review and approve AI-generated patient-friendly lab report explanations before they are sent.
          </p>
        </div>
        <button
          onClick={fetchPending}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 text-gray-600 rounded-xl text-sm hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-yellow-50 border border-yellow-100 rounded-2xl p-4">
          <p className="text-2xl font-bold text-yellow-700">{explanations.length}</p>
          <p className="text-xs text-yellow-600 mt-0.5">Pending Review</p>
        </div>
        <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4">
          <p className="text-2xl font-bold text-blue-700">
            {explanations.filter((e) => e.flaggedValues && (e.flaggedValues as FlaggedValue[]).some((fv) => fv.flag !== "NORMAL")).length}
          </p>
          <p className="text-xs text-blue-600 mt-0.5">With Abnormal Values</p>
        </div>
        <div className="bg-green-50 border border-green-100 rounded-2xl p-4">
          <p className="text-2xl font-bold text-green-700">
            {explanations.filter((e) =>
              (e.flaggedValues as FlaggedValue[]).some(
                (fv) => fv.flag === "CRITICAL_HIGH" || fv.flag === "CRITICAL_LOW"
              )
            ).length}
          </p>
          <p className="text-xs text-green-600 mt-0.5">With Critical Values</p>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-center space-y-2">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500 mx-auto" />
            <p className="text-sm text-gray-500">Loading pending explanations...</p>
          </div>
        </div>
      ) : explanations.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-center space-y-3">
            <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto">
              <CheckCircle className="w-8 h-8 text-green-500" />
            </div>
            <p className="text-gray-700 font-medium">All caught up!</p>
            <p className="text-sm text-gray-400">No lab report explanations are pending review.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {explanations.map((item) => (
            <ExplanationCard
              key={item.id}
              item={item}
              onApprove={handleApprove}
              approving={approvingId === item.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
