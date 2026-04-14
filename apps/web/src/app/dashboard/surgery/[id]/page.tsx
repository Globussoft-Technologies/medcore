"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
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
};

export default function SurgeryDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const [surgery, setSurgery] = useState<Surgery | null>(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [notes, setNotes] = useState({ preOpNotes: "", postOpNotes: "", diagnosis: "" });

  const canEdit = user?.role === "DOCTOR" || user?.role === "ADMIN";

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
    } catch {
      setSurgery(null);
    }
    setLoading(false);
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
      alert(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function startSurgery() {
    if (!surgery) return;
    try {
      await api.patch(`/surgery/${surgery.id}/start`, {});
      loadSurgery();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Start failed");
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
      alert(err instanceof Error ? err.message : "Complete failed");
    }
  }

  async function cancelSurgery() {
    if (!surgery) return;
    const reason = prompt("Cancellation reason:");
    if (!reason) return;
    try {
      await api.patch(`/surgery/${surgery.id}/cancel`, { reason });
      loadSurgery();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Cancel failed");
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
          <span
            className={`rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[surgery.status]}`}
          >
            {surgery.status.replace("_", " ")}
          </span>
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
          <p className="font-medium">{surgery.surgeon.user.name}</p>
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
            Daily Rate: ₹{surgery.ot.dailyRate}
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
            <span>₹{surgery.ot.dailyRate.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Procedure Cost</span>
            <span>
              {surgery.cost != null ? `₹${surgery.cost.toFixed(2)}` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Actions */}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {surgery.status === "SCHEDULED" && (
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
      alert(err instanceof Error ? err.message : "Save failed");
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
      alert("Complications description is required");
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
      alert(err instanceof Error ? err.message : "Save failed");
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
