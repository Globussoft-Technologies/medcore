"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { extractFieldErrors } from "@/lib/field-errors";
import { usePrompt } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { Autocomplete } from "@/components/Autocomplete";
import { InfoIcon } from "@/components/Tooltip";
import { Plus, Scissors } from "lucide-react";
import { formatDoctorName } from "@/lib/format-doctor-name";

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
  status:
    | "SCHEDULED"
    | "IN_PROGRESS"
    | "COMPLETED"
    | "CANCELLED"
    | "POSTPONED"
    | "MISSED_SCHEDULE";
  cost?: number | null;
  patient: { id: string; mrNumber?: string; user: { name: string; phone?: string } };
  surgeon: { id: string; user: { name: string } };
  ot: { id: string; name: string };
}

// Issue #86: surface a surgery start failure with the underlying reason.
// The API may return either a flat `error` string ("Pre-op checklist
// incomplete") or zod-style `details: [{field, message}]` (past-dated
// scheduledAt). Either way we want the user to see *what* went wrong.
function startErrorMessage(err: unknown): string {
  const fields = extractFieldErrors(err);
  if (fields) {
    const first = Object.values(fields)[0];
    if (first) return first;
  }
  if (err && typeof err === "object") {
    const payload = (err as { payload?: unknown }).payload as
      | { missing?: string[]; error?: string }
      | undefined;
    if (payload?.missing && Array.isArray(payload.missing) && payload.missing.length > 0) {
      return `Pre-op checklist incomplete: ${payload.missing.join(", ")}`;
    }
    if (payload?.error) return payload.error;
  }
  return err instanceof Error ? err.message : "Start failed";
}

type Tab = "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

// Issue #436 (Apr 30 2026): nurse view of surgery schedule was a flat list
// with no date filter, no status filter beyond the four tabs, and no
// sortable column headers. Add a client-side sort key and direction so the
// nurse can scan by start time / case # / patient / surgeon.
type SortKey = "scheduledAt" | "caseNumber" | "patient" | "surgeon" | "status";
type SortDir = "asc" | "desc";

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-yellow-100 text-yellow-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-red-100 text-red-700",
  POSTPONED: "bg-gray-100 text-gray-700",
  MISSED_SCHEDULE: "bg-orange-100 text-orange-700",
};

// Issue #86: a SCHEDULED surgery whose scheduledAt is in the past should be
// shown to the user as MISSED_SCHEDULE. We do NOT mutate the database from a
// read; the canonical state remains SCHEDULED so a doctor can still Start it
// (back-dated start is a real operational case for emergencies). This is a
// view-time tag only.
const STALE_GRACE_MIN = 30;
function effectiveStatus(s: Pick<Surgery, "status" | "scheduledAt">): Surgery["status"] {
  if (s.status !== "SCHEDULED") return s.status;
  const scheduled = new Date(s.scheduledAt).getTime();
  if (Number.isNaN(scheduled)) return s.status;
  if (Date.now() - scheduled > STALE_GRACE_MIN * 60 * 1000) return "MISSED_SCHEDULE";
  return s.status;
}

