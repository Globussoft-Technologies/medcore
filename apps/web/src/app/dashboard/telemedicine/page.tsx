"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { toast } from "@/lib/toast";
import { useConfirm, usePrompt } from "@/lib/use-dialog";
import { createTelemedicineSchema } from "@medcore/shared";
import Link from "next/link";
import {
  Plus,
  Video,
  Star,
  XCircle,
  Play,
  Square,
  UserCheck,
  UserX,
  Mic,
} from "lucide-react";
import { getSocket } from "@/lib/socket";

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

interface TelemedicineSession {
  id: string;
  sessionNumber: string;
  scheduledAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMin?: number | null;
  meetingUrl?: string | null;
  meetingId?: string | null;
  status:
    | "SCHEDULED"
    | "WAITING"
    | "IN_PROGRESS"
    | "COMPLETED"
    | "MISSED"
    | "CANCELLED";
  chiefComplaint?: string | null;
  doctorNotes?: string | null;
  patientRating?: number | null;
  fee: number;
  patient: PatientLite;
  doctor: DoctorLite;
}

type Tab = "upcoming" | "completed" | "cancelled";

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: "bg-blue-100 text-blue-700",
  WAITING: "bg-purple-100 text-purple-700",
  IN_PROGRESS: "bg-green-100 text-green-700",
  COMPLETED: "bg-gray-100 text-gray-700",
  MISSED: "bg-yellow-100 text-yellow-700",
  CANCELLED: "bg-red-100 text-red-700",
};

function joinActive(session: TelemedicineSession): boolean {
  if (session.status === "IN_PROGRESS") return true;
  if (session.status !== "SCHEDULED" && session.status !== "WAITING") return false;
  const diffMs = new Date(session.scheduledAt).getTime() - Date.now();
  // active within 15 minutes before and anytime after the scheduled start
  return diffMs <= 15 * 60 * 1000;
}

