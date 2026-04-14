"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Plus, Building, Power, PowerOff, Edit2 } from "lucide-react";

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
      alert(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function toggleActive(ot: OT) {
    try {
      await api.patch(`/surgery/ots/${ot.id}`, { isActive: !ot.isActive });
      loadOts();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Toggle failed");
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
          <p className="text-sm text-gray-500">Manage OTs and view weekly schedule</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} /> Add OT
        </button>
      </div>

      <div className="mb-6 rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : ots.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No OTs configured.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
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
                  className={`cursor-pointer border-b last:border-0 hover:bg-gray-50 ${
                    selectedOt?.id === ot.id ? "bg-primary/5" : ""
                  }`}
                >
                  <td className="px-4 py-3 font-medium">{ot.name}</td>
                  <td className="px-4 py-3 text-sm">{ot.floor || "—"}</td>
                  <td className="px-4 py-3 text-sm">{ot.equipment || "—"}</td>
                  <td className="px-4 py-3 text-sm">₹{ot.dailyRate}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        ot.isActive
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {ot.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => openEdit(ot)}
                        className="flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs hover:bg-gray-200"
                      >
                        <Edit2 size={12} /> Edit
                      </button>
                      <button
                        onClick={() => toggleActive(ot)}
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
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">
              Weekly Schedule — {selectedOt.name}
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setWeekStart(addDays(weekStart, -7))}
                className="rounded border px-2 py-1 text-xs"
              >
                ← Prev
              </button>
              <button
                onClick={() => setWeekStart(startOfWeek(new Date()))}
                className="rounded border px-2 py-1 text-xs"
              >
                This Week
              </button>
              <button
                onClick={() => setWeekStart(addDays(weekStart, 7))}
                className="rounded border px-2 py-1 text-xs"
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
                  className="min-h-[160px] rounded-lg border bg-gray-50 p-2"
                >
                  <p className="mb-2 text-xs font-semibold text-gray-600">
                    {d.toLocaleDateString("en", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}
                  </p>
                  <div className="space-y-1">
                    {surgeries.length === 0 ? (
                      <p className="text-xs text-gray-400">—</p>
                    ) : (
                      surgeries.map((s) => (
                        <div
                          key={s.id}
                          className="rounded bg-white p-2 text-xs shadow-sm"
                        >
                          <p className="font-medium">
                            {new Date(s.scheduledAt).toLocaleTimeString("en", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                          <p className="truncate text-gray-700">{s.procedure}</p>
                          <p className="truncate text-gray-500">
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
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
          >
            <h2 className="mb-4 text-lg font-semibold">
              {editing ? "Edit OT" : "Add Operating Theater"}
            </h2>

            <div className="mb-3">
              <label className="mb-1 block text-sm font-medium">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                required
              />
            </div>

            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Floor</label>
                <input
                  type="text"
                  value={form.floor}
                  onChange={(e) => setForm((f) => ({ ...f, floor: e.target.value }))}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Daily Rate</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.dailyRate}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, dailyRate: e.target.value }))
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium">Equipment</label>
              <textarea
                value={form.equipment}
                onChange={(e) =>
                  setForm((f) => ({ ...f, equipment: e.target.value }))
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
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
                className="rounded-lg border px-4 py-2 text-sm"
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
