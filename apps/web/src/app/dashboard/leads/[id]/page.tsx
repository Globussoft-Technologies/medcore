"use client";

// Pearl §3.3 row 6 + row 7 (gaps closed 2026-05-29) — lead detail
// page. Closes the 404 the list page's "View" link was generating and
// adds the convert-to-patient modal + post-conversion redirect that
// prefills the booking form with the lead's preferredDoctorId.
//
// Backed by:
//   GET    /api/v1/leads/:id            — detail + activity timeline
//   PATCH  /api/v1/leads/:id            — status / assignment edits
//   POST   /api/v1/leads/:id/activities — append a NOTE to the timeline
//   POST   /api/v1/leads/:id/convert    — create User+Patient atomically,
//                                          stamp LEAD_CONVERT audit row,
//                                          returns the new patientId.
// On convert success the page navigates to
//   /dashboard/appointments?patientId=<new>&doctorId=<preferredDoctorId>
// so the booking form (which now reads those query params) lands
// pre-filled with the right patient + doctor.

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import {
  LEAD_STATUS_VALUES,
  type LeadStatus,
  type LeadSource,
} from "@medcore/shared";
import {
  ArrowLeft,
  CheckCircle2,
  MessageSquarePlus,
  UserPlus,
  Loader2,
} from "lucide-react";

interface LeadActivity {
  id: string;
  type: string;
  body: string | null;
  data: unknown;
  createdAt: string;
  authorUser?: { id: string; name: string; role: string } | null;
}

interface LeadDetail {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: LeadSource;
  status: LeadStatus;
  notes: string | null;
  createdAt: string;
  convertedPatientId: string | null;
  convertedAt: string | null;
  assignedToUser?: { id: string; name: string; role: string } | null;
  preferredDoctor?: {
    id: string;
    user: { name: string };
  } | null;
  preferredDoctorId?: string | null;
  convertedPatient?: {
    id: string;
    mrNumber: string;
    user: { name: string };
  } | null;
  activities: LeadActivity[];
}

const STATUS_COLORS: Record<LeadStatus, string> = {
  NEW: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  QUALIFIED: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
  ENGAGED: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
  BOOKED: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
  CONVERTED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
  LOST: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200",
};

// Lead activity icons + labels. Mirrors LeadActivityType in schema.prisma.
const ACTIVITY_LABELS: Record<string, string> = {
  STATUS_CHANGE: "Status changed",
  NOTE: "Note",
  CALL: "Call",
  MESSAGE: "Message",
  EMAIL: "Email",
  WHATSAPP_OUTBOUND: "WhatsApp sent",
  DOCTOR_ALLOCATION: "Doctor allocated",
  CONVERSION: "Converted to patient",
};

const WRITE_ROLES = new Set(["ADMIN", "RECEPTION", "DOCTOR"]);
const CONVERT_ROLES = new Set(["ADMIN", "RECEPTION"]);
// View access mirrors the list page + the Leads nav entry: only
// ADMIN + RECEPTION own the CRM pipeline. DOCTOR/NURSE/PATIENT are
// redirected to not-authorized (CLAUDE.md gotcha #7 — no client gate
// otherwise). Note: this is stricter than WRITE_ROLES, which still
// lists DOCTOR for the legacy note-append affordance.
const VIEW_ROLES = new Set(["ADMIN", "RECEPTION"]);

