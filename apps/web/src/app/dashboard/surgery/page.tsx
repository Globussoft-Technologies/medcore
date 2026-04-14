"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Plus, Scissors } from "lucide-react";

interface Doctor {
  id: string;
  userId: string;
  user: { name: string };
  specialization?: string;
}

interface OT {
  id: string;
  name: string;
  floor?: string | null;
  isActive: boolean;
  dailyRate: number;
}

interface PatientSearchResult {
  id: string;
  mrNumber?: string;
  user: { name: string; phone?: string };
}

interface Surgery {
  id: string;
  caseNumber: string;
  patientId: string;
  surgeonId: string;
  otId: string;
  procedure: string;
  scheduledAt: string;
  durationMin?: number | null;
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "POSTPONED";
  cost?: number | null;
  patient: { id: string; mrNumber?: string; user: { name: string; phone?: string } };
  surgeon: { id: string; user: { name: string } };
  ot: { id: string; name: string };
}

type Tab = "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-yellow-100 text-yellow-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-red-100 text-red-700",
  POSTPONED: "bg-gray-100 text-gray-700",
};

export default function SurgeryPage() {
  const { user } = useAuthStore();
  const [surgeries, setSurgeries] = useState<Surgery[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("SCHEDULED");
  const [showCreate, setShowCreate] = useState(false);

  // Form
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [ots, setOts] = useState<OT[]>([]);
  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<PatientSearchResult[]>([]);
  const [selectedPatient, setSelectedPatient] =
    useState<PatientSearchResult | null>(null);
  const [form, setForm] = useState({
    surgeonId: "",
    otId: "",
    procedure: "",
    scheduledAt: "",
    durationMin: "60",
    anaesthesiologist: "",
    assistants: "",
    preOpNotes: "",
    diagnosis: "",
    cost: "",
  });

  const canSchedule = user?.role === "DOCTOR" || user?.role === "ADMIN";

  const loadSurgeries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Surgery[] }>(
        `/surgery?status=${tab}&limit=100`
      );
      setSurgeries(res.data);
    } catch {
      setSurgeries([]);
    }
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    loadSurgeries();
  }, [loadSurgeries]);

  useEffect(() => {
    if (showCreate) {
      api
        .get<{ data: Doctor[] }>("/doctors")
        .then((res) => setDoctors(res.data))
        .catch(() => setDoctors([]));
      api
        .get<{ data: OT[] }>("/surgery/ots")
        .then((res) => setOts(res.data))
        .catch(() => setOts([]));
    }
  }, [showCreate]);

  useEffect(() => {
    if (patientSearch.length < 2) {
      setPatientResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: PatientSearchResult[] }>(
          `/patients?search=${encodeURIComponent(patientSearch)}&limit=10`
        );
        setPatientResults(res.data);
      } catch {
        setPatientResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [patientSearch]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPatient) {
      alert("Select a patient");
      return;
    }
    if (!form.scheduledAt) {
      alert("Select scheduled date/time");
      return;
    }
    try {
      await api.post("/surgery", {
        patientId: selectedPatient.id,
        surgeonId: form.surgeonId,
        otId: form.otId,
        procedure: form.procedure,
        scheduledAt: new Date(form.scheduledAt).toISOString(),
        durationMin: form.durationMin ? parseInt(form.durationMin, 10) : undefined,
        anaesthesiologist: form.anaesthesiologist || undefined,
        assistants: form.assistants || undefined,
        preOpNotes: form.preOpNotes || undefined,
        diagnosis: form.diagnosis || undefined,
        cost: form.cost ? parseFloat(form.cost) : undefined,
      });
      setShowCreate(false);
      setSelectedPatient(null);
      setPatientSearch("");
      setForm({
        surgeonId: "",
        otId: "",
        procedure: "",
        scheduledAt: "",
        durationMin: "60",
        anaesthesiologist: "",
        assistants: "",
        preOpNotes: "",
        diagnosis: "",
        cost: "",
      });
      loadSurgeries();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Scheduling failed");
    }
  }

  async function startSurgery(id: string) {
    try {
      await api.patch(`/surgery/${id}/start`, {});
      loadSurgeries();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Start failed");
    }
  }

  async function completeSurgery(id: string) {
    const postOpNotes = prompt("Post-op notes (optional):") || undefined;
    try {
      await api.patch(`/surgery/${id}/complete`, { postOpNotes });
      loadSurgeries();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Complete failed");
    }
  }

  async function cancelSurgery(id: string) {
    const reason = prompt("Cancellation reason:");
    if (!reason) return;
    try {
      await api.patch(`/surgery/${id}/cancel`, { reason });
      loadSurgeries();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  const tabClasses = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Surgery</h1>
          <p className="text-sm text-gray-500">
            Operating theater scheduling and case management
          </p>
        </div>
        {canSchedule && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Schedule Surgery
          </button>
        )}
      </div>

      <div className="mb-4 flex gap-2">
        <button onClick={() => setTab("SCHEDULED")} className={tabClasses("SCHEDULED")}>
          Scheduled
        </button>
        <button
          onClick={() => setTab("IN_PROGRESS")}
          className={tabClasses("IN_PROGRESS")}
        >
          In Progress
        </button>
        <button onClick={() => setTab("COMPLETED")} className={tabClasses("COMPLETED")}>
          Completed
        </button>
        <button onClick={() => setTab("CANCELLED")} className={tabClasses("CANCELLED")}>
          Cancelled
        </button>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : surgeries.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Scissors size={32} className="mx-auto mb-2 text-gray-300" />
            No surgeries in this state.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Case #</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Surgeon</th>
                <th className="px-4 py-3">OT</th>
                <th className="px-4 py-3">Procedure</th>
                <th className="px-4 py-3">Scheduled</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {surgeries.map((s) => (
                <tr key={s.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">
                    <Link
                      href={`/dashboard/surgery/${s.id}`}
                      className="text-primary hover:underline"
                    >
                      {s.caseNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{s.patient.user.name}</p>
                    <p className="text-xs text-gray-500">{s.patient.mrNumber}</p>
                  </td>
                  <td className="px-4 py-3 text-sm">{s.surgeon.user.name}</td>
                  <td className="px-4 py-3 text-sm">{s.ot.name}</td>
                  <td className="px-4 py-3 text-sm">{s.procedure}</td>
                  <td className="px-4 py-3 text-sm">
                    {new Date(s.scheduledAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {s.durationMin ? `${s.durationMin} min` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[s.status]}`}
                    >
                      {s.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {s.status === "SCHEDULED" && canSchedule && (
                        <>
                          <button
                            onClick={() => startSurgery(s.id)}
                            className="rounded bg-yellow-500 px-2 py-1 text-xs text-white hover:bg-yellow-600"
                          >
                            Start
                          </button>
                          <button
                            onClick={() => cancelSurgery(s.id)}
                            className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {s.status === "IN_PROGRESS" && canSchedule && (
                        <button
                          onClick={() => completeSurgery(s.id)}
                          className="rounded bg-green-500 px-2 py-1 text-xs text-white hover:bg-green-600"
                        >
                          Complete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Schedule modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={submit}
            className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
          >
            <h2 className="mb-4 text-lg font-semibold">Schedule Surgery</h2>

            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium">Patient</label>
              {selectedPatient ? (
                <div className="flex items-center justify-between rounded-lg border bg-gray-50 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{selectedPatient.user.name}</p>
                    <p className="text-xs text-gray-500">
                      {selectedPatient.mrNumber} · {selectedPatient.user.phone}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedPatient(null)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    placeholder="Search by name or phone..."
                    value={patientSearch}
                    onChange={(e) => setPatientSearch(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                  {patientResults.length > 0 && (
                    <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border bg-white">
                      {patientResults.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setSelectedPatient(p);
                            setPatientResults([]);
                            setPatientSearch("");
                          }}
                          className="block w-full border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-gray-50"
                        >
                          <p className="font-medium">{p.user.name}</p>
                          <p className="text-xs text-gray-500">
                            {p.mrNumber} · {p.user.phone}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">Surgeon</label>
                <select
                  value={form.surgeonId}
                  onChange={(e) => setForm((f) => ({ ...f, surgeonId: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  required
                >
                  <option value="">Select surgeon</option>
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.user.name} — {d.specialization}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Operating Theater</label>
                <select
                  value={form.otId}
                  onChange={(e) => setForm((f) => ({ ...f, otId: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  required
                >
                  <option value="">Select OT</option>
                  {ots.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} {o.floor ? `(Floor ${o.floor})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium">Procedure</label>
              <textarea
                value={form.procedure}
                onChange={(e) => setForm((f) => ({ ...f, procedure: e.target.value }))}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                rows={2}
                required
              />
            </div>

            <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Scheduled At</label>
                <input
                  type="datetime-local"
                  value={form.scheduledAt}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, scheduledAt: e.target.value }))
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Duration (min)
                </label>
                <input
                  type="number"
                  min="0"
                  value={form.durationMin}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, durationMin: e.target.value }))
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Estimated Cost
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.cost}
                  onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Anaesthesiologist
                </label>
                <input
                  type="text"
                  value={form.anaesthesiologist}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, anaesthesiologist: e.target.value }))
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Assistants</label>
                <input
                  type="text"
                  value={form.assistants}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, assistants: e.target.value }))
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  placeholder="Comma-separated names"
                />
              </div>
            </div>

            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium">Diagnosis</label>
              <input
                type="text"
                value={form.diagnosis}
                onChange={(e) => setForm((f) => ({ ...f, diagnosis: e.target.value }))}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>

            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium">Pre-Op Notes</label>
              <textarea
                value={form.preOpNotes}
                onChange={(e) =>
                  setForm((f) => ({ ...f, preOpNotes: e.target.value }))
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
                rows={3}
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-lg border px-4 py-2 text-sm"
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
    </div>
  );
}
