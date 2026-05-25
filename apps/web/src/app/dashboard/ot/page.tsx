"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { getSocket } from "@/lib/socket";
import { Plus, Building, Power, PowerOff, Edit2 } from "lucide-react";
import { SkeletonTable } from "@/components/Skeleton";

interface OT {
  id: string;
  name: string;
  floor?: string | null;
  equipment?: string | null;
  dailyRate: number;
  isActive: boolean;
}

interface ScheduledSurgery {
  id: string;
  caseNumber: string;
  procedure: string;
  scheduledAt: string;
  durationMin?: number | null;
  status: string;
  patient: { user: { name: string } };
  surgeon: { user: { name: string } };
  ot: { id: string; name: string };
}

// Shared styling for the OT add/edit modal form controls. The modal renders on
// the dark dashboard layout, so without explicit colors the inputs inherit the
// layout's light text (dark:text-gray-100) and wash out (white-on-white); the
// dark variants give them a legible dark surface.
const MODAL_FIELD =
  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500";

function startOfWeek(d: Date) {
  const r = new Date(d);
  const day = r.getDay();
  const diff = r.getDate() - day + (day === 0 ? -6 : 1);
  r.setDate(diff);
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function ymd(d: Date) {
  return d.toISOString().split("T")[0];
}

export default function OTPage() {
  const [ots, setOts] = useState<OT[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<OT | null>(null);
  const [selectedOt, setSelectedOt] = useState<OT | null>(null);
  const [weekStart, setWeekStart] = useState<Date>(startOfWeek(new Date()));
  const [weekSurgeries, setWeekSurgeries] = useState<ScheduledSurgery[]>([]);

  const [form, setForm] = useState({
    name: "",
    floor: "",
    equipment: "",
    dailyRate: "0",
  });

  const loadOts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: OT[] }>("/surgery/ots?includeInactive=true");
      setOts(res.data);
    } catch {
      setOts([]);
    }
    setLoading(false);
  }, []);

  const loadWeekSchedule = useCallback(async () => {
    if (!selectedOt) {
      setWeekSurgeries([]);
      return;
    }
    try {
      const from = weekStart.toISOString();
      const to = addDays(weekStart, 7).toISOString();
      const res = await api.get<{ data: ScheduledSurgery[] }>(
        `/surgery?otId=${selectedOt.id}&from=${from}&to=${to}&limit=100`
      );
      setWeekSurgeries(res.data);
    } catch {
      setWeekSurgeries([]);
    }
  }, [selectedOt, weekStart]);

  useEffect(() => {
    loadOts();
  }, [loadOts]);

  useEffect(() => {
    loadWeekSchedule();
  }, [loadWeekSchedule]);

  // Live updates as surgeries change status
  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();
    const handler = () => {
      loadOts();
      loadWeekSchedule();
    };
    socket.on("surgery:status", handler);
    return () => {
      socket.off("surgery:status", handler);
    };
  }, [loadOts, loadWeekSchedule]);

  function openAdd() {
    setEditing(null);
    setForm({ name: "", floor: "", equipment: "", dailyRate: "0" });
    setShowAdd(true);
  }

  function openEdit(ot: OT) {
    setEditing(ot);
    setForm({
      name: ot.name,
      floor: ot.floor || "",
      equipment: ot.equipment || "",
      dailyRate: String(ot.dailyRate),
    });
    setShowAdd(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // A4: with HTML5 `required` removed (so React-side feedback can render),
    // we must explicitly guard the empty case for the OT name.
    if (!form.name.trim()) {
      toast.error("OT name is required");
      return;
    }
    const body = {
      name: form.name,
      floor: form.floor || undefined,
      equipment: form.equipment || undefined,
      dailyRate: parseFloat(form.dailyRate) || 0,
    };
    try {
      if (editing) {
        await api.patch(`/surgery/ots/${editing.id}`, body);
      } else {
        await api.post("/surgery/ots", body);
      }
      setShowAdd(false);
      setEditing(null);
      loadOts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  }

  // Issue #727 (2026-05-08): the Disable / Mark Out-of-Service toggle
  // succeeded silently — no toast, and the row only updated after the full
  // `loadOts()` round-trip so admins thought nothing happened. Three fixes:
  //   (a) optimistic local update so the badge flips immediately;
  //   (b) explicit success toast naming the OT and target state;
  //   (c) the loadOts() re-fetch still runs to pick up server truth and
  //       roll back the optimistic write if the server's response disagrees
  //       (e.g. concurrent edit from another admin).
  async function toggleActive(ot: OT) {
    const target = !ot.isActive;
    const previous = ots;
    setOts((prev) =>
      prev.map((o) => (o.id === ot.id ? { ...o, isActive: target } : o)),
    );
    try {
      await api.patch(`/surgery/ots/${ot.id}`, { isActive: target });
      toast.success(
        target
          ? `${ot.name} is now active`
          : `${ot.name} marked Out of Service`,
      );
      loadOts();
    } catch (err) {
      // Roll back the optimistic update on failure so the UI matches
      // server truth.
      setOts(previous);
      toast.error(err instanceof Error ? err.message : "Toggle failed");
    }
  }

  const weekDays = Array.from({ length: 7 }).map((_, i) => addDays(weekStart, i));

  function surgeriesOnDay(date: Date) {
    const key = ymd(date);
    return weekSurgeries
      .filter((s) => ymd(new Date(s.scheduledAt)) === key)
      .sort(
        (a, b) =>
          new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
      );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Building size={22} /> Operating Theaters
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Manage OTs and view weekly schedule</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} /> Add OT
        </button>
      </div>

      <div className="mb-6 rounded-xl bg-white shadow-sm dark:bg-gray-800">
        {loading ? (
          <div data-testid="ot-loading" aria-busy="true" className="p-4">
            <SkeletonTable rows={5} columns={6} />
          </div>
        ) : ots.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">No OTs configured.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Floor</th>
                <th className="px-4 py-3">Equipment</th>
                <th className="px-4 py-3">Daily Rate</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ots.map((ot) => (
                <tr
                  key={ot.id}
                  onClick={() => setSelectedOt(ot)}
                  className={`cursor-pointer border-b last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700 ${
                    selectedOt?.id === ot.id ? "bg-primary/5" : ""
                  }`}
                >
                  <td className="px-4 py-3 font-medium">{ot.name}</td>
                  <td className="px-4 py-3 text-sm">{ot.floor || "—"}</td>
                  <td className="px-4 py-3 text-sm">{ot.equipment || "—"}</td>
                  <td className="px-4 py-3 text-sm">₹{ot.dailyRate}</td>
                  <td className="px-4 py-3">
                    <span
                      data-testid={`ot-status-${ot.id}`}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        ot.isActive
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {ot.isActive ? "Active" : "Out of Service"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => openEdit(ot)}
                        className="flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                      >
                        <Edit2 size={12} /> Edit
                      </button>
                      <button
                        onClick={() => toggleActive(ot)}
                        data-testid={`ot-toggle-${ot.id}`}
                        title={
                          ot.isActive
                            ? "Mark out of service"
                            : "Mark active"
                        }
                        className={`flex items-center gap-1 rounded px-2 py-1 text-xs text-white ${
                          ot.isActive
                            ? "bg-red-500 hover:bg-red-600"
                            : "bg-green-500 hover:bg-green-600"
                        }`}
                      >
                        {ot.isActive ? <PowerOff size={12} /> : <Power size={12} />}
                        {ot.isActive ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Week calendar for selected OT */}
      {selectedOt && (
        <div className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              Weekly Schedule — {selectedOt.name}
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setWeekStart(addDays(weekStart, -7))}
                className="rounded border px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
              >
                ← Prev
              </button>
              <button
                onClick={() => setWeekStart(startOfWeek(new Date()))}
                className="rounded border px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
              >
                This Week
              </button>
              <button
                onClick={() => setWeekStart(addDays(weekStart, 7))}
                className="rounded border px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
              >
                Next →
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-2">
            {weekDays.map((d) => {
              const dayKey = ymd(d);
              const surgeries = surgeriesOnDay(d);
              return (
                <div
                  key={dayKey}
                  className="min-h-[160px] rounded-lg border bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/40"
                >
                  <p className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">
                    {d.toLocaleDateString("en", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}
                  </p>
                  <div className="space-y-1">
                    {surgeries.length === 0 ? (
                      <p className="text-xs text-gray-400 dark:text-gray-500">—</p>
                    ) : (
                      surgeries.map((s) => (
                        <div
                          key={s.id}
                          className="rounded bg-white p-2 text-xs shadow-sm dark:bg-gray-800"
                        >
                          <p className="font-medium">
                            {new Date(s.scheduledAt).toLocaleTimeString("en", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                          <p className="truncate text-gray-700 dark:text-gray-200">{s.procedure}</p>
                          <p className="truncate text-gray-500 dark:text-gray-400">
                            {s.patient.user.name}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add/Edit modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={submit}
            noValidate
            className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-2xl bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100"
          >
            <h2 className="mb-4 text-lg font-semibold">
              {editing ? "Edit OT" : "Add Operating Theater"}
            </h2>

            <div className="mb-3">
              <label htmlFor="ot-name" className="mb-1 block text-sm font-medium">Name</label>
              <input
                id="ot-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className={MODAL_FIELD}
              />
            </div>

            <div className="mb-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="ot-floor" className="mb-1 block text-sm font-medium">Floor</label>
                <input
                  id="ot-floor"
                  type="text"
                  value={form.floor}
                  onChange={(e) => setForm((f) => ({ ...f, floor: e.target.value }))}
                  className={MODAL_FIELD}
                />
              </div>
              <div>
                <label htmlFor="ot-daily-rate" className="mb-1 block text-sm font-medium">Daily Rate</label>
                <input
                  id="ot-daily-rate"
                  type="number"
                  step="0.01"
                  value={form.dailyRate}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, dailyRate: e.target.value }))
                  }
                  className={MODAL_FIELD}
                />
              </div>
            </div>

            <div className="mb-4">
              <label htmlFor="ot-equipment" className="mb-1 block text-sm font-medium">Equipment</label>
              <textarea
                id="ot-equipment"
                value={form.equipment}
                onChange={(e) =>
                  setForm((f) => ({ ...f, equipment: e.target.value }))
                }
                className={MODAL_FIELD}
                rows={2}
                placeholder="e.g. C-arm, Anaesthesia machine, ventilator"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false);
                  setEditing(null);
                }}
                className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                {editing ? "Save" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
