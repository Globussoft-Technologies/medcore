"use client";

// Pearl ERP Stage 1 §2.1.3 — full-page consult history for a patient.
//
// What / which modules / why:
//   Dedicated route for browsing every SOAP consultation a patient has
//   accumulated. Complements the right-side drawer (quick peek from
//   the patient profile / appointments list) — this page is the
//   roomier read-everything surface for chart review.
//
//   Data: GET /consultations/by-patient/:patientId (same endpoint the
//   drawer uses). Each consult is rendered fully expanded — no
//   expand/collapse — so a doctor reading patient history doesn't
//   have to click each card.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { ArrowLeft, FileText, User, Calendar } from "lucide-react";
import { SkeletonCard, SkeletonText } from "@/components/Skeleton";

interface DiagnosisCode {
  code: string;
  description: string;
}

interface ConsultationDoctor {
  id: string;
  specialization: string | null;
  user: { name: string };
}

interface ConsultationAppointment {
  id: string;
  date: string;
  slotStart: string | null;
  status: string;
  tokenNumber: number | null;
}

interface ConsultationRow {
  id: string;
  appointmentId: string;
  doctorId: string;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  notes: string | null;
  findings: string | null;
  icd10Codes: DiagnosisCode[] | null;
  snomedCodes: DiagnosisCode[] | null;
  status: string;
  signedAt: string | null;
  createdAt: string;
  appointment?: ConsultationAppointment;
  doctor?: ConsultationDoctor;
}

interface PatientHead {
  id: string;
  mrNumber: string;
  user: { name: string; phone: string | null };
}

