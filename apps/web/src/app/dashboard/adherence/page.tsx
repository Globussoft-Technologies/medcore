"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Bell, Trash2, Plus, Clock, Calendar, Pill } from "lucide-react";

interface MedicationItem {
  name: string;
  dosage: string;
  frequency: string;
  duration: string;
  reminderTimes: string[];
}

interface AdherenceSchedule {
  id: string;
  patientId: string;
  prescriptionId: string;
  medications: MedicationItem[];
  startDate: string;
  endDate: string;
  active: boolean;
  remindersSent: number;
  lastReminderAt: string | null;
  createdAt: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function AdherencePage() {
  const { user } = useAuthStore();
  const [schedules, setSchedules] = useState<AdherenceSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Enroll form state
  const [showEnroll, setShowEnroll] = useState(false);
  const [enrollPrescriptionId, setEnrollPrescriptionId] = useState("");
  const [enrollReminderTimes, setEnrollReminderTimes] = useState<string[]>([""]);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);

  // Issue #24: patients must not be asked to look up their own patientId.
  // For PATIENT role we call the new /ai/adherence/mine endpoint which
  // resolves the patientId server-side from the authed user. For staff
  // roles (who were never the cause of the bug but still need this page
  // during triage) we keep the /patients?userId= lookup since staff are
  // authorized to hit that endpoint.
  const [patientId, setPatientId] = useState<string | null>(null);
  // `hasPatientProfile` is the single source of truth for the "profile
  // missing" empty state. For PATIENT: true once /mine returned 200, false
  // if /mine returned 404, null while still loading. For staff: true once
  // /patients?userId lookup returned a row, false if it returned empty.
  const [hasPatientProfile, setHasPatientProfile] =
    useState<boolean | null>(null);

  const isPatient = user?.role === "PATIENT";