export default function SurgeryPage() {
  const { user } = useAuthStore();
  const promptUser = usePrompt();
  const [surgeries, setSurgeries] = useState<Surgery[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("SCHEDULED");
  const [showCreate, setShowCreate] = useState(false);

  // Issue #436: filter + sort state. Default `from` to today (00:00) and
  // `to` empty so the nurse view collapses to today + future, which is the
  // common theatre-nursing case. Sort defaults to scheduledAt ASC for the
  // SCHEDULED tab (next-up first), and DESC for completed/cancelled
  // (most-recent first).
  const [fromDate, setFromDate] = useState<string>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("scheduledAt");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // Issue #86: client-side parity with the schedule schema's past-date guard.
  // datetime-local doesn't accept seconds, so we round to the next minute.
  const minScheduledAt = new Date(Date.now()).toISOString().slice(0, 16);

  const canSchedule = user?.role === "DOCTOR" || user?.role === "ADMIN";

  const loadSurgeries = useCallback(async () => {
    setLoading(true);
    try {
      // Issue #436: pass `from`/`to` through to the API so the server does
      // the date scoping (the route already supports it — see
      // GET /api/v1/surgery in apps/api/src/routes/surgery.ts).
      const params = new URLSearchParams({
        status: tab,
        limit: "100",
      });
      if (fromDate) {
        params.set("from", new Date(`${fromDate}T00:00:00`).toISOString());
      }
      if (toDate) {
        params.set("to", new Date(`${toDate}T23:59:59`).toISOString());
      }
      const res = await api.get<{ data: Surgery[] }>(
        `/surgery?${params.toString()}`
      );
      setSurgeries(res.data);
    } catch {
      setSurgeries([]);
    }
    setLoading(false);
  }, [tab, fromDate, toDate]);

  useEffect(() => {
    loadSurgeries();
  }, [loadSurgeries]);

  // Issue #436: when the tab changes, flip the default sort direction so
  // future-facing tabs (SCHEDULED, IN_PROGRESS) lead with "next up first"
  // and historical tabs (COMPLETED, CANCELLED) lead with "most recent first".
  // We only reset when the user hasn't explicitly clicked a sort header for
  // this tab — but tracking that is over-engineering, so we just reset to
  // scheduledAt + the natural direction on every tab switch.
  useEffect(() => {
    setSortKey("scheduledAt");
    setSortDir(tab === "SCHEDULED" || tab === "IN_PROGRESS" ? "asc" : "desc");
  }, [tab]);

  // Issue #436: pure client-side sort over the loaded page. We cap at 100
  // rows server-side so a stable in-memory sort is fine.
  const sortedSurgeries = (() => {
    const copy = [...surgeries];
    copy.sort((a, b) => {
      let av: string | number = "";
      let bv: string | number = "";
      switch (sortKey) {
        case "scheduledAt":
          av = new Date(a.scheduledAt).getTime();
          bv = new Date(b.scheduledAt).getTime();
          break;
        case "caseNumber":
          av = a.caseNumber || "";
          bv = b.caseNumber || "";
          break;
        case "patient":
          av = a.patient.user.name || "";
          bv = b.patient.user.name || "";
          break;
        case "surgeon":
          av = a.surgeon.user.name || "";
          bv = b.surgeon.user.name || "";
          break;
        case "status":
          av = effectiveStatus(a);
          bv = effectiveStatus(b);
          break;
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  })();

  function toggleSort(k: SortKey) {
    if (sortKey === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir("asc");
    }
  }

  function sortIndicator(k: SortKey): string {
    if (sortKey !== k) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

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
    setScheduleError(null);
    if (!selectedPatient) {
      toast.error("Select a patient");
      return;
    }
    if (!form.scheduledAt) {
      toast.error("Select scheduled date/time");
      return;
    }
    // Issue #86: block past-dated submissions before they hit the API.
    const scheduledMs = new Date(form.scheduledAt).getTime();
    if (Number.isFinite(scheduledMs) && scheduledMs < Date.now() - 5 * 60 * 1000) {
      setScheduleError("Scheduled date/time cannot be in the past");
      toast.error("Scheduled date/time cannot be in the past");
      return;
    }
    // Issue #53: pre-submit numeric guards (mirror the zod schema so we fail
    // fast rather than round-tripping a 400 from the API).
    if (form.durationMin) {
      const dur = parseInt(form.durationMin, 10);
      if (!Number.isFinite(dur) || dur <= 0) {
        toast.error("Duration must be greater than 0");
        return;
      }
    }
    if (form.cost) {
      const c = parseFloat(form.cost);
      if (!Number.isFinite(c) || c < 0) {
        toast.error("Cost cannot be negative");
        return;
      }
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
      const fields = extractFieldErrors(err);
      if (fields) {
        const msg = Object.values(fields)[0] || "Scheduling failed";
        setScheduleError(msg);
        toast.error(msg);
      } else {
        toast.error(err instanceof Error ? err.message : "Scheduling failed");
      }
    }
  }

  async function startSurgery(id: string) {
    try {
      await api.patch(`/surgery/${id}/start`, {});
      loadSurgeries();
    } catch (err) {
      // Issue #86: previously this lost detail when the API returned
      // missing-checklist items or zod validation, so the user saw nothing.
      toast.error(startErrorMessage(err));
    }
  }

  async function completeSurgery(id: string) {
    const postOpNotes = await promptUser({
      title: "Complete surgery",
      label: "Post-op notes (optional)",
      multiline: true,
    });
    if (postOpNotes === null) return;
    try {
      await api.patch(`/surgery/${id}/complete`, { postOpNotes: postOpNotes || undefined });
      loadSurgeries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Complete failed");
    }
  }

  async function cancelSurgery(id: string) {
    const reason = await promptUser({
      title: "Cancel surgery",
      label: "Cancellation reason",
      required: true,
      multiline: true,
    });
    if (!reason) return;
    try {
      await api.patch(`/surgery/${id}/cancel`, { reason });
      loadSurgeries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Surgery</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
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

      {/* Issue #436: nurse-usable date filter row. Placing this under the
          status tabs (and not in the modal) lets theatre nursing collapse
          the schedule to "today" or "this week" without opening a form. */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
            From
          </label>
          <input
            type="date"
            data-testid="surgery-filter-from"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
            To
          </label>
          <input
            type="date"
            data-testid="surgery-filter-to"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            setFromDate(d.toISOString().slice(0, 10));
            setToDate(d.toISOString().slice(0, 10));
          }}
          className="rounded-lg border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
          data-testid="surgery-filter-today"
        >
          Today
        </button>
        <button
          type="button"
          onClick={() => {
            setFromDate("");
            setToDate("");
          }}
          className="rounded-lg border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
          data-testid="surgery-filter-clear"
        >
          Clear dates
        </button>
        <span
          className="ml-auto text-xs text-gray-500 dark:text-gray-400"
          data-testid="surgery-result-count"
        >
          {sortedSurgeries.length} result{sortedSurgeries.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="rounded-xl bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>
        ) : sortedSurgeries.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            <Scissors size={32} className="mx-auto mb-2 text-gray-300 dark:text-gray-600" />
            No surgeries in this state.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {/* Issue #436: click-to-sort headers. Each clickable column
                    is rendered as a button so it's keyboard accessible and
                    announces a role-presentation to screen readers. */}
                <th className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleSort("caseNumber")}
                    data-testid="surgery-sort-caseNumber"
                    className="font-medium hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    Case #{sortIndicator("caseNumber")}
                  </button>
                </th>
                <th className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleSort("patient")}
                    data-testid="surgery-sort-patient"
                    className="font-medium hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    Patient{sortIndicator("patient")}
                  </button>
                </th>
                <th className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleSort("surgeon")}
                    data-testid="surgery-sort-surgeon"
                    className="font-medium hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    Surgeon{sortIndicator("surgeon")}
                  </button>
                </th>
                <th className="px-4 py-3">OT</th>
                <th className="px-4 py-3">Procedure</th>
                <th className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleSort("scheduledAt")}
                    data-testid="surgery-sort-scheduledAt"
                    className="font-medium hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    Scheduled{sortIndicator("scheduledAt")}
                  </button>
                </th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleSort("status")}
                    data-testid="surgery-sort-status"
                    className="font-medium hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    Status{sortIndicator("status")}
                  </button>
                </th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedSurgeries.map((s) => {
                const effective = effectiveStatus(s);
                return (
                  <tr key={s.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700">
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
                      <p className="text-xs text-gray-500 dark:text-gray-400">{s.patient.mrNumber}</p>
                    </td>
                    <td className="px-4 py-3 text-sm">{formatDoctorName(s.surgeon.user.name)}</td>
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
                        data-testid={`surgery-status-${s.id}`}
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[effective] || STATUS_COLORS[s.status]}`}
                      >
                        {effective.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {/* Issue #148: hide "Start" once a SCHEDULED row has
                            slipped past its grace window — the case is
                            effectively MISSED_SCHEDULE. The user must
                            explicitly Reschedule (a future enhancement) or
                            Cancel. The Cancel action remains available so
                            the row doesn't get stranded. */}
                        {s.status === "SCHEDULED" && canSchedule && effective !== "MISSED_SCHEDULE" && (
                          <>
                            <button
                              onClick={() => startSurgery(s.id)}
                              data-testid={`start-surgery-${s.id}`}
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
                        {s.status === "SCHEDULED" && canSchedule && effective === "MISSED_SCHEDULE" && (
                          <button
                            onClick={() => cancelSurgery(s.id)}
                            data-testid={`cancel-missed-${s.id}`}
                            className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
                          >
                            Cancel
                          </button>
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
                );
              })}
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
                  data-testid="schedule-surgery-at"
                  aria-invalid={!!scheduleError}
                  min={minScheduledAt}
                  value={form.scheduledAt}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, scheduledAt: e.target.value }));
                    if (scheduleError) setScheduleError(null);
                  }}
                  className={`w-full rounded-lg border px-3 py-2 text-sm ${
                    scheduleError ? "border-red-500 bg-red-50" : ""
                  }`}
                  required
                />
                {scheduleError && (
                  <p
                    data-testid="error-scheduled-at"
                    className="mt-1 text-xs text-red-600"
                  >
                    {scheduleError}
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Duration (min)
                </label>
                <input
                  type="number"
                  // Issue #53: duration must be strictly positive (matches
                  // the zod .positive() guard on scheduleSurgerySchema).
                  min={1}
                  step={1}
                  data-testid="schedule-surgery-duration"
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
                  // Issue #53: cost is non-negative (0 allowed for pro-bono /
                  // charity cases). Mirrors zod .nonnegative() at the API.
                  min={0}
                  step="0.01"
                  data-testid="schedule-surgery-cost"
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
              <label className="mb-1 flex items-center text-sm font-medium">
                Diagnosis (ICD-10)
                <InfoIcon tooltip="ICD-10 codes are international standard diagnosis codes (e.g. K35.80 = acute appendicitis). Type to search." />
              </label>
              {/* Issue #97 (Apr 2026): replace free-text diagnosis with the
                  same ICD-10 picker the prescription form uses (Issue #84).
                  We persist the rendered "CODE — Description" string into the
                  existing free-text `diagnosis` column, no schema change. */}
              <Autocomplete<{ code: string; description: string }>
                value={form.diagnosis}
                onChange={(val, item) =>
                  setForm((f) => ({
                    ...f,
                    diagnosis: item ? `${item.code} — ${item.description}` : val,
                  }))
                }
                fetchOptions={async (q) => {
                  const r = await api.get<{
                    data: Array<{ code: string; description: string }>;
                  }>(`/icd10?q=${encodeURIComponent(q)}`);
                  return r.data ?? [];
                }}
                getOptionLabel={(o) => `${o.code} — ${o.description}`}
                renderOption={(o) => (
                  <div>
                    <span className="font-mono text-xs text-primary">
                      {o.code}
                    </span>{" "}
                    <span>{o.description}</span>
                  </div>
                )}
                placeholder="Search ICD-10 (e.g. appendicitis)"
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
