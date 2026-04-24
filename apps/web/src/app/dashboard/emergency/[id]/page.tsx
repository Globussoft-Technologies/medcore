"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { toast } from "@/lib/toast";
import {
  ArrowLeft,
  Clock,
  Activity,
  UserCheck,
  FileText,
  CheckCircle2,
} from "lucide-react";

const TRIAGE_COLORS: Record<string, string> = {
  RESUSCITATION: "bg-red-900 text-white",
  EMERGENT: "bg-red-500 text-white",
  URGENT: "bg-orange-500 text-white",
  LESS_URGENT: "bg-yellow-500 text-black",
  NON_URGENT: "bg-green-500 text-white",
};

interface PatientLite {
  id: string;
  mrNumber?: string;
  user: { name: string; phone?: string; email?: string };
}
interface DoctorLite {
  id: string;
  specialization?: string;
  user: { name: string };
}

interface EmergencyCase {
  id: string;
  caseNumber: string;
  patientId?: string | null;
  unknownName?: string | null;
  unknownAge?: number | null;
  unknownGender?: string | null;
  arrivedAt: string;
  arrivalMode?: string | null;
  triageLevel?: string | null;
  triagedAt?: string | null;
  triagedBy?: string | null;
  chiefComplaint: string;
  mewsScore?: number | null;
  vitalsBP?: string | null;
  vitalsPulse?: number | null;
  vitalsResp?: number | null;
  vitalsSpO2?: number | null;
  vitalsTemp?: number | null;
  glasgowComa?: number | null;
  rtsScore?: number | null;
  rtsRespiratory?: number | null;
  rtsSystolic?: number | null;
  rtsGCS?: number | null;
  attendingDoctorId?: string | null;
  seenAt?: string | null;
  status: string;
  disposition?: string | null;
  outcomeNotes?: string | null;
  closedAt?: string | null;
  patient?: PatientLite | null;
  attendingDoctor?: DoctorLite | null;
}

function fmt(d: string | null | undefined) {
  if (!d) return null;
  return new Date(d).toLocaleString();
}

function elapsedMin(from: string, to?: string | null): number {
  const end = to ? new Date(to).getTime() : Date.now();
  return Math.max(0, Math.floor((end - new Date(from).getTime()) / 60000));
}