export default function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuthStore();
  const isAuthLoading = useAuthStore((s) => s.isLoading);
  const canWrite = !!user?.role && WRITE_ROLES.has(user.role);
  const canConvert = !!user?.role && CONVERT_ROLES.has(user.role);
  const canViewLead = !!user?.role && VIEW_ROLES.has(user.role);

  // Redirect non-allowlisted roles (DOCTOR / NURSE / PATIENT) before the
  // lead detail renders. Mirrors the list page + queue gate.
  useEffect(() => {
    if (!isAuthLoading && user && !canViewLead) {
      toast.error("Leads pipeline is reception/admin-only.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || `/dashboard/leads/${id}`)}`,
      );
    }
  }, [isAuthLoading, user, canViewLead, router, pathname, id]);

  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // Add-note state.
  const [noteBody, setNoteBody] = useState("");
  const [noteSubmitting, setNoteSubmitting] = useState(false);

  // Convert modal state.
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertForm, setConvertForm] = useState({
    gender: "" as "" | "MALE" | "FEMALE" | "OTHER",
    dateOfBirth: "",
    age: "",
    address: "",
  });
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{ data: LeadDetail }>(`/leads/${id}`);
      setLead(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load lead");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Skip the GET for non-allowlisted roles — it would 403 and toast a
    // spurious error during the redirect flicker.
    if (!canViewLead) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, canViewLead]);

  async function changeStatus(status: LeadStatus) {
    if (!lead || !canWrite) return;
    try {
      await api.patch(`/leads/${lead.id}`, { status });
      toast.success(`Status → ${status}`);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update status");
    }
  }

  async function addNote() {
    if (!lead || !canWrite || !noteBody.trim()) return;
    setNoteSubmitting(true);
    try {
      await api.post(`/leads/${lead.id}/activities`, {
        type: "NOTE",
        body: noteBody.trim(),
      });
      setNoteBody("");
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add note");
    } finally {
      setNoteSubmitting(false);
    }
  }

  async function handleConvert() {
    if (!lead) return;
    if (!convertForm.gender) {
      setConvertError("Gender is required.");
      return;
    }
    setConverting(true);
    setConvertError(null);
    try {
      const payload: Record<string, unknown> = {
        gender: convertForm.gender,
      };
      if (convertForm.dateOfBirth) payload.dateOfBirth = convertForm.dateOfBirth;
      if (convertForm.age) payload.age = Number(convertForm.age);
      if (convertForm.address.trim()) payload.address = convertForm.address.trim();

      const res = await api.post<{
        data: { convertedPatientId: string; preferredDoctorId: string | null };
      }>(`/leads/${lead.id}/convert`, payload);

      const newPatientId = res.data.convertedPatientId;
      const preferredDoctorId =
        res.data.preferredDoctorId ?? lead.preferredDoctorId ?? null;

      toast.success("Lead converted to patient");
      // Pearl §3.3 row 7 — prefill the booking form by passing
      // patientId + doctorId on the query string. The appointments
      // page reads these on mount and pre-fills the booking form.
      const qs = new URLSearchParams({ patientId: newPatientId });
      if (preferredDoctorId) qs.set("doctorId", preferredDoctorId);
      router.push(`/dashboard/appointments?${qs.toString()}`);
    } catch (err) {
      setConvertError(
        err instanceof Error ? err.message : "Failed to convert lead",
      );
    } finally {
      setConverting(false);
    }
  }

  const isConverted = useMemo(() => Boolean(lead?.convertedPatientId), [lead]);

  // Non-allowlisted roles are being redirected by the gate effect;
  // render nothing so the lead detail never flashes for them.
  if (!canViewLead) {
    return null;
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-gray-400">
        <Loader2 size={20} className="mr-2 animate-spin" />
        Loading…
      </div>
    );
  }
  if (!lead) {
    return <div className="p-12 text-gray-400">Lead not found.</div>;
  }

  return (
    <div className="p-6">
      <Link
        href="/dashboard/leads"
        className="mb-2 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft size={12} /> All leads
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {lead.name}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {lead.phone ? `${lead.phone} · ` : ""}
            {lead.email ? `${lead.email} · ` : ""}
            <span className="text-gray-400">Source: {lead.source}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_COLORS[lead.status]}`}
            data-testid="lead-status-pill"
          >
            {lead.status}
          </span>
          {!isConverted && canConvert && (
            <button
              onClick={() => setConvertOpen(true)}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
              data-testid="lead-convert-btn"
            >
              <UserPlus size={14} /> Convert to patient
            </button>
          )}
          {isConverted && lead.convertedPatient && (
            <Link
              href={`/dashboard/patients/${lead.convertedPatient.id}`}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200"
            >
              <CheckCircle2 size={14} />
              Patient {lead.convertedPatient.mrNumber}
            </Link>
          )}
        </div>
      </div>

      {/* Quick-action: status menu (when not converted). */}
      {!isConverted && canWrite && (
        <div className="mt-4 flex flex-wrap gap-1">
          {LEAD_STATUS_VALUES.filter((s) => s !== "CONVERTED").map((s) => (
            <button
              key={s}
              onClick={() => changeStatus(s)}
              disabled={s === lead.status}
              className={`rounded-md border border-gray-300 px-2 py-1 text-xs font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700`}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Meta */}
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Assigned to
          </p>
          <p className="mt-1 text-sm font-medium">
            {lead.assignedToUser?.name ?? (
              <span className="text-gray-400">Unassigned</span>
            )}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Preferred doctor
          </p>
          <p className="mt-1 text-sm font-medium">
            {lead.preferredDoctor?.user.name ?? (
              <span className="text-gray-400">—</span>
            )}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Created
          </p>
          <p className="mt-1 text-sm font-medium">
            {new Date(lead.createdAt).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </p>
        </div>
      </div>

      {lead.notes && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide">
            Notes
          </p>
          <p>{lead.notes}</p>
        </div>
      )}

      {/* Add-note */}
      {canWrite && (
        <div className="mt-6">
          <p className="mb-1 text-sm font-medium">Add note</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="e.g. Called — patient will visit Friday"
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
              data-testid="lead-note-input"
            />
            <button
              onClick={addNote}
              disabled={noteSubmitting || !noteBody.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="lead-note-submit"
            >
              <MessageSquarePlus size={14} />
              {noteSubmitting ? "Saving…" : "Add"}
            </button>
          </div>
        </div>
      )}

      {/* Activity timeline */}
      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-600">
          Activity ({lead.activities.length})
        </h2>
        {lead.activities.length === 0 ? (
          <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900/40">
            No activity yet.
          </p>
        ) : (
          <ol className="space-y-3">
            {lead.activities.map((a) => (
              <li
                key={a.id}
                className="rounded-md border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-800"
                data-testid={`lead-activity-${a.id}`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                    {ACTIVITY_LABELS[a.type] ?? a.type}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(a.createdAt).toLocaleString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                {a.body && (
                  <p className="text-sm text-gray-800 dark:text-gray-100">
                    {a.body}
                  </p>
                )}
                {a.authorUser && (
                  <p className="mt-1 text-xs text-gray-500">
                    by {a.authorUser.name} ({a.authorUser.role})
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Convert modal */}
      {convertOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            className="w-full max-h-[90vh] max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl dark:bg-gray-800"
            data-testid="lead-convert-modal"
          >
            <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-700">
              <h2 className="text-lg font-semibold">Convert to patient</h2>
              <p className="mt-1 text-xs text-gray-500">
                Creates a new patient record from this lead. Phone is
                reused; an MR number is auto-generated.
              </p>
            </div>
            <div className="space-y-3 p-6">
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Gender <span className="text-red-600">*</span>
                </label>
                <select
                  value={convertForm.gender}
                  onChange={(e) =>
                    setConvertForm({
                      ...convertForm,
                      gender: e.target.value as
                        | ""
                        | "MALE"
                        | "FEMALE"
                        | "OTHER",
                    })
                  }
                  data-testid="lead-convert-gender"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                >
                  <option value="">— Select —</option>
                  <option value="MALE">Male</option>
                  <option value="FEMALE">Female</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Date of birth
                  </label>
                  <input
                    type="date"
                    value={convertForm.dateOfBirth}
                    onChange={(e) =>
                      setConvertForm({
                        ...convertForm,
                        dateOfBirth: e.target.value,
                      })
                    }
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Age (years)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={130}
                    value={convertForm.age}
                    onChange={(e) =>
                      setConvertForm({ ...convertForm, age: e.target.value })
                    }
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Address
                </label>
                <textarea
                  value={convertForm.address}
                  onChange={(e) =>
                    setConvertForm({ ...convertForm, address: e.target.value })
                  }
                  rows={2}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                />
              </div>
              {convertError && (
                <p className="text-sm text-red-600" role="alert">
                  {convertError}
                </p>
              )}
              <p className="text-xs text-gray-500">
                After conversion you&apos;ll land on the booking form with
                {lead.preferredDoctor
                  ? ` Dr. ${lead.preferredDoctor.user.name}`
                  : " the patient"}{" "}
                pre-selected.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/40">
              <button
                onClick={() => {
                  setConvertOpen(false);
                  setConvertError(null);
                }}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={handleConvert}
                disabled={converting || !convertForm.gender}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                data-testid="lead-convert-submit"
              >
                {converting ? "Converting…" : "Convert"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
