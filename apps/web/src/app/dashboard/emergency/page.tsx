"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { useTranslation } from "@/lib/i18n";
import { getSocket } from "@/lib/socket";
import { InfoIcon } from "@/components/Tooltip";
import { Plus, Siren, AlertTriangle, UserCheck, X } from "lucide-react";

interface PatientLite {
  id: string;
  mrNumber?: string;
  user: { name: string; phone?: string };
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
  triageLevel?:
    | "RESUSCITATION"
    | "EMERGENT"
    | "URGENT"
    | "LESS_URGENT"
    | "NON_URGENT"
    | null;
  triagedAt?: string | null;
  chiefComplaint: string;
  mewsScore?: number | null;
  vitalsBP?: string | null;
  vitalsPulse?: number | null;
  vitalsResp?: number | null;
  vitalsSpO2?: number | null;
  vitalsTemp?: number | null;
  glasgowComa?: number | null;
  attendingDoctorId?: string | null;
  seenAt?: string | null;
  status:
    | "WAITING"
    | "TRIAGED"
    | "IN_TREATMENT"
    | "ADMITTED"
    | "DISCHARGED"
    | "TRANSFERRED"
    | "LEFT_WITHOUT_BEING_SEEN"
    | "DECEASED";
  disposition?: string | null;
  outcomeNotes?: string | null;
  patient?: PatientLite | null;
  attendingDoctor?: DoctorLite | null;
}

interface EmergencyStats {
  totalActive: number;
  totalWaiting: number;
  byTriage: Record<string, number>;
  avgWaitMin: number;
  availableBeds: number;
}

const TRIAGE_COLORS: Record<string, string> = {
  RESUSCITATION: "bg-red-900 text-white",
  EMERGENT: "bg-red-500 text-white",
  URGENT: "bg-orange-500 text-white",
  LESS_URGENT: "bg-yellow-500 text-black",
  NON_URGENT: "bg-green-500 text-white",
};

const TRIAGE_TARGET_MIN: Record<string, number> = {
  RESUSCITATION: 0,
  EMERGENT: 10,
  URGENT: 30,
  LESS_URGENT: 60,
  NON_URGENT: 120,
};

function elapsedMin(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
}