  useEffect(() => {
    if (!user) return;
    if (isPatient) {
      loadSchedulesMine();
      return;
    }
    // Staff (ADMIN/DOCTOR/NURSE/RECEPTION) path — unchanged.
    api
      .get<{ data: { id: string }[] }>(`/patients?userId=${user.id}&limit=1`)
      .then((res) => {
        const pid = res.data?.[0]?.id ?? null;
        setPatientId(pid);
        setHasPatientProfile(!!pid);
      })
      .catch(() => {
        setHasPatientProfile(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isPatient]);

  useEffect(() => {
    if (isPatient) return; // /mine path already handled above
    if (!patientId) return;
    loadSchedulesById(patientId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  async function loadSchedulesMine() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{
        data: AdherenceSchedule[];
      }>(`/ai/adherence/mine`);
      const list = res.data ?? [];
      setSchedules(list);
      setHasPatientProfile(true);
      // Surface the resolved id so the enroll flow can refresh after success.
      if (list[0]?.patientId) setPatientId(list[0].patientId);
    } catch (err: any) {
      // 404 = no Patient row linked. Leave the existing "no patient profile"
      // empty-state to render instead of a scary red error banner.
      if (err?.status === 404) {
        setHasPatientProfile(false);
        setPatientId(null);
      } else {
        setError(err.message ?? "Failed to load schedules");
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadSchedulesById(pid: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ data: AdherenceSchedule[] }>(
        `/ai/adherence/${pid}`
      );
      setSchedules(res.data ?? []);
    } catch (err: any) {
      setError(err.message ?? "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }

  async function handleUnenroll(scheduleId: string) {
    if (!confirm("Remove this medication reminder schedule?")) return;
    try {
      await api.delete<{ data: AdherenceSchedule }>(`/ai/adherence/${scheduleId}`);
      setSchedules((prev) => prev.filter((s) => s.id !== scheduleId));
    } catch (err: any) {
      alert(err.message ?? "Failed to unenroll");
    }
  }

  async function handleEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!enrollPrescriptionId.trim()) {
      setEnrollError("Prescription ID is required");
      return;
    }
    setEnrolling(true);
    setEnrollError(null);
    try {
      const validTimes = enrollReminderTimes.filter((t) => t.trim() !== "");
      await api.post<{ data: AdherenceSchedule }>("/ai/adherence/enroll", {
        prescriptionId: enrollPrescriptionId.trim(),
        reminderTimes: validTimes.length > 0 ? validTimes : undefined,
      });
      setShowEnroll(false);
      setEnrollPrescriptionId("");
      setEnrollReminderTimes([""]);
      // PATIENT refreshes via /mine (patientId may not be known yet on first
      // enroll). Staff refreshes via the resolved patientId.
      if (isPatient) {
        await loadSchedulesMine();
      } else if (patientId) {
        await loadSchedulesById(patientId);
      }
    } catch (err: any) {
      setEnrollError(err.message ?? "Failed to enroll");
    } finally {
      setEnrolling(false);
    }
  }

  function addReminderTimeInput() {
    setEnrollReminderTimes((prev) => [...prev, ""]);
  }

  function updateReminderTime(index: number, value: string) {
    setEnrollReminderTimes((prev) => prev.map((t, i) => (i === index ? value : t)));
  }

  function removeReminderTime(index: number) {
    setEnrollReminderTimes((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Bell className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-semibold text-gray-900">Medication Reminders</h1>
        </div>
        <button
          onClick={() => setShowEnroll((v) => !v)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          Enroll Prescription
        </button>
      </div>

      {/* Enroll form */}
      {showEnroll && (
        <div className="mb-6 bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
          <h2 className="text-lg font-medium text-gray-800 mb-4">Enroll a Prescription</h2>
          <form onSubmit={handleEnroll} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Prescription ID
              </label>
              <input
                type="text"
                value={enrollPrescriptionId}
                onChange={(e) => setEnrollPrescriptionId(e.target.value)}
                placeholder="e.g. 6a4f2b..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reminder Times (optional — leave blank to auto-derive)
              </label>
              <div className="space-y-2">
                {enrollReminderTimes.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="time"
                      value={t}
                      onChange={(e) => updateReminderTime(i, e.target.value)}
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {enrollReminderTimes.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeReminderTime(i)}
                        className="text-red-500 hover:text-red-700 text-sm"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addReminderTimeInput}
                  className="text-blue-600 hover:text-blue-800 text-sm flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" /> Add time
                </button>
              </div>
            </div>

            {enrollError && (
              <p className="text-red-600 text-sm">{enrollError}</p>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={enrolling}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {enrolling ? "Enrolling..." : "Enroll"}
              </button>
              <button
                type="button"
                onClick={() => setShowEnroll(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Loading / error states */}
      {loading && (
        <div className="text-center py-12 text-gray-500 text-sm">Loading reminders...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">
          {error}
        </div>
      )}

      {/* No patient profile at all — the Issue #24 copy. Only rendered when
          the lookup / /mine endpoint has definitively told us there is no
          Patient row. */}
      {!loading && !error && hasPatientProfile === false && (
        <div className="text-center py-12 text-gray-500 text-sm">
          No patient profile found for your account.
        </div>
      )}
      {!loading &&
        !error &&
        hasPatientProfile === true &&
        schedules.length === 0 && (
        <div className="text-center py-12">
          <Pill className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">No active medication reminders.</p>
          <p className="text-gray-400 text-xs mt-1">
            Enroll a prescription above to get started.
          </p>
        </div>
      )}

      {/* Schedule cards */}
      <div className="space-y-4">
        {schedules.map((schedule) => (
          <div
            key={schedule.id}
            className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm"
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-xs text-gray-400 mb-1">
                  Prescription ID: <span className="font-mono">{schedule.prescriptionId}</span>
                </p>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5" />
                    {formatDate(schedule.startDate)} — {formatDate(schedule.endDate)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Bell className="w-3.5 h-3.5" />
                    {schedule.remindersSent} reminder{schedule.remindersSent !== 1 ? "s" : ""} sent
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleUnenroll(schedule.id)}
                title="Unenroll"
                className="flex items-center gap-1 px-3 py-1.5 text-red-600 border border-red-200 rounded-lg hover:bg-red-50 text-xs font-medium transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Unenroll
              </button>
            </div>

            {/* Medications list */}
            <div className="space-y-2">
              {(schedule.medications ?? []).map((med, idx) => (
                <div
                  key={idx}
                  className="flex items-start justify-between bg-blue-50 rounded-lg px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">{med.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {med.dosage} · {med.frequency} · {med.duration}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-blue-700 mt-0.5">
                    <Clock className="w-3.5 h-3.5 shrink-0" />
                    <span>{med.reminderTimes?.join(", ") ?? "—"}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
