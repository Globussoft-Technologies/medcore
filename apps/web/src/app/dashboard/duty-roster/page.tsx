"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { Plus, Users2, CalendarDays, Trash2 } from "lucide-react";

interface StaffUser {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "DOCTOR" | "NURSE" | "RECEPTION";
}

interface Shift {
  id: string;
  userId: string;
  date: string;
  type: "MORNING" | "AFTERNOON" | "NIGHT" | "ON_CALL";
  startTime: string;
  endTime: string;
  status: "SCHEDULED" | "PRESENT" | "ABSENT" | "LATE" | "LEAVE";
  notes?: string | null;
  user?: { id: string; name: string; role: string };
}

const SHIFT_TYPES: Array<Shift["type"]> = [
  "MORNING",
  "AFTERNOON",
  "NIGHT",
  "ON_CALL",
];

const DEFAULT_TIMES: Record<string, { start: string; end: string }> = {
  MORNING: { start: "07:00", end: "15:00" },
  AFTERNOON: { start: "15:00", end: "23:00" },
  NIGHT: { start: "23:00", end: "07:00" },
  ON_CALL: { start: "00:00", end: "23:59" },
};

const STATUS_DOT: Record<string, string> = {
  SCHEDULED: "bg-gray-400",
  PRESENT: "bg-green-500",
  ABSENT: "bg-red-500",
  LATE: "bg-yellow-500",
  LEAVE: "bg-blue-500",
};