export default function EmergencyCaseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuthStore();
  const id = params.id as string;
  const [ecase, setCase] = useState<EmergencyCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [showTraumaModal, setShowTraumaModal] = useState(false);

  useEffect(() => {
    load();
  }, [id]);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{ data: EmergencyCase }>(
        `/emergency/cases/${id}`
      );
      setCase(res.data);
    } catch {
      setCase(null);
    }
    setLoading(false);
  }

  async function quickAction(action: "cancel") {
    // placeholder for extra actions
    if (action === "cancel") router.push("/dashboard/emergency");
  }

  if (loading) {
    return <div className="p-8 text-gray-500">Loading...</div>;
  }
  if (!ecase) {
    return (
      <div className="p-8 text-gray-500">
        Case not found.{" "}
        <Link href="/dashboard/emergency" className="text-primary hover:underline">
          Back
        </Link>
      </div>
    );
  }

  const displayName =
    ecase.patient?.user.name || ecase.unknownName || "Unknown";
  const triageLevel = ecase.triageLevel || "";

  const timelineEvents = [
    {
      label: "Arrived",
      time: ecase.arrivedAt,
      icon: Clock,
      done: true,
    },
    {
      label: "Triaged",
      time: ecase.triagedAt,
      icon: Activity,
      done: !!ecase.triagedAt,
    },
    {
      label: "Doctor Assigned",
      time: ecase.seenAt,
      icon: UserCheck,
      done: !!ecase.attendingDoctorId,
      extra: ecase.attendingDoctor?.user.name,
    },
    {
      label: "Closed",
      time: ecase.closedAt,
      icon: CheckCircle2,
      done: !!ecase.closedAt,
      extra: ecase.status,
    },
  ];

  const canClose = user?.role === "ADMIN" || user?.role === "DOCTOR";

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <Link
          href="/dashboard/emergency"
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft size={16} /> Back to ER Board
        </Link>
        <span className="text-xs font-semibold text-gray-400">
          {ecase.caseNumber}
        </span>
      </div>

      <div className="mb-6 rounded-2xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{displayName}</h1>
            {ecase.patient ? (
              <p className="text-sm text-gray-500">
                MR: {ecase.patient.mrNumber || "—"} ·{" "}
                {ecase.patient.user.phone || "—"}
              </p>
            ) : (
              <p className="text-sm text-gray-500">
                {ecase.unknownAge ? `${ecase.unknownAge}y ` : ""}
                {ecase.unknownGender || ""}
                {ecase.arrivalMode ? ` · ${ecase.arrivalMode}` : ""}
              </p>
            )}
            <p className="mt-1 text-sm text-gray-500">
              Arrived {fmt(ecase.arrivedAt)} · {elapsedMin(ecase.arrivedAt, ecase.closedAt)}m
              total
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {triageLevel && (
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${TRIAGE_COLORS[triageLevel]}`}
              >
                {triageLevel.replace("_", " ")}
              </span>
            )}
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
              {ecase.status.replace(/_/g, " ")}
            </span>
          </div>
        </div>

        <div className="mt-5 rounded-lg bg-gray-50 p-4">
          <p className="text-xs font-medium text-gray-500">Chief Complaint</p>
          <p className="mt-1 text-sm text-gray-800">{ecase.chiefComplaint}</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Timeline */}
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <Clock size={18} /> Timeline
          </h2>
          <ol className="space-y-4">
            {timelineEvents.map((e, i) => {
              const Icon = e.icon;
              return (
                <li key={i} className="flex gap-3">
                  <div
                    className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-full ${
                      e.done ? "bg-primary text-white" : "bg-gray-200 text-gray-500"
                    }`}
                  >
                    <Icon size={14} />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium">{e.label}</p>
                    <p className="text-xs text-gray-500">
                      {e.time ? fmt(e.time) : "Pending"}
                      {e.extra ? ` · ${e.extra}` : ""}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Vitals */}
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <Activity size={18} /> Vitals & Scores
          </h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Blood Pressure</p>
              <p className="font-semibold">{ecase.vitalsBP || "—"}</p>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Pulse</p>
              <p className="font-semibold">
                {ecase.vitalsPulse ?? "—"}
                {ecase.vitalsPulse != null && " bpm"}
              </p>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Respiration</p>
              <p className="font-semibold">
                {ecase.vitalsResp ?? "—"}
                {ecase.vitalsResp != null && " /min"}
              </p>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">SpO2</p>
              <p className="font-semibold">
                {ecase.vitalsSpO2 ?? "—"}
                {ecase.vitalsSpO2 != null && "%"}
              </p>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Temperature</p>
              <p className="font-semibold">
                {ecase.vitalsTemp ?? "—"}
                {ecase.vitalsTemp != null && " °C"}
              </p>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">GCS</p>
              <p className="font-semibold">{ecase.glasgowComa ?? "—"}</p>
            </div>
            <div className="col-span-2 rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">MEWS Score</p>
              <p className="font-semibold">{ecase.mewsScore ?? "—"}</p>
            </div>
            <div className="col-span-2 rounded-lg bg-gray-50 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500">Revised Trauma Score</p>
                  <p className="font-semibold">
                    {ecase.rtsScore != null ? ecase.rtsScore.toFixed(2) : "—"}
                    {ecase.rtsScore != null && (
                      <span
                        className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          ecase.rtsScore >= 7
                            ? "bg-green-100 text-green-700"
                            : ecase.rtsScore >= 4
                            ? "bg-amber-100 text-amber-700"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        {ecase.rtsScore >= 7
                          ? "Minor"
                          : ecase.rtsScore >= 4
                          ? "Moderate"
                          : "Severe"}
                      </span>
                    )}
                  </p>
                </div>
                {(ecase.vitalsResp != null ||
                  ecase.vitalsBP ||
                  ecase.glasgowComa != null) && (
                  <button
                    onClick={() => setShowTraumaModal(true)}
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-dark"
                  >
                    Calculate Trauma Score
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Attending Doctor */}
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <UserCheck size={18} /> Attending Doctor
          </h2>
          {ecase.attendingDoctor ? (
            <div>
              <p className="text-lg font-semibold">
                {formatDoctorName(ecase.attendingDoctor.user.name)}
              </p>
              <p className="text-sm text-gray-500">
                {ecase.attendingDoctor.specialization}
              </p>
              {ecase.seenAt && (
                <p className="mt-2 text-xs text-gray-500">
                  Seen at {fmt(ecase.seenAt)}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No doctor assigned yet.</p>
          )}
        </div>

        {/* Outcome */}
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <FileText size={18} /> Outcome
          </h2>
          {ecase.closedAt ? (
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-gray-500">Status:</span>{" "}
                <strong>{ecase.status.replace(/_/g, " ")}</strong>
              </p>
              {ecase.disposition && (
                <p>
                  <span className="text-gray-500">Disposition:</span>{" "}
                  {ecase.disposition}
                </p>
              )}
              {ecase.outcomeNotes && (
                <p className="mt-2 rounded-lg bg-gray-50 p-3">
                  {ecase.outcomeNotes}
                </p>
              )}
              <p className="mt-2 text-xs text-gray-500">
                Closed at {fmt(ecase.closedAt)}
              </p>
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              Case is still active. Use the main board to close the case.
            </p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mt-6 flex gap-2">
        <Link
          href="/dashboard/emergency"
          className="rounded-lg border px-4 py-2 text-sm"
        >
          Back to Board
        </Link>
        {canClose && !ecase.closedAt && (
          <Link
            href="/dashboard/emergency"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            Manage Case
          </Link>
        )}
      </div>

      {showTraumaModal && (
        <TraumaScoreModal
          caseId={ecase.id}
          onClose={() => setShowTraumaModal(false)}
          onSaved={() => {
            setShowTraumaModal(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── Revised Trauma Score modal ────────────────────────

const RTS_RESP_OPTIONS = [
  { code: 4, label: "10-29 /min" },
  { code: 3, label: ">29 /min" },
  { code: 2, label: "6-9 /min" },
  { code: 1, label: "1-5 /min" },
  { code: 0, label: "None" },
];
const RTS_SBP_OPTIONS = [
  { code: 4, label: ">89 mmHg" },
  { code: 3, label: "76-89 mmHg" },
  { code: 2, label: "50-75 mmHg" },
  { code: 1, label: "1-49 mmHg" },
  { code: 0, label: "No pulse" },
];
const RTS_GCS_OPTIONS = [
  { code: 4, label: "GCS 13-15" },
  { code: 3, label: "GCS 9-12" },
  { code: 2, label: "GCS 6-8" },
  { code: 1, label: "GCS 4-5" },
  { code: 0, label: "GCS 3" },
];

function TraumaScoreModal({
  caseId,
  onClose,
  onSaved,
}: {
  caseId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [resp, setResp] = useState(4);
  const [sbp, setSbp] = useState(4);
  const [gcs, setGcs] = useState(4);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{
    rtsScore: number;
    interpretation: string;
  } | null>(null);

  async function submit() {
    setSaving(true);
    try {
      const res = await api.post<{
        data: { rtsScore: number; interpretation: string };
      }>(`/emergency/cases/${caseId}/trauma-score`, {
        rtsRespiratory: resp,
        rtsSystolic: sbp,
        rtsGCS: gcs,
      });
      setResult(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
    setSaving(false);
  }

  const badgeColor = result
    ? result.rtsScore >= 7
      ? "bg-green-100 text-green-700"
      : result.rtsScore >= 4
      ? "bg-amber-100 text-amber-700"
      : "bg-red-100 text-red-700"
    : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Revised Trauma Score</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>

        <p className="mb-4 text-xs text-gray-500">
          RTS = 0.9368 × GCS + 0.7326 × SBP + 0.2908 × RR. Range 0-7.84.
        </p>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Respiratory Rate
            </label>
            <select
              value={resp}
              onChange={(e) => setResp(Number(e.target.value))}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            >
              {RTS_RESP_OPTIONS.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label} (code {o.code})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Systolic BP
            </label>
            <select
              value={sbp}
              onChange={(e) => setSbp(Number(e.target.value))}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            >
              {RTS_SBP_OPTIONS.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label} (code {o.code})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              Glasgow Coma Scale
            </label>
            <select
              value={gcs}
              onChange={(e) => setGcs(Number(e.target.value))}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            >
              {RTS_GCS_OPTIONS.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label} (code {o.code})
                </option>
              ))}
            </select>
          </div>
        </div>

        {result && (
          <div className="mt-4 rounded-lg border-l-4 border-primary bg-gray-50 p-3">
            <p className="text-sm">
              Score:{" "}
              <span className="text-xl font-bold">
                {result.rtsScore.toFixed(2)}
              </span>
            </p>
            <span
              className={`mt-1 inline-block rounded-full px-3 py-0.5 text-xs font-semibold ${badgeColor}`}
            >
              {result.interpretation}
            </span>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            Close
          </button>
          {result ? (
            <button
              onClick={onSaved}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white"
            >
              Done
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={saving}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {saving ? "Calculating..." : "Calculate"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
