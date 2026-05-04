"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { extractFieldErrors } from "@/lib/field-errors";
import { usePrompt } from "@/lib/use-dialog";
import { formatDoctorName } from "@/lib/format-doctor-name";
import {
  ArrowLeft,
  Scissors,
  User,
  Stethoscope,
  Building,
  Clock,
  CheckCircle2,
  XCircle,
  PlayCircle,
  DollarSign,
} from "lucide-react";

interface Surgery {
  id: string;
  caseNumber: string;
  procedure: string;
  scheduledAt: string;
  durationMin?: number | null;
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "POSTPONED";
  anaesthesiologist?: string | null;
  assistants?: string | null;
  preOpNotes?: string | null;
  postOpNotes?: string | null;
  diagnosis?: string | null;
  cost?: number | null;
  consentSigned?: boolean;
  npoSince?: string | null;
  allergiesVerified?: boolean;
  antibioticsGiven?: boolean;
  antibioticsAt?: string | null;
  siteMarked?: boolean;
  bloodReserved?: boolean;
  anesthesiaStartAt?: string | null;
  anesthesiaEndAt?: string | null;
  incisionAt?: string | null;
  closureAt?: string | null;
  complications?: string | null;
  complicationSeverity?: string | null;
  bloodLossMl?: number | null;
  ssiDetected?: boolean;
  ssiType?: string | null;
  ssiDetectedDate?: string | null;
  ssiTreatment?: string | null;
  patient: {
    id: string;
    mrNumber?: string;
    age?: number;
    gender?: string;
    bloodGroup?: string;
    user: { name: string; phone?: string; email?: string };
  };
  surgeon: {
    id: string;
    specialization?: string;
    user: { name: string; email?: string };
  };
  ot: {
    id: string;
    name: string;
    floor?: string | null;
    equipment?: string | null;
    dailyRate: number;
  };
}

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-yellow-100 text-yellow-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-red-100 text-red-700",
  POSTPONED: "bg-gray-100 text-gray-700",
  MISSED_SCHEDULE: "bg-orange-100 text-orange-700",
};

// Issue #86: a SCHEDULED surgery whose scheduledAt is > 30 min in the past
// should display as MISSED_SCHEDULE in the UI even though the database row
// is still SCHEDULED (no enum migration). The doctor can still Start it for
// late-running emergencies — this is purely a labelling fix.
const STALE_GRACE_MIN = 30;
function effectiveSurgeryStatus(s: { status: string; scheduledAt: string }): string {
  if (s.status !== "SCHEDULED") return s.status;
  const t = new Date(s.scheduledAt).getTime();
  if (Number.isNaN(t)) return s.status;
  if (Date.now() - t > STALE_GRACE_MIN * 60 * 1000) return "MISSED_SCHEDULE";
  return s.status;
}