function todayKey(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

export default function DutyRosterPage() {
  const { user } = useAuthStore();
  const confirm = useConfirm();
  const [date, setDate] = useState<string>(todayKey());
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState<string>("ALL");

  // Add single shift modal
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    userId: "",
    date: date,
    type: "MORNING" as Shift["type"],
    startTime: "07:00",
    endTime: "15:00",
    notes: "",
  });

  // Bulk modal
  const [showBulk, setShowBulk] = useState(false);
  const [bulkForm, setBulkForm] = useState({
    userIds: [] as string[],
    fromDate: date,
    toDate: date,
    type: "MORNING" as Shift["type"],
    startTime: "07:00",
    endTime: "15:00",
  });

  const loadStaff = useCallback(async () => {
    try {
      const res = await api.get<{ data: StaffUser[] }>("/shifts/staff");
      setStaff(res.data);
    } catch {
      // empty
    }
  }, []);

  const loadRoster = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{
        data: { shifts: Shift[]; grouped: Record<string, Shift[]> };
      }>(`/shifts/roster?date=${date}`);
      setShifts(res.data.shifts);
    } catch {
      setShifts([]);
    }
    setLoading(false);
  }, [date]);

  useEffect(() => {
    loadStaff();
  }, [loadStaff]);

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    setAddForm((f) => ({ ...f, date }));
    setBulkForm((f) => ({ ...f, fromDate: date, toDate: date }));
  }, [date]);

  if (user?.role !== "ADMIN") {
    return (
      <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm">
        Access restricted to administrators.
      </div>
    );
  }

  const filteredStaff =
    roleFilter === "ALL" ? staff : staff.filter((u) => u.role === roleFilter);

  function cellShifts(userId: string, type: string): Shift[] {
    return shifts.filter((s) => s.userId === userId && s.type === type);
  }

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post("/shifts", addForm);
      setShowAdd(false);
      loadRoster();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    }
  }

  async function submitBulk(e: React.FormEvent) {
    e.preventDefault();
    if (bulkForm.userIds.length === 0) {
      toast.error("Select at least one staff member");
      return;
    }
    const shifts: any[] = [];
    const start = new Date(`${bulkForm.fromDate}T00:00:00.000Z`);
    const end = new Date(`${bulkForm.toDate}T00:00:00.000Z`);
    for (
      let d = new Date(start);
      d.getTime() <= end.getTime();
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      const dateStr = d.toISOString().slice(0, 10);
      for (const userId of bulkForm.userIds) {
        shifts.push({
          userId,
          date: dateStr,
          type: bulkForm.type,
          startTime: bulkForm.startTime,
          endTime: bulkForm.endTime,
        });
      }
    }
    try {
      const res = await api.post<{
        data: { created: Shift[]; skipped: unknown[] };
      }>("/shifts/bulk", { shifts });
      toast.success(
        `Created ${res.data.created.length}, skipped ${res.data.skipped.length}`
      );
      setShowBulk(false);
      setBulkForm((f) => ({ ...f, userIds: [] }));
      loadRoster();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk create failed");
    }
  }

  async function deleteShift(id: string) {
    if (!(await confirm({ title: "Delete this shift?", danger: true }))) return;
    try {
      await api.delete(`/shifts/${id}`);
      loadRoster();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  function handleShiftTypeChange(
    type: Shift["type"],
    target: "add" | "bulk"
  ) {
    const t = DEFAULT_TIMES[type];
    if (target === "add") {
      setAddForm((f) => ({ ...f, type, startTime: t.start, endTime: t.end }));
    } else {
      setBulkForm((f) => ({ ...f, type, startTime: t.start, endTime: t.end }));
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Users2 /> Duty Roster
          </h1>
          <p className="text-sm text-gray-500">
            Shift assignments for all staff on a given date
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowBulk(true)}
            className="flex items-center gap-2 rounded-lg border bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50"
          >
            <CalendarDays size={16} /> Bulk Schedule
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Add Shift
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Date:</label>
          <input
            data-testid="roster-date-filter"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Role:</label>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="rounded-lg border px-3 py-1.5 text-sm"
          >
            <option value="ALL">All</option>
            <option value="DOCTOR">Doctor</option>
            <option value="NURSE">Nurse</option>
            <option value="RECEPTION">Reception</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : filteredStaff.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No staff found.</div>
        ) : (
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-sm text-gray-600">
                <th className="px-4 py-3">Staff</th>
                {SHIFT_TYPES.map((t) => (
                  <th key={t} className="px-4 py-3">
                    {t.replace("_", "-")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredStaff.map((u) => (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium">{u.name}</p>
                    <p className="text-xs text-gray-500">{u.role}</p>
                  </td>
                  {SHIFT_TYPES.map((t) => {
                    const cs = cellShifts(u.id, t);
                    return (
                      <td key={t} className="px-4 py-3">
                        {cs.length === 0 ? (
                          <span className="text-xs text-gray-300">—</span>
                        ) : (
                          <div className="space-y-1">
                            {cs.map((s) => (
                              <div
                                key={s.id}
                                className="flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-2 py-1"
                              >
                                <div className="flex items-center gap-2">
                                  <span
                                    className={`h-2 w-2 rounded-full ${STATUS_DOT[s.status]}`}
                                  />
                                  <span className="text-xs font-medium">
                                    {s.startTime}–{s.endTime}
                                  </span>
                                </div>
                                <button
                                  onClick={() => deleteShift(s.id)}
                                  className="text-gray-400 hover:text-red-600"
                                  title="Delete"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-4 text-xs text-gray-600">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-gray-400" /> Scheduled
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-green-500" /> Present
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-yellow-500" /> Late
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-red-500" /> Absent
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-blue-500" /> Leave
        </span>
      </div>

      {/* Add Single Shift Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form
            data-testid="add-shift-modal"
            onSubmit={submitAdd}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
          >
            <h2 className="mb-4 text-lg font-semibold">Add Shift</h2>
            <div className="space-y-3">
              <div>
                <label htmlFor="add-shift-staff" className="mb-1 block text-sm font-medium">Staff</label>
                <select
                  id="add-shift-staff"
                  required
                  value={addForm.userId}
                  onChange={(e) =>
                    setAddForm({ ...addForm, userId: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  <option value="">Select staff</option>
                  {filteredStaff.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.role})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="add-shift-date" className="mb-1 block text-sm font-medium">Date</label>
                <input
                  id="add-shift-date"
                  type="date"
                  required
                  value={addForm.date}
                  onChange={(e) =>
                    setAddForm({ ...addForm, date: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="add-shift-type" className="mb-1 block text-sm font-medium">
                  Shift Type
                </label>
                <select
                  id="add-shift-type"
                  value={addForm.type}
                  onChange={(e) =>
                    handleShiftTypeChange(e.target.value as Shift["type"], "add")
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  {SHIFT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="add-shift-start-time" className="mb-1 block text-sm font-medium">
                    Start Time
                  </label>
                  <input
                    id="add-shift-start-time"
                    type="time"
                    required
                    value={addForm.startTime}
                    onChange={(e) =>
                      setAddForm({ ...addForm, startTime: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="add-shift-end-time" className="mb-1 block text-sm font-medium">
                    End Time
                  </label>
                  <input
                    id="add-shift-end-time"
                    type="time"
                    required
                    value={addForm.endTime}
                    onChange={(e) =>
                      setAddForm({ ...addForm, endTime: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="add-shift-notes" className="mb-1 block text-sm font-medium">
                  Notes (optional)
                </label>
                <input
                  id="add-shift-notes"
                  value={addForm.notes}
                  onChange={(e) =>
                    setAddForm({ ...addForm, notes: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="rounded-lg border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Bulk Schedule Modal */}
      {showBulk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form
            onSubmit={submitBulk}
            className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"
          >
            <h2 className="mb-4 text-lg font-semibold">Bulk Schedule</h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Select Staff ({bulkForm.userIds.length} selected)
                </label>
                <div className="max-h-40 overflow-y-auto rounded-lg border p-2">
                  {filteredStaff.map((u) => (
                    <label
                      key={u.id}
                      className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm hover:bg-gray-50"
                    >
                      <input
                        type="checkbox"
                        checked={bulkForm.userIds.includes(u.id)}
                        onChange={(e) => {
                          setBulkForm((f) => ({
                            ...f,
                            userIds: e.target.checked
                              ? [...f.userIds, u.id]
                              : f.userIds.filter((x) => x !== u.id),
                          }));
                        }}
                      />
                      {u.name} <span className="text-xs text-gray-500">({u.role})</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="bulk-shift-from" className="mb-1 block text-sm font-medium">From</label>
                  <input
                    id="bulk-shift-from"
                    type="date"
                    required
                    value={bulkForm.fromDate}
                    onChange={(e) =>
                      setBulkForm({ ...bulkForm, fromDate: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="bulk-shift-to" className="mb-1 block text-sm font-medium">To</label>
                  <input
                    id="bulk-shift-to"
                    type="date"
                    required
                    value={bulkForm.toDate}
                    onChange={(e) =>
                      setBulkForm({ ...bulkForm, toDate: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="bulk-shift-type" className="mb-1 block text-sm font-medium">
                  Shift Type
                </label>
                <select
                  id="bulk-shift-type"
                  value={bulkForm.type}
                  onChange={(e) =>
                    handleShiftTypeChange(e.target.value as Shift["type"], "bulk")
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  {SHIFT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="bulk-shift-start-time" className="mb-1 block text-sm font-medium">
                    Start Time
                  </label>
                  <input
                    id="bulk-shift-start-time"
                    type="time"
                    required
                    value={bulkForm.startTime}
                    onChange={(e) =>
                      setBulkForm({ ...bulkForm, startTime: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="bulk-shift-end-time" className="mb-1 block text-sm font-medium">
                    End Time
                  </label>
                  <input
                    id="bulk-shift-end-time"
                    type="time"
                    required
                    value={bulkForm.endTime}
                    onChange={(e) =>
                      setBulkForm({ ...bulkForm, endTime: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowBulk(false)}
                className="rounded-lg border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Create Shifts
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
