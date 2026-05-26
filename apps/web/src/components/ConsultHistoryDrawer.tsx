"use client";

// Pearl ERP Stage 1 §2.1.3 — Consult History drawer.
//
// What / which modules / why:
//   Reusable right-side drawer that lists every Consultation row for
//   either (a) one patient (`mode="patient"` → /consultations/by-patient/:id)
//   or (b) one appointment (`mode="appointment"` → /consultations/by-appointment/:id).
//   Renders the SOAP fields, ICD-10 + SNOMED code chips, doctor + date
//   header. Read-only — editing happens on /dashboard/consult.
//
//   Mounted by:
//     - apps/web/src/app/dashboard/patients/[id]/page.tsx
//         "Consult History" action button (doctor view, all encounters)
//     - apps/web/src/app/dashboard/my-appointments/page.tsx
//         per-row "View Notes" action on Past tab (patient view, one encounter)

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { X, FileText, User, Calendar } from "lucide-react";

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

export interface ConsultationRow {
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

export type ConsultHistoryMode =
  | { kind: "patient"; patientId: string }
  | { kind: "appointment"; appointmentId: string };

export interface ConsultHistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  mode: ConsultHistoryMode;
  title?: string;
}

export function ConsultHistoryDrawer({
  open,
  onClose,
  mode,
  title,
}: ConsultHistoryDrawerProps) {
  const [rows, setRows] = useState<ConsultationRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        if (mode.kind === "patient") {
          const res = await api.get<{ data: ConsultationRow[] }>(
            `/consultations/by-patient/${mode.patientId}`,
          );
          if (!cancelled) setRows(res.data ?? []);
        } else {
          const res = await api.get<{ data: ConsultationRow }>(
            `/consultations/by-appointment/${mode.appointmentId}`,
          );
          if (!cancelled) setRows(res.data ? [res.data] : []);
        }
      } catch (err) {
        if (!cancelled) {
          // 404 with the "no consultation" / "not yet finalized" body
          // is a normal empty state for patients — treat it as zero
          // rows, not a red error block. Anything else (auth, server)
          // surfaces as a real error.
          const msg = err instanceof Error ? err.message : "";
          const isEmpty404 =
            /no consultation notes|not yet finalized/i.test(msg);
          if (isEmpty404) {
            setRows([]);
          } else {
            setError(msg || "Could not load history");
            setRows([]);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode]);

  if (!open) return null;

  const drawerTitle =
    title ?? (mode.kind === "patient" ? "Consult History" : "Consult Notes");

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer panel */}
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col bg-white shadow-2xl dark:bg-gray-900"
        role="dialog"
        aria-label={drawerTitle}
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {drawerTitle}
            </h2>
            {rows && rows.length > 0 && (
              <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                {rows.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 [scrollbar-width:thin]">
          {loading && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Loading…
            </p>
          )}
          {!loading && error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200">
              {error}
            </div>
          )}
          {!loading && !error && rows && rows.length === 0 && (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-8 text-center dark:border-gray-700 dark:bg-gray-800/50">
              <FileText className="mx-auto h-8 w-8 text-gray-300" />
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                No consultation notes yet.
              </p>
            </div>
          )}
          {!loading && !error && rows && rows.length > 0 && (
            <div className="space-y-4">
              {rows.map((c) => (
                <ConsultationCard key={c.id} c={c} />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function ConsultationCard({ c }: { c: ConsultationRow }) {
  const date = c.appointment?.date
    ? new Date(c.appointment.date).toLocaleDateString()
    : new Date(c.createdAt).toLocaleDateString();
  const doctorName = c.doctor?.user.name ?? "—";
  const specialization = c.doctor?.specialization ?? null;
  const empty =
    !c.subjective &&
    !c.objective &&
    !c.assessment &&
    !c.plan &&
    !c.notes &&
    !c.findings &&
    (!c.icd10Codes || c.icd10Codes.length === 0) &&
    (!c.snomedCodes || c.snomedCodes.length === 0);

  return (
    <article className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-700">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
            <Calendar className="h-3.5 w-3.5" />
            {date}
            {c.appointment?.slotStart ? ` · ${c.appointment.slotStart}` : ""}
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
            <User className="h-3.5 w-3.5" />
            {doctorName}
            {specialization ? ` · ${specialization}` : ""}
          </span>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
            c.status === "SIGNED"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
              : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
          }`}
        >
          {c.status === "SIGNED" ? "Signed" : "Draft"}
        </span>
      </header>

      {empty ? (
        <p className="px-4 py-6 text-center text-xs italic text-gray-400">
          No notes recorded.
        </p>
      ) : (
        <div className="space-y-3 px-4 py-3">
          {c.subjective && (
            <SoapBlock label="Subjective" body={c.subjective} />
          )}
          {c.objective && <SoapBlock label="Objective" body={c.objective} />}
          {c.assessment && (
            <SoapBlock label="Assessment" body={c.assessment} />
          )}
          {c.plan && <SoapBlock label="Plan" body={c.plan} />}
          {(c.icd10Codes && c.icd10Codes.length > 0) ||
          (c.snomedCodes && c.snomedCodes.length > 0) ? (
            <div className="border-t border-gray-100 pt-3 dark:border-gray-700">
              {c.icd10Codes && c.icd10Codes.length > 0 && (
                <CodeRow label="ICD-10" codes={c.icd10Codes} color="indigo" />
              )}
              {c.snomedCodes && c.snomedCodes.length > 0 && (
                <CodeRow label="SNOMED" codes={c.snomedCodes} color="teal" />
              )}
            </div>
          ) : null}
        </div>
      )}
    </article>
  );
}

function SoapBlock({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-800 dark:text-gray-200">
        {body}
      </p>
    </div>
  );
}

function CodeRow({
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
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}:
      </span>
      {codes.map((c) => (
        <span
          key={c.code}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${chip}`}
        >
          <span className="font-mono">{c.code}</span>
          <span title={c.description} className="max-w-[160px] truncate">
            {c.description}
          </span>
        </span>
      ))}
    </div>
  );
}