export default function EmergencyPage() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const [cases, setCases] = useState<EmergencyCase[]>([]);
  const [stats, setStats] = useState<EmergencyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedCase, setSelectedCase] = useState<EmergencyCase | null>(null);
  const [showIntakeModal, setShowIntakeModal] = useState(false);
  const [doctors, setDoctors] = useState<DoctorLite[]>([]);

  // intake form
  const [intakeSearch, setIntakeSearch] = useState("");
  const [intakeResults, setIntakeResults] = useState<PatientLite[]>([]);
  const [intakePatient, setIntakePatient] = useState<PatientLite | null>(null);
  const [unknownMode, setUnknownMode] = useState(false);
  const [intakeForm, setIntakeForm] = useState({
    unknownName: "",
    unknownAge: "",
    unknownGender: "",
    arrivalMode: "Walk-in",
    chiefComplaint: "",
  });

  // triage form
  const [triageForm, setTriageForm] = useState({
    triageLevel: "URGENT" as string,
    vitalsBP: "",
    vitalsPulse: "",
    vitalsResp: "",
    vitalsSpO2: "",
    vitalsTemp: "",
    glasgowComa: "",
    mewsScore: "",
  });
  const [assignDoctorId, setAssignDoctorId] = useState("");
  const [closeForm, setCloseForm] = useState({
    status: "DISCHARGED",
    disposition: "",
    outcomeNotes: "",
  });

  const canRegister =
    user?.role === "ADMIN" ||
    user?.role === "NURSE" ||
    user?.role === "RECEPTION" ||
    user?.role === "DOCTOR";
  const canTriage =
    user?.role === "ADMIN" || user?.role === "NURSE" || user?.role === "DOCTOR";
  const canAssign =
    user?.role === "ADMIN" ||
    user?.role === "NURSE" ||
    user?.role === "RECEPTION" ||
    user?.role === "DOCTOR";
  const canClose = user?.role === "ADMIN" || user?.role === "DOCTOR";

  useEffect(() => {
    loadData();
    const t = setInterval(loadData, 30000);
    return () => clearInterval(t);
  }, []);

  // Realtime emergency updates
  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();
    const handler = () => loadData();
    socket.on("emergency:update", handler);
    return () => {
      socket.off("emergency:update", handler);
    };
  }, []);

  useEffect(() => {
    loadDoctors();
  }, []);

  useEffect(() => {
    if (intakeSearch.length < 2) {
      setIntakeResults([]);
      return;
    }
    const t = setTimeout(() => searchPatients(intakeSearch), 300);
    return () => clearTimeout(t);
  }, [intakeSearch]);

  async function loadData() {
    setLoading(true);
    try {
      const [activeRes, statsRes] = await Promise.all([
        api.get<{ data: EmergencyCase[] }>("/emergency/cases/active"),
        api.get<{ data: EmergencyStats }>("/emergency/stats"),
      ]);
      setCases(activeRes.data);
      setStats(statsRes.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function loadDoctors() {
    try {
      const res = await api.get<{ data: DoctorLite[] }>("/doctors");
      setDoctors(res.data);
    } catch {
      // empty
    }
  }

  async function searchPatients(q: string) {
    try {
      const res = await api.get<{ data: PatientLite[] }>(
        `/patients?search=${encodeURIComponent(q)}&limit=10`
      );
      setIntakeResults(res.data);
    } catch {
      setIntakeResults([]);
    }
  }

  async function submitIntake(e: React.FormEvent) {
    e.preventDefault();
    if (!intakeForm.chiefComplaint) {
      toast.error("Chief complaint is required");
      return;
    }
    if (!intakePatient && !unknownMode) {
      toast.error("Select a patient or mark as Unknown");
      return;
    }
    if (unknownMode && !intakeForm.unknownName) {
      toast.error("Enter a name (or John/Jane Doe) for the unknown patient");
      return;
    }

    try {
      await api.post("/emergency/cases", {
        patientId: intakePatient?.id,
        unknownName: unknownMode ? intakeForm.unknownName : undefined,
        unknownAge:
          unknownMode && intakeForm.unknownAge
            ? Number(intakeForm.unknownAge)
            : undefined,
        unknownGender: unknownMode ? intakeForm.unknownGender : undefined,
        arrivalMode: intakeForm.arrivalMode,
        chiefComplaint: intakeForm.chiefComplaint,
      });
      setShowIntakeModal(false);
      setIntakePatient(null);
      setIntakeSearch("");
      setUnknownMode(false);
      setIntakeForm({
        unknownName: "",
        unknownAge: "",
        unknownGender: "",
        arrivalMode: "Walk-in",
        chiefComplaint: "",
      });
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Registration failed");
    }
  }

  async function submitTriage() {
    if (!selectedCase) return;
    try {
      await api.patch(`/emergency/cases/${selectedCase.id}/triage`, {
        triageLevel: triageForm.triageLevel,
        vitalsBP: triageForm.vitalsBP || undefined,
        vitalsPulse: triageForm.vitalsPulse
          ? Number(triageForm.vitalsPulse)
          : undefined,
        vitalsResp: triageForm.vitalsResp
          ? Number(triageForm.vitalsResp)
          : undefined,
        vitalsSpO2: triageForm.vitalsSpO2
          ? Number(triageForm.vitalsSpO2)
          : undefined,
        vitalsTemp: triageForm.vitalsTemp
          ? Number(triageForm.vitalsTemp)
          : undefined,
        glasgowComa: triageForm.glasgowComa
          ? Number(triageForm.glasgowComa)
          : undefined,
        mewsScore: triageForm.mewsScore ? Number(triageForm.mewsScore) : undefined,
      });
      setSelectedCase(null);
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Triage failed");
    }
  }

  async function submitAssign() {
    if (!selectedCase || !assignDoctorId) {
      toast.error("Select a doctor");
      return;
    }
    try {
      await api.patch(`/emergency/cases/${selectedCase.id}/assign`, {
        attendingDoctorId: assignDoctorId,
      });
      setSelectedCase(null);
      setAssignDoctorId("");
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Assign failed");
    }
  }

  async function submitClose() {
    if (!selectedCase) return;
    try {
      await api.patch(`/emergency/cases/${selectedCase.id}/close`, {
        status: closeForm.status,
        disposition: closeForm.disposition || undefined,
        outcomeNotes: closeForm.outcomeNotes || undefined,
      });
      setSelectedCase(null);
      setCloseForm({ status: "DISCHARGED", disposition: "", outcomeNotes: "" });
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Close failed");
    }
  }

  const columns: Array<{
    key: string;
    label: string;
    filter: (c: EmergencyCase) => boolean;
  }> = [
    { key: "waiting", label: "Waiting", filter: (c) => c.status === "WAITING" },
    { key: "triaged", label: "Triaged", filter: (c) => c.status === "TRIAGED" },
    {
      key: "treatment",
      label: "In Treatment",
      filter: (c) => c.status === "IN_TREATMENT",
    },
    {
      key: "disposition",
      label: "Disposition Pending",
      filter: (c) => c.status === "ADMITTED",
    },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Siren className="text-red-600" size={28} aria-hidden="true" />
          <div>
            <h1 className="text-2xl font-bold">{t("dashboard.emergency.title")}</h1>
            <p className="text-sm text-gray-700 dark:text-gray-300">Real-time ER dashboard</p>
          </div>
        </div>
        {canRegister && (
          <button
            onClick={() => setShowIntakeModal(true)}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            <Plus size={16} /> Register New Case
          </button>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div className="mb-6 grid gap-3 md:grid-cols-4 lg:grid-cols-7">
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-gray-500">Active</p>
            <p className="text-2xl font-bold">{stats.totalActive}</p>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-gray-500">Waiting</p>
            <p className="text-2xl font-bold">{stats.totalWaiting}</p>
          </div>
          {(
            [
              "RESUSCITATION",
              "EMERGENT",
              "URGENT",
              "LESS_URGENT",
              "NON_URGENT",
            ] as const
          ).map((level) => (
            <div
              key={level}
              className={`rounded-xl p-4 shadow-sm ${TRIAGE_COLORS[level]}`}
            >
              <p className="text-xs opacity-80">{level.replace("_", " ")}</p>
              <p className="text-2xl font-bold">{stats.byTriage[level] ?? 0}</p>
            </div>
          ))}
        </div>
      )}

      {stats && (
        <div className="mb-6 grid gap-3 md:grid-cols-2">
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-gray-500">Avg Wait Time</p>
            <p className="text-xl font-semibold">{stats.avgWaitMin} min</p>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-gray-500">Available Beds</p>
            <p className="text-xl font-semibold">{stats.availableBeds}</p>
          </div>
        </div>
      )}

      {/* Columns */}
      {loading ? (
        <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm">
          Loading...
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-4">
          {columns.map((col) => {
            const colCases = cases.filter(col.filter);
            return (
              <div key={col.key} className="rounded-xl bg-gray-50 p-3">
                <div className="mb-3 flex items-center justify-between px-1">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-600">
                    {col.label}
                  </h3>
                  <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium">
                    {colCases.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {colCases.length === 0 ? (
                    <p className="py-6 text-center text-xs text-gray-400">
                      No cases
                    </p>
                  ) : (
                    colCases.map((c) => {
                      const elapsed = elapsedMin(c.arrivedAt);
                      const target = c.triageLevel
                        ? TRIAGE_TARGET_MIN[c.triageLevel]
                        : 60;
                      const overdue = elapsed > target;
                      return (
                        <button
                          key={c.id}
                          onClick={() => {
                            setSelectedCase(c);
                            setTriageForm({
                              triageLevel: c.triageLevel || "URGENT",
                              vitalsBP: c.vitalsBP || "",
                              vitalsPulse: c.vitalsPulse?.toString() || "",
                              vitalsResp: c.vitalsResp?.toString() || "",
                              vitalsSpO2: c.vitalsSpO2?.toString() || "",
                              vitalsTemp: c.vitalsTemp?.toString() || "",
                              glasgowComa: c.glasgowComa?.toString() || "",
                              mewsScore: c.mewsScore?.toString() || "",
                            });
                          }}
                          className="w-full rounded-lg border bg-white p-3 text-left shadow-sm transition hover:shadow-md"
                        >
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs font-semibold text-gray-400">
                              {c.caseNumber}
                            </span>
                            {c.triageLevel && (
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${TRIAGE_COLORS[c.triageLevel]}`}
                              >
                                {c.triageLevel.replace("_", " ")}
                              </span>
                            )}
                          </div>
                          <p className="text-sm font-semibold">
                            {c.patient?.user.name ||
                              c.unknownName ||
                              "Unknown"}
                          </p>
                          <p className="text-xs text-gray-500">
                            {c.unknownAge ? `${c.unknownAge}y ` : ""}
                            {c.unknownGender || ""}
                            {c.arrivalMode ? ` · ${c.arrivalMode}` : ""}
                          </p>
                          <p className="mt-1 line-clamp-2 text-xs text-gray-600">
                            {c.chiefComplaint}
                          </p>
                          <div className="mt-2 flex items-center justify-between text-xs">
                            <span
                              className={
                                overdue ? "font-semibold text-red-600" : "text-gray-500"
                              }
                            >
                              {overdue && <AlertTriangle size={12} className="mr-1 inline" />}
                              {elapsed}m elapsed
                            </span>
                            {c.attendingDoctor && (
                              <span className="truncate text-gray-500">
                                {formatDoctorName(c.attendingDoctor.user.name)}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Intake modal */}
      {showIntakeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form
            onSubmit={submitIntake}
            className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl"
          >
            <h2 className="mb-4 text-lg font-semibold">Register Emergency Case</h2>

            <div className="mb-3 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setUnknownMode(false);
                  setIntakePatient(null);
                }}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${
                  !unknownMode ? "bg-primary text-white" : "bg-gray-100"
                }`}
              >
                Registered Patient
              </button>
              <button
                type="button"
                onClick={() => {
                  setUnknownMode(true);
                  setIntakePatient(null);
                }}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${
                  unknownMode ? "bg-primary text-white" : "bg-gray-100"
                }`}
              >
                Unknown / Unregistered
              </button>
            </div>

            <div className="space-y-4">
              {!unknownMode ? (
                <div>
                  <label className="mb-1 block text-sm font-medium">Patient</label>
                  {intakePatient ? (
                    <div className="flex items-center justify-between rounded-lg border bg-gray-50 px-3 py-2 text-sm">
                      <span>
                        <strong>{intakePatient.user.name}</strong>
                        {intakePatient.mrNumber && ` — ${intakePatient.mrNumber}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setIntakePatient(null);
                          setIntakeSearch("");
                        }}
                        className="text-xs text-red-600"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        placeholder="Search by name or MR number"
                        value={intakeSearch}
                        onChange={(e) => setIntakeSearch(e.target.value)}
                        className="w-full rounded-lg border px-3 py-2 text-sm"
                      />
                      {intakeResults.length > 0 && (
                        <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border bg-white shadow-sm">
                          {intakeResults.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => {
                                setIntakePatient(p);
                                setIntakeResults([]);
                              }}
                              className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                            >
                              <strong>{p.user.name}</strong>
                              {p.mrNumber && ` · ${p.mrNumber}`}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-3">
                    <label className="mb-1 block text-sm font-medium">Name / Label</label>
                    <input
                      required
                      placeholder="e.g. John Doe, Trauma 1"
                      value={intakeForm.unknownName}
                      onChange={(e) =>
                        setIntakeForm({ ...intakeForm, unknownName: e.target.value })
                      }
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Age</label>
                    <input
                      type="number"
                      value={intakeForm.unknownAge}
                      onChange={(e) =>
                        setIntakeForm({ ...intakeForm, unknownAge: e.target.value })
                      }
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="mb-1 block text-sm font-medium">Gender</label>
                    <select
                      value={intakeForm.unknownGender}
                      onChange={(e) =>
                        setIntakeForm({ ...intakeForm, unknownGender: e.target.value })
                      }
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    >
                      <option value="">—</option>
                      <option value="MALE">Male</option>
                      <option value="FEMALE">Female</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium">Arrival Mode</label>
                <select
                  value={intakeForm.arrivalMode}
                  onChange={(e) =>
                    setIntakeForm({ ...intakeForm, arrivalMode: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  <option>Walk-in</option>
                  <option>Ambulance</option>
                  <option>Police</option>
                  <option>Referred</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">
                  Chief Complaint *
                </label>
                <textarea
                  required
                  rows={3}
                  value={intakeForm.chiefComplaint}
                  onChange={(e) =>
                    setIntakeForm({ ...intakeForm, chiefComplaint: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowIntakeModal(false)}
                className="rounded-lg border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Register
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Side panel */}
      {selectedCase && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
          <div className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold text-gray-400">
                  {selectedCase.caseNumber}
                </p>
                <h2 className="text-xl font-bold">
                  {selectedCase.patient?.user.name ||
                    selectedCase.unknownName ||
                    "Unknown"}
                </h2>
                <p className="text-sm text-gray-500">
                  Arrived {new Date(selectedCase.arrivedAt).toLocaleString()} ·{" "}
                  {elapsedMin(selectedCase.arrivedAt)}m ago
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/dashboard/emergency/${selectedCase.id}`}
                  className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                >
                  Full Details
                </Link>
                <button
                  onClick={() => setSelectedCase(null)}
                  className="rounded-full p-1 hover:bg-gray-100"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="mb-5 rounded-lg bg-gray-50 p-3 text-sm">
              <p className="font-medium">Chief Complaint</p>
              <p className="text-gray-700">{selectedCase.chiefComplaint}</p>
            </div>

            {/* Triage section */}
            {canTriage &&
              (selectedCase.status === "WAITING" ||
                selectedCase.status === "TRIAGED") && (
                <section className="mb-6">
                  <h3 className="mb-3 font-semibold">Triage</h3>
                  <div className="mb-3 flex flex-wrap gap-2">
                    {(
                      [
                        "RESUSCITATION",
                        "EMERGENT",
                        "URGENT",
                        "LESS_URGENT",
                        "NON_URGENT",
                      ] as const
                    ).map((level) => (
                      <button
                        key={level}
                        type="button"
                        onClick={() =>
                          setTriageForm({ ...triageForm, triageLevel: level })
                        }
                        className={`rounded-full px-3 py-1 text-xs font-medium ${
                          triageForm.triageLevel === level
                            ? TRIAGE_COLORS[level]
                            : "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {level.replace("_", " ")}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <input
                      placeholder="BP (e.g. 120/80)"
                      value={triageForm.vitalsBP}
                      onChange={(e) =>
                        setTriageForm({ ...triageForm, vitalsBP: e.target.value })
                      }
                      className="rounded-lg border px-3 py-2"
                    />
                    <input
                      placeholder="Pulse"
                      value={triageForm.vitalsPulse}
                      onChange={(e) =>
                        setTriageForm({ ...triageForm, vitalsPulse: e.target.value })
                      }
                      className="rounded-lg border px-3 py-2"
                    />
                    <input
                      placeholder="Resp rate"
                      value={triageForm.vitalsResp}
                      onChange={(e) =>
                        setTriageForm({ ...triageForm, vitalsResp: e.target.value })
                      }
                      className="rounded-lg border px-3 py-2"
                    />
                    <input
                      placeholder="SpO2 %"
                      value={triageForm.vitalsSpO2}
                      onChange={(e) =>
                        setTriageForm({ ...triageForm, vitalsSpO2: e.target.value })
                      }
                      className="rounded-lg border px-3 py-2"
                    />
                    <input
                      placeholder="Temp °C"
                      value={triageForm.vitalsTemp}
                      onChange={(e) =>
                        setTriageForm({ ...triageForm, vitalsTemp: e.target.value })
                      }
                      className="rounded-lg border px-3 py-2"
                    />
                    <div>
                      <label className="mb-1 flex items-center text-xs text-gray-600">
                        GCS
                        <InfoIcon tooltip="GCS — Glasgow Coma Scale. Scores consciousness from 3 (deep coma) to 15 (fully alert). Sums eye, verbal, and motor response." />
                      </label>
                      <input
                        placeholder="GCS (3-15)"
                        value={triageForm.glasgowComa}
                        onChange={(e) =>
                          setTriageForm({ ...triageForm, glasgowComa: e.target.value })
                        }
                        className="w-full rounded-lg border px-3 py-2"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="mb-1 flex items-center text-xs text-gray-600">
                        MEWS
                        <InfoIcon tooltip="MEWS — Modified Early Warning Score. Range 0–14. Based on vitals to flag deteriorating patients. >4 indicates urgent review." />
                        <span className="ml-3">RTS</span>
                        <InfoIcon tooltip="RTS — Revised Trauma Score. Uses GCS, SBP and respiratory rate. Lower scores indicate more severe trauma." />
                      </label>
                      <input
                        placeholder="MEWS (0-14)"
                        value={triageForm.mewsScore}
                        onChange={(e) =>
                          setTriageForm({ ...triageForm, mewsScore: e.target.value })
                        }
                        className="w-full rounded-lg border px-3 py-2"
                      />
                    </div>
                  </div>
                  <button
                    onClick={submitTriage}
                    className="mt-3 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
                  >
                    Save Triage
                  </button>
                </section>
              )}

            {/* Assign doctor */}
            {canAssign &&
              (selectedCase.status === "TRIAGED" ||
                selectedCase.status === "WAITING") && (
                <section className="mb-6">
                  <h3 className="mb-3 font-semibold">Assign Doctor</h3>
                  <div className="flex gap-2">
                    <select
                      value={assignDoctorId}
                      onChange={(e) => setAssignDoctorId(e.target.value)}
                      className="flex-1 rounded-lg border px-3 py-2 text-sm"
                    >
                      <option value="">Select Doctor</option>
                      {doctors.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.user.name}
                          {d.specialization && ` — ${d.specialization}`}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={submitAssign}
                      className="flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-dark"
                    >
                      <UserCheck size={14} /> Assign
                    </button>
                  </div>
                </section>
              )}

            {/* Close case */}
            {canClose && selectedCase.status !== "WAITING" && (
              <section className="mb-6">
                <h3 className="mb-3 font-semibold">Close / Disposition</h3>
                <div className="space-y-2">
                  <select
                    value={closeForm.status}
                    onChange={(e) =>
                      setCloseForm({ ...closeForm, status: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  >
                    <option value="DISCHARGED">Discharged</option>
                    <option value="ADMITTED">Admitted</option>
                    <option value="TRANSFERRED">Transferred</option>
                    <option value="LEFT_WITHOUT_BEING_SEEN">
                      Left Without Being Seen
                    </option>
                    <option value="DECEASED">Deceased</option>
                  </select>
                  <input
                    placeholder="Disposition (e.g. Home, Ward-3, Other hospital)"
                    value={closeForm.disposition}
                    onChange={(e) =>
                      setCloseForm({ ...closeForm, disposition: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                  <textarea
                    rows={3}
                    placeholder="Outcome notes"
                    value={closeForm.outcomeNotes}
                    onChange={(e) =>
                      setCloseForm({ ...closeForm, outcomeNotes: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                  <button
                    onClick={submitClose}
                    className="w-full rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900"
                  >
                    Close Case
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
