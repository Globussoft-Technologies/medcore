"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { SOAPNote } from "@medcore/shared";
// PRD §3.5.1 Phase 2 — 8-language picker + BCP-47 conversion. The scribe
// page exposes the selected language as the `language_code` the ASR client
// forwards to Sarvam, so the doctor can transcribe regional-language
// consultations without a config change.
import {
  TRIAGE_LANGUAGE_CODES,
  LANGUAGE_DISPLAY,
  toSarvamLanguageCode,
  type TriageLanguageCode,
} from "@medcore/shared";
import {
  Mic,
  MicOff,
  FileText,
  CheckCircle,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  AlertOctagon,
  ChevronDown,
  ChevronUp,
  Edit3,
  Save,
  X,
  Activity,
  Clipboard,
  Pill,
  FlaskConical,
  UserCheck,
  ArrowLeft,
  Check,
  Ban,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────

interface DrugInteractionAlert {
  drug1: string;
  drug2: string;
  severity: "MILD" | "MODERATE" | "SEVERE" | "CONTRAINDICATED";
  description: string;
}

interface DrugSafetyReport {
  alerts: DrugInteractionAlert[];
  hasContraindicated: boolean;
  hasSevere: boolean;
  checkedAt: string;
  checkedMeds: string[];
}

type SectionKey = "S" | "O" | "A" | "P";
type SectionStatus = "pending" | "accepted" | "edited" | "rejected";
type SectionStatusMap = Record<SectionKey, SectionStatus>;

// ─── Helpers ─────────────────────────────────────────────

function soapSectionToText(section: SectionKey, soap: SOAPNote): string {
  switch (section) {
    case "S": {
      const s = soap.subjective;
      const lines: string[] = [];
      if (s.chiefComplaint) lines.push(`Chief Complaint: ${s.chiefComplaint}`);
      if (s.hpi) lines.push(`HPI: ${s.hpi}`);
      if (s.pastMedicalHistory) lines.push(`Past Medical History: ${s.pastMedicalHistory}`);
      if (s.medications?.length) lines.push(`Medications: ${s.medications.join(", ")}`);
      if (s.allergies?.length) lines.push(`Allergies: ${s.allergies.join(", ")}`);
      if (s.socialHistory) lines.push(`Social History: ${s.socialHistory}`);
      if (s.familyHistory) lines.push(`Family History: ${s.familyHistory}`);
      return lines.join("\n");
    }
    case "O": {
      const o = soap.objective;
      const lines: string[] = [];
      if (o.vitals) lines.push(`Vitals: ${o.vitals}`);
      if (o.examinationFindings) lines.push(`Examination Findings: ${o.examinationFindings}`);
      return lines.join("\n");
    }
    case "A": {
      const a = soap.assessment;
      const lines: string[] = [];
      if (a.impression) lines.push(`Impression: ${a.impression}`);
      if (a.icd10Codes?.length) {
        lines.push("ICD-10 Codes:");
        for (const c of a.icd10Codes) lines.push(`  ${c.code} — ${c.description}`);
      }
      return lines.join("\n");
    }
    case "P": {
      const p = soap.plan;
      const lines: string[] = [];
      if (p.medications?.length) {
        lines.push("Medications:");
        for (const m of p.medications)
          lines.push(
            `  ${m.name} ${m.dose} ${m.frequency} ${m.duration}${m.notes ? ` (${m.notes})` : ""}`
          );
      }
      if (p.investigations?.length) lines.push(`Investigations: ${p.investigations.join(", ")}`);
      if (p.procedures?.length) lines.push(`Procedures: ${p.procedures.join(", ")}`);
      if (p.referrals?.length) lines.push(`Referrals: ${p.referrals.join(", ")}`);
      if (p.followUpTimeline) lines.push(`Follow-up: ${p.followUpTimeline}`);
      if (p.patientInstructions) lines.push(`Instructions: ${p.patientInstructions}`);
      return lines.join("\n");
    }
  }
}

function applyTextToSection(section: SectionKey, text: string, base: SOAPNote): SOAPNote {
  const soap = JSON.parse(JSON.stringify(base)) as SOAPNote;
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const extract = (prefix: string): string | undefined => {
    const line = lines.find((l) => l.toLowerCase().startsWith(prefix.toLowerCase() + ":"));
    return line ? line.slice(prefix.length + 1).trim() : undefined;
  };

  switch (section) {
    case "S": {
      const cc = extract("Chief Complaint");
      if (cc !== undefined) soap.subjective.chiefComplaint = cc;
      const hpi = extract("HPI");
      if (hpi !== undefined) soap.subjective.hpi = hpi;
      const pmh = extract("Past Medical History");
      if (pmh !== undefined) soap.subjective.pastMedicalHistory = pmh;
      const meds = extract("Medications");
      if (meds !== undefined)
        soap.subjective.medications = meds.split(",").map((m) => m.trim()).filter(Boolean);
      const allergies = extract("Allergies");
      if (allergies !== undefined)
        soap.subjective.allergies = allergies.split(",").map((a) => a.trim()).filter(Boolean);
      const sh = extract("Social History");
      if (sh !== undefined) soap.subjective.socialHistory = sh;
      const fh = extract("Family History");
      if (fh !== undefined) soap.subjective.familyHistory = fh;
      break;
    }
    case "O": {
      const vitals = extract("Vitals");
      if (vitals !== undefined) soap.objective.vitals = vitals;
      const ef = extract("Examination Findings");
      if (ef !== undefined) soap.objective.examinationFindings = ef;
      break;
    }
    case "A": {
      const imp = extract("Impression");
      if (imp !== undefined) soap.assessment.impression = imp;
      // ICD-10 codes: leave structured data unchanged on free-text edit
      break;
    }
    case "P": {
      const inv = extract("Investigations");
      if (inv !== undefined)
        soap.plan.investigations = inv.split(",").map((i) => i.trim()).filter(Boolean);
      const proc = extract("Procedures");
      if (proc !== undefined)
        soap.plan.procedures = proc.split(",").map((p) => p.trim()).filter(Boolean);
      const ref = extract("Referrals");
      if (ref !== undefined)
        soap.plan.referrals = ref.split(",").map((r) => r.trim()).filter(Boolean);
      const fu = extract("Follow-up");
      if (fu !== undefined) soap.plan.followUpTimeline = fu;
      const inst = extract("Instructions");
      if (inst !== undefined) soap.plan.patientInstructions = inst;
      // Medications: leave structured data unchanged on free-text edit
      break;
    }
  }
  return soap;
}

// ─── Status Badge ─────────────────────────────────────────

const STATUS_BADGE: Record<SectionStatus, { label: string; cls: string }> = {
  pending:  { label: "Pending",  cls: "bg-gray-100 text-gray-500" },
  accepted: { label: "Accepted", cls: "bg-green-100 text-green-700" },
  edited:   { label: "Edited",   cls: "bg-blue-100 text-blue-700" },
  rejected: { label: "Rejected", cls: "bg-red-100 text-red-700" },
};

function StatusBadge({ status }: { status: SectionStatus }) {
  const { label, cls } = STATUS_BADGE[status];
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cls}`}>{label}</span>
  );
}

// ─── Section read-only view ───────────────────────────────

function ReadRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-gray-800 bg-gray-50 rounded-lg px-3 py-2 min-h-[2rem]">
        {value || <span className="text-gray-400 italic">Not captured</span>}
      </p>
    </div>
  );
}

function SectionReadView({ sectionKey, soap }: { sectionKey: SectionKey; soap: SOAPNote }) {
  switch (sectionKey) {
    case "S": {
      const s = soap.subjective;
      return (
        <div className="space-y-3">
          <ReadRow label="Chief Complaint" value={s.chiefComplaint} />
          <ReadRow label="History of Present Illness" value={s.hpi} />
          {s.pastMedicalHistory && <ReadRow label="Past Medical History" value={s.pastMedicalHistory} />}
          {s.medications?.length ? <ReadRow label="Medications" value={s.medications.join(", ")} /> : null}
          {s.allergies?.length ? <ReadRow label="Allergies" value={s.allergies.join(", ")} /> : null}
          {s.socialHistory && <ReadRow label="Social History" value={s.socialHistory} />}
          {s.familyHistory && <ReadRow label="Family History" value={s.familyHistory} />}
        </div>
      );
    }
    case "O": {
      const o = soap.objective;
      return (
        <div className="space-y-3">
          <ReadRow label="Vitals" value={o.vitals} />
          <ReadRow label="Examination Findings" value={o.examinationFindings} />
        </div>
      );
    }
    case "A": {
      const a = soap.assessment;
      return (
        <div className="space-y-3">
          <ReadRow label="Clinical Impression" value={a.impression} />
          {a.icd10Codes?.length ? (
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                ICD-10 Codes
              </p>
              <div className="space-y-1.5">
                {a.icd10Codes.map((code, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 bg-orange-50 border border-orange-100 rounded-lg px-3 py-2"
                  >
                    <span className="text-xs font-mono font-bold text-orange-700">{code.code}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-700">{code.description}</p>
                      {code.evidenceSpan && (
                        <p className="text-xs text-gray-400 italic mt-0.5">
                          &ldquo;{code.evidenceSpan}&rdquo;
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-orange-600">{Math.round(code.confidence * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      );
    }
    case "P": {
      const p = soap.plan;
      return (
        <div className="space-y-3">
          {p.medications?.length ? (
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                Medications
              </p>
              <div className="space-y-1.5">
                {p.medications.map((med, i) => (
                  <div key={i} className="bg-green-50 border border-green-100 rounded-lg px-3 py-2">
                    <p className="text-sm font-medium text-gray-800">{med.name}</p>
                    <p className="text-xs text-gray-600">
                      {med.dose} · {med.frequency} · {med.duration}
                    </p>
                    {med.notes && <p className="text-xs text-gray-400 mt-0.5">{med.notes}</p>}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {p.investigations?.length ? (
            <ReadRow label="Investigations" value={p.investigations.join(", ")} />
          ) : null}
          {p.procedures?.length ? (
            <ReadRow label="Procedures" value={p.procedures.join(", ")} />
          ) : null}
          {p.referrals?.length ? (
            <ReadRow label="Referrals" value={p.referrals.join(", ")} />
          ) : null}
          {p.followUpTimeline && <ReadRow label="Follow-up" value={p.followUpTimeline} />}
          {p.patientInstructions && (
            <ReadRow label="Patient Instructions" value={p.patientInstructions} />
          )}
        </div>
      );
    }
  }
}

// ─── Review Card ──────────────────────────────────────────

function ReviewCard({
  sectionKey,
  title,
  icon,
  soap,
  status,
  onAccept,
  onReject,
  onSaveEdit,
}: {
  sectionKey: SectionKey;
  title: string;
  icon: React.ReactNode;
  soap: SOAPNote;
  status: SectionStatus;
  onAccept: () => void;
  onReject: () => void;
  onSaveEdit: (text: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");

  const handleEditClick = () => {
    setDraftText(soapSectionToText(sectionKey, soap));
    setEditing(true);
  };

  const handleSave = () => {
    onSaveEdit(draftText);
    setEditing(false);
  };

  const borderColor =
    status === "accepted" ? "border-green-300" :
    status === "edited"   ? "border-blue-300"  :
    status === "rejected" ? "border-red-300"   :
    "border-gray-200";

  return (
    <div className={`border-2 rounded-xl overflow-hidden transition-colors ${borderColor}`}>
      {/* Header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors"
      >
        <span className="flex items-center gap-2 font-semibold text-sm text-gray-700">
          {icon} {title}
          <StatusBadge status={status} />
        </span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-gray-400" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-400" />
        )}
      </button>

      {open && (
        <div className="p-4 space-y-4">
          {/* Content */}
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                rows={8}
                className="w-full border border-blue-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-400">
                Edit freely. Keep label prefixes (e.g. &ldquo;Chief Complaint:&rdquo;) for accurate parsing.
              </p>
            </div>
          ) : (
            <SectionReadView sectionKey={sectionKey} soap={soap} />
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
            {editing ? (
              <>
                <button
                  onClick={handleSave}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700"
                >
                  <Save className="w-3.5 h-3.5" /> Save Edit
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs hover:bg-gray-50"
                >
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={onAccept}
                  disabled={status === "accepted"}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Check className="w-3.5 h-3.5" /> Accept
                </button>
                <button
                  onClick={handleEditClick}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-blue-300 text-blue-700 rounded-lg text-xs font-medium hover:bg-blue-50"
                >
                  <Edit3 className="w-3.5 h-3.5" /> Edit
                </button>
                <button
                  onClick={onReject}
                  disabled={status === "rejected"}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-red-300 text-red-600 rounded-lg text-xs font-medium hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Ban className="w-3.5 h-3.5" /> Reject
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Section component (live draft view) ─────────────────

function SOAPSection({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors"
      >
        <span className="flex items-center gap-2 font-semibold text-sm text-gray-700">
          {icon} {title}
        </span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-gray-400" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-400" />
        )}
      </button>
      {open && <div className="p-4">{children}</div>}
    </div>
  );
}

function EditableField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
        {!editing ? (
          <button
            onClick={() => { setDraft(value); setEditing(true); }}
            className="text-xs text-blue-500 hover:underline flex items-center gap-1"
          >
            <Edit3 className="w-3 h-3" /> Edit
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => { onChange(draft); setEditing(false); }}
              className="text-xs text-green-600 hover:underline flex items-center gap-1"
            >
              <Save className="w-3 h-3" /> Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-xs text-gray-400 hover:underline flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          className="w-full border border-blue-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      ) : (
        <p className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2 min-h-[2.5rem]">
          {value || <span className="text-gray-400 italic">Not captured</span>}
        </p>
      )}
    </div>
  );
}

// ─── Drug Alert Banner ───────────────────────────────────

const SEVERITY_CONFIG = {
  CONTRAINDICATED: {
    bg: "bg-red-50", border: "border-red-400", text: "text-red-800",
    badge: "bg-red-600 text-white", icon: AlertOctagon, label: "CONTRAINDICATED",
  },
  SEVERE: {
    bg: "bg-orange-50", border: "border-orange-400", text: "text-orange-800",
    badge: "bg-orange-500 text-white", icon: ShieldAlert, label: "SEVERE",
  },
  MODERATE: {
    bg: "bg-yellow-50", border: "border-yellow-400", text: "text-yellow-800",
    badge: "bg-yellow-500 text-white", icon: AlertTriangle, label: "MODERATE",
  },
  MILD: {
    bg: "bg-blue-50", border: "border-blue-300", text: "text-blue-800",
    badge: "bg-blue-400 text-white", icon: AlertTriangle, label: "MILD",
  },
};

function DrugAlertBanner({
  report,
  acknowledged,
  onAcknowledge,
}: {
  report: DrugSafetyReport;
  acknowledged: boolean;
  onAcknowledge: () => void;
}) {
  if (!report.alerts.length) return null;

  const sortOrder = { CONTRAINDICATED: 0, SEVERE: 1, MODERATE: 2, MILD: 3 };
  const sorted = [...report.alerts].sort(
    (a, b) => sortOrder[a.severity] - sortOrder[b.severity]
  );

  return (
    <div
      className={`rounded-xl border-2 p-4 space-y-3 ${
        report.hasContraindicated ? "border-red-400 bg-red-50" : "border-orange-300 bg-orange-50"
      }`}
    >
      <div className="flex items-center gap-2">
        <ShieldAlert
          className={`w-5 h-5 ${report.hasContraindicated ? "text-red-600" : "text-orange-500"}`}
        />
        <p
          className={`font-semibold text-sm ${
            report.hasContraindicated ? "text-red-800" : "text-orange-800"
          }`}
        >
          Drug Safety Alerts &mdash; {report.alerts.length}{" "}
          {report.alerts.length === 1 ? "issue" : "issues"} found
        </p>
        <span className="text-xs text-gray-400 ml-auto">
          Checked: {new Date(report.checkedAt).toLocaleTimeString()}
        </span>
      </div>

      <div className="space-y-2">
        {sorted.map((alert, i) => {
          const cfg = SEVERITY_CONFIG[alert.severity];
          const Icon = cfg.icon;
          return (
            <div key={i} className={`rounded-lg border p-3 ${cfg.bg} ${cfg.border}`}>
              <div className="flex items-start gap-2">
                <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${cfg.text}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${cfg.badge}`}>
                      {cfg.label}
                    </span>
                    <span className="text-xs font-medium text-gray-800">{alert.drug1}</span>
                    <span className="text-xs text-gray-500">+</span>
                    <span className="text-xs font-medium text-gray-800">{alert.drug2}</span>
                  </div>
                  <p className={`text-xs ${cfg.text}`}>{alert.description}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {report.hasContraindicated && !acknowledged && (
        <div className="border-t border-red-200 pt-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              onChange={(e) => e.target.checked && onAcknowledge()}
              className="mt-0.5 w-4 h-4 accent-red-600"
            />
            <span className="text-xs text-red-800 font-medium">
              I have reviewed the CONTRAINDICATED alert(s) above and accept clinical responsibility
              for prescribing despite this warning.
            </span>
          </label>
        </div>
      )}
      {report.hasContraindicated && acknowledged && (
        <p className="text-xs text-red-700 font-medium flex items-center gap-1">
          <CheckCircle className="w-3.5 h-3.5" /> Override acknowledged &mdash; you may now sign off.
        </p>
      )}
    </div>
  );
}

