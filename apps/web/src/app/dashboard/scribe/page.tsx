"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { SOAPNote } from "@medcore/shared";
// PRD §4.5.6 — voice commands for the review screen. The parser is a pure
// function so it can be unit-tested independent of the Web Speech API and
// the page component (see ./voice-commands.ts and __tests__/voice-commands.test.tsx).
import { parseVoiceCommand, type VoiceAction } from "./voice-commands";
// Pearl ERP Stage 1 §2.1.3 (gap row 46) — right rail with derived
// favourites + last 3 visits, click-to-paste into the active SOAP draft.
import { ConsultRightRail, VisitDetail, type Visit } from "@/components/ConsultRightRail";
import { SkeletonText } from "@/components/Skeleton";
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
  pending:  { label: "Pending",  cls: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300" },
  accepted: { label: "Accepted", cls: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  edited:   { label: "Edited",   cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  rejected: { label: "Rejected", cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" },
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
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide dark:text-gray-400">{label}</p>
      <p className="text-sm text-gray-800 bg-gray-50 rounded-lg px-3 py-2 min-h-[2rem] dark:bg-gray-900/40 dark:text-gray-100">
        {value || <span className="text-gray-400 italic dark:text-gray-500">Not captured</span>}
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
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 dark:text-gray-400">
                ICD-10 Codes
              </p>
              <div className="space-y-1.5">
                {a.icd10Codes.map((code, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 bg-orange-50 border border-orange-100 rounded-lg px-3 py-2 dark:bg-orange-900/20 dark:border-orange-800"
                  >
                    <span className="text-xs font-mono font-bold text-orange-700 dark:text-orange-300">{code.code}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-700 dark:text-gray-200">{code.description}</p>
                      {code.evidenceSpan && (
                        <p className="text-xs text-gray-400 italic mt-0.5 dark:text-gray-400">
                          &ldquo;{code.evidenceSpan}&rdquo;
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-orange-600 dark:text-orange-300">{Math.round(code.confidence * 100)}%</span>
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
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 dark:text-gray-400">
                Medications
              </p>
              <div className="space-y-1.5">
                {p.medications.map((med, i) => (
                  <div key={i} className="bg-green-50 border border-green-100 rounded-lg px-3 py-2 dark:bg-green-900/20 dark:border-green-800">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{med.name}</p>
                    <p className="text-xs text-gray-600 dark:text-gray-300">
                      {med.dose} · {med.frequency} · {med.duration}
                    </p>
                    {med.notes && <p className="text-xs text-gray-400 mt-0.5 dark:text-gray-400">{med.notes}</p>}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {p.investigations?.length ? (
            <ReadRow label="Investigations" value={Array.isArray(p.investigations) ? p.investigations.join(", ") : p.investigations} />
          ) : null}
          {p.procedures?.length ? (
            <ReadRow label="Procedures" value={Array.isArray(p.procedures) ? p.procedures.join(", ") : p.procedures} />
          ) : null}
          {p.referrals?.length ? (
            <ReadRow label="Referrals" value={Array.isArray(p.referrals) ? p.referrals.join(", ") : p.referrals} />
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

// ─── Section edit helpers ─────────────────────────────────

function initDraftFields(section: SectionKey, soap: SOAPNote): Record<string, string> {
  switch (section) {
    case "S": {
      const s = soap.subjective;
      return {
        chiefComplaint: s.chiefComplaint ?? "",
        hpi: s.hpi ?? "",
        pastMedicalHistory: s.pastMedicalHistory ?? "",
        medications: Array.isArray(s.medications) ? s.medications.join(", ") : (s.medications ?? ""),
        allergies: Array.isArray(s.allergies) ? s.allergies.join(", ") : (s.allergies ?? ""),
        socialHistory: s.socialHistory ?? "",
        familyHistory: s.familyHistory ?? "",
      };
    }
    case "O": {
      const o = soap.objective;
      return { vitals: o.vitals ?? "", examinationFindings: o.examinationFindings ?? "" };
    }
    case "A":
      return { impression: soap.assessment.impression ?? "" };
    case "P": {
      const p = soap.plan;
      return {
        investigations: Array.isArray(p.investigations) ? p.investigations.join(", ") : (p.investigations ?? ""),
        procedures: Array.isArray(p.procedures) ? p.procedures.join(", ") : (p.procedures ?? ""),
        referrals: Array.isArray(p.referrals) ? p.referrals.join(", ") : (p.referrals ?? ""),
        followUpTimeline: p.followUpTimeline ?? "",
        patientInstructions: p.patientInstructions ?? "",
      };
    }
  }
}

function draftFieldsToText(section: SectionKey, fields: Record<string, string>): string {
  const lines: string[] = [];
  switch (section) {
    case "S":
      if (fields.chiefComplaint) lines.push(`Chief Complaint: ${fields.chiefComplaint}`);
      if (fields.hpi) lines.push(`HPI: ${fields.hpi}`);
      if (fields.pastMedicalHistory) lines.push(`Past Medical History: ${fields.pastMedicalHistory}`);
      if (fields.medications) lines.push(`Medications: ${fields.medications}`);
      if (fields.allergies) lines.push(`Allergies: ${fields.allergies}`);
      if (fields.socialHistory) lines.push(`Social History: ${fields.socialHistory}`);
      if (fields.familyHistory) lines.push(`Family History: ${fields.familyHistory}`);
      break;
    case "O":
      if (fields.vitals) lines.push(`Vitals: ${fields.vitals}`);
      if (fields.examinationFindings) lines.push(`Examination Findings: ${fields.examinationFindings}`);
      break;
    case "A":
      if (fields.impression) lines.push(`Impression: ${fields.impression}`);
      break;
    case "P":
      if (fields.investigations) lines.push(`Investigations: ${fields.investigations}`);
      if (fields.procedures) lines.push(`Procedures: ${fields.procedures}`);
      if (fields.referrals) lines.push(`Referrals: ${fields.referrals}`);
      if (fields.followUpTimeline) lines.push(`Follow-up: ${fields.followUpTimeline}`);
      if (fields.patientInstructions) lines.push(`Instructions: ${fields.patientInstructions}`);
      break;
  }
  return lines.join("\n");
}

function EditField({ label, value, onChange, multiline = false }: {
  label: string; value: string; onChange: (v: string) => void; multiline?: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide dark:text-gray-400">{label}</p>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="w-full border border-blue-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none dark:border-blue-700 dark:bg-gray-900 dark:text-gray-100"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-blue-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-blue-700 dark:bg-gray-900 dark:text-gray-100"
        />
      )}
    </div>
  );
}

function SectionEditFields({ sectionKey, fields, onChange }: {
  sectionKey: SectionKey; fields: Record<string, string>; onChange: (key: string, value: string) => void;
}) {
  const f = (key: string) => fields[key] ?? "";
  const set = (key: string) => (v: string) => onChange(key, v);
  switch (sectionKey) {
    case "S":
      return (
        <div className="space-y-3">
          <EditField label="Chief Complaint" value={f("chiefComplaint")} onChange={set("chiefComplaint")} />
          <EditField label="History of Present Illness" value={f("hpi")} onChange={set("hpi")} multiline />
          <EditField label="Past Medical History" value={f("pastMedicalHistory")} onChange={set("pastMedicalHistory")} multiline />
          <EditField label="Medications (comma-separated)" value={f("medications")} onChange={set("medications")} />
          <EditField label="Allergies (comma-separated)" value={f("allergies")} onChange={set("allergies")} />
          <EditField label="Social History" value={f("socialHistory")} onChange={set("socialHistory")} multiline />
          <EditField label="Family History" value={f("familyHistory")} onChange={set("familyHistory")} multiline />
        </div>
      );
    case "O":
      return (
        <div className="space-y-3">
          <EditField label="Vitals" value={f("vitals")} onChange={set("vitals")} multiline />
          <EditField label="Examination Findings" value={f("examinationFindings")} onChange={set("examinationFindings")} multiline />
        </div>
      );
    case "A":
      return (
        <div className="space-y-3">
          <EditField label="Clinical Impression" value={f("impression")} onChange={set("impression")} multiline />
        </div>
      );
    case "P":
      return (
        <div className="space-y-3">
          <EditField label="Investigations (comma-separated)" value={f("investigations")} onChange={set("investigations")} />
          <EditField label="Procedures (comma-separated)" value={f("procedures")} onChange={set("procedures")} />
          <EditField label="Referrals (comma-separated)" value={f("referrals")} onChange={set("referrals")} />
          <EditField label="Follow-up" value={f("followUpTimeline")} onChange={set("followUpTimeline")} />
          <EditField label="Patient Instructions" value={f("patientInstructions")} onChange={set("patientInstructions")} multiline />
        </div>
      );
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
  const [draftFields, setDraftFields] = useState<Record<string, string>>({});

  const handleEditClick = () => {
    setDraftFields(initDraftFields(sectionKey, soap));
    setEditing(true);
  };

  const handleSave = () => {
    onSaveEdit(draftFieldsToText(sectionKey, draftFields));
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
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors dark:bg-gray-900/50 dark:hover:bg-gray-700"
      >
        <span className="flex items-center gap-2 font-semibold text-sm text-gray-700 dark:text-gray-200">
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
            <SectionEditFields
              sectionKey={sectionKey}
              fields={draftFields}
              onChange={(key, value) => setDraftFields((prev) => ({ ...prev, [key]: value }))}
            />
          ) : (
            <SectionReadView sectionKey={sectionKey} soap={soap} />
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-1 border-t border-gray-100 dark:border-gray-700">
            {editing ? (
              <>
                <button
                  onClick={handleSave}
                  className="touch-target flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700"
                >
                  <Save className="w-3.5 h-3.5" /> Save Edit
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="touch-target flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={onAccept}
                  disabled={status === "accepted"}
                  className="touch-target flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Check className="w-3.5 h-3.5" /> Accept
                </button>
                <button
                  onClick={handleEditClick}
                  className="touch-target flex items-center gap-1.5 px-3 py-1.5 border border-blue-300 text-blue-700 rounded-lg text-xs font-medium hover:bg-blue-50"
                >
                  <Edit3 className="w-3.5 h-3.5" /> Edit
                </button>
                <button
                  onClick={onReject}
                  disabled={status === "rejected"}
                  className="touch-target flex items-center gap-1.5 px-3 py-1.5 border border-red-300 text-red-600 rounded-lg text-xs font-medium hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
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
    <div className="border border-gray-200 rounded-xl overflow-hidden dark:border-gray-700">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors dark:bg-gray-900/50 dark:hover:bg-gray-700"
      >
        <span className="flex items-center gap-2 font-semibold text-sm text-gray-700 dark:text-gray-200">
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
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide dark:text-gray-400">{label}</p>
        {!readOnly && !editing ? (
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
          className="w-full border border-blue-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-blue-700 dark:bg-gray-900 dark:text-gray-100"
        />
      ) : (
        <p className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2 min-h-[2.5rem] dark:bg-gray-900/50 dark:text-gray-200">
          {value || <span className="text-gray-400 italic dark:text-gray-500">Not captured</span>}
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
                    <span className="text-xs text-gray-500 dark:text-gray-400">+</span>
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
              className="bg-red-100 text-red-800 line-through px-0.5 rounded dark:bg-red-900/40 dark:text-red-300"
            >
              {op.text}
            </span>
          );
        return (
          <span
            key={i}
            className="bg-green-100 text-green-800 px-0.5 rounded dark:bg-green-900/40 dark:text-green-300"
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

// Human-readable labels keyed by SectionKey, used by voice-command toasts and
// the per-section notes panel rendered inside each ReviewCard.
const SECTION_LABELS: Record<SectionKey, string> = {
  S: "Subjective",
  O: "Objective",
  A: "Assessment",
  P: "Plan",
};

// Issue #509: page-level gate matching API authorize() in
// apps/api/src/routes/ai-scribe.ts (DOCTOR, ADMIN). Page previously had no
// gate, so PATIENT / NURSE / RECEPTION could see the AI Scribe SOAP-note
// chrome via the URL bar.
const VIEW_ALLOWED = new Set(["ADMIN", "DOCTOR"]);

// ─── Main component ──────────────────────────────────────

export default function ScribePage() {
  const { token, user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  // Issue #509: redirect non-allowed roles to /dashboard/not-authorized.
  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error("AI Scribe is restricted to doctors and administrators.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/scribe")}`,
      );
    }
  }, [user, isLoading, router, pathname]);
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
  // Live refs so the long-lived recording handlers can recover a dead session
  // (start a fresh one for the current appointment) without stale closures.
  const selectedAppointmentRef = useRef<any>(null);
  selectedAppointmentRef.current = selectedAppointment;
  const startScribeRef = useRef<
    ((appt: any, opts?: { silent?: boolean }) => Promise<void>) | null
  >(null);
  // Guards the once-per-mount auto-resume of an active session after a page
  // refresh (sessionId lives only in React state, so a reload would otherwise
  // drop back to the picker and lose the live transcript/draft).
  const scribeResumeAttempted = useRef(false);
  // PRD §4.5.5: surface the patient's preferred language so the doctor can see
  // what the post-visit summary will be sent in BEFORE they sign off.
  const [patientPreferredLanguage, setPatientPreferredLanguage] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [soapDraft, setSoapDraft] = useState<SOAPNote | null>(null);
  const [editedSOAP, setEditedSOAP] = useState<SOAPNote | null>(null);
  const [signedOff, setSignedOff] = useState(false);
  const [isCompletedSession, setIsCompletedSession] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [transcriptLength, setTranscriptLength] = useState(0);
  const [liveText, setLiveText] = useState("");
  useEffect(() => {
    if (liveTextRef.current) {
      liveTextRef.current.scrollTop = liveTextRef.current.scrollHeight;
    }
  }, [liveText]);
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


  // GAP-S6: compare-to-previous-visit.
  const [compareOpen, setCompareOpen] = useState(false);
  const [previousConsultation, setPreviousConsultation] = useState<
    { id: string; notes: string | null; findings: string | null; createdAt: string; appointment?: any } | null
  >(null);
  const [previousLoading, setPreviousLoading] = useState(false);

  // ── Voice command state (review mode) ─────────────────
  // PRD §4.5.6: separate Web Speech recogniser scoped to the review screen,
  // so it does NOT run during ambient consultation capture. Pure parsing
  // happens in ./voice-commands.ts.
  const [voiceListening, setVoiceListening] = useState(false);
  // When set, the main SOAP panel shows this past visit's full detail (same as
  // the manual consult screen) instead of the live draft.
  const [viewingVisit, setViewingVisit] = useState<Visit | null>(null);
  const [lastVoiceCommand, setLastVoiceCommand] = useState("");
  const [voiceLegendOpen, setVoiceLegendOpen] = useState(false);
  // Per-section free-text notes the doctor builds via "add note <text>".
  const [sectionNotes, setSectionNotes] = useState<Record<SectionKey, string>>({
    S: "", O: "", A: "", P: "",
  });
  const voiceCmdRecognitionRef = useRef<any>(null);
  // Map of medication-row index -> dosage <input> element so a "change dosage"
  // command can focus the matching row immediately after pre-filling.
  const dosageInputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  const [useServerASR, setUseServerASR] = useState(false);
  // Spoken language for ASR — drives BOTH Browser STT (recognition.lang) and
  // Sarvam (language_code). Default English; pick Hindi/regional so the patient
  // isn't transcribed through an en-IN model that garbles non-English speech.
  const [asrLanguage, setAsrLanguage] = useState<string>("en");
  // Mirror in a ref so the long-lived SpeechRecognition handlers read the
  // current language at the moment recording starts.
  const asrLanguageRef = useRef(asrLanguage);
  useEffect(() => {
    asrLanguageRef.current = asrLanguage;
  }, [asrLanguage]);
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
  const liveTextRef = useRef<HTMLDivElement>(null);
  const userStoppedRef = useRef(false);
  const finalBufferRef = useRef<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const asrIntervalRef = useRef<any>(null);
  const serverASRActiveRef = useRef(false);
  const liveDisplayRecognitionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const stopServerASRResolveRef = useRef<(() => void) | null>(null);
  // Show the "microphone denied" toast at most once per attempt instead of
  // flooding the screen when the mic is blocked / busy. Reset on a clean start.
  const micDeniedToastRef = useRef(false);
  // Set to true when a transcript POST just triggered a SOAP regen so the
  // stop-time forceRegen call can be skipped (avoids a redundant round-trip).
  const soapJustUpdatedRef = useRef(false);

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
          `/appointments?date=${today}&status=BOOKED,CHECKED_IN,IN_CONSULTATION&limit=100`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        // Issue #156: the api wrapper returns the parsed JSON directly,
        // i.e. `{ success, data, meta }` — the previous code reached for
        // `res.data.data?.appointments` (a non-existent property) and
        // always rendered an empty list. The list endpoint returns
        // `data: Appointment[]` so we accept either an array or a
        // legacy `{appointments: […]}` envelope defensively.
        const payload = res?.data;
        const list = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.appointments)
            ? payload.appointments
            : [];
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

        // Auto-resume after a page refresh: sessionId lives only in React
        // state, so a reload would drop back to the picker. We stored the
        // active appointment in sessionStorage on start — re-open it (POST
        // /start resumes the existing session and rehydrates transcript +
        // SOAP). Runs at most once per mount and never overrides a URL target.
        if (
          !scribeResumeAttempted.current &&
          !sessionId &&
          !urlAppointmentId &&
          !urlPatientId
        ) {
          scribeResumeAttempted.current = true;
          let storedApptId: string | null = null;
          try {
            storedApptId = sessionStorage.getItem("medcore-scribe-active-appt");
          } catch {
            storedApptId = null;
          }
          const resumeTarget = storedApptId
            ? list.find((a: any) => a.id === storedApptId)
            : null;
          if (resumeTarget) void startScribe(resumeTarget, { silent: true });
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, urlAppointmentId, urlPatientId, apptRetryNonce]);

  // Poll for SOAP updates while recording
  useEffect(() => {
    if (recording && sessionId) {
      pollRef.current = setInterval(async () => {
        try {
          const res = await api.get<any>(`/ai/scribe/${sessionId}/soap`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.data?.soapDraft) {
            setSoapDraft(res.data.soapDraft);
            setEditedSOAP(res.data.soapDraft);
          }
          if (res.data?.rxDraft?.alerts) {
            setRxSafetyReport(res.data.rxDraft);
            setAlertsAcknowledged(false);
          }
          if (Array.isArray(res.data?.transcript)) {
            setTranscriptEntries(res.data.transcript);
          }
        } catch { /* silent */ }
      }, 15000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [recording, sessionId, token]);

  const startScribe = async (appointment: any, opts?: { silent?: boolean }) => {
    setLoading(true);
    // eslint-disable-next-line no-console
    console.log(
      `[SCRIBE-DBG] startScribe apiBase=${process.env.NEXT_PUBLIC_API_URL || "(default localhost:4000)"} secureContext=${typeof window !== "undefined" ? window.isSecureContext : "n/a"} hasMediaDevices=${typeof navigator !== "undefined" && !!navigator.mediaDevices} appt=${appointment?.id}`,
    );
    try {
      // Issue #193: `api.post` already returns the parsed JSON envelope
      // `{ success, data, error }` — the previous `res.data.data.sessionId`
      // double-walked the envelope and read `undefined`, so the success
      // branch fell through to the catch and toasted "Failed to start
      // scribe" even on HTTP 201. The API response shape is
      // `{ data: { sessionId, patientContext, ... } }`.
      const res = await api.post<any>(
        "/ai/scribe/start",
        { appointmentId: appointment.id, consentObtained: true, audioRetentionDays: 30 },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const sid: string | undefined = res?.data?.sessionId;
      // eslint-disable-next-line no-console
      console.log(`[SCRIBE-DBG] /ai/scribe/start ✓ session=${sid ?? "MISSING"} completed=${res?.data?.completed === true}`);
      if (!sid) {
        toast.error("Scribe started but no session id was returned");
        return;
      }
      const isCompleted = res?.data?.completed === true;
      setIsCompletedSession(isCompleted);
      setIsEditMode(false);
      setSessionId(sid);
      setSelectedAppointment(appointment);
      // Remember the active appointment so a page refresh can auto-resume this
      // session (rehydrating transcript + SOAP) instead of dropping to the
      // picker. Cleared on withdraw/finalize.
      try {
        sessionStorage.setItem("medcore-scribe-active-appt", appointment.id);
      } catch {
        /* sessionStorage unavailable (private mode) — resume just won't fire */
      }
      setTranscriptEntries([]);
      setTranscriptLength(0);
      setSoapDraft(null);
      setEditedSOAP(null);
      setEditLog([]);
      setPatientPreferredLanguage(
        res?.data?.patientContext?.preferredLanguage ?? null
      );
      // Hydrate existing SOAP + transcript for resumed sessions so the UI
      // shows prior state immediately without waiting for recording to start.
      try {
        const soapRes = await api.get<any>(`/ai/scribe/${sid}/soap`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (soapRes?.data?.soapDraft) {
          setSoapDraft(soapRes.data.soapDraft);
          setEditedSOAP(soapRes.data.soapDraft);
        }
        if (Array.isArray(soapRes?.data?.transcript) && soapRes.data.transcript.length > 0) {
          setTranscriptEntries(soapRes.data.transcript);
          setTranscriptLength(soapRes.data.transcript.length);
        }
      } catch { /* non-fatal — UI degrades gracefully */ }
      // Silent on auto-resume (page refresh) — only toast on an explicit start.
      if (!opts?.silent) toast.success("Scribe session started");
    } catch (err: any) {
      // Surface the API's actual error message (fetch-style payload, not
      // axios `response`) so the user sees the real cause.
      toast.error(err?.payload?.error || err?.message || "Failed to start scribe");
    } finally {
      setLoading(false);
    }
  };
  // Keep a live reference so dead-session recovery can re-start without a
  // stale closure (startScribe isn't memoized, so this re-points each render).
  startScribeRef.current = startScribe;

  // ── Serialized transcript sender: single in-flight request + queue ─────
  // Speech recognition can emit several "final" results in quick succession.
  // Firing a POST /transcript per result IN PARALLEL is the core production
  // failure: (a) the server does a read-append-write of session.transcript, so
  // concurrent writes race → last-write-wins DROPS lines; and (b) each request
  // regenerates the SOAP note, so parallel requests run concurrent LLM calls
  // (wasted tokens, clobbered drafts, and — behind a slow prod network — piled-
  // up in-flight requests). So we keep AT MOST ONE request in flight and QUEUE
  // new entries; when it finishes we drain the queue in ONE batched POST (the
  // latest delta) and regen once, then repeat until the queue is empty.
  const pendingEntriesRef = useRef<
    {
      speaker: "DOCTOR" | "PATIENT" | "ATTENDANT";
      text: string;
      timestamp: string;
      confidence: number;
    }[]
  >([]);
  const soapInFlightRef = useRef(false);

  const flushTranscriptQueue = useCallback(async () => {
    if (soapInFlightRef.current) return; // a drain is already running
    const sid = sessionId;
    if (!sid) return;
    soapInFlightRef.current = true;
    try {
      while (pendingEntriesRef.current.length > 0) {
        // Drain everything queued so far into ONE request — the "latest
        // transcript update" batch. Entries that arrive mid-request queue up
        // and go out on the next loop iteration (never concurrently).
        const batch = pendingEntriesRef.current;
        pendingEntriesRef.current = [];
        try {
          const _t0 = Date.now();
          const res = await api.post<any>(
            `/ai/scribe/${sid}/transcript`,
            { entries: batch },
            { headers: { Authorization: `Bearer ${token}` } },
          );
          // eslint-disable-next-line no-console
          console.log(
            `[SCRIBE-DBG] /transcript ✓ ${Date.now() - _t0}ms sent=${batch.length}`,
            res?.data?._debug ?? {
              soapDraftUpdated: res?.data?.soapDraftUpdated,
              soapError: res?.data?.soapError,
            },
          );
          setTranscriptLength(res.data.transcriptLength);
          if (res.data.soapDraft) {
            setSoapDraft(res.data.soapDraft);
            setEditedSOAP(res.data.soapDraft);
            soapJustUpdatedRef.current = true;
          }
          if (res.data.rxSafetyReport?.alerts) {
            setRxSafetyReport(res.data.rxSafetyReport);
            setAlertsAcknowledged(false);
          }
          // Append succeeded but the AI couldn't draft — surface why instead of
          // leaving a silently-blank / stale draft.
          if (res.data.soapError) {
            toast.error(`AI draft failed: ${res.data.soapError}`);
          }
        } catch (err: any) {
          console.error("[scribe] transcript append failed:", {
            status: err?.status,
            payload: err?.payload,
            sentEntries: batch,
          });
          const serverMsg: string = err?.payload?.error || err?.message || "";
          // Dead session (consent withdrawn / not found): stop draining, halt
          // the stale recorder, and transparently spin up a FRESH session so
          // the doctor can continue by tapping Start Recording again.
          if (
            err?.status === 404 ||
            /consent has been withdrawn|session not found/i.test(serverMsg)
          ) {
            pendingEntriesRef.current = [];
            serverASRActiveRef.current = false;
            try {
              recognitionRef.current?.stop();
            } catch {
              /* ignore */
            }
            recognitionRef.current = null;
            setRecording(false);
            setSessionId(null);
            const appt = selectedAppointmentRef.current;
            if (appt && startScribeRef.current) {
              try {
                await startScribeRef.current(appt, { silent: true });
                toast.info(
                  "Scribe session refreshed — tap Start Recording to continue.",
                );
              } catch {
                toast.error("Scribe session ended — please start a new one.");
              }
            } else {
              toast.error("Scribe session ended — please start a new one.");
            }
            break;
          }
          // Transient / other error (timeout, 5xx, network): surface it and
          // STOP draining this cycle. The lines stay shown locally; the next
          // spoken utterance triggers a fresh flush — no tight retry loop.
          const detail =
            err?.payload?.details?.[0]?.message ||
            err?.payload?.error ||
            err?.message ||
            "please try again";
          toast.error(`Couldn't sync that line: ${detail}`);
          break;
        }
      }
    } finally {
      soapInFlightRef.current = false;
    }
    // If a line arrived between the while-exit and the flag reset, flush again.
    if (pendingEntriesRef.current.length > 0 && sessionId) {
      void flushTranscriptQueue();
    }
  }, [sessionId, token]);

  // Shared handler: push a final transcript string into the scribe session.
  // Accepts ATTENDANT as well so diarization-driven flushes can emit family
  // members' utterances without losing the acoustic label. Enqueues the entry
  // and kicks the serialized sender (never posts directly / concurrently).
  const handleFinalTranscript = useCallback(
    async (text: string, speaker: "DOCTOR" | "PATIENT" | "ATTENDANT") => {
      // Build a schema-valid entry: non-empty trimmed text (addTranscriptChunk
      // requires text.min(1)), a real ISO timestamp, confidence in [0,1].
      const cleanText = text.trim();
      if (!cleanText || !sessionId) return;
      const newEntry = {
        speaker,
        text: cleanText,
        timestamp: new Date().toISOString(),
        confidence: 0.9,
      };
      // Optimistic UI — show the captured line immediately.
      setTranscriptEntries((prev) => [...prev, newEntry]);
      // Queue + kick the single-in-flight sender.
      pendingEntriesRef.current.push(newEntry);
      void flushTranscriptQueue();
    },
    [sessionId, flushTranscriptQueue],
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
      setPreviousConsultation(res.data?.previous ?? null);
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
  // Send a single clean audio blob to Sarvam and push transcript into session.
  const sendAudioToSarvam = useCallback(
    async (blob: Blob, speaker: "DOCTOR" | "PATIENT") => {
      if (blob.size < 1000) return; // skip near-silent / empty chunks
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);
        let binary = "";
        const CHUNK = 8192;
        for (let i = 0; i < uint8.length; i += CHUNK) {
          binary += String.fromCharCode(...uint8.subarray(i, i + CHUNK));
        }
        const base64 = btoa(binary);
        const _t0 = Date.now();
        const res = await api.post<any>(
          "/ai/transcribe",
          {
            audioBase64: base64,
            language: toSarvamLanguageCode(asrLanguageRef.current),
            // Keep the spoken language (Sarvam's native STT + auto-detect)
            // rather than the translate model — more reliable per language,
            // and the SOAP step translates to English anyway.
            translate: false,
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const transcript: string = res.data?.transcript ?? "";
        // eslint-disable-next-line no-console
        console.log(
          `[SCRIBE-DBG] /transcribe ✓ ${Date.now() - _t0}ms audioBytes=${blob.size} gotChars=${transcript.length}`,
          res?.data?._debug ?? {},
        );
        if (transcript.trim()) {
          await handleFinalTranscript(transcript, speaker);
        }
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error("[SCRIBE-DBG] /transcribe ✗", {
          status: err?.status,
          serverError: err?.payload?.error,
          msg: err?.message,
        });
        const msg = err?.payload?.error || err?.message || "Sarvam transcription failed";
        toast.error(`ASR: ${msg}`);
      }
    },
    [token, handleFinalTranscript]
  );

  // Rotate-recorder pattern: each 8-second window is a fresh MediaRecorder
  // so Sarvam receives a clean, self-contained WebM file every time.
  const startServerASR = useCallback(
    async (speaker: "DOCTOR" | "PATIENT") => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // eslint-disable-next-line no-console
        console.log(`[SCRIBE-DBG] mic granted (getUserMedia ok) speaker=${speaker}`);
        micStreamRef.current = stream;
        serverASRActiveRef.current = true;
        micDeniedToastRef.current = false;

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";

        const startChunk = () => {
          if (!serverASRActiveRef.current) return;
          const recorder = new MediaRecorder(stream, { mimeType });
          const chunks: Blob[] = [];

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
          };

          recorder.onstop = async () => {
            await sendAudioToSarvam(new Blob(chunks, { type: mimeType }), speaker);
            if (serverASRActiveRef.current) {
              startChunk(); // rotate to next 8-second window
            } else {
              stopServerASRResolveRef.current?.(); // signal stop complete
            }
          };

          recorder.start();
          mediaRecorderRef.current = recorder;

          // Rotate the recorder every 12 s, then onstop ships the clean file.
          // 8 s was too short — a normal sentence often spanned the boundary,
          // so the first half landed in one chunk and the tail (e.g. just
          // "Yes") in the next, losing the complaint. 12 s fits most single
          // utterances while live interim (browser STT) keeps it feeling real-time.
          asrIntervalRef.current = setTimeout(() => {
            if (recorder.state !== "inactive") recorder.stop();
          }, 12_000);
        };

        startChunk();
        setRecording(true);

        // Run browser STT in parallel for interim live-text display only.
        // Final results from this instance are discarded — Sarvam owns finals.
        const SpeechRecognition =
          (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (SpeechRecognition) {
          const liveRec = new SpeechRecognition();
          liveRec.continuous = true;
          liveRec.interimResults = true;
          liveRec.lang = toSarvamLanguageCode(asrLanguageRef.current);
          liveRec.onresult = (e: any) => {
            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
              if (!e.results[i].isFinal) interim += e.results[i][0].transcript;
            }
            if (interim) setLiveText(interim);
          };
          liveRec.onend = () => {
            if (serverASRActiveRef.current) liveRec.start();
          };
          liveRec.start();
          liveDisplayRecognitionRef.current = liveRec;
        } else {
          setLiveText("🎤 Listening...");
        }
      } catch (micErr: any) {
        // eslint-disable-next-line no-console
        console.error(
          `[SCRIBE-DBG] mic FAILED (getUserMedia) name=${micErr?.name} msg=${micErr?.message} secureContext=${typeof window !== "undefined" ? window.isSecureContext : "n/a"} — over a tunnel this is almost always: page not served over HTTPS, or the user denied the mic.`,
        );
        // Mic blocked / busy — fully stop so the loop can't retry, and toast
        // only once (a denied mic otherwise spams one toast per attempt).
        serverASRActiveRef.current = false;
        try {
          liveDisplayRecognitionRef.current?.stop();
        } catch {
          /* ignore */
        }
        liveDisplayRecognitionRef.current = null;
        setRecording(false);
        setLiveText("");
        if (!micDeniedToastRef.current) {
          micDeniedToastRef.current = true;
          toast.error(
            "Microphone access denied — allow mic access in your browser, then tap Start Recording.",
          );
        }
      }
    },
    [sendAudioToSarvam]
  );

  const stopServerASR = useCallback(async () => {
    serverASRActiveRef.current = false;
    if (asrIntervalRef.current) {
      clearTimeout(asrIntervalRef.current);
      asrIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      await new Promise<void>((resolve) => {
        stopServerASRResolveRef.current = resolve;
        mediaRecorderRef.current!.stop();
      });
    }
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    liveDisplayRecognitionRef.current?.stop();
    liveDisplayRecognitionRef.current = null;
    setRecording(false);
    setLiveText("");
  }, []);

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
    recognition.lang = toSarvamLanguageCode(asrLanguageRef.current);

    finalBufferRef.current = [];
    userStoppedRef.current = false;

    const flushBuffer = async () => {
      if (finalBufferRef.current.length === 0) return;
      const toFlush = [...finalBufferRef.current];
      finalBufferRef.current = [];
      for (const text of toFlush) {
        await handleFinalTranscript(text, activeSpeaker);
      }
    };

    recognition.onresult = async (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalBufferRef.current.push(transcript);
          if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
          if (finalBufferRef.current.length >= 5) {
            await flushBuffer();
          } else {
            flushTimerRef.current = setTimeout(flushBuffer, 2000);
          }
        } else {
          interim += transcript;
        }
      }
      setLiveText(interim);
    };

    recognition.onstart = () => {
      // Mic granted — re-arm the denied-toast for a future genuine denial.
      micDeniedToastRef.current = false;
    };
    recognition.onerror = async (e: any) => {
      await flushBuffer();
      // A denied/blocked mic must STOP, not auto-restart — otherwise onend
      // restarts it and it errors again in a tight loop. Toast once.
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        userStoppedRef.current = true;
        if (!micDeniedToastRef.current) {
          micDeniedToastRef.current = true;
          toast.error(
            "Microphone access denied — allow mic access in your browser, then tap Start Recording.",
          );
        }
      }
    };
    recognition.onend = async () => {
      // Clear the pending flush timer first to prevent double-send
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      await flushBuffer();
      // Auto-restart if the user hasn't explicitly stopped — Chrome fires onend
      // on silence/timeout even with continuous:true.
      if (!userStoppedRef.current && recognitionRef.current === recognition) {
        try { recognition.start(); return; } catch { /* fallthrough to stop */ }
      }
      setRecording(false);
    };
    recognition.start();
    recognitionRef.current = recognition;
    setRecording(true);
  }, [sessionId, token, activeSpeaker, useServerASR, startServerASR, handleFinalTranscript]);

  const stopRecording = useCallback(async () => {
    // No separate "force regen" POST on stop: every transcript append already
    // triggers a live SOAP regen, and the final utterance is flushed below
    // before we stop — so the draft is already current. The old empty-`entries`
    // forceRegen call was redundant and was the source of the 400 on stop.
    if (useServerASR) {
      await stopServerASR();
      return;
    }

    userStoppedRef.current = true;
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    // Flush any buffered finals before stopping so no speech is lost
    if (finalBufferRef.current.length > 0) {
      const toFlush = [...finalBufferRef.current];
      finalBufferRef.current = [];
      for (const text of toFlush) {
        await handleFinalTranscript(text, activeSpeaker);
      }
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setRecording(false);
    setLiveText("");
  }, [useServerASR, activeSpeaker, stopServerASR, handleFinalTranscript]);

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

  // ── Right-rail paste handlers (Pearl §2.1.3, gap row 46) ──────────────
  // Click-to-paste from the right rail into the active SOAP draft. We do
  // NOT clobber the existing chief complaint — if one's already typed we
  // append with a separator so a quick second click doesn't lose work.
  const handlePasteDiagnosis = useCallback((value: string) => {
    setEditedSOAP((prev) => {
      const next: SOAPNote = prev
        ? JSON.parse(JSON.stringify(prev))
        : ({
            subjective: { chiefComplaint: "" },
            objective: {},
            assessment: {},
            plan: {},
          } as unknown as SOAPNote);
      const sub = (next.subjective ?? (next.subjective = {} as any)) as any;
      const existing = (sub.chiefComplaint ?? "").trim();
      sub.chiefComplaint = existing ? `${existing}; ${value}` : value;
      return next;
    });
  }, []);

  const handlePasteMedicine = useCallback(
    (med: { name: string; dose?: string; frequency?: string; duration?: string }) => {
      setEditedSOAP((prev) => {
        const next: SOAPNote = prev
          ? JSON.parse(JSON.stringify(prev))
          : ({
              subjective: {},
              objective: {},
              assessment: {},
              plan: { medications: [] },
            } as unknown as SOAPNote);
        const plan = (next.plan ?? (next.plan = {} as any)) as any;
        const meds = Array.isArray(plan.medications) ? plan.medications : (plan.medications = []);
        meds.push({
          name: med.name,
          dose: med.dose ?? "",
          frequency: med.frequency ?? "",
          duration: med.duration ?? "",
        });
        return next;
      });
    },
    [],
  );

  // ── Enter review mode ─────────────────────────────────
  const handleEnterReview = () => {
    if (!editedSOAP) return;
    setReviewSoap(JSON.parse(JSON.stringify(editedSOAP)) as SOAPNote);
    setSectionStatus({ ...INITIAL_SECTION_STATUS });
    setSectionNotes({ S: "", O: "", A: "", P: "" });
    setReviewMode(true);
  };

  // ── Exit review mode (back to draft) ──────────────────
  const handleExitReview = () => {
    setReviewMode(false);
  };

  // ── Voice command dispatcher (PRD §4.5.6) ─────────────
  // Stable ref so the recogniser callbacks (which capture stale closures)
  // always invoke the latest dispatcher. Defined below; the ref is set up
  // here so it survives across re-renders.
  const voiceDispatchRef = useRef<((heard: string) => void) | null>(null);

  const handleVoiceAction = useCallback((action: VoiceAction, heard: string) => {
    // Audit trail (client-side). Falls through to console.debug per spec when
    // there is no analytics endpoint configured.
    // eslint-disable-next-line no-console
    console.debug("[scribe.voice]", { heard, action });

    switch (action.kind) {
      case "accept-section": {
        setSectionStatus((p) => ({ ...p, [action.section]: "accepted" }));
        setLastVoiceCommand(`accept ${action.section}`);
        break;
      }
      case "reject-section": {
        setSectionStatus((p) => ({ ...p, [action.section]: "rejected" }));
        setLastVoiceCommand(`reject ${action.section}`);
        break;
      }
      case "accept-all": {
        setSectionStatus({ S: "accepted", O: "accepted", A: "accepted", P: "accepted" });
        setLastVoiceCommand("accept all");
        // Defer so status updates flush before triggering sign-off
        setTimeout(() => { signOffTriggerRef.current?.(); }, 0);
        break;
      }
      case "change-dosage": {
        // Substring match against medicineName (case-insensitive).
        const meds = reviewSoap?.plan?.medications ?? editedSOAP?.plan?.medications ?? [];
        const q = action.medicineQuery.toLowerCase();
        const idx = meds.findIndex((m) => (m.name || "").toLowerCase().includes(q));
        if (idx === -1) {
          toast.info(`No prescription matched "${action.medicineQuery}"`);
          setLastVoiceCommand(`change dosage of ${action.medicineQuery}`);
          break;
        }
        // Update the dose in both the review draft and the editable SOAP so the
        // change persists if the doctor exits review mode.
        setReviewSoap((prev) => {
          if (!prev?.plan?.medications) return prev;
          const next = JSON.parse(JSON.stringify(prev)) as SOAPNote;
          next.plan.medications![idx].dose = action.newDosage;
          return next;
        });
        setEditedSOAP((prev) => {
          if (!prev?.plan?.medications) return prev;
          const next = JSON.parse(JSON.stringify(prev)) as SOAPNote;
          next.plan.medications![idx].dose = action.newDosage;
          return next;
        });
        setSectionStatus((p) => ({ ...p, P: "edited" }));
        setEditLog((log) => [
          ...log,
          { path: `plan.medications[${idx}].dose`, from: meds[idx].dose, to: action.newDosage },
        ]);
        setLastVoiceCommand(`change dosage of ${meds[idx].name} to ${action.newDosage}`);
        // Focus the matching row's dosage <input> on the next tick so the
        // doctor can immediately tweak the pre-filled value.
        setTimeout(() => {
          const el = dosageInputRefs.current[idx];
          if (el) {
            el.focus();
            el.select();
          }
        }, 0);
        toast.success(`Updated ${meds[idx].name} dose → ${action.newDosage}`);
        break;
      }
      case "add-note": {
        const target: SectionKey = action.section ?? "P"; // default to Plan
        setSectionNotes((prev) => ({
          ...prev,
          [target]: prev[target] ? `${prev[target]}\n${action.text}` : action.text,
        }));
        setLastVoiceCommand(`add note (${target}): ${action.text}`);
        toast.info(`Note added to ${SECTION_LABELS[target]}`);
        break;
      }
      case "discard": {
        setLastVoiceCommand("discard");
        handleExitReview();
        break;
      }
      case "show-help": {
        setVoiceLegendOpen((o) => !o);
        setLastVoiceCommand("what can I say");
        break;
      }
      case "unknown": {
        toast.info(`Command not recognised: "${action.raw}"`);
        setLastVoiceCommand(`(unrecognised) ${action.raw}`);
        break;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedSOAP, reviewSoap]);

  // Keep the dispatcher ref pointed at the latest closure so the
  // long-lived SpeechRecognition `onresult` handler always sees fresh state.
  voiceDispatchRef.current = (heard: string) => {
    const action = parseVoiceCommand(heard);
    handleVoiceAction(action, heard);
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
    recognition.lang = toSarvamLanguageCode(asrLanguageRef.current);

    recognition.onresult = (event: any) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        }
      }
      const heard = transcript.trim();
      if (!heard) return;
      voiceDispatchRef.current?.(heard);
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

  // Does the live draft actually have content yet? Key fields = chief complaint
  // and medications. While both are empty the AI hasn't captured anything (or
  // returned the placeholder), so the main panel shows the "Auto-updating"
  // spinner — and the backend retry re-asks the AI with the same transcript.
  const soapHasContent = (() => {
    if (!editedSOAP) return false;
    const cc = String(editedSOAP.subjective?.chiefComplaint ?? "")
      .trim()
      .toLowerCase();
    const ccReal = cc !== "" && cc !== "no clinical complaint stated yet";
    const medCount = Array.isArray(editedSOAP.plan?.medications)
      ? editedSOAP.plan.medications.length
      : 0;
    return ccReal || medCount > 0;
  })();

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
      // Stop the main recording mic and the voice-command recognition mic.
      if (recording) await stopRecording();
      setReviewMode(false);
      setIsCompletedSession(true);
      setSignedOff(true);
      try {
        sessionStorage.removeItem("medcore-scribe-active-appt");
      } catch {
        /* ignore */
      }
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
      setIsCompletedSession(false);
      setIsEditMode(false);
      setApptRetryNonce((n) => n + 1);
      try {
        sessionStorage.removeItem("medcore-scribe-active-appt");
      } catch {
        /* ignore */
      }
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
          <p className="text-gray-500 text-sm dark:text-gray-400">The SOAP note has been committed to the EHR.</p>
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
              setIsCompletedSession(false);
              setTranscriptEntries([]);
              setTranscriptLength(0);
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
      recognition.lang = toSarvamLanguageCode(asrLanguageRef.current);

      recognition.onresult = (event: any) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) transcript += event.results[i][0].transcript;
        }
        const heard = transcript.trim();
        if (!heard) return;
        // Route through the same dispatcher as the auto-started recogniser
        // so the parse-then-act pipeline is the single source of truth.
        voiceDispatchRef.current?.(heard);
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
        <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-gray-200 shadow-sm flex-shrink-0 dark:bg-gray-800 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <button
              onClick={handleExitReview}
              className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-blue-600 transition-colors dark:text-gray-300 dark:hover:text-blue-400"
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
            {/* PRD §4.5.5: tell the doctor which language the auto-generated
                visit summary will be sent in BEFORE they hit Sign & Save. */}
            <span
              data-testid="scribe-summary-language-badge"
              className="text-xs px-2.5 py-1 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
              title="Auto-generated patient visit summary will be sent in this language"
            >
              Sending summary in: {(LANGUAGE_DISPLAY as any)[patientPreferredLanguage ?? "en"]?.englishName ?? "English"}
            </span>
            {signOffDisabledReason && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 max-w-xs dark:text-amber-300 dark:bg-amber-900/20 dark:border-amber-700">
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

        {/* Voice command status bar (PRD §4.5.6) */}
        <div className="flex items-center gap-3 px-6 py-2 bg-gray-50 border-b border-gray-100 flex-shrink-0 dark:bg-gray-900/50 dark:border-gray-700">
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
            <span
              data-testid="review-voice-transcript"
              className="text-xs text-gray-500 italic max-w-[60%] truncate dark:text-gray-400"
              title={lastVoiceCommand}
            >
              Heard: {lastVoiceCommand}
            </span>
          )}
          <button
            data-testid="review-voice-mic"
            aria-pressed={voiceListening}
            onClick={toggleVoiceListener}
            className="ml-auto text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100 transition-colors dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {voiceListening ? "Voice Off" : "Voice On"}
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
              <span className="font-medium text-gray-700 dark:text-gray-200">Compare to previous visit</span>
            </label>
            {previousLoading && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />
            )}
          </div>
          {compareOpen && (
            <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 overflow-hidden dark:border-gray-700 dark:bg-gray-900/50">
              <div className="px-4 py-2 border-b border-gray-200 bg-white dark:bg-gray-800 dark:border-gray-700">
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                  Side-by-side: previous consultation vs current AI draft
                </p>
                {previousConsultation?.createdAt && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Previous visit: {new Date(previousConsultation.createdAt).toLocaleDateString()}
                  </p>
                )}
              </div>
              {previousLoading ? (
                // Pearl §7.2 skeleton sweep (wave 13, 2026-05-23): replaced
                // the bare "Loading previous consultation…" text with a
                // `SkeletonText lines=4` block under a stable
                // `scribe-previous-loading` testid + `aria-busy="true"`.
                // Same pattern as wave-12 `<slug>-loading`.
                <div
                  data-testid="scribe-previous-loading"
                  aria-busy="true"
                  className="p-4"
                >
                  <SkeletonText lines={4} />
                </div>
              ) : !previousConsultation ? (
                <div className="p-4 text-xs text-gray-500 italic dark:text-gray-400">
                  No prior completed consultation found for this patient.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-x divide-gray-200 dark:divide-gray-700">
                  <div className="p-4 space-y-1 min-h-[120px]">
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide dark:text-gray-400">
                      Previous visit notes
                    </p>
                    <pre className="text-xs whitespace-pre-wrap font-sans text-gray-700 dark:text-gray-200">
                      {previousConsultation.notes || <span className="italic text-gray-400">No notes saved.</span>}
                    </pre>
                  </div>
                  <div className="p-4 space-y-1 min-h-[120px]">
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide dark:text-gray-400">
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

          {/* Voice-driven prescription dosage editor (PRD §4.5.6) — only
              renders rows when the Plan has any meds. The dosage <input>
              receives focus when "change dosage of <med> to <new>" pre-fills
              its value. */}
          {reviewSoap.plan?.medications && reviewSoap.plan.medications.length > 0 && (
            <div className="border border-gray-200 rounded-xl overflow-hidden dark:border-gray-700">
              <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 dark:bg-gray-900/50 dark:border-gray-700">
                <span className="text-xs font-medium text-gray-600 flex items-center gap-2 dark:text-gray-300">
                  <Pill className="w-3.5 h-3.5 text-green-500" /> Prescriptions (voice-editable)
                </span>
              </div>
              <div className="px-4 py-3 space-y-2">
                {reviewSoap.plan.medications.map((med, i) => (
                  <div key={i} className="flex items-center gap-3 text-sm">
                    <span className="font-medium text-gray-800 min-w-[8rem] dark:text-gray-100">{med.name}</span>
                    <input
                      type="text"
                      data-testid={`review-rx-dose-${i}`}
                      ref={(el) => { dosageInputRefs.current[i] = el; }}
                      value={med.dose}
                      onChange={(e) => {
                        const v = e.target.value;
                        setReviewSoap((prev) => {
                          if (!prev?.plan?.medications) return prev;
                          const next = JSON.parse(JSON.stringify(prev)) as SOAPNote;
                          next.plan.medications![i].dose = v;
                          return next;
                        });
                        setSectionStatus((p) => ({ ...p, P: "edited" }));
                      }}
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                    />
                    <span className="text-xs text-gray-400">
                      {med.frequency} · {med.duration}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Per-section voice notes (PRD §4.5.6 "add note <text>") */}
          {(["S", "O", "A", "P"] as SectionKey[]).some((k) => sectionNotes[k]) && (
            <div
              data-testid="review-voice-notes"
              className="border border-blue-200 bg-blue-50/40 rounded-xl px-4 py-3 space-y-2"
            >
              <p className="text-xs font-semibold text-blue-700 flex items-center gap-1.5">
                <Edit3 className="w-3.5 h-3.5" /> Voice notes (will be merged into the SOAP on sign-off)
              </p>
              {(["S", "O", "A", "P"] as SectionKey[]).map((k) =>
                sectionNotes[k] ? (
                  <div key={k} className="text-xs">
                    <span className="font-medium text-blue-800">{SECTION_LABELS[k]}:</span>{" "}
                    <span className="text-blue-700 whitespace-pre-line">{sectionNotes[k]}</span>
                  </div>
                ) : null,
              )}
            </div>
          )}

          {/* Collapsible voice commands legend (PRD §4.5.6 cheat-sheet) */}
          <div
            data-testid="review-voice-cheatsheet"
            className="border border-gray-200 rounded-xl overflow-hidden dark:border-gray-700"
          >
            <button
              onClick={() => setVoiceLegendOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors dark:bg-gray-900/50 dark:hover:bg-gray-700"
            >
              <span className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
                <Mic className="w-3.5 h-3.5 text-gray-400" /> Voice commands
                <span className="text-gray-400">— say &ldquo;what can I say&rdquo; to toggle</span>
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
                    ["accept all / approve all", "Accept every section + sign off"],
                    ["sign off / finalize / submit", "Same as accept all"],
                    ["change dosage of <med> to <new>", "Edit a prescription's dose"],
                    ["add note <text>", "Append a note to the Plan"],
                    ["add note to plan <text>", "Append to a specific section"],
                    ["discard / cancel", "Exit review without saving"],
                    ["what can I say", "Toggle this cheat-sheet"],
                  ] as [string, string][]).map(([cmd, desc]) => (
                    <div key={cmd} className="flex items-baseline gap-2">
                      <code className="text-xs bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded font-mono whitespace-nowrap dark:bg-gray-700 dark:text-gray-200">
                        &ldquo;{cmd}&rdquo;
                      </code>
                      <span className="text-xs text-gray-500 truncate dark:text-gray-400">{desc}</span>
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
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto p-6 space-y-4 dark:bg-gray-800">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-6 h-6 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-gray-800">Patient Consent Required</h3>
                <p className="text-sm text-gray-500 mt-1 dark:text-gray-400">
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
                className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="flex h-[calc(100vh-4rem)] gap-4 p-4 overflow-hidden">
        {/* ── Left: appointment picker + controls ────────── */}
        <div className="w-72 flex flex-col gap-3 h-full">
          {/* Appointment selector */}
          {!sessionId && (
          <div className="bg-white rounded-2xl shadow border border-gray-100 p-4 flex-1 flex flex-col overflow-hidden dark:bg-gray-800 dark:border-gray-700">
            <p className="font-semibold text-sm text-gray-700 mb-3 flex items-center gap-2 dark:text-gray-200">
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
                  className="mt-2 w-full rounded-lg border border-red-300 bg-white px-2 py-1 font-medium text-red-700 hover:bg-red-100 dark:border-red-700 dark:bg-gray-800 dark:text-red-300 dark:hover:bg-red-900/30"
                >
                  Retry
                </button>
              </div>
            )}
            {appointments.length === 0 && !apptLoadError ? (
              <p className="text-xs text-gray-400 text-center py-4">No appointments today</p>
            ) : appointments.length === 0 ? null : (
              <div className="space-y-1.5 flex-1 overflow-y-auto scrollbar-hide">
                {appointments.map((appt) => {
                  const scribeStatus = appt.scribeSession?.status ?? null;
                  const isCompleted = scribeStatus === "COMPLETED";
                  const isPending = scribeStatus === "ACTIVE" || scribeStatus === "PAUSED";
                  return (
                    <button
                      key={appt.id}
                      onClick={() => {
                        if (sessionId || loading) return;
                        if (isCompleted) {
                          startScribe(appt);
                        } else {
                          setConsentTarget(appt);
                        }
                      }}
                      disabled={!!sessionId || loading}
                      className={`w-full text-left px-3 py-2 rounded-xl border text-sm transition-all ${
                        selectedAppointment?.id === appt.id
                          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30"
                          : "border-gray-200 hover:border-blue-200 disabled:opacity-50 dark:border-gray-700 dark:hover:border-blue-700"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <p className="font-medium text-gray-800 truncate dark:text-gray-100">{appt.patient?.user?.name}</p>
                        {isCompleted && (
                          <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
                            Completed
                          </span>
                        )}
                        {isPending && (
                          <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600">
                            Pending
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Token #{appt.tokenNumber} · {appt.slotStart || "Walk-in"}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          )}

          {/* Scribe controls */}
          {sessionId && (
            <div className="bg-white rounded-2xl shadow border border-gray-100 p-4 space-y-3 dark:bg-gray-800 dark:border-gray-700">
              <p className="font-semibold text-sm text-gray-700 flex items-center gap-2 dark:text-gray-200">
                <Activity className="w-4 h-4 text-emerald-600" /> Scribe Active
              </p>
              <div className="text-xs text-gray-500 space-y-1 dark:text-gray-400">
                <p>
                  Patient:{" "}
                  <span className="font-medium text-gray-700 dark:text-gray-200">
                    {selectedAppointment?.patient?.user?.name}
                  </span>
                </p>
                <p>
                  Transcript:{" "}
                  <span className="font-medium text-gray-700 dark:text-gray-200">{transcriptLength} entries</span>
                </p>
              </div>

              {liveText && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-700/50 dark:bg-emerald-900/20">
                  <p className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                    Hearing now
                  </p>
                  <div
                    ref={liveTextRef}
                    className="max-h-24 overflow-y-auto scrollbar-hide break-words text-sm text-gray-700 dark:text-gray-200"
                  >
                    {liveText}
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Active Speaker</p>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setActiveSpeaker("DOCTOR")}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      activeSpeaker === "DOCTOR"
                        ? "bg-blue-600 text-white"
                        : "border border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    }`}
                  >
                    Doctor
                  </button>
                  <button
                    onClick={() => setActiveSpeaker("PATIENT")}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      activeSpeaker === "PATIENT"
                        ? "bg-emerald-600 text-white"
                        : "border border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    }`}
                  >
                    Patient
                  </button>
                </div>
              </div>

              {mediaRecorderSupported && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">ASR Engine</p>
                  <div className="flex gap-1.5">
                    <button
                      disabled={recording}
                      onClick={() => setUseServerASR(false)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        !useServerASR
                          ? "bg-blue-600 text-white"
                          : "border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
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
                          : "border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                      }`}
                    >
                      Sarvam ASR
                    </button>
                  </div>
                  {/* Spoken language — drives both Browser STT and Sarvam so
                      Hindi/regional speech isn't transcribed through en-IN. */}
                  <div className="pt-1">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                      Language
                    </p>
                    <select
                      value={asrLanguage}
                      disabled={recording}
                      onChange={(e) => setAsrLanguage(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-400 focus:outline-none disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
                    >
                      {TRIAGE_LANGUAGE_CODES.map((code) => (
                        <option key={code} value={code}>
                          {LANGUAGE_DISPLAY[code].englishName} (
                          {LANGUAGE_DISPLAY[code].nativeName})
                        </option>
                      ))}
                    </select>
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
          {sessionId && (
            <div className="bg-white rounded-2xl shadow border border-gray-100 overflow-hidden flex-1 flex flex-col dark:bg-gray-800 dark:border-gray-700">
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100 dark:bg-gray-900/50 dark:border-gray-700">
                <span className="flex items-center gap-2 text-xs font-semibold text-gray-700 dark:text-gray-200">
                  <FileText className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
                  Transcript
                  <span className="bg-blue-100 text-blue-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                    {transcriptEntries.length}
                  </span>
                </span>
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-hide p-3 space-y-2">
                {transcriptEntries.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-4">No transcript entries yet</p>
                ) : transcriptEntries.map((entry, i) => {
                    const isDoctor = entry.speaker === "DOCTOR" || entry.speaker === "UNKNOWN";
                    const isPatient = entry.speaker === "PATIENT";
                    const isAttendant = entry.speaker === "ATTENDANT";
                    const bubbleBg = isDoctor
                      ? "bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800"
                      : isPatient
                      ? "bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800"
                      : isAttendant
                      ? "bg-purple-50 border-purple-200 dark:bg-purple-900/20 dark:border-purple-800"
                      : "bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-700";
                    const badgeColor = isDoctor
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200"
                      : isPatient
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
                      : isAttendant
                      ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-200"
                      : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-200";
                    return (
                      <div
                        key={i}
                        className={`rounded-xl border p-2.5 ${bubbleBg}`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <select
                            value={entry.speaker === "UNKNOWN" ? "DOCTOR" : entry.speaker}
                            onChange={(e) =>
                              updateEntrySpeaker(
                                i,
                                e.target.value as "DOCTOR" | "PATIENT" | "ATTENDANT",
                              )
                            }
                            className={`text-[10px] font-semibold rounded-full px-2 py-0.5 border-0 cursor-pointer ${badgeColor}`}
                            aria-label={`Speaker for entry ${i + 1}`}
                          >
                            <option value="DOCTOR">Doctor</option>
                            <option value="PATIENT">Patient</option>
                            <option value="ATTENDANT">Attendant</option>
                          </select>
                          <span className="text-[10px] text-gray-400 flex-shrink-0">#{i + 1}</span>
                        </div>
                        <p className="text-xs text-gray-700 leading-relaxed break-words dark:text-gray-200">{entry.text}</p>
                      </div>
                    );
                  })}
                {/* Live interim — shows what's being spoken right now, in real
                    time, before it's finalized into an entry above. */}
                {liveText && liveText !== "🎤 Listening..." && (
                  <div className="rounded-xl border border-dashed border-emerald-300 bg-emerald-50/60 p-2.5 dark:border-emerald-700/60 dark:bg-emerald-900/15">
                    <span className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                      Speaking now
                    </span>
                    <p className="text-xs italic leading-relaxed break-words text-gray-600 dark:text-gray-300">
                      {liveText}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Right: SOAP draft ──────────────────────────── */}
        <div className="flex-1 flex flex-col bg-white rounded-2xl shadow border border-gray-100 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50 dark:border-gray-700 dark:from-blue-900/30 dark:to-indigo-900/30">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <p className="font-semibold text-sm text-gray-800 dark:text-gray-100">AI-Drafted SOAP Note</p>
              {isCompletedSession ? (
                <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full dark:bg-green-900/40 dark:text-green-300">
                  Completed
                </span>
              ) : sessionId && !viewingVisit ? (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full dark:bg-blue-900/40 dark:text-blue-300">
                  Auto-updating
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {isCompletedSession && editedSOAP && (
                <button
                  onClick={() => setIsEditMode((v) => !v)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    isEditMode
                      ? "bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100"
                      : "bg-gray-50 border-gray-300 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  {isEditMode ? "Stop Editing" : "Edit"}
                </button>
              )}
              {editedSOAP && !signedOff && !isCompletedSession && (
                <button
                  onClick={handleEnterReview}
                  disabled={loading}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <CheckCircle className="w-4 h-4" />
                  Review &amp; Sign Off
                </button>
              )}
              {editedSOAP && !signedOff && isCompletedSession && isEditMode && (
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
          </div>

          {viewingVisit ? (
            <div className="flex-1 overflow-y-auto p-4">
              <VisitDetail
                visit={viewingVisit}
                onBack={() => setViewingVisit(null)}
              />
            </div>
          ) : !sessionId ? (
            <div className="flex-1 flex items-center justify-center text-gray-400">
              <div className="text-center space-y-2">
                <Clipboard className="w-12 h-12 mx-auto opacity-30" />
                <p className="text-sm">
                  Select a patient and start the scribe to generate a SOAP note
                </p>
              </div>
            </div>
          ) : !soapHasContent && !isCompletedSession ? (
            <div className="flex-1 flex items-center justify-center text-gray-400">
              <div className="max-w-xs text-center space-y-2">
                <Loader2 className="w-8 h-8 mx-auto animate-spin text-blue-400" />
                <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
                  Listening to the consultation&hellip;
                </p>
                <p className="text-xs text-gray-400">
                  Your SOAP note drafts live and keeps updating as you and the
                  patient speak — just keep talking.
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
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 dark:text-gray-400">
                          Suggested ICD-10 Codes
                        </p>
                        <div className="space-y-1.5">
                          {editedSOAP.assessment.icd10Codes.map((code, i) => (
                            <div
                              key={i}
                              className="flex items-start gap-2 bg-orange-50 border border-orange-100 rounded-lg px-3 py-2 dark:bg-orange-900/20 dark:border-orange-800"
                            >
                              <span className="text-xs font-mono font-bold text-orange-700 dark:text-orange-300">
                                {code.code}
                              </span>
                              <div className="flex-1">
                                <p className="text-xs text-gray-700 dark:text-gray-200">{code.description}</p>
                                {code.evidenceSpan && (
                                  <p className="text-xs text-gray-400 italic mt-0.5 dark:text-gray-400">
                                    &ldquo;{code.evidenceSpan}&rdquo;
                                  </p>
                                )}
                              </div>
                              <span className="text-xs text-orange-600 dark:text-orange-300">
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
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 dark:text-gray-400">
                          Medications
                        </p>
                        <div className="space-y-1.5">
                          {editedSOAP.plan.medications.map((med, i) => (
                            <div
                              key={i}
                              className="bg-green-50 border border-green-100 rounded-lg px-3 py-2 dark:bg-green-900/20 dark:border-green-800"
                            >
                              <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{med.name}</p>
                              <p className="text-xs text-gray-600 dark:text-gray-300">
                                {med.dose} · {med.frequency} · {med.duration}
                              </p>
                              {med.notes && (
                                <p className="text-xs text-gray-400 mt-0.5 dark:text-gray-400">{med.notes}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  <EditableField
                    label="Investigations Ordered"
                    value={Array.isArray(editedSOAP?.plan?.investigations) ? editedSOAP.plan.investigations.join(", ") : editedSOAP?.plan?.investigations || ""}
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

        {/* ── Pearl §2.1.3 (gap row 46) Right rail: last 3 visits.
              Hidden on small screens (the page already crowds at <lg) and
              promoted to a third column at lg+. Click-to-paste wired into the
              active SOAP draft via handlePasteDiagnosis / handlePasteMedicine.
              Only rendered AFTER the scribe session has started (sessionId
              set) — pre-start it was an empty "No prior visits" panel sitting
              next to an empty SOAP placeholder, which looked broken. Now it
              shows up once the doctor actually starts the consult. */}
        {sessionId && (
          <div className="hidden lg:flex lg:w-80 lg:shrink-0 lg:flex-col lg:overflow-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <ConsultRightRail
              doctorId={selectedAppointment?.doctorId ?? null}
              patientId={selectedAppointment?.patientId ?? null}
              token={token}
              onPasteDiagnosis={handlePasteDiagnosis}
              onPasteMedicine={handlePasteMedicine}
              // AI scribe is voice/LLM-driven — click-to-paste favourites
              // aren't part of that workflow. Hide the card; keep the
              // Last-3-visits panel which is still useful context.
              hideFavourites
              // Scribe has no left-rail patient panel, so surface the patient
              // identity + last vitals here, above Last 3 visits.
              showLastVitals
              patient={
                selectedAppointment?.patient
                  ? {
                      name: selectedAppointment.patient.user?.name,
                      age: selectedAppointment.patient.age,
                      gender: selectedAppointment.patient.gender,
                      bloodGroup: selectedAppointment.patient.bloodGroup,
                      phone: selectedAppointment.patient.user?.phone,
                    }
                  : null
              }
              // Clicking a past visit opens its full detail in the main panel.
              onSelectVisit={setViewingVisit}
              // Full-height column: let Last 3 visits fill the leftover space
              // (scrolling its list) so the right-side cards stay fixed-height.
              fillLastVisits
            />
          </div>
        )}
      </div>
    </>
  );
}