export default function TelemedicinePage() {
  const { user } = useAuthStore();
  const confirm = useConfirm();
  const promptDialog = usePrompt();
  const [sessions, setSessions] = useState<TelemedicineSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("upcoming");
  const [showModal, setShowModal] = useState(false);

  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<PatientLite[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<PatientLite | null>(null);
  const [doctors, setDoctors] = useState<DoctorLite[]>([]);
  const [form, setForm] = useState({
    doctorId: "",
    date: "",
    time: "",
    chiefComplaint: "",
    fee: 500,
  });
  // Issues #18 / #27: inline validation errors surfaced for fee, date, etc.
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const [ratingSession, setRatingSession] = useState<TelemedicineSession | null>(
    null
  );
  const [rating, setRating] = useState(5);

  const canSchedule =
    user?.role === "ADMIN" || user?.role === "DOCTOR" || user?.role === "RECEPTION";
  const canStartEnd = user?.role === "ADMIN" || user?.role === "DOCTOR";
  const canRate = user?.role === "PATIENT";

  useEffect(() => {
    loadSessions();
  }, [tab]);

  useEffect(() => {
    if (showModal) loadDoctors();
  }, [showModal]);

  useEffect(() => {
    if (patientSearch.length < 2) {
      setPatientResults([]);
      return;
    }
    const t = setTimeout(() => searchPatients(patientSearch), 300);
    return () => clearTimeout(t);
  }, [patientSearch]);

  async function loadSessions() {
    setLoading(true);
    try {
      let query = "";
      if (tab === "upcoming")
        query = "?status=SCHEDULED";
      else if (tab === "completed")
        query = "?status=COMPLETED";
      else if (tab === "cancelled")
        query = "?status=CANCELLED";
      const res = await api.get<{ data: TelemedicineSession[] }>(
        `/telemedicine${query}&limit=50`.replace("?&", "?")
      );
      // also merge WAITING/IN_PROGRESS into upcoming
      if (tab === "upcoming") {
        const [waitRes, progRes] = await Promise.all([
          api
            .get<{ data: TelemedicineSession[] }>(`/telemedicine?status=WAITING&limit=50`)
            .catch(() => ({ data: [] })),
          api
            .get<{ data: TelemedicineSession[] }>(`/telemedicine?status=IN_PROGRESS&limit=50`)
            .catch(() => ({ data: [] })),
        ]);
        const merged = [...res.data, ...waitRes.data, ...progRes.data];
        merged.sort(
          (a, b) =>
            new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
        );
        setSessions(merged);
      } else {
        setSessions(res.data);
      }
    } catch {
      setSessions([]);
    }
    setLoading(false);
  }

  async function searchPatients(q: string) {
    try {
      const res = await api.get<{ data: PatientLite[] }>(
        `/patients?search=${encodeURIComponent(q)}&limit=10`
      );
      setPatientResults(res.data);
    } catch {
      setPatientResults([]);
    }
  }

  async function loadDoctors() {
    try {
      const res = await api.get<{ data: DoctorLite[] }>("/doctors");
      setDoctors(res.data);
    } catch {
      // empty
    }
  }

  async function submitSchedule(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!selectedPatient) {
      errs.patient = "Select a patient";
    }
    if (!form.date || !form.time) {
      errs.scheduledAt = "Select date and time";
    }

    const feeNum = Number(form.fee);
    const scheduledAtRaw =
      form.date && form.time
        ? new Date(`${form.date}T${form.time}:00`).toISOString()
        : "";

    // Issues #18 / #27: validate via the shared Zod schema so both the
    // doctor/admin and reception flows reject negative fees and past dates
    // with identical semantics.
    const parsed = createTelemedicineSchema.safeParse({
      patientId: selectedPatient?.id ?? "",
      doctorId: form.doctorId,
      scheduledAt: scheduledAtRaw,
      chiefComplaint: form.chiefComplaint || undefined,
      fee: Number.isFinite(feeNum) ? feeNum : 500,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "_");
        if (!errs[field]) errs[field] = issue.message;
      }
    }

    setFormErrors(errs);
    if (Object.keys(errs).length > 0) {
      return;
    }

    try {
      await api.post("/telemedicine", {
        patientId: selectedPatient!.id,
        doctorId: form.doctorId,
        scheduledAt: scheduledAtRaw,
        chiefComplaint: form.chiefComplaint || undefined,
        fee: feeNum || 500,
      });
      setShowModal(false);
      setSelectedPatient(null);
      setPatientSearch("");
      setForm({ doctorId: "", date: "", time: "", chiefComplaint: "", fee: 500 });
      setFormErrors({});
      loadSessions();
    } catch (err) {
      // Issue #93 (2026-04-26): replace native alert() with a toast so
      // browser automation can read the error and so we don't violate
      // the no-native-dialogs rule. Server returns a 400 with a clear
      // message for past-date scheduling.
      const msg = err instanceof Error ? err.message : "Schedule failed";
      toast.error(msg);
    }
  }

  async function startSession(id: string) {
    try {
      await api.patch(`/telemedicine/${id}/start`);
      loadSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start");
    }
  }

  async function endSession(id: string) {
    const notes = await promptDialog({
      title: "End session",
      label: "Doctor notes (optional):",
      placeholder: "e.g. Patient stable, follow-up in 1 week",
      multiline: true,
      confirmLabel: "End session",
    });
    if (notes === null) return; // user cancelled
    try {
      await api.patch(`/telemedicine/${id}/end`, { doctorNotes: notes || undefined });
      loadSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not end");
    }
  }

  async function cancelSession(id: string) {
    const ok = await confirm({
      title: "Cancel this session?",
      message: "The patient will be notified that the session was cancelled.",
      confirmLabel: "Cancel session",
      cancelLabel: "Keep",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.patch(`/telemedicine/${id}/cancel`);
      loadSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  async function admitPatient(id: string, admit: boolean) {
    let reason: string | undefined;
    if (!admit) {
      const r = await promptDialog({
        title: "Deny patient",
        label: "Reason for denying (optional):",
        placeholder: "e.g. Wrong appointment, patient already seen",
        multiline: false,
        confirmLabel: "Deny",
      });
      if (r === null) return; // user cancelled
      reason = r || undefined;
    }
    try {
      const res = await api.post<{
        data: { doctorUrl?: string | null; patientUrl?: string | null };
      }>(`/telemedicine/${id}/waiting-room/admit`, { admit, reason });
      if (admit && res.data?.doctorUrl) {
        window.open(res.data.doctorUrl, "_blank", "noopener");
      }
      loadSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Admit failed");
    }
  }

  // Listen for patient-waiting notifications
  useEffect(() => {
    if (!user?.id) return;
    if (user.role !== "DOCTOR" && user.role !== "ADMIN") return;
    const socket = getSocket();
    if (!socket.connected) socket.connect();
    socket.emit("join", `telemedicine:doctor:${user.id}`);
    const handler = () => loadSessions();
    socket.on("telemedicine:patient-waiting", handler);
    return () => {
      socket.off("telemedicine:patient-waiting", handler);
    };
  }, [user?.id, user?.role]);

  async function submitRating() {
    if (!ratingSession) return;
    try {
      await api.patch(`/telemedicine/${ratingSession.id}/rating`, {
        patientRating: rating,
      });
      setRatingSession(null);
      loadSessions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rating failed");
    }
  }

  const tabClasses = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  const filtered = useMemo(() => sessions, [sessions]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Telemedicine</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Virtual video consultations with patients
          </p>
        </div>
        {canSchedule && (
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Schedule Session
          </button>
        )}
      </div>

      <div className="mb-4 flex gap-2">
        <button onClick={() => setTab("upcoming")} className={tabClasses("upcoming")}>
          Upcoming
        </button>
        <button
          onClick={() => setTab("completed")}
          className={tabClasses("completed")}
        >
          Completed
        </button>
        <button
          onClick={() => setTab("cancelled")}
          className={tabClasses("cancelled")}
        >
          Cancelled
        </button>
      </div>

      {loading ? (
        <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
          Loading...
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
          No sessions found.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((s) => {
            const canJoin = joinActive(s);
            return (
              <div
                key={s.id}
                className="rounded-xl bg-white p-5 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-400 dark:text-gray-500">
                    {s.sessionNumber}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[s.status] || ""}`}
                  >
                    {s.status.replace("_", " ")}
                  </span>
                </div>

                <h3 className="text-base font-semibold">{s.patient.user.name}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-300">
                  {formatDoctorName(s.doctor.user.name)}
                  {s.doctor.specialization && ` · ${s.doctor.specialization}`}
                </p>

                <div className="mt-3 text-sm">
                  <p className="text-gray-600 dark:text-gray-300">
                    {new Date(s.scheduledAt).toLocaleString()}
                  </p>
                  {s.chiefComplaint && (
                    <p className="mt-1 line-clamp-2 text-xs text-gray-500">
                      {s.chiefComplaint}
                    </p>
                  )}
                  {s.durationMin != null && (
                    <p className="mt-1 text-xs text-gray-500">
                      Duration: {s.durationMin} min
                    </p>
                  )}
                  {s.patientRating && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-yellow-500">
                      {Array.from({ length: s.patientRating }).map((_, i) => (
                        <Star key={i} size={12} fill="currentColor" />
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {canJoin && s.meetingUrl && (
                    <a
                      href={s.meetingUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                    >
                      <Video size={14} /> Join Call
                    </a>
                  )}
                  {canStartEnd && s.status === "SCHEDULED" && (
                    <button
                      onClick={() => startSession(s.id)}
                      className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-dark"
                    >
                      <Play size={14} /> Start
                    </button>
                  )}
                  {canStartEnd && s.status === "WAITING" && (
                    <>
                      <button
                        onClick={() => admitPatient(s.id, true)}
                        className="flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                      >
                        <UserCheck size={14} /> Admit
                      </button>
                      <button
                        onClick={() => admitPatient(s.id, false)}
                        className="flex items-center gap-1 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                      >
                        <UserX size={14} /> Deny
                      </button>
                    </>
                  )}
                  {canStartEnd && s.status === "IN_PROGRESS" && (
                    <button
                      onClick={() => endSession(s.id)}
                      className="flex items-center gap-1 rounded-lg bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800"
                    >
                      <Square size={14} /> End
                    </button>
                  )}
                  {/* GAP-S14: Start Ambient Scribe (DOCTOR only, only while
                      the tele-consult is in progress). Opens the scribe page
                      in a new tab pre-focused on this patient so the doctor
                      can capture audio while Jitsi is still active. */}
                  {user?.role === "DOCTOR" && s.status === "IN_PROGRESS" && (
                    <Link
                      href={`/dashboard/scribe?patientId=${s.patient.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                      title="Start ambient scribe in a new tab while the call continues"
                    >
                      <Mic size={14} /> Start Ambient Scribe
                    </Link>
                  )}
                  {(s.status === "SCHEDULED" || s.status === "WAITING") && (
                    <button
                      onClick={() => cancelSession(s.id)}
                      className="flex items-center gap-1 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      <XCircle size={14} /> Cancel
                    </button>
                  )}
                  {canRate && s.status === "COMPLETED" && !s.patientRating && (
                    <button
                      onClick={() => {
                        setRatingSession(s);
                        setRating(5);
                      }}
                      className="flex items-center gap-1 rounded-lg border border-yellow-300 px-3 py-1.5 text-xs font-medium text-yellow-700 hover:bg-yellow-50"
                    >
                      <Star size={14} /> Rate
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Schedule modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form
            onSubmit={submitSchedule}
            className="w-full max-w-2xl rounded-2xl bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100"
          >
            <h2 className="mb-4 text-lg font-semibold">Schedule Telemedicine Session</h2>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">Patient</label>
                {selectedPatient ? (
                  <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900">
                    <span>
                      <strong>{selectedPatient.user.name}</strong>
                      {selectedPatient.mrNumber && ` — ${selectedPatient.mrNumber}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPatient(null);
                        setPatientSearch("");
                      }}
                      className="text-xs text-red-600 dark:text-red-400"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      placeholder="Search by name or MR number"
                      value={patientSearch}
                      onChange={(e) => setPatientSearch(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                    />
                    {patientResults.length > 0 && (
                      <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                        {patientResults.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setSelectedPatient(p);
                              setPatientResults([]);
                            }}
                            className="block w-full px-3 py-2 text-left text-sm text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-700"
                          >
                            <strong>{p.user.name}</strong>
                            {p.mrNumber && ` · ${p.mrNumber}`}
                            {p.user.phone && ` · ${p.user.phone}`}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">Doctor</label>
                <select
                  required
                  value={form.doctorId}
                  onChange={(e) => setForm({ ...form, doctorId: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option value="">Select Doctor</option>
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.user.name}
                      {d.specialization && ` — ${d.specialization}`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium">Date</label>
                  <input
                    type="date"
                    required
                    value={form.date}
                    min={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                    className={
                      "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 " +
                      (formErrors.scheduledAt ? "border-red-500" : "")
                    }
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Time</label>
                  <input
                    type="time"
                    required
                    value={form.time}
                    onChange={(e) => setForm({ ...form, time: e.target.value })}
                    className={
                      "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 " +
                      (formErrors.scheduledAt ? "border-red-500" : "")
                    }
                  />
                </div>
                {formErrors.scheduledAt && (
                  <p className="col-span-2 -mt-2 text-xs text-red-600 dark:text-red-400">
                    {formErrors.scheduledAt}
                  </p>
                )}
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">Chief Complaint</label>
                <textarea
                  rows={2}
                  value={form.chiefComplaint}
                  onChange={(e) =>
                    setForm({ ...form, chiefComplaint: e.target.value })
                  }
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">Fee</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.fee}
                  onChange={(e) =>
                    setForm({ ...form, fee: Number(e.target.value) })
                  }
                  className={
                    "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 " +
                    (formErrors.fee ? "border-red-500" : "")
                  }
                />
                {formErrors.fee && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{formErrors.fee}</p>
                )}
              </div>

              {formErrors.patient && (
                <p className="text-xs text-red-600 dark:text-red-400">{formErrors.patient}</p>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Schedule
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rating modal */}
      {ratingSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold">Rate Your Session</h2>
            <p className="mb-3 text-sm text-gray-600">
              Session with {formatDoctorName(ratingSession.doctor.user.name)}
            </p>
            <div className="mb-6 flex justify-center gap-2">
              {[1, 2, 3, 4, 5].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setRating(v)}
                  className={`text-3xl transition ${
                    v <= rating ? "text-yellow-500" : "text-gray-300"
                  }`}
                >
                  <Star fill={v <= rating ? "currentColor" : "none"} />
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRatingSession(null)}
                className="rounded-lg border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={submitRating}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