// ─── Simple inline diff (GAP-S6) ──────────────────────────
// Word-level longest-common-subsequence diff. Kept tiny and dep-free — this
// is a visual aid, not a merge tool, and the visit notes are short.

type DiffOp = { type: "same" | "del" | "ins"; text: string };

function computeWordDiff(a: string, b: string): DiffOp[] {
  const tokens = (s: string): string[] => (s ? s.match(/\S+|\s+/g) || [] : []);
  const A = tokens(a);
  const B = tokens(b);
  const m = A.length;
  const n = B.length;

  // Cap on LCS matrix size to protect the browser from pathologically long
  // notes. If exceeded we degrade to a trivial "delete all + insert all" diff.
  if (m * n > 40000) {
    const ops: DiffOp[] = [];
    if (a) ops.push({ type: "del", text: a });
    if (b) ops.push({ type: "ins", text: b });
    return ops;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = A[i - 1] === B[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const out: DiffOp[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) {
      out.push({ type: "same", text: A[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ type: "del", text: A[i - 1] });
      i--;
    } else {
      out.push({ type: "ins", text: B[j - 1] });
      j--;
    }
  }
  while (i > 0) { out.push({ type: "del", text: A[--i] }); }
  while (j > 0) { out.push({ type: "ins", text: B[--j] }); }
  return out.reverse();
}

function InlineDiff({ previous, current }: { previous: string; current: string }) {
  const ops = computeWordDiff(previous || "", current || "");
  return (
    <p className="text-xs leading-relaxed whitespace-pre-wrap">
      {ops.map((op, i) => {
        if (op.type === "same") return <span key={i}>{op.text}</span>;
        if (op.type === "del")
          return (
            <span
              key={i}
              className="bg-red-100 text-red-800 line-through px-0.5 rounded"
            >
              {op.text}
            </span>
          );
        return (
          <span
            key={i}
            className="bg-green-100 text-green-800 px-0.5 rounded"
          >
            {op.text}
          </span>
        );
      })}
    </p>
  );
}

/**
 * Flatten a SOAPNote into a single plain-text block so it can be diffed
 * against the previous consultation's free-text `notes` field.
 */
function soapToPlainText(soap: SOAPNote | null): string {
  if (!soap) return "";
  const parts: string[] = [];
  parts.push(soapSectionToText("S", soap));
  parts.push(soapSectionToText("O", soap));
  parts.push(soapSectionToText("A", soap));
  parts.push(soapSectionToText("P", soap));
  return parts.filter(Boolean).join("\n\n");
}

// ─── Constants ────────────────────────────────────────────

const INITIAL_SECTION_STATUS: SectionStatusMap = {
  S: "pending",
  O: "pending",
  A: "pending",
  P: "pending",
};

// ─── Main component ──────────────────────────────────────

export default function ScribePage() {
  const { token } = useAuthStore();
  // GAP-S14: tele-consult integration. When the doctor clicks "Start Ambient
  // Scribe" on the telemedicine page we jump here with ?appointmentId=... (or
  // ?patientId=...). Both params are optional; when present we auto-advance
  // to the consent modal for the matching appointment on load.
  const searchParams = useSearchParams();
  const urlAppointmentId = searchParams?.get("appointmentId") ?? null;
  const urlPatientId = searchParams?.get("patientId") ?? null;
  const [autoStartedFromUrl, setAutoStartedFromUrl] = useState(false);
  const [appointments, setAppointments] = useState<any[]>([]);
  // Issue #62: surface appointments-API failures with a banner + retry button
  // instead of the previous silent-degrade. `apptLoadError` carries the human
  // message; `apptRetryNonce` increments to re-trigger the fetch effect.
  const [apptLoadError, setApptLoadError] = useState<string | null>(null);
  const [apptRetryNonce, setApptRetryNonce] = useState(0);
  const [selectedAppointment, setSelectedAppointment] = useState<any>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [soapDraft, setSoapDraft] = useState<SOAPNote | null>(null);
  const [editedSOAP, setEditedSOAP] = useState<SOAPNote | null>(null);
  const [signedOff, setSignedOff] = useState(false);
  const [loading, setLoading] = useState(false);
  const [transcriptLength, setTranscriptLength] = useState(0);
  const [liveText, setLiveText] = useState("");
  const [rxSafetyReport, setRxSafetyReport] = useState<DrugSafetyReport | null>(null);
  const [alertsAcknowledged, setAlertsAcknowledged] = useState(false);
  const [consentTarget, setConsentTarget] = useState<any>(null);
  const [activeSpeaker, setActiveSpeaker] = useState<"DOCTOR" | "PATIENT">("DOCTOR");
  const [editLog, setEditLog] = useState<{ path: string; from: string; to: string }[]>([]);

  // ── Review mode state ─────────────────────────────────
  const [reviewMode, setReviewMode] = useState(false);
  const [sectionStatus, setSectionStatus] = useState<SectionStatusMap>({
    ...INITIAL_SECTION_STATUS,
  });
  const [reviewSoap, setReviewSoap] = useState<SOAPNote | null>(null);

  // GAP-S4: live transcript with speaker tags editable by the doctor.
  const [transcriptEntries, setTranscriptEntries] = useState<
    { speaker: "DOCTOR" | "PATIENT" | "ATTENDANT" | "UNKNOWN"; text: string; timestamp: string; confidence?: number }[]
  >([]);
  const [transcriptPanelOpen, setTranscriptPanelOpen] = useState(false);

  // GAP-S6: compare-to-previous-visit.
  const [compareOpen, setCompareOpen] = useState(false);
  const [previousConsultation, setPreviousConsultation] = useState<
    { id: string; notes: string | null; findings: string | null; createdAt: string; appointment?: any } | null
  >(null);
  const [previousLoading, setPreviousLoading] = useState(false);

  // ── Voice command state (review mode) ─────────────────
  const [voiceListening, setVoiceListening] = useState(false);
  const [lastVoiceCommand, setLastVoiceCommand] = useState("");
  const [voiceLegendOpen, setVoiceLegendOpen] = useState(false);
  const voiceCmdRecognitionRef = useRef<any>(null);

  const [useServerASR, setUseServerASR] = useState(false);
  // Acoustic diarization is currently disabled product-wide — the only
  // providers that supported it (AssemblyAI / Deepgram) were removed on
  // 2026-04-25 due to non-India data residency. The flag is kept as a
  // hardcoded `false` so the legacy fall-through paths (manual speaker
  // toggle) keep working; remove this and the related branches when an
  // India-region diarizing provider is added.
  const acousticDiarize = false;
  const [mediaRecorderSupported] = useState(
    () => typeof window !== "undefined" && typeof (window as any).MediaRecorder !== "undefined"
  );

  const recognitionRef = useRef<any>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const asrIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch today's appointments for this doctor.
  // Issue #62: previously we swallowed errors silently — when the appointments
  // API was down (502/timeout) the picker showed "No appointments today" and
  // the doctor had no way to know whether the queue was actually empty or the
  // backend was sick. We now surface failures via `apptLoadError` (rendered
  // as a banner with a Retry button) instead of degrading silently.
  useEffect(() => {
    const fetchAppts = async () => {
      try {
        const today = new Date().toISOString().split("T")[0];
        const res = await api.get<any>(
          `/appointments?date=${today}&status=CHECKED_IN,BOOKED`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const list = res.data.data?.appointments || [];
        setAppointments(list);
        setApptLoadError(null);

        // GAP-S14: if URL params point at a specific appointment/patient,
        // auto-open the consent modal so the doctor can start scribe with one
        // click from the tele-consult page. Only runs once per mount.
        if (!autoStartedFromUrl && !sessionId) {
          let target: any = null;
          if (urlAppointmentId) {
            target = list.find((a: any) => a.id === urlAppointmentId);
          } else if (urlPatientId) {
            target = list.find((a: any) => a.patientId === urlPatientId);
          }
          if (target) {
            setConsentTarget(target);
            setAutoStartedFromUrl(true);
          }
        }
      } catch (err: any) {
        // Issue #62: do NOT silently degrade — clear stale list and store the
        // error so the UI can render a banner with Retry.
        setAppointments([]);
        const msg =
          (err && typeof err.message === "string" && err.message) ||
          "Couldn't load today's appointments";
        setApptLoadError(msg);
      }
    };
    fetchAppts();
  }, [token, urlAppointmentId, urlPatientId, autoStartedFromUrl, sessionId, apptRetryNonce]);

  // Poll for SOAP updates while recording
  useEffect(() => {
    if (recording && sessionId) {
      pollRef.current = setInterval(async () => {
        try {
          const res = await api.get<any>(`/ai/scribe/${sessionId}/soap`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.data.data?.soapDraft) {
            setSoapDraft(res.data.data.soapDraft);
            setEditedSOAP(res.data.data.soapDraft);
          }
          if (res.data.data?.rxDraft?.alerts) {
            setRxSafetyReport(res.data.data.rxDraft);
            setAlertsAcknowledged(false);
          }
          // GAP-S4: keep transcript panel in sync with server-side edits
          // (reconnects, multi-tab usage).
          if (Array.isArray(res.data.data?.transcript)) {
            setTranscriptEntries(res.data.data.transcript);
          }
        } catch { /* silent */ }
      }, 15000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [recording, sessionId, token]);

  const startScribe = async (appointment: any) => {
    setLoading(true);
    try {
      const res = await api.post<any>(
        "/ai/scribe/start",
        { appointmentId: appointment.id, consentObtained: true, audioRetentionDays: 30 },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSessionId(res.data.data.sessionId);
      setSelectedAppointment(appointment);
      setEditLog([]);
      toast.success("Scribe session started");
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Failed to start scribe");
    } finally {
      setLoading(false);
    }
  };

  // Shared handler: push a final transcript string into the scribe session.
  // Accepts ATTENDANT as well so diarization-driven flushes can emit family
  // members' utterances without losing the acoustic label.
  const handleFinalTranscript = useCallback(
    async (text: string, speaker: "DOCTOR" | "PATIENT" | "ATTENDANT") => {
      if (!text.trim() || !sessionId) return;
      const newEntry = {
        speaker,
        text,
        timestamp: new Date().toISOString(),
        confidence: 0.9,
      };
      const entries = [newEntry];
      try {
        const res = await api.post<any>(
          `/ai/scribe/${sessionId}/transcript`,
          { entries },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        setTranscriptLength(res.data.data.transcriptLength);
        // GAP-S4: keep local transcript state in sync so the doctor can edit
        // speaker tags on entries we just sent.
        setTranscriptEntries((prev) => [...prev, newEntry]);
        if (res.data.data.soapDraft) {
          setSoapDraft(res.data.data.soapDraft);
          setEditedSOAP(res.data.data.soapDraft);
        }
        if (res.data.data.rxSafetyReport?.alerts) {
          setRxSafetyReport(res.data.data.rxSafetyReport);
          setAlertsAcknowledged(false);
        }
      } catch {
        /* silent */
      }
    },
    [sessionId, token]
  );

  // GAP-S4: update speaker on a single transcript entry.
  const updateEntrySpeaker = useCallback(
    async (
      index: number,
      speaker: "DOCTOR" | "PATIENT" | "ATTENDANT",
    ) => {
      if (!sessionId) return;
      // Optimistic update
      setTranscriptEntries((prev) => {
        const copy = [...prev];
        if (copy[index]) copy[index] = { ...copy[index], speaker };
        return copy;
      });
      try {
        await api.patch<any>(
          `/ai/scribe/${sessionId}/transcript/${index}/speaker`,
          { speaker },
          { headers: { Authorization: `Bearer ${token}` } },
        );
      } catch {
        toast.error("Failed to update speaker tag");
      }
    },
    [sessionId, token],
  );

  // GAP-S6: lazy-load previous consultation when toggle is flipped on.
  const fetchPreviousConsultation = useCallback(async () => {
    if (!sessionId) return;
    setPreviousLoading(true);
    try {
      const res = await api.get<any>(
        `/ai/scribe/${sessionId}/previous-consultation`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setPreviousConsultation(res.data.data?.previous ?? null);
    } catch {
      setPreviousConsultation(null);
    } finally {
      setPreviousLoading(false);
    }
  }, [sessionId, token]);

  // Flush accumulated audio chunks to the server ASR endpoint and push the
  // resulting transcript into the scribe session.
  //
  // GAP-ASR-DIARIZE: when acousticDiarize is on, the endpoint returns
  // `segments[]` with per-utterance speaker labels (DOCTOR | PATIENT |
  // ATTENDANT) from AssemblyAI. Each segment becomes its own transcript
  // entry so the doctor sees the acoustic split in the dropdown. When off
  // (or when the provider returns a single un-labeled segment), we fall
  // back to the legacy behaviour: emit one entry tagged with the `speaker`
  // the doctor currently has selected.
  const flushAudioChunks = useCallback(
    async (speaker: "DOCTOR" | "PATIENT") => {
      if (audioChunksRef.current.length === 0) return;
      const chunks = [...audioChunksRef.current];
      audioChunksRef.current = [];
      const blob = new Blob(chunks, { type: "audio/webm" });
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = btoa(
          String.fromCharCode(...new Uint8Array(arrayBuffer))
        );
        const res = await api.post<any>(
          "/ai/transcribe",
          {
            audioBase64: base64,
            language: "en-IN",
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = res.data.data ?? {};
        const segments: Array<{ text: string; speaker?: string }> = Array.isArray(
          data.segments,
        )
          ? data.segments
          : [];
        // Prefer per-segment emission when diarization actually labelled
        // speakers (more than just a single un-labeled entry).
        const hasAcousticLabels = segments.some(
          (s) => s.speaker === "DOCTOR" || s.speaker === "PATIENT" || s.speaker === "ATTENDANT",
        );
        if (acousticDiarize && hasAcousticLabels) {
          for (const seg of segments) {
            const segText = (seg.text ?? "").trim();
            if (!segText) continue;
            const segSpeaker: "DOCTOR" | "PATIENT" | "ATTENDANT" =
              seg.speaker === "PATIENT" || seg.speaker === "ATTENDANT"
                ? seg.speaker
                : "DOCTOR";
            await handleFinalTranscript(segText, segSpeaker);
          }
          return;
        }
        const transcript: string = data.transcript ?? "";
        if (transcript.trim()) {
          await handleFinalTranscript(transcript, speaker);
        }
      } catch {
        /* silent */
      }
    },
    [token, handleFinalTranscript, acousticDiarize]
  );

  const startServerASR = useCallback(
    async (speaker: "DOCTOR" | "PATIENT") => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        const recorder = new MediaRecorder(stream, { mimeType });
        audioChunksRef.current = [];

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };

        recorder.start(1000); // collect data every 1 s
        mediaRecorderRef.current = recorder;

        // Flush every 30 s
        asrIntervalRef.current = setInterval(() => {
          flushAudioChunks(speaker);
        }, 30_000);

        setRecording(true);
      } catch {
        toast.error("Microphone access denied");
      }
    },
    [flushAudioChunks]
  );

  const stopServerASR = useCallback(
    async (speaker: "DOCTOR" | "PATIENT") => {
      if (asrIntervalRef.current) {
        clearInterval(asrIntervalRef.current);
        asrIntervalRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        // Stop recorder; flush remaining chunks after it fully stops
        await new Promise<void>((resolve) => {
          mediaRecorderRef.current!.onstop = async () => {
            await flushAudioChunks(speaker);
            // Stop all tracks to release mic
            mediaRecorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
            resolve();
          };
          mediaRecorderRef.current!.stop();
        });
      }
      mediaRecorderRef.current = null;
      setRecording(false);
      setLiveText("");
    },
    [flushAudioChunks]
  );

  const startRecording = useCallback(() => {
    if (useServerASR) {
      // Stop any lingering browser recognition
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      startServerASR(activeSpeaker);
      return;
    }

    if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
      toast.error("Speech recognition not supported in this browser");
      return;
    }
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-IN";

    let finalBuffer: string[] = [];

    const flushBuffer = async (buffer: string[]) => {
      if (buffer.length === 0) return;
      for (const text of buffer) {
        await handleFinalTranscript(text, activeSpeaker);
      }
    };

    recognition.onresult = async (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalBuffer.push(transcript);
          if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
          if (finalBuffer.length >= 5) {
            const toFlush = [...finalBuffer];
            finalBuffer = [];
            await flushBuffer(toFlush);
          } else {
            flushTimerRef.current = setTimeout(async () => {
              if (finalBuffer.length > 0) {
                const toFlush = [...finalBuffer];
                finalBuffer = [];
                await flushBuffer(toFlush);
              }
            }, 20000);
          }
        } else {
          interim += transcript;
        }
      }
      setLiveText(interim);
    };

    recognition.onerror = () => setRecording(false);
    recognition.onend = () => setRecording(false);
    recognition.start();
    recognitionRef.current = recognition;
    setRecording(true);
  }, [sessionId, token, activeSpeaker, useServerASR, startServerASR, handleFinalTranscript]);

  const stopRecording = useCallback(() => {
    if (useServerASR) {
      stopServerASR(activeSpeaker);
      return;
    }
    recognitionRef.current?.stop();
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    setRecording(false);
    setLiveText("");
  }, [useServerASR, activeSpeaker, stopServerASR]);

  const updateSOAPField = (path: string[], value: string) => {
    setEditedSOAP((prev) => {
      if (!prev) return prev;
      let oldVal: any = prev;
      for (const key of path) oldVal = oldVal?.[key];
      if (oldVal !== value) {
        setEditLog((log) => [
          ...log,
          { path: path.join("."), from: String(oldVal ?? ""), to: value },
        ]);
      }
      const updated = { ...prev };
      let obj: any = updated;
      for (let i = 0; i < path.length - 1; i++) {
        obj[path[i]] = { ...(obj[path[i]] || {}) };
        obj = obj[path[i]];
      }
      obj[path[path.length - 1]] = value;
      return updated;
    });
  };

  // ── Enter review mode ─────────────────────────────────
  const handleEnterReview = () => {
    if (!editedSOAP) return;
    setReviewSoap(JSON.parse(JSON.stringify(editedSOAP)) as SOAPNote);
    setSectionStatus({ ...INITIAL_SECTION_STATUS });
    setReviewMode(true);
  };

  // ── Exit review mode (back to draft) ──────────────────
  const handleExitReview = () => {
    setReviewMode(false);
  };

  // ── Voice command recognition (review mode only) ──────
  useEffect(() => {
    const hasSpeechRecognition =
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

    if (!reviewMode) {
      // Stop any active voice recognition when leaving review mode
      if (voiceCmdRecognitionRef.current) {
        try { voiceCmdRecognitionRef.current.stop(); } catch { /* ignore */ }
        voiceCmdRecognitionRef.current = null;
      }
      setVoiceListening(false);
      return;
    }

    if (!hasSpeechRecognition) return;

    const SpeechRecognitionImpl =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-IN";

    recognition.onresult = (event: any) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        }
      }
      const cmd = transcript.toLowerCase().trim();
      if (!cmd) return;

      // Section-specific accept
      if (cmd.includes("accept subjective") || cmd.includes("approve subjective")) {
        setSectionStatus((p) => ({ ...p, S: "accepted" }));
        setLastVoiceCommand("accept subjective");
      } else if (cmd.includes("accept objective") || cmd.includes("approve objective")) {
        setSectionStatus((p) => ({ ...p, O: "accepted" }));
        setLastVoiceCommand("accept objective");
      } else if (cmd.includes("accept assessment") || cmd.includes("approve assessment")) {
        setSectionStatus((p) => ({ ...p, A: "accepted" }));
        setLastVoiceCommand("accept assessment");
      } else if (cmd.includes("accept plan") || cmd.includes("approve plan")) {
        setSectionStatus((p) => ({ ...p, P: "accepted" }));
        setLastVoiceCommand("accept plan");
      }
      // Section-specific reject
      else if (cmd.includes("reject subjective")) {
        setSectionStatus((p) => ({ ...p, S: "rejected" }));
        setLastVoiceCommand("reject subjective");
      } else if (cmd.includes("reject objective")) {
        setSectionStatus((p) => ({ ...p, O: "rejected" }));
        setLastVoiceCommand("reject objective");
      } else if (cmd.includes("reject assessment")) {
        setSectionStatus((p) => ({ ...p, A: "rejected" }));
        setLastVoiceCommand("reject assessment");
      } else if (cmd.includes("reject plan")) {
        setSectionStatus((p) => ({ ...p, P: "rejected" }));
        setLastVoiceCommand("reject plan");
      }
      // Accept all
      else if (cmd.includes("accept all") || cmd.includes("approve all")) {
        setSectionStatus({ S: "accepted", O: "accepted", A: "accepted", P: "accepted" });
        setLastVoiceCommand("accept all");
      }
      // Sign off / finalize / submit — use functional ref pattern to access latest canSignOff
      else if (
        cmd.includes("sign off") ||
        cmd.includes("finalize") ||
        cmd.includes("submit")
      ) {
        // canSignOff is derived state; we read it at trigger time via the closure
        setLastVoiceCommand("sign off");
        // Defer to next tick so setSectionStatus updates flush first
        setTimeout(() => {
          signOffTriggerRef.current?.();
        }, 0);
      }
      // Go back / cancel review
      else if (cmd.includes("go back") || cmd.includes("cancel review")) {
        setLastVoiceCommand("go back");
        handleExitReview();
      }
    };

    recognition.onerror = () => { /* silent */ };
    recognition.onend = () => {
      // Auto-restart so continuous mode survives browser timeouts
      if (voiceCmdRecognitionRef.current === recognition) {
        try { recognition.start(); } catch { /* ignore */ }
      }
    };

    recognition.start();
    voiceCmdRecognitionRef.current = recognition;
    setVoiceListening(true);

    return () => {
      try { recognition.stop(); } catch { /* ignore */ }
      voiceCmdRecognitionRef.current = null;
      setVoiceListening(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewMode]);

  // Stable ref so voice onresult can call handleSignOff without stale closure
  const signOffTriggerRef = useRef<(() => void) | null>(null);

  // ── Section status helpers ────────────────────────────
  const setStatus = (key: SectionKey, status: SectionStatus) => {
    setSectionStatus((prev) => ({ ...prev, [key]: status }));
  };

  const handleSectionEdit = (key: SectionKey, text: string) => {
    if (!reviewSoap) return;
    const oldText = soapSectionToText(key, reviewSoap);
    const updated = applyTextToSection(key, text, reviewSoap);
    setReviewSoap(updated);
    setEditLog((log) => [...log, { path: key, from: oldText, to: text }]);
    setStatus(key, "edited");
  };

  // ── Sign-off readiness ────────────────────────────────
  const hasRejected = Object.values(sectionStatus).some((s) => s === "rejected");
  const hasPending  = Object.values(sectionStatus).some((s) => s === "pending");
  const allResolved = !hasRejected && !hasPending;

  const signOffBlockedByDrug = !!(rxSafetyReport?.hasContraindicated && !alertsAcknowledged);
  const canSignOff = allResolved && !signOffBlockedByDrug;

  const signOffDisabledReason: string | null = signOffBlockedByDrug
    ? "Acknowledge the CONTRAINDICATED drug alert before signing."
    : hasRejected
    ? "Remove or re-record the rejected section(s) before signing."
    : hasPending
    ? "Accept or edit all 4 sections before signing."
    : null;

  // ── Final sign-off ────────────────────────────────────
  const handleSignOff = async () => {
    if (!sessionId || !reviewSoap) return;
    setLoading(true);
    try {
      await api.post<any>(
        `/ai/scribe/${sessionId}/finalize`,
        { soapFinal: reviewSoap, rxApproved: true, doctorEdits: editLog },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSignedOff(true);
      toast.success("SOAP note signed and saved to EHR");
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Failed to sign off");
    } finally {
      setLoading(false);
    }
  };

  // Keep signOffTriggerRef up to date so voice command can call it (must be after handleSignOff)
  signOffTriggerRef.current = canSignOff ? handleSignOff : null;

  const handleWithdrawConsent = async () => {
    if (!sessionId) return;
    try {
      await api.delete<any>(`/ai/scribe/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      stopRecording();
      setSessionId(null);
      setSoapDraft(null);
      setEditedSOAP(null);
      setReviewMode(false);
      setReviewSoap(null);
      toast.info("Consent withdrawn — transcript purged");
    } catch { /* silent */ }
  };

  // ── Signed off screen ────────────────────────────────
  if (signedOff) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="text-center space-y-3">
          <CheckCircle className="w-16 h-16 text-green-500 mx-auto" />
          <h2 className="text-xl font-bold text-gray-800">Note Signed &amp; Saved</h2>
          <p className="text-gray-500 text-sm">The SOAP note has been committed to the EHR.</p>
          <button
            onClick={() => {
              setSessionId(null);
              setSoapDraft(null);
              setEditedSOAP(null);
              setSignedOff(false);
              setSelectedAppointment(null);
              setReviewMode(false);
              setReviewSoap(null);
              setSectionStatus({ ...INITIAL_SECTION_STATUS });
            }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
          >
            Next patient
          </button>
        </div>
      </div>
    );
  }

  // ── Voice listener manual toggle ─────────────────────
  const toggleVoiceListener = () => {
    const hasSpeechRecognition =
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
    if (!hasSpeechRecognition) return;

    if (voiceListening) {
      // Stop
      if (voiceCmdRecognitionRef.current) {
        const r = voiceCmdRecognitionRef.current;
        // Null the ref first so onend handler does not auto-restart
        voiceCmdRecognitionRef.current = null;
        try { r.stop(); } catch { /* ignore */ }
      }
      setVoiceListening(false);
    } else {
      // Start fresh
      const SpeechRecognitionImpl =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const recognition = new SpeechRecognitionImpl();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = "en-IN";

      recognition.onresult = (event: any) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) transcript += event.results[i][0].transcript;
        }
        const cmd = transcript.toLowerCase().trim();
        if (!cmd) return;

        if (cmd.includes("accept subjective") || cmd.includes("approve subjective")) {
          setSectionStatus((p) => ({ ...p, S: "accepted" })); setLastVoiceCommand("accept subjective");
        } else if (cmd.includes("accept objective") || cmd.includes("approve objective")) {
          setSectionStatus((p) => ({ ...p, O: "accepted" })); setLastVoiceCommand("accept objective");
        } else if (cmd.includes("accept assessment") || cmd.includes("approve assessment")) {
          setSectionStatus((p) => ({ ...p, A: "accepted" })); setLastVoiceCommand("accept assessment");
        } else if (cmd.includes("accept plan") || cmd.includes("approve plan")) {
          setSectionStatus((p) => ({ ...p, P: "accepted" })); setLastVoiceCommand("accept plan");
        } else if (cmd.includes("reject subjective")) {
          setSectionStatus((p) => ({ ...p, S: "rejected" })); setLastVoiceCommand("reject subjective");
        } else if (cmd.includes("reject objective")) {
          setSectionStatus((p) => ({ ...p, O: "rejected" })); setLastVoiceCommand("reject objective");
        } else if (cmd.includes("reject assessment")) {
          setSectionStatus((p) => ({ ...p, A: "rejected" })); setLastVoiceCommand("reject assessment");
        } else if (cmd.includes("reject plan")) {
          setSectionStatus((p) => ({ ...p, P: "rejected" })); setLastVoiceCommand("reject plan");
        } else if (cmd.includes("accept all") || cmd.includes("approve all")) {
          setSectionStatus({ S: "accepted", O: "accepted", A: "accepted", P: "accepted" });
          setLastVoiceCommand("accept all");
        } else if (cmd.includes("sign off") || cmd.includes("finalize") || cmd.includes("submit")) {
          setLastVoiceCommand("sign off");
          setTimeout(() => { signOffTriggerRef.current?.(); }, 0);
        } else if (cmd.includes("go back") || cmd.includes("cancel review")) {
          setLastVoiceCommand("go back"); handleExitReview();
        }
      };

      recognition.onerror = () => { /* silent */ };
      recognition.onend = () => {
        if (voiceCmdRecognitionRef.current === recognition) {
          try { recognition.start(); } catch { /* ignore */ }
        }
      };

      recognition.start();
      voiceCmdRecognitionRef.current = recognition;
      setVoiceListening(true);
    }
  };

  // ── Review mode screen ───────────────────────────────
  if (reviewMode && reviewSoap) {
    const SECTIONS: { key: SectionKey; title: string; icon: React.ReactNode }[] = [
      { key: "S", title: "Subjective",  icon: <Activity className="w-4 h-4 text-blue-500" /> },
      { key: "O", title: "Objective",   icon: <FlaskConical className="w-4 h-4 text-purple-500" /> },
      { key: "A", title: "Assessment",  icon: <Clipboard className="w-4 h-4 text-orange-500" /> },
      { key: "P", title: "Plan",        icon: <Pill className="w-4 h-4 text-green-500" /> },
    ];

    return (
      <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
        {/* Review header */}
        <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-gray-200 shadow-sm flex-shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={handleExitReview}
              className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-blue-600 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Back to recording
            </button>
            <span className="text-gray-300">|</span>
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-600" />
              <p className="font-semibold text-sm text-gray-800">Section-by-Section Review</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {signOffDisabledReason && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 max-w-xs">
                {signOffDisabledReason}
              </p>
            )}
            <button
              onClick={handleSignOff}
              disabled={!canSignOff || loading}
              title={signOffDisabledReason ?? undefined}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle className="w-4 h-4" />
              )}
              Sign &amp; Save to EHR
            </button>
          </div>
        </div>

        {/* Voice command status bar */}
        <div className="flex items-center gap-3 px-6 py-2 bg-gray-50 border-b border-gray-100 flex-shrink-0">
          {voiceListening ? (
            <span className="flex items-center gap-1.5 text-green-600">
              <Mic className="w-3.5 h-3.5 animate-pulse" />
              <span className="text-xs font-medium">Listening</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-gray-400">
              <MicOff className="w-3.5 h-3.5" />
              <span className="text-xs">Voice off</span>
            </span>
          )}
          {lastVoiceCommand && (
            <span className="text-xs text-gray-400 italic">Last: {lastVoiceCommand}</span>
          )}
          <button
            onClick={toggleVoiceListener}
            className="ml-auto text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100 transition-colors"
          >
            {voiceListening ? "🎙 Voice Off" : "🎙 Voice On"}
          </button>
        </div>

        {/* Drug alert banner at top of review if drug alerts exist */}
        {rxSafetyReport && rxSafetyReport.alerts.length > 0 && (
          <div className="px-6 pt-4 flex-shrink-0">
            <DrugAlertBanner
              report={rxSafetyReport}
              acknowledged={alertsAcknowledged}
              onAcknowledge={() => setAlertsAcknowledged(true)}
            />
          </div>
        )}

        {/* GAP-S6: Compare to previous visit toggle + diff panel */}
        <div className="px-6 pt-4 flex-shrink-0">
          <div className="flex items-center gap-3 text-sm">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 accent-blue-600"
                checked={compareOpen}
                onChange={(e) => {
                  const next = e.target.checked;
                  setCompareOpen(next);
                  if (next && !previousConsultation && !previousLoading) {
                    fetchPreviousConsultation();
                  }
                }}
              />
              <span className="font-medium text-gray-700">Compare to previous visit</span>
            </label>
            {previousLoading && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />
            )}
          </div>
          {compareOpen && (
            <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
              <div className="px-4 py-2 border-b border-gray-200 bg-white">
                <p className="text-xs font-semibold text-gray-700">
                  Side-by-side: previous consultation vs current AI draft
                </p>
                {previousConsultation?.createdAt && (
                  <p className="text-xs text-gray-500">
                    Previous visit: {new Date(previousConsultation.createdAt).toLocaleDateString()}
                  </p>
                )}
              </div>
              {previousLoading ? (
                <div className="p-4 text-xs text-gray-500">Loading previous consultation…</div>
              ) : !previousConsultation ? (
                <div className="p-4 text-xs text-gray-500 italic">
                  No prior completed consultation found for this patient.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-x divide-gray-200">
                  <div className="p-4 space-y-1 min-h-[120px]">
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                      Previous visit notes
                    </p>
                    <pre className="text-xs whitespace-pre-wrap font-sans text-gray-700">
                      {previousConsultation.notes || <span className="italic text-gray-400">No notes saved.</span>}
                    </pre>
                  </div>
                  <div className="p-4 space-y-1 min-h-[120px]">
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                      Current draft — diff vs previous (red = removed, green = added)
                    </p>
                    <InlineDiff
                      previous={previousConsultation.notes || ""}
                      current={soapToPlainText(reviewSoap)}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 4 review cards */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {SECTIONS.map(({ key, title, icon }) => (
            <ReviewCard
              key={key}
              sectionKey={key}
              title={title}
              icon={icon}
              soap={reviewSoap}
              status={sectionStatus[key]}
              onAccept={() => setStatus(key, "accepted")}
              onReject={() => setStatus(key, "rejected")}
              onSaveEdit={(text) => handleSectionEdit(key, text)}
            />
          ))}

          <p className="text-xs text-center text-gray-400 pb-2">
            Accept or edit each section. Rejected sections will block sign-off. Nothing is saved
            until you click &quot;Sign &amp; Save to EHR&quot;.
          </p>

          {/* Collapsible voice commands legend */}
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <button
              onClick={() => setVoiceLegendOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors"
            >
              <span className="flex items-center gap-2 text-xs font-medium text-gray-600">
                <Mic className="w-3.5 h-3.5 text-gray-400" /> Voice commands
              </span>
              {voiceLegendOpen ? (
                <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
              )}
            </button>
            {voiceLegendOpen && (
              <div className="px-4 py-3">
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                  {([
                    ["accept subjective", "Accept Subjective (S)"],
                    ["reject subjective", "Reject Subjective (S)"],
                    ["accept objective", "Accept Objective (O)"],
                    ["reject objective", "Reject Objective (O)"],
                    ["accept assessment", "Accept Assessment (A)"],
                    ["reject assessment", "Reject Assessment (A)"],
                    ["accept plan", "Accept Plan (P)"],
                    ["reject plan", "Reject Plan (P)"],
                    ["accept all", "Accept all sections"],
                    ["sign off", "Sign & Save to EHR"],
                    ["approve all", "Accept all sections"],
                    ["go back", "Exit review mode"],
                  ] as [string, string][]).map(([cmd, desc]) => (
                    <div key={cmd} className="flex items-baseline gap-2">
                      <code className="text-xs bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded font-mono whitespace-nowrap">
                        &ldquo;{cmd}&rdquo;
                      </code>
                      <span className="text-xs text-gray-500 truncate">{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Main recording / draft view ──────────────────────
  return (
    <>
      {consentTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-6 h-6 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-gray-800">Patient Consent Required</h3>
                <p className="text-sm text-gray-500 mt-1">
                  This session will transcribe the consultation using AI. The patient must give
                  explicit consent before recording begins.
                </p>
              </div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
              Patient:{" "}
              <span className="font-semibold">{consentTarget.patient?.user?.name}</span>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { startScribe(consentTarget); setConsentTarget(null); }}
                className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700"
              >
                Patient Has Consented
              </button>
              <button
                onClick={() => setConsentTarget(null)}
                className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="flex h-[calc(100vh-4rem)] gap-4 p-4 overflow-hidden">
        {/* ── Left: appointment picker + controls ────────── */}
        <div className="w-72 flex flex-col gap-3">
          {/* Appointment selector */}
          <div className="bg-white rounded-2xl shadow border border-gray-100 p-4">
            <p className="font-semibold text-sm text-gray-700 mb-3 flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-blue-600" /> Today&apos;s Patients
            </p>
            {/* Issue #62: visible error banner + Retry when the appointments
                API fails. data-testid hooks are present so browser-automation
                tests can target the banner and the retry button without
                relying on text content. */}
            {apptLoadError && (
              <div
                data-testid="scribe-appts-error-banner"
                className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
                role="alert"
              >
                <p className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    Couldn&apos;t load today&apos;s appointments. {apptLoadError}
                  </span>
                </p>
                <button
                  type="button"
                  data-testid="scribe-appts-retry"
                  onClick={() => {
                    setApptLoadError(null);
                    setApptRetryNonce((n) => n + 1);
                  }}
                  className="mt-2 w-full rounded-lg border border-red-300 bg-white px-2 py-1 font-medium text-red-700 hover:bg-red-100"
                >
                  Retry
                </button>
              </div>
            )}
            {appointments.length === 0 && !apptLoadError ? (
              <p className="text-xs text-gray-400 text-center py-4">No appointments today</p>
            ) : appointments.length === 0 ? null : (
              <div className="space-y-1.5">
                {appointments.map((appt) => (
                  <button
                    key={appt.id}
                    onClick={() => !sessionId && setConsentTarget(appt)}
                    disabled={!!sessionId || loading}
                    className={`w-full text-left px-3 py-2 rounded-xl border text-sm transition-all ${
                      selectedAppointment?.id === appt.id
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:border-blue-200 disabled:opacity-50"
                    }`}
                  >
                    <p className="font-medium text-gray-800 truncate">
                      {appt.patient?.user?.name}
                    </p>
                    <p className="text-xs text-gray-500">
                      Token #{appt.tokenNumber} · {appt.slotStart || "Walk-in"}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Scribe controls */}
          {sessionId && (
            <div className="bg-white rounded-2xl shadow border border-gray-100 p-4 space-y-3">
              <p className="font-semibold text-sm text-gray-700 flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-600" /> Scribe Active
              </p>
              <div className="text-xs text-gray-500 space-y-1">
                <p>
                  Patient:{" "}
                  <span className="font-medium text-gray-700">
                    {selectedAppointment?.patient?.user?.name}
                  </span>
                </p>
                <p>
                  Transcript:{" "}
                  <span className="font-medium text-gray-700">{transcriptLength} entries</span>
                </p>
              </div>

              {liveText && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 text-xs text-gray-600 italic">
                  {liveText}
                </div>
              )}

              <div className="space-y-1">
                <p className="text-xs font-medium text-gray-500">Active Speaker</p>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setActiveSpeaker("DOCTOR")}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      activeSpeaker === "DOCTOR"
                        ? "bg-blue-600 text-white"
                        : "border border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    Doctor
                  </button>
                  <button
                    onClick={() => setActiveSpeaker("PATIENT")}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      activeSpeaker === "PATIENT"
                        ? "bg-emerald-600 text-white"
                        : "border border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    Patient
                  </button>
                </div>
              </div>

              {mediaRecorderSupported && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-500">ASR Engine</p>
                  <div className="flex gap-1.5">
                    <button
                      disabled={recording}
                      onClick={() => setUseServerASR(false)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        !useServerASR
                          ? "bg-blue-600 text-white"
                          : "border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                      }`}
                    >
                      Browser STT
                    </button>
                    <button
                      disabled={recording}
                      onClick={() => setUseServerASR(true)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        useServerASR
                          ? "bg-indigo-600 text-white"
                          : "border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                      }`}
                    >
                      Sarvam ASR
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={recording ? stopRecording : startRecording}
                className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-medium text-sm transition-all ${
                  recording
                    ? "bg-red-500 hover:bg-red-600 text-white"
                    : "bg-emerald-500 hover:bg-emerald-600 text-white"
                }`}
              >
                {recording ? (
                  <><MicOff className="w-4 h-4" /> Stop Recording</>
                ) : (
                  <><Mic className="w-4 h-4" /> Start Recording</>
                )}
              </button>

              <button
                onClick={handleWithdrawConsent}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border border-red-200 text-red-600 text-sm hover:bg-red-50"
              >
                <X className="w-4 h-4" /> Withdraw Consent
              </button>
            </div>
          )}

          {/* GAP-S4: Transcript with per-entry speaker dropdowns. */}
          {sessionId && transcriptEntries.length > 0 && (
            <div className="bg-white rounded-2xl shadow border border-gray-100 overflow-hidden flex-1 min-h-0 flex flex-col">
              <button
                onClick={() => setTranscriptPanelOpen((o) => !o)}
                className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors flex-shrink-0"
              >
                <span className="flex items-center gap-2 text-xs font-semibold text-gray-700">
                  <FileText className="w-3.5 h-3.5 text-gray-500" />
                  Transcript · {transcriptEntries.length}
                </span>
                {transcriptPanelOpen ? (
                  <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                )}
              </button>
              {transcriptPanelOpen && (
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {transcriptEntries.map((entry, i) => {
                    const speakerClass =
                      entry.speaker === "DOCTOR"
                        ? "bg-blue-50 border-blue-200"
                        : entry.speaker === "PATIENT"
                        ? "bg-emerald-50 border-emerald-200"
                        : entry.speaker === "ATTENDANT"
                        ? "bg-purple-50 border-purple-200"
                        : "bg-gray-50 border-gray-200";
                    return (
                      <div
                        key={i}
                        className={`rounded-lg border px-2.5 py-2 text-xs ${speakerClass}`}
                      >
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <select
                            value={
                              entry.speaker === "UNKNOWN" ? "DOCTOR" : entry.speaker
                            }
                            onChange={(e) =>
                              updateEntrySpeaker(
                                i,
                                e.target.value as "DOCTOR" | "PATIENT" | "ATTENDANT",
                              )
                            }
                            className="text-[10px] font-semibold border border-gray-200 rounded px-1 py-0.5 bg-white"
                            aria-label={`Speaker for entry ${i + 1}`}
                          >
                            <option value="DOCTOR">DOCTOR</option>
                            <option value="PATIENT">PATIENT</option>
                            <option value="ATTENDANT">ATTENDANT</option>
                          </select>
                          <span className="text-[10px] text-gray-400">
                            #{i + 1}
                          </span>
                        </div>
                        <p className="text-gray-700 break-words">{entry.text}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right: SOAP draft ──────────────────────────── */}
        <div className="flex-1 flex flex-col bg-white rounded-2xl shadow border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-600" />
              <p className="font-semibold text-sm text-gray-800">AI-Drafted SOAP Note</p>
              {soapDraft && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                  Auto-updating
                </span>
              )}
            </div>
            {editedSOAP && !signedOff && (
              <button
                onClick={handleEnterReview}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <CheckCircle className="w-4 h-4" />
                Review &amp; Sign Off
              </button>
            )}
          </div>

          {!sessionId ? (
            <div className="flex-1 flex items-center justify-center text-gray-400">
              <div className="text-center space-y-2">
                <Clipboard className="w-12 h-12 mx-auto opacity-30" />
                <p className="text-sm">
                  Select a patient and start the scribe to generate a SOAP note
                </p>
              </div>
            </div>
          ) : !editedSOAP ? (
            <div className="flex-1 flex items-center justify-center text-gray-400">
              <div className="text-center space-y-2">
                <Loader2 className="w-8 h-8 mx-auto animate-spin text-blue-400" />
                <p className="text-sm">
                  Listening&hellip; SOAP draft will appear after a few exchanges
                </p>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {/* Subjective */}
              <SOAPSection
                title="Subjective"
                icon={<Activity className="w-4 h-4 text-blue-500" />}
              >
                <div className="space-y-3">
                  <EditableField
                    label="Chief Complaint"
                    value={editedSOAP?.subjective?.chiefComplaint || ""}
                    onChange={(v) => updateSOAPField(["subjective", "chiefComplaint"], v)}
                  />
                  <EditableField
                    label="History of Present Illness"
                    value={editedSOAP?.subjective?.hpi || ""}
                    onChange={(v) => updateSOAPField(["subjective", "hpi"], v)}
                  />
                  <EditableField
                    label="Past Medical History"
                    value={editedSOAP?.subjective?.pastMedicalHistory || ""}
                    onChange={(v) => updateSOAPField(["subjective", "pastMedicalHistory"], v)}
                  />
                </div>
              </SOAPSection>

              {/* Objective */}
              <SOAPSection
                title="Objective"
                icon={<FlaskConical className="w-4 h-4 text-purple-500" />}
              >
                <div className="space-y-3">
                  <EditableField
                    label="Vitals"
                    value={editedSOAP?.objective?.vitals || ""}
                    onChange={(v) => updateSOAPField(["objective", "vitals"], v)}
                  />
                  <EditableField
                    label="Examination Findings"
                    value={editedSOAP?.objective?.examinationFindings || ""}
                    onChange={(v) => updateSOAPField(["objective", "examinationFindings"], v)}
                  />
                </div>
              </SOAPSection>

              {/* Assessment */}
              <SOAPSection
                title="Assessment"
                icon={<Clipboard className="w-4 h-4 text-orange-500" />}
              >
                <div className="space-y-3">
                  <EditableField
                    label="Clinical Impression / Diagnosis"
                    value={editedSOAP?.assessment?.impression || ""}
                    onChange={(v) => updateSOAPField(["assessment", "impression"], v)}
                  />
                  {editedSOAP?.assessment?.icd10Codes &&
                    editedSOAP.assessment.icd10Codes.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                          Suggested ICD-10 Codes
                        </p>
                        <div className="space-y-1.5">
                          {editedSOAP.assessment.icd10Codes.map((code, i) => (
                            <div
                              key={i}
                              className="flex items-start gap-2 bg-orange-50 border border-orange-100 rounded-lg px-3 py-2"
                            >
                              <span className="text-xs font-mono font-bold text-orange-700">
                                {code.code}
                              </span>
                              <div className="flex-1">
                                <p className="text-xs text-gray-700">{code.description}</p>
                                {code.evidenceSpan && (
                                  <p className="text-xs text-gray-400 italic mt-0.5">
                                    &ldquo;{code.evidenceSpan}&rdquo;
                                  </p>
                                )}
                              </div>
                              <span className="text-xs text-orange-600">
                                {Math.round(code.confidence * 100)}%
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
              </SOAPSection>

              {/* Plan */}
              <SOAPSection title="Plan" icon={<Pill className="w-4 h-4 text-green-500" />}>
                <div className="space-y-3">
                  {rxSafetyReport && (
                    <DrugAlertBanner
                      report={rxSafetyReport}
                      acknowledged={alertsAcknowledged}
                      onAcknowledge={() => setAlertsAcknowledged(true)}
                    />
                  )}
                  {editedSOAP?.plan?.medications &&
                    editedSOAP.plan.medications.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                          Medications
                        </p>
                        <div className="space-y-1.5">
                          {editedSOAP.plan.medications.map((med, i) => (
                            <div
                              key={i}
                              className="bg-green-50 border border-green-100 rounded-lg px-3 py-2"
                            >
                              <p className="text-sm font-medium text-gray-800">{med.name}</p>
                              <p className="text-xs text-gray-600">
                                {med.dose} · {med.frequency} · {med.duration}
                              </p>
                              {med.notes && (
                                <p className="text-xs text-gray-400 mt-0.5">{med.notes}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  <EditableField
                    label="Investigations Ordered"
                    value={editedSOAP?.plan?.investigations?.join(", ") || ""}
                    onChange={(v) => updateSOAPField(["plan", "investigations"], v)}
                  />
                  <EditableField
                    label="Follow-up"
                    value={editedSOAP?.plan?.followUpTimeline || ""}
                    onChange={(v) => updateSOAPField(["plan", "followUpTimeline"], v)}
                  />
                  <EditableField
                    label="Patient Instructions"
                    value={editedSOAP?.plan?.patientInstructions || ""}
                    onChange={(v) => updateSOAPField(["plan", "patientInstructions"], v)}
                  />
                </div>
              </SOAPSection>

              <p className="text-xs text-center text-gray-400 pb-2">
                AI-generated draft &mdash; review all sections before signing. Click &quot;Review
                &amp; Sign Off&quot; when ready.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