export default function SurgeryDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const promptUser = usePrompt();
  const [surgery, setSurgery] = useState<Surgery | null>(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [notes, setNotes] = useState({ preOpNotes: "", postOpNotes: "", diagnosis: "" });

  // Issue #459 (A5 RBAC drift, May 2026): NURSE is allowed server-side on
  // PATCH /surgery/:id and on the peri-op endpoints (preop/observations/
  // anesthesia-record — see surgery.ts:371,613,660,968,1070). Nurses are the
  // primary recorder for pre-op checklists and PACU observations, so the
  // page-level Edit gate must include NURSE; otherwise the entire detail
  // page becomes read-only for them.
  const canEdit =
    user?.role === "DOCTOR" ||
    user?.role === "ADMIN" ||
    user?.role === "NURSE";

  const loadSurgery = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Surgery }>(`/surgery/${params.id}`);
      setSurgery(res.data);
      setNotes({
        preOpNotes: res.data.preOpNotes || "",
        postOpNotes: res.data.postOpNotes || "",
        diagnosis: res.data.diagnosis || "",
      });
    } catch (err) {
      // Issue #86: previously this swallowed every error and rendered "not
      // found" — masking 503/RSC/server errors. Toast the underlying message
      // and keep `surgery` null so the not-found block renders.
      setSurgery(null);
      const msg = err instanceof Error ? err.message : "Failed to load surgery";
      // Skip the toast for plain 404s — the inline "not found" view is enough.
      if ((err as { status?: number })?.status !== 404) {
        toast.error(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    loadSurgery();
  }, [loadSurgery]);

  async function saveNotes() {
    if (!surgery) return;
    try {
      await api.patch(`/surgery/${surgery.id}`, notes);
      setEditMode(false);
      loadSurgery();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function startSurgery() {
    if (!surgery) return;
    try {
      await api.patch(`/surgery/${surgery.id}/start`, {});
      loadSurgery();
    } catch (err) {
      // Issue #86: surface zod field errors AND the `missing` checklist array
      // so the user sees what blocked the start instead of a silent failure.
      const fields = extractFieldErrors(err);
      if (fields) {
        toast.error(Object.values(fields)[0] || "Start failed");
        return;
      }
      const payload = (err as { payload?: { missing?: string[]; error?: string } })
        ?.payload;
      if (payload?.missing && Array.isArray(payload.missing) && payload.missing.length > 0) {
        toast.error(`Pre-op checklist incomplete: ${payload.missing.join(", ")}`);
        return;
      }
      toast.error(payload?.error || (err instanceof Error ? err.message : "Start failed"));
    }
  }

  async function completeSurgery() {
    if (!surgery) return;
    try {
      await api.patch(`/surgery/${surgery.id}/complete`, {
        postOpNotes: notes.postOpNotes || undefined,
        diagnosis: notes.diagnosis || undefined,
      });
      loadSurgery();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Complete failed");
    }
  }

  async function cancelSurgery() {
    if (!surgery) return;
    const reason = await promptUser({
      title: "Cancel surgery",
      label: "Cancellation reason",
      required: true,
      multiline: true,
    });
    if (!reason) return;
    try {
      await api.patch(`/surgery/${surgery.id}/cancel`, { reason });
      loadSurgery();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  }

  if (!surgery) {
    return (
      <div className="p-8 text-center text-gray-500">
        Surgery not found.
        <div className="mt-4">
          <Link href="/dashboard/surgery" className="text-primary hover:underline">
            ← Back to Surgery
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <button
            onClick={() => router.push("/dashboard/surgery")}
            className="mb-2 flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
          >
            <ArrowLeft size={14} /> Back to Surgery
          </button>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Scissors size={22} /> {surgery.caseNumber}
          </h1>
          <p className="text-sm text-gray-500">{surgery.procedure}</p>
        </div>
        <div className="flex items-center gap-3">
          {(() => {
            const eff = effectiveSurgeryStatus(surgery);
            return (
              <span
                data-testid="surgery-detail-status"
                className={`rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[eff] || STATUS_COLORS[surgery.status]}`}
              >
                {eff.replace("_", " ")}
              </span>
            );
          })()}
        </div>
      </div>

      {/* Info cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700">
            <User size={16} /> Patient
          </div>
          <p className="font-medium">{surgery.patient.user.name}</p>
          <p className="text-xs text-gray-500">{surgery.patient.mrNumber}</p>
          <p className="mt-2 text-xs text-gray-600">
            {surgery.patient.age ? `${surgery.patient.age} yrs · ` : ""}
            {surgery.patient.gender || ""} {surgery.patient.bloodGroup ? `· ${surgery.patient.bloodGroup}` : ""}
          </p>
          {surgery.patient.user.phone && (
            <p className="text-xs text-gray-500">{surgery.patient.user.phone}</p>
          )}
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700">
            <Stethoscope size={16} /> Surgeon
          </div>
          <p className="font-medium">{formatDoctorName(surgery.surgeon.user.name)}</p>
          {surgery.surgeon.specialization && (
            <p className="text-xs text-gray-500">
              {surgery.surgeon.specialization}
            </p>
          )}
          {surgery.anaesthesiologist && (
            <p className="mt-2 text-xs text-gray-600">
              <span className="text-gray-500">Anaesthesiologist:</span>{" "}
              {surgery.anaesthesiologist}
            </p>
          )}
          {surgery.assistants && (
            <p className="text-xs text-gray-600">
              <span className="text-gray-500">Assistants:</span> {surgery.assistants}
            </p>
          )}
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700">
            <Building size={16} /> Operating Theater
          </div>
          <p className="font-medium">{surgery.ot.name}</p>
          {surgery.ot.floor && (
            <p className="text-xs text-gray-500">Floor {surgery.ot.floor}</p>
          )}
          {surgery.ot.equipment && (
            <p className="mt-2 text-xs text-gray-600">{surgery.ot.equipment}</p>
          )}
          <p className="mt-2 text-xs text-gray-500">
            Daily Rate: ₹{surgery.ot?.dailyRate ?? "—"}
          </p>
        </div>
      </div>

      {/* Timeline */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-700">
          <Clock size={16} /> Timeline
        </h2>
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-xs text-gray-500">Scheduled</p>
            <p className="text-sm font-medium">
              {new Date(surgery.scheduledAt).toLocaleString()}
            </p>
            {surgery.durationMin && (
              <p className="text-xs text-gray-500">~{surgery.durationMin} min</p>
            )}
          </div>
          <div>
            <p className="text-xs text-gray-500">Started</p>
            <p className="text-sm font-medium">
              {surgery.actualStartAt
                ? new Date(surgery.actualStartAt).toLocaleString()
                : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Ended</p>
            <p className="text-sm font-medium">
              {surgery.actualEndAt
                ? new Date(surgery.actualEndAt).toLocaleString()
                : "—"}
            </p>
          </div>
          {surgery.actualStartAt && surgery.actualEndAt && (
            <div>
              <p className="text-xs text-gray-500">Actual Duration</p>
              <p className="text-sm font-medium">
                {Math.round(
                  (new Date(surgery.actualEndAt).getTime() -
                    new Date(surgery.actualStartAt).getTime()) /
                    60000
                )}{" "}
                min
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Pre-op Checklist */}
      <PreOpChecklistCard surgery={surgery} canEdit={canEdit} onUpdate={loadSurgery} />

      {/* Complications */}
      {(surgery.complications || surgery.status === "COMPLETED") && (
        <ComplicationsCard surgery={surgery} canEdit={canEdit} onUpdate={loadSurgery} />
      )}

      {/* Notes */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Clinical Notes</h2>
          {canEdit && (
            <div className="flex gap-2">
              {!editMode ? (
                <button
                  onClick={() => setEditMode(true)}
                  className="rounded bg-gray-100 px-3 py-1 text-xs hover:bg-gray-200"
                >
                  Edit Notes
                </button>
              ) : (
                <>
                  <button
                    onClick={() => {
                      setEditMode(false);
                      setNotes({
                        preOpNotes: surgery.preOpNotes || "",
                        postOpNotes: surgery.postOpNotes || "",
                        diagnosis: surgery.diagnosis || "",
                      });
                    }}
                    className="rounded border px-3 py-1 text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveNotes}
                    className="rounded bg-primary px-3 py-1 text-xs text-white"
                  >
                    Save
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <p className="mb-1 text-xs font-medium text-gray-500">Diagnosis</p>
            {editMode ? (
              <input
                type="text"
                value={notes.diagnosis}
                onChange={(e) =>
                  setNotes((n) => ({ ...n, diagnosis: e.target.value }))
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            ) : (
              <p className="rounded-lg bg-gray-50 p-3 text-sm">
                {surgery.diagnosis || "—"}
              </p>
            )}
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-gray-500">Pre-Op Notes</p>
            {editMode ? (
              <textarea
                value={notes.preOpNotes}
                onChange={(e) =>
                  setNotes((n) => ({ ...n, preOpNotes: e.target.value }))
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
                rows={3}
              />
            ) : (
              <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm">
                {surgery.preOpNotes || "—"}
              </p>
            )}
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-gray-500">Post-Op Notes</p>
            {editMode ? (
              <textarea
                value={notes.postOpNotes}
                onChange={(e) =>
                  setNotes((n) => ({ ...n, postOpNotes: e.target.value }))
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
                rows={4}
              />
            ) : (
              <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm">
                {surgery.postOpNotes || "—"}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Cost */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700">
          <DollarSign size={16} /> Cost Breakdown
        </h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">OT Daily Rate</span>
            <span>
              {/* Issue #86: harden null deref — historically threw inside RSC
                  render when an OT had no dailyRate, surfacing as a 503. */}
              {surgery.ot && typeof surgery.ot.dailyRate === "number"
                ? `₹${surgery.ot.dailyRate.toFixed(2)}`
                : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Procedure Cost</span>
            <span>
              {surgery.cost != null ? `₹${surgery.cost.toFixed(2)}` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* SSI Alert Banner */}
      {surgery.ssiDetected && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border-l-4 border-red-500 bg-red-50 p-4 text-sm text-red-900">
          <span className="font-semibold">⚠ SSI Detected</span>
          <span>
            Type: <b>{surgery.ssiType}</b>
            {surgery.ssiDetectedDate && (
              <> · Detected: {new Date(surgery.ssiDetectedDate).toLocaleDateString()}</>
            )}
            {surgery.ssiTreatment && <> · Treatment: {surgery.ssiTreatment}</>}
          </span>
        </div>
      )}

      <AnesthesiaCard surgeryId={surgery.id} canEdit={canEdit} />

      <BloodAvailabilityCard surgeryId={surgery.id} canEdit={canEdit} />

      <PacuObservationsCard surgeryId={surgery.id} canEdit={canEdit} />

      <SsiReportCard surgery={surgery} canEdit={canEdit} onUpdate={loadSurgery} />

      {/* Actions */}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {/* Issue #148: hide "Start Surgery" once the case has slipped past
              its grace window. The doctor must Cancel (or Reschedule via the
              Cancel-then-create flow) instead of starting a stale slot. */}
          {surgery.status === "SCHEDULED" && effectiveSurgeryStatus(surgery) !== "MISSED_SCHEDULE" && (
            <>
              <button
                onClick={startSurgery}
                className="flex items-center gap-1 rounded-lg bg-yellow-500 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-600"
              >
                <PlayCircle size={16} /> Start Surgery
              </button>
              <button
                onClick={cancelSurgery}
                className="flex items-center gap-1 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
              >
                <XCircle size={16} /> Cancel
              </button>
            </>
          )}
          {surgery.status === "SCHEDULED" && effectiveSurgeryStatus(surgery) === "MISSED_SCHEDULE" && (
            <button
              onClick={cancelSurgery}
              className="flex items-center gap-1 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
              data-testid="cancel-missed-surgery"
            >
              <XCircle size={16} /> Cancel (Missed)
            </button>
          )}
          {surgery.status === "IN_PROGRESS" && (
            <button
              onClick={completeSurgery}
              className="flex items-center gap-1 rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600"
            >
              <CheckCircle2 size={16} /> Complete Surgery
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PreOpChecklistCard({
  surgery,
  canEdit,
  onUpdate,
}: {
  surgery: Surgery;
  canEdit: boolean;
  onUpdate: () => void;
}) {
  const [saving, setSaving] = useState(false);
  async function toggle(field: string, value: boolean) {
    if (!canEdit) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { [field]: value };
      if (field === "antibioticsGiven" && value) {
        payload.antibioticsAt = new Date().toISOString();
      }
      await api.patch(`/surgery/${surgery.id}/preop`, payload);
      onUpdate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
    setSaving(false);
  }
  const items: Array<{ key: keyof Surgery; label: string }> = [
    { key: "consentSigned", label: "Consent signed" },
    { key: "allergiesVerified", label: "Allergies verified" },
    { key: "antibioticsGiven", label: "Prophylactic antibiotics given" },
    { key: "siteMarked", label: "Surgical site marked" },
    { key: "bloodReserved", label: "Blood products reserved" },
  ];
  const done = items.filter((i) => !!surgery[i.key]).length;
  return (
    <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">
          Pre-Op Checklist
        </h2>
        <span className="text-xs text-gray-500">
          {done}/{items.length} complete
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {items.map((it) => (
          <label
            key={String(it.key)}
            className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          >
            <input
              type="checkbox"
              checked={!!surgery[it.key]}
              disabled={!canEdit || saving}
              onChange={(e) => toggle(String(it.key), e.target.checked)}
            />
            <span>{it.label}</span>
          </label>
        ))}
        {surgery.npoSince && (
          <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 md:col-span-2">
            NPO since: {new Date(surgery.npoSince).toLocaleString()}
          </div>
        )}
      </div>
    </div>
  );
}

function ComplicationsCard({
  surgery,
  canEdit,
  onUpdate,
}: {
  surgery: Surgery;
  canEdit: boolean;
  onUpdate: () => void;
}) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({
    complications: surgery.complications ?? "",
    complicationSeverity: surgery.complicationSeverity ?? "MILD",
    bloodLossMl: surgery.bloodLossMl ?? 0,
  });
  async function save() {
    if (!form.complications.trim()) {
      toast.error("Complications description is required");
      return;
    }
    try {
      await api.patch(`/surgery/${surgery.id}/complications`, {
        complications: form.complications,
        complicationSeverity: form.complicationSeverity,
        bloodLossMl: Number(form.bloodLossMl) || 0,
      });
      setEdit(false);
      onUpdate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  }
  return (
    <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">
          Complications & Blood Loss
        </h2>
        {canEdit && !edit && (
          <button
            onClick={() => setEdit(true)}
            className="rounded bg-gray-100 px-3 py-1 text-xs hover:bg-gray-200"
          >
            {surgery.complications ? "Edit" : "Add"}
          </button>
        )}
      </div>
      {!edit && (
        <div className="text-sm text-gray-700">
          {surgery.complications ? (
            <>
              <p>
                <span className="text-gray-500">Complications:</span>{" "}
                {surgery.complications}
              </p>
              {surgery.complicationSeverity && (
                <p>
                  <span className="text-gray-500">Severity:</span>{" "}
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      surgery.complicationSeverity === "SEVERE"
                        ? "bg-red-100 text-red-700"
                        : surgery.complicationSeverity === "MODERATE"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-green-100 text-green-700"
                    }`}
                  >
                    {surgery.complicationSeverity}
                  </span>
                </p>
              )}
              {surgery.bloodLossMl != null && (
                <p>
                  <span className="text-gray-500">Estimated Blood Loss:</span>{" "}
                  {surgery.bloodLossMl} ml
                </p>
              )}
            </>
          ) : (
            <p className="text-gray-500">No complications recorded.</p>
          )}
        </div>
      )}
      {edit && (
        <div className="space-y-2">
          <textarea
            rows={2}
            value={form.complications}
            onChange={(e) => setForm({ ...form, complications: e.target.value })}
            placeholder="Describe complications"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              value={form.complicationSeverity}
              onChange={(e) =>
                setForm({ ...form, complicationSeverity: e.target.value })
              }
              className="rounded-lg border px-3 py-2 text-sm"
            >
              <option value="MILD">Mild</option>
              <option value="MODERATE">Moderate</option>
              <option value="SEVERE">Severe</option>
            </select>
            <input
              type="number"
              value={form.bloodLossMl}
              onChange={(e) =>
                setForm({ ...form, bloodLossMl: Number(e.target.value) })
              }
              placeholder="Blood loss (ml)"
              className="rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setEdit(false)}
              className="rounded-lg border px-3 py-1 text-xs"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="rounded-lg bg-primary px-3 py-1 text-xs text-white"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── New cards (Apr 2026) ─────────────────────────────

interface AnesthesiaRecord {
  id: string;
  anesthetist?: string | null;
  anesthesiaType: string;
  inductionAt?: string | null;
  extubationAt?: string | null;
  bloodLossMl?: number | null;
  urineOutputMl?: number | null;
  complications?: string | null;
  recoveryNotes?: string | null;
  vitalsLog?: Array<{ time: string; bp?: string; hr?: number; spo2?: number; etco2?: number }> | null;
}

function AnesthesiaCard({ surgeryId, canEdit }: { surgeryId: string; canEdit: boolean }) {
  const [record, setRecord] = useState<AnesthesiaRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({
    anesthetist: "",
    anesthesiaType: "GENERAL",
    inductionAt: "",
    extubationAt: "",
    bloodLossMl: 0,
    urineOutputMl: 0,
    complications: "",
    recoveryNotes: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: AnesthesiaRecord | null }>(
        `/surgery/${surgeryId}/anesthesia-record`
      );
      setRecord(res.data);
      if (res.data) {
        setForm({
          anesthetist: res.data.anesthetist ?? "",
          anesthesiaType: res.data.anesthesiaType,
          inductionAt: res.data.inductionAt
            ? new Date(res.data.inductionAt).toISOString().slice(0, 16)
            : "",
          extubationAt: res.data.extubationAt
            ? new Date(res.data.extubationAt).toISOString().slice(0, 16)
            : "",
          bloodLossMl: res.data.bloodLossMl ?? 0,
          urineOutputMl: res.data.urineOutputMl ?? 0,
          complications: res.data.complications ?? "",
          recoveryNotes: res.data.recoveryNotes ?? "",
        });
      }
    } catch {
      setRecord(null);
    }
    setLoading(false);
  }, [surgeryId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    try {
      await api.post(`/surgery/${surgeryId}/anesthesia-record`, {
        anesthetist: form.anesthetist || undefined,
        anesthesiaType: form.anesthesiaType,
        inductionAt: form.inductionAt ? new Date(form.inductionAt).toISOString() : undefined,
        extubationAt: form.extubationAt ? new Date(form.extubationAt).toISOString() : undefined,
        bloodLossMl: Number(form.bloodLossMl) || undefined,
        urineOutputMl: Number(form.urineOutputMl) || undefined,
        complications: form.complications || undefined,
        recoveryNotes: form.recoveryNotes || undefined,
      });
      setEdit(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  }

  return (
    <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Anesthesia Record</h2>
        {canEdit && !edit && (
          <button onClick={() => setEdit(true)} className="rounded bg-gray-100 px-3 py-1 text-xs hover:bg-gray-200">
            {record ? "Edit" : "Add"}
          </button>
        )}
      </div>
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : !edit ? (
        record ? (
          <div className="space-y-1 text-sm text-gray-700">
            <p><span className="text-gray-500">Type:</span> {record.anesthesiaType}</p>
            {record.anesthetist && <p><span className="text-gray-500">Anesthetist:</span> {record.anesthetist}</p>}
            {record.inductionAt && <p><span className="text-gray-500">Induction:</span> {new Date(record.inductionAt).toLocaleString()}</p>}
            {record.extubationAt && <p><span className="text-gray-500">Extubation:</span> {new Date(record.extubationAt).toLocaleString()}</p>}
            {record.bloodLossMl != null && <p><span className="text-gray-500">Blood Loss:</span> {record.bloodLossMl} ml</p>}
            {record.urineOutputMl != null && <p><span className="text-gray-500">Urine Output:</span> {record.urineOutputMl} ml</p>}
            {record.complications && <p><span className="text-gray-500">Complications:</span> {record.complications}</p>}
            {record.recoveryNotes && <p><span className="text-gray-500">Recovery:</span> {record.recoveryNotes}</p>}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No anesthesia record yet.</p>
        )
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <select value={form.anesthesiaType} onChange={(e) => setForm({ ...form, anesthesiaType: e.target.value })} className="rounded-lg border px-3 py-2 text-sm">
              {["GENERAL","SPINAL","EPIDURAL","LOCAL","REGIONAL","SEDATION"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <input value={form.anesthetist} onChange={(e) => setForm({ ...form, anesthetist: e.target.value })} placeholder="Anesthetist name" className="rounded-lg border px-3 py-2 text-sm" />
            <input type="datetime-local" value={form.inductionAt} onChange={(e) => setForm({ ...form, inductionAt: e.target.value })} className="rounded-lg border px-3 py-2 text-sm" />
            <input type="datetime-local" value={form.extubationAt} onChange={(e) => setForm({ ...form, extubationAt: e.target.value })} className="rounded-lg border px-3 py-2 text-sm" />
            <input type="number" value={form.bloodLossMl} onChange={(e) => setForm({ ...form, bloodLossMl: Number(e.target.value) })} placeholder="Blood loss (ml)" className="rounded-lg border px-3 py-2 text-sm" />
            <input type="number" value={form.urineOutputMl} onChange={(e) => setForm({ ...form, urineOutputMl: Number(e.target.value) })} placeholder="Urine output (ml)" className="rounded-lg border px-3 py-2 text-sm" />
          </div>
          <textarea rows={2} value={form.complications} onChange={(e) => setForm({ ...form, complications: e.target.value })} placeholder="Complications" className="w-full rounded-lg border px-3 py-2 text-sm" />
          <textarea rows={2} value={form.recoveryNotes} onChange={(e) => setForm({ ...form, recoveryNotes: e.target.value })} placeholder="Recovery notes" className="w-full rounded-lg border px-3 py-2 text-sm" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setEdit(false)} className="rounded-lg border px-3 py-1 text-xs">Cancel</button>
            <button onClick={save} className="rounded-lg bg-primary px-3 py-1 text-xs text-white">Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface BloodCheckResult {
  patientBloodGroup: string;
  compatibleGroups: string[];
  component: string;
  unitsRequested: number;
  unitsAvailable: number;
  shortfall: number;
  canProceed: boolean;
  reserved: Array<{ id: string; unitNumber: string; bloodGroup: string; expiresAt: string }>;
}

function BloodAvailabilityCard({ surgeryId, canEdit }: { surgeryId: string; canEdit: boolean }) {
  const [component, setComponent] = useState("PACKED_RED_CELLS");
  const [units, setUnits] = useState(2);
  const [autoReserve, setAutoReserve] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BloodCheckResult | null>(null);

  async function check() {
    setLoading(true);
    try {
      const res = await api.post<{ data: BloodCheckResult }>(
        `/surgery/${surgeryId}/blood-requirement`,
        { component, units, autoReserve }
      );
      setResult(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Check failed");
    }
    setLoading(false);
  }

  if (!canEdit) return null;

  return (
    <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">Blood Availability Check</h2>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs text-gray-500">Component</label>
          <select value={component} onChange={(e) => setComponent(e.target.value)} className="rounded-lg border px-3 py-2 text-sm">
            <option value="WHOLE_BLOOD">Whole Blood</option>
            <option value="PACKED_RED_CELLS">Packed Red Cells</option>
            <option value="PLATELETS">Platelets</option>
            <option value="FRESH_FROZEN_PLASMA">FFP</option>
            <option value="CRYOPRECIPITATE">Cryoprecipitate</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500">Units</label>
          <input type="number" min={1} value={units} onChange={(e) => setUnits(Number(e.target.value) || 1)} className="w-24 rounded-lg border px-3 py-2 text-sm" />
        </div>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={autoReserve} onChange={(e) => setAutoReserve(e.target.checked)} />
          Auto-reserve
        </label>
        <button onClick={check} disabled={loading} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {loading ? "Checking..." : "Check Availability"}
        </button>
      </div>
      {result && (
        <div className={`rounded-lg border-l-4 p-3 text-sm ${result.canProceed ? "border-green-500 bg-green-50" : "border-red-500 bg-red-50"}`}>
          <p className="mb-1 font-semibold">
            {result.canProceed
              ? `✓ ${result.unitsAvailable} unit(s) available and reserved`
              : `✗ Shortfall: ${result.shortfall} unit(s)`}
          </p>
          <p className="text-xs">
            Patient: {result.patientBloodGroup} · Compatible: {result.compatibleGroups.join(", ")}
          </p>
          {result.reserved.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs">
              {result.reserved.map((u) => (
                <li key={u.id}>{u.unitNumber} ({u.bloodGroup}) · exp {new Date(u.expiresAt).toLocaleDateString()}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

interface PacuObs {
  id: string;
  observedAt: string;
  bpSystolic?: number | null;
  bpDiastolic?: number | null;
  pulse?: number | null;
  spO2?: number | null;
  painScore?: number | null;
  consciousness?: string | null;
  nausea: boolean;
  notes?: string | null;
}

function PacuObservationsCard({ surgeryId, canEdit }: { surgeryId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<PacuObs[]>([]);
  const [form, setForm] = useState({
    bpSystolic: "", bpDiastolic: "", pulse: "", spO2: "", painScore: "",
    consciousness: "ALERT", nausea: false, notes: "",
  });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: PacuObs[] }>(`/surgery/${surgeryId}/observations`);
      setRows(res.data);
    } catch {
      setRows([]);
    }
    setLoading(false);
  }, [surgeryId]);

  useEffect(() => { load(); }, [load]);

  async function add() {
    try {
      await api.post(`/surgery/${surgeryId}/observations`, {
        bpSystolic: form.bpSystolic ? Number(form.bpSystolic) : undefined,
        bpDiastolic: form.bpDiastolic ? Number(form.bpDiastolic) : undefined,
        pulse: form.pulse ? Number(form.pulse) : undefined,
        spO2: form.spO2 ? Number(form.spO2) : undefined,
        painScore: form.painScore ? Number(form.painScore) : undefined,
        consciousness: form.consciousness,
        nausea: form.nausea,
        notes: form.notes || undefined,
      });
      setForm({ bpSystolic: "", bpDiastolic: "", pulse: "", spO2: "", painScore: "", consciousness: "ALERT", nausea: false, notes: "" });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  }

  const latest = rows[rows.length - 1];

  return (
    <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">PACU Recovery</h2>
      {canEdit && (
        <div className="mb-4 rounded-lg border p-3">
          <p className="mb-2 text-xs font-semibold text-gray-600">Record Observation</p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <input type="number" placeholder="BP Sys" value={form.bpSystolic} onChange={(e) => setForm({ ...form, bpSystolic: e.target.value })} className="rounded-lg border px-3 py-2 text-sm" />
            <input type="number" placeholder="BP Dia" value={form.bpDiastolic} onChange={(e) => setForm({ ...form, bpDiastolic: e.target.value })} className="rounded-lg border px-3 py-2 text-sm" />
            <input type="number" placeholder="Pulse" value={form.pulse} onChange={(e) => setForm({ ...form, pulse: e.target.value })} className="rounded-lg border px-3 py-2 text-sm" />
            <input type="number" placeholder="SpO2 %" value={form.spO2} onChange={(e) => setForm({ ...form, spO2: e.target.value })} className="rounded-lg border px-3 py-2 text-sm" />
            <input type="number" min={0} max={10} placeholder="Pain (0-10)" value={form.painScore} onChange={(e) => setForm({ ...form, painScore: e.target.value })} className="rounded-lg border px-3 py-2 text-sm" />
            <select value={form.consciousness} onChange={(e) => setForm({ ...form, consciousness: e.target.value })} className="rounded-lg border px-3 py-2 text-sm">
              <option value="ALERT">Alert</option>
              <option value="DROWSY">Drowsy</option>
              <option value="UNRESPONSIVE">Unresponsive</option>
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.nausea} onChange={(e) => setForm({ ...form, nausea: e.target.checked })} />
              Nausea
            </label>
          </div>
          <textarea rows={1} placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="mt-2 w-full rounded-lg border px-3 py-2 text-sm" />
          <div className="mt-2 flex justify-end">
            <button onClick={add} className="rounded-lg bg-primary px-3 py-1 text-xs text-white">Add observation</button>
          </div>
        </div>
      )}
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No observations yet.</p>
      ) : (
        <>
          {latest && (
            <div className="mb-3 grid grid-cols-5 gap-2 text-xs">
              <div className="rounded bg-gray-50 p-2 text-center">
                <div className="text-gray-500">Latest BP</div>
                <div className="font-semibold">{latest.bpSystolic ?? "-"}/{latest.bpDiastolic ?? "-"}</div>
              </div>
              <div className="rounded bg-gray-50 p-2 text-center">
                <div className="text-gray-500">Pulse</div>
                <div className="font-semibold">{latest.pulse ?? "-"}</div>
              </div>
              <div className="rounded bg-gray-50 p-2 text-center">
                <div className="text-gray-500">SpO2</div>
                <div className="font-semibold">{latest.spO2 ?? "-"}%</div>
              </div>
              <div className="rounded bg-gray-50 p-2 text-center">
                <div className="text-gray-500">Pain</div>
                <div className="font-semibold">{latest.painScore ?? "-"}</div>
              </div>
              <div className="rounded bg-gray-50 p-2 text-center">
                <div className="text-gray-500">Conscious</div>
                <div className="font-semibold">{latest.consciousness ?? "-"}</div>
              </div>
            </div>
          )}
          <div className="max-h-60 overflow-y-auto">
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-2 py-1 text-left">Time</th>
                  <th className="px-2 py-1">BP</th>
                  <th className="px-2 py-1">Pulse</th>
                  <th className="px-2 py-1">SpO2</th>
                  <th className="px-2 py-1">Pain</th>
                  <th className="px-2 py-1">Conscious</th>
                  <th className="px-2 py-1">Nausea</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-2 py-1">{new Date(r.observedAt).toLocaleTimeString()}</td>
                    <td className="px-2 py-1 text-center">{r.bpSystolic ?? "-"}/{r.bpDiastolic ?? "-"}</td>
                    <td className="px-2 py-1 text-center">{r.pulse ?? "-"}</td>
                    <td className="px-2 py-1 text-center">{r.spO2 ?? "-"}</td>
                    <td className="px-2 py-1 text-center">{r.painScore ?? "-"}</td>
                    <td className="px-2 py-1 text-center">{r.consciousness ?? "-"}</td>
                    <td className="px-2 py-1 text-center">{r.nausea ? "Y" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SsiReportCard({ surgery, canEdit, onUpdate }: { surgery: Surgery; canEdit: boolean; onUpdate: () => void }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({
    ssiType: surgery.ssiType ?? "SUPERFICIAL",
    detectedDate: surgery.ssiDetectedDate
      ? new Date(surgery.ssiDetectedDate).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    treatment: surgery.ssiTreatment ?? "",
  });

  async function save() {
    try {
      await api.patch(`/surgery/${surgery.id}/ssi-report`, {
        ssiType: form.ssiType,
        detectedDate: new Date(form.detectedDate).toISOString(),
        treatment: form.treatment || undefined,
      });
      setEdit(false);
      onUpdate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  }

  if (!canEdit && !surgery.ssiDetected) return null;

  return (
    <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Surgical Site Infection</h2>
        {canEdit && !edit && (
          <button onClick={() => setEdit(true)} className="rounded bg-red-100 px-3 py-1 text-xs text-red-700 hover:bg-red-200">
            {surgery.ssiDetected ? "Update SSI" : "Report SSI"}
          </button>
        )}
      </div>
      {!edit ? (
        surgery.ssiDetected ? (
          <div className="text-sm text-gray-700">
            <p><span className="text-gray-500">Type:</span> {surgery.ssiType}</p>
            {surgery.ssiDetectedDate && <p><span className="text-gray-500">Detected:</span> {new Date(surgery.ssiDetectedDate).toLocaleDateString()}</p>}
            {surgery.ssiTreatment && <p><span className="text-gray-500">Treatment:</span> {surgery.ssiTreatment}</p>}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No SSI reported.</p>
        )
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <select value={form.ssiType} onChange={(e) => setForm({ ...form, ssiType: e.target.value })} className="rounded-lg border px-3 py-2 text-sm">
              <option value="SUPERFICIAL">Superficial</option>
              <option value="DEEP">Deep</option>
              <option value="ORGAN_SPACE">Organ/Space</option>
            </select>
            <input type="date" value={form.detectedDate} onChange={(e) => setForm({ ...form, detectedDate: e.target.value })} className="rounded-lg border px-3 py-2 text-sm" />
          </div>
          <textarea rows={2} placeholder="Treatment details" value={form.treatment} onChange={(e) => setForm({ ...form, treatment: e.target.value })} className="w-full rounded-lg border px-3 py-2 text-sm" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setEdit(false)} className="rounded-lg border px-3 py-1 text-xs">Cancel</button>
            <button onClick={save} className="rounded-lg bg-red-600 px-3 py-1 text-xs text-white">Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