export default function PatientConsultsPage() {
  const params = useParams<{ id: string }>();
  const patientId = params?.id ?? "";

  const [rows, setRows] = useState<ConsultationRow[] | null>(null);
  const [patient, setPatient] = useState<PatientHead | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!patientId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [consults, pt] = await Promise.allSettled([
          api.get<{ data: ConsultationRow[] }>(
            `/consultations/by-patient/${patientId}`,
          ),
          api.get<{ data: PatientHead }>(`/patients/${patientId}`),
        ]);
        if (cancelled) return;
        if (consults.status === "fulfilled") {
          setRows(consults.value.data ?? []);
        } else {
          toast.error("Could not load consult history");
          setRows([]);
        }
        if (pt.status === "fulfilled") {
          setPatient(pt.value.data);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const signedCount = rows?.filter((c) => c.status === "SIGNED").length ?? 0;
  const draftCount = rows?.filter((c) => c.status !== "SIGNED").length ?? 0;

  return (
    <div className="min-h-full bg-gray-50 px-6 py-6 dark:bg-gray-900">
      {/* Header */}
      <div className="mx-auto max-w-5xl">
        <Link
          href={`/dashboard/patients/${patientId}`}
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to patient
        </Link>

        <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-b border-gray-200 pb-4 dark:border-gray-700">
          <div>
            <div className="flex items-center gap-2">
              <FileText className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                Consult History
              </h1>
            </div>
            {patient && (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {patient.user.name}
                <span className="mx-2 text-gray-300 dark:text-gray-600">|</span>
                MR {patient.mrNumber}
                {patient.user.phone ? (
                  <>
                    <span className="mx-2 text-gray-300 dark:text-gray-600">
                      |
                    </span>
                    {patient.user.phone}
                  </>
                ) : null}
              </p>
            )}
          </div>
          {rows && rows.length > 0 && (
            <div className="flex items-center gap-2">
              <Stat
                label="Total"
                value={rows.length.toString()}
                color="bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
              />
              <Stat
                label="Signed"
                value={signedCount.toString()}
                color="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
              />
              {draftCount > 0 && (
                <Stat
                  label="Drafts"
                  value={draftCount.toString()}
                  color="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                />
              )}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="mt-6 space-y-5">
          {loading && (
            <div
              data-testid="consults-skeleton"
              className="space-y-5"
              aria-busy="true"
            >
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
                >
                  <div className="mb-4 grid gap-4 sm:grid-cols-3">
                    <SkeletonCard />
                    <SkeletonCard />
                    <SkeletonCard />
                  </div>
                  <SkeletonText lines={3} />
                </div>
              ))}
            </div>
          )}
          {!loading && rows && rows.length === 0 && (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-12 text-center dark:border-gray-700 dark:bg-gray-800">
              <FileText className="mx-auto h-10 w-10 text-gray-300" />
              <p className="mt-3 text-sm font-medium text-gray-700 dark:text-gray-200">
                No consultation notes yet.
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Notes appear here after a doctor records and signs a
                consultation for this patient.
              </p>
            </div>
          )}
          {!loading && rows && rows.length > 0 && (
            <>
              {rows.map((c) => (
                <FullConsultCard key={c.id} c={c} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${color}`}
    >
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </span>
  );
}

function FullConsultCard({ c }: { c: ConsultationRow }) {
  const dateStr = c.appointment?.date
    ? new Date(c.appointment.date).toLocaleDateString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : new Date(c.createdAt).toLocaleDateString();
  const doctorName = c.doctor?.user.name ?? "—";
  const specialization = c.doctor?.specialization ?? null;
  const hasCodes =
    (c.icd10Codes && c.icd10Codes.length > 0) ||
    (c.snomedCodes && c.snomedCodes.length > 0);
  const isEmpty =
    !c.subjective &&
    !c.objective &&
    !c.assessment &&
    !c.plan &&
    !c.notes &&
    !c.findings &&
    !hasCodes;

  return (
    <article className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      {/* Card header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-gradient-to-r from-gray-50 to-white px-5 py-3 dark:border-gray-700 dark:from-gray-900 dark:to-gray-800">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Calendar className="h-4 w-4 text-gray-500" />
            {dateStr}
            {c.appointment?.slotStart ? ` · ${c.appointment.slotStart}` : ""}
          </span>
          <span className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300">
            <User className="h-4 w-4 text-gray-500" />
            {doctorName}
            {specialization ? (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                · {specialization}
              </span>
            ) : null}
          </span>
          {c.appointment?.tokenNumber != null && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200">
              T-{c.appointment.tokenNumber}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase ${
              c.status === "SIGNED"
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
                : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            }`}
          >
            {c.status === "SIGNED" ? "✓ Signed" : "Draft"}
          </span>
        </div>
      </header>

      {/* Body */}
      {isEmpty ? (
        <p className="px-5 py-8 text-center text-sm italic text-gray-400">
          No clinical notes recorded for this encounter.
        </p>
      ) : (
        <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
          {c.subjective && <SoapTile label="Subjective" body={c.subjective} />}
          {c.objective && <SoapTile label="Objective" body={c.objective} />}
          {c.assessment && (
            <SoapTile label="Assessment" body={c.assessment} />
          )}
          {c.plan && <SoapTile label="Plan" body={c.plan} />}
          {(c.notes || c.findings) && (
            <div className="md:col-span-2 grid gap-4 md:grid-cols-2">
              {c.findings && (
                <SoapTile label="Findings (legacy)" body={c.findings} />
              )}
              {c.notes &&
                (parseLegacyAIScribeNote(c.notes) ? (
                  // Old AI-scribe notes were dumped into `notes` as
                  // "[AI Scribe — Doctor Approved]\n\nSubjective:
                  // {...JSON...}\nObjective: {...}\nAssessment: …\n
                  // Plan: {...}". Parse and render structured.
                  <LegacyAIScribeNote raw={c.notes} />
                ) : (
                  <SoapTile label="Notes (legacy)" body={c.notes} />
                ))}
            </div>
          )}
          {hasCodes && (
            <div className="md:col-span-2 mt-1 border-t border-gray-100 pt-3 dark:border-gray-700">
              {c.icd10Codes && c.icd10Codes.length > 0 && (
                <CodeChips label="ICD-10" codes={c.icd10Codes} color="indigo" />
              )}
              {c.snomedCodes && c.snomedCodes.length > 0 && (
                <CodeChips label="SNOMED" codes={c.snomedCodes} color="teal" />
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// Parse a SOAP column's body that the consult editor writes as
// markdown-sectioned text (`## Chief Complaint\n…\n\n## HPI\n…`) into
// an array of { label, body } pairs for nicer rendering. Falls back to
// a single section with the original body so legacy plain-text rows
// don't render as a confusing empty block.
function parseSoapSubsections(
  text: string,
): Array<{ label: string | null; body: string }> {
  const out: Array<{ label: string | null; body: string }> = [];
  const regex = /^## (.+?)\r?\n([\s\S]*?)(?=\r?\n## |$)/gm;
  let m: RegExpExecArray | null;
  let anyMatched = false;
  while ((m = regex.exec(text)) !== null) {
    const label = m[1].trim();
    const body = m[2].trim();
    if (body) out.push({ label, body });
    anyMatched = true;
  }
  if (!anyMatched) {
    const trimmed = text.trim();
    if (trimmed) out.push({ label: null, body: trimmed });
  }
  return out;
}

function SoapTile({ label, body }: { label: string; body: string }) {
  const subs = parseSoapSubsections(body);
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800/60">
      {/* Parent SOAP section label (Subjective / Objective / …) */}
      <p className="border-b border-gray-100 pb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-primary dark:border-gray-700 dark:text-blue-300">
        {label}
      </p>
      {/* Sub-sections rendered as a definition-list-style stack:
            label = small-caps muted accent, body = main text colour.
            The visual difference between the SOAP heading (bold caps,
            colored, underlined) and the sub-label (smaller caps,
            muted) makes the hierarchy obvious in both themes. */}
      <dl className="mt-3 space-y-3">
        {subs.map((s, i) => (
          <div key={i}>
            {s.label && (
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {s.label}
              </dt>
            )}
            <dd className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-gray-900 dark:text-gray-100">
              {s.body}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CodeChips({
  label,
  codes,
  color,
}: {
  label: string;
  codes: DiagnosisCode[];
  color: "indigo" | "teal";
}) {
  const chip =
    color === "indigo"
      ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200"
      : "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </span>
      {codes.map((c) => (
        <span
          key={c.code}
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${chip}`}
        >
          <span className="font-mono">{c.code}</span>
          <span>{c.description}</span>
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Legacy AI Scribe note renderer.
//
// Pre-§2.1.3, AI-scribe finalize dumped the SOAP draft as a single
// "[AI Scribe — Doctor Approved]\n\nSubjective: {…JSON…}\nObjective:
// {…}\nAssessment: free text\nPlan: {…}" blob into Consultation.notes.
// Without parsing, the consult history rendered the raw JSON.
//
// `parseLegacyAIScribeNote` returns a structured view of those rows,
// or null if the text is plain prose (newer rows just write to
// subjective/objective/assessment/plan columns directly).
// ─────────────────────────────────────────────────────────────────────
interface LegacyAIScribePayload {
  approved: boolean;
  subjective: Record<string, unknown> | null;
  objective: Record<string, unknown> | null;
  assessment: string | null;
  plan: Record<string, unknown> | null;
}

function parseLegacyAIScribeNote(
  text: string | null | undefined,
): LegacyAIScribePayload | null {
  if (!text) return null;
  if (!/\[AI Scribe/i.test(text)) return null;

  const out: LegacyAIScribePayload = {
    approved: /Doctor Approved/i.test(text),
    subjective: null,
    objective: null,
    assessment: null,
    plan: null,
  };

  // Split on the four section markers. Each section's value can
  // span multiple lines (JSON pretty-printed or wrapped).
  const sections = ["Subjective", "Objective", "Assessment", "Plan"];
  for (let i = 0; i < sections.length; i++) {
    const name = sections[i];
    const next = sections.slice(i + 1).join("|");
    const re = next
      ? new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n(?:${next}):|$)`, "i")
      : new RegExp(`${name}:\\s*([\\s\\S]*?)$`, "i");
    const m = text.match(re);
    if (!m) continue;
    const raw = m[1].trim();
    if (!raw) continue;
    if (name === "Assessment") {
      out.assessment = raw;
      continue;
    }
    // Subjective / Objective / Plan are JSON-encoded.
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw);
        if (name === "Subjective") out.subjective = parsed;
        else if (name === "Objective") out.objective = parsed;
        else if (name === "Plan") out.plan = parsed;
      } catch {
        // Malformed JSON — leave as null; caller falls back to raw.
      }
    }
  }

  // If we couldn't extract ANY section, treat as "not parseable" so
  // the caller renders the raw blob (better than an empty panel).
  if (!out.subjective && !out.objective && !out.assessment && !out.plan) {
    return null;
  }
  return out;
}

function LegacyAIScribeNote({ raw }: { raw: string }) {
  const parsed = parseLegacyAIScribeNote(raw);
  if (!parsed) return <SoapTile label="Notes (legacy)" body={raw} />;
  return (
    <div className="md:col-span-2 rounded-xl border border-amber-200 bg-amber-50/40 p-4 shadow-sm dark:border-amber-700/50 dark:bg-amber-900/10">
      <div className="mb-3 flex items-center gap-2 border-b border-amber-200 pb-2 dark:border-amber-700/40">
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-amber-700 dark:text-amber-300">
          AI Scribe note (legacy)
        </p>
        {parsed.approved && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
            ✓ Doctor approved
          </span>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {parsed.subjective && (
          <LegacyAIScribeSection
            title="Subjective"
            entries={readableEntries(parsed.subjective)}
          />
        )}
        {parsed.objective && (
          <LegacyAIScribeSection
            title="Objective"
            entries={readableEntries(parsed.objective)}
          />
        )}
        {parsed.assessment && (
          <LegacyAIScribeSection
            title="Assessment"
            entries={[{ label: "Impression", body: parsed.assessment }]}
          />
        )}
        {parsed.plan && (
          <LegacyAIScribeSection
            title="Plan"
            entries={readableEntries(parsed.plan)}
          />
        )}
      </div>
    </div>
  );
}

function LegacyAIScribeSection({
  title,
  entries,
}: {
  title: string;
  entries: Array<{ label: string; body: string }>;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800/60">
      <p className="border-b border-gray-100 pb-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-primary dark:border-gray-700 dark:text-blue-300">
        {title}
      </p>
      <dl className="mt-2 space-y-2">
        {entries.map((e, i) => (
          <div key={i}>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {e.label}
            </dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-gray-900 dark:text-gray-100">
              {e.body}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// Normalize a parsed AI-scribe section object into a readable
// label/value list. Skips internal-only fields (confidence,
// evidenceSpan), formats arrays/objects sensibly.
function readableEntries(
  obj: Record<string, unknown>,
): Array<{ label: string; body: string }> {
  const HIDDEN = new Set(["confidence", "evidenceSpan"]);
  const out: Array<{ label: string; body: string }> = [];
  for (const [key, value] of Object.entries(obj)) {
    if (HIDDEN.has(key)) continue;
    if (value === null || value === undefined) continue;
    const label = humaniseKey(key);
    const body = formatValue(value);
    if (!body) continue;
    out.push({ label, body });
  }
  return out;
}

function humaniseKey(key: string): string {
  // chiefComplaint → Chief Complaint, hpi → HPI, etc.
  if (key === "hpi") return "History of Present Illness";
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    // Array of strings (allergies / investigations / referrals etc).
    if (value.every((v) => typeof v === "string")) {
      return (value as string[]).filter(Boolean).join(", ");
    }
    // Array of medication-like objects: name · dose · frequency · duration.
    if (value.every((v) => v && typeof v === "object")) {
      return (value as Array<Record<string, unknown>>)
        .map((m) => {
          const parts: string[] = [];
          if (typeof m.name === "string") parts.push(m.name);
          if (typeof m.dose === "string" && m.dose) parts.push(m.dose);
          if (typeof m.frequency === "string" && m.frequency)
            parts.push(m.frequency);
          if (typeof m.duration === "string" && m.duration)
            parts.push(m.duration);
          const head = parts.join(" · ");
          const note =
            typeof m.notes === "string" && m.notes
              ? ` — ${m.notes}`
              : "";
          return head + note;
        })
        .filter(Boolean)
        .join("\n");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
