"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { Plus, X, CalendarOff, Clock } from "lucide-react";

// Issue #77 — Sunday is a valid working day for some specialists
// (Dental, Casualty, Radiology). Include the full Mon..Sun set.
const DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];
const DAY_LABELS: Record<string, string> = {
  MONDAY: "Mon",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
  THURSDAY: "Thu",
  FRIDAY: "Fri",
  SATURDAY: "Sat",
  SUNDAY: "Sun",
};

interface ScheduleSlot {
  id: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  slotDuration: number;
}

interface ScheduleOverride {
  id: string;
  date: string;
  isBlocked: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

interface DoctorOption {
  id: string;
  user: { name: string };
  specialization: string;
}

export default function SchedulePage() {
  const { user } = useAuthStore();
  const [schedules, setSchedules] = useState<ScheduleSlot[]>([]);
  const [overrides, setOverrides] = useState<ScheduleOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [doctors, setDoctors] = useState<DoctorOption[]>([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>("");

  // Schedule form
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({
    dayOfWeek: "MONDAY",
    startTime: "09:00",
    endTime: "13:00",
    slotDuration: 15,
    bufferMinutes: 0,
  });

  // Override form
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [overrideForm, setOverrideForm] = useState({
    date: "",
    isBlocked: true,
    startTime: "",
    endTime: "",
    reason: "",
  });

  const isAdmin = user?.role === "ADMIN";

  useEffect(() => {
    if (isAdmin) {
      loadDoctors();
    } else {
      // Doctor viewing own schedule - need to get their doctor profile ID
      loadOwnDoctorId();
    }
  }, [user]);

  useEffect(() => {
    if (selectedDoctorId) {
      loadSchedule();
    }
  }, [selectedDoctorId]);

  async function loadDoctors() {
    try {
      const res = await api.get<{ data: DoctorOption[] }>("/doctors");
      setDoctors(res.data);
      if (res.data.length > 0) {
        setSelectedDoctorId(res.data[0].id);
      }
    } catch {
      // empty
    }
  }

  async function loadOwnDoctorId() {
    try {
      const res = await api.get<{ data: DoctorOption[] }>("/doctors");
      const ownProfile = res.data.find(
        (d: DoctorOption) => d.user && (d.user as { name: string; id?: string }).id === user?.id
      );
      if (ownProfile) {
        setSelectedDoctorId(ownProfile.id);
      } else if (res.data.length > 0) {
        // Fallback: use first doctor (might be the user)
        setSelectedDoctorId(res.data[0].id);
      }
    } catch {
      // empty
    }
  }

  async function loadSchedule() {
    setLoading(true);
    try {
      const [schedRes, overRes] = await Promise.all([
        api.get<{ data: ScheduleSlot[] }>(`/doctors/${selectedDoctorId}/schedule`),
        api
          .get<{ data: ScheduleOverride[] }>(`/doctors/${selectedDoctorId}/overrides`)
          .catch(() => ({ data: [] })),
      ]);
      setSchedules(schedRes.data);
      setOverrides(overRes.data);
    } catch {
      setSchedules([]);
      setOverrides([]);
    }
    setLoading(false);
  }

  async function handleAddSchedule(e: React.FormEvent) {
    e.preventDefault();
    // Issue #178: reject reverse / equal start–end before posting. The API
    // rejects this too, but pre-validating gives the user an inline reason
    // instead of a generic 400.
    if (scheduleForm.startTime >= scheduleForm.endTime) {
      toast.error("End time must be after start time");
      return;
    }
    try {
      await api.post(`/doctors/${selectedDoctorId}/schedule`, {
        dayOfWeek: scheduleForm.dayOfWeek,
        startTime: scheduleForm.startTime,
        endTime: scheduleForm.endTime,
        slotDuration: scheduleForm.slotDuration,
        slotDurationMinutes: scheduleForm.slotDuration,
        bufferMinutes: scheduleForm.bufferMinutes,
      });
      setShowScheduleForm(false);
      loadSchedule();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add schedule");
    }
  }

  async function handleAddOverride(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/doctors/${selectedDoctorId}/override`, {
        date: overrideForm.date,
        isBlocked: overrideForm.isBlocked,
        startTime: overrideForm.isBlocked ? undefined : overrideForm.startTime,
        endTime: overrideForm.isBlocked ? undefined : overrideForm.endTime,
        reason: overrideForm.reason || undefined,
      });
      setShowOverrideForm(false);
      setOverrideForm({
        date: "",
        isBlocked: true,
        startTime: "",
        endTime: "",
        reason: "",
      });
      loadSchedule();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add override");
    }
  }

  function getScheduleForDay(day: string) {
    return schedules.filter((s) => s.dayOfWeek === day);
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Schedule Management</h1>
          <p className="text-sm text-gray-500">Manage doctor availability</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowOverrideForm(!showOverrideForm)}
            className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50"
          >
            <CalendarOff size={16} /> Add Override
          </button>
          <button
            onClick={() => setShowScheduleForm(!showScheduleForm)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Add Slot
          </button>
        </div>
      </div>

      {/* Doctor selector (Admin only) */}
      {isAdmin && doctors.length > 0 && (
        <div className="mb-6">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Select Doctor
          </label>
          <select
            value={selectedDoctorId}
            onChange={(e) => setSelectedDoctorId(e.target.value)}
            className="rounded-lg border px-4 py-2 text-sm"
          >
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.user?.name || "Doctor"} - {d.specialization || "General"}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Add Schedule Form */}
      {showScheduleForm && (
        <form
          onSubmit={handleAddSchedule}
          className="mb-6 rounded-xl bg-white p-6 shadow-sm"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Add Schedule Slot</h2>
            <button type="button" onClick={() => setShowScheduleForm(false)}>
              <X size={18} className="text-gray-400" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Day of Week
              </label>
              <select
                value={scheduleForm.dayOfWeek}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, dayOfWeek: e.target.value })
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d.charAt(0) + d.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Start Time
              </label>
              <input
                type="time"
                required
                value={scheduleForm.startTime}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, startTime: e.target.value })
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                End Time
              </label>
              <input
                type="time"
                required
                value={scheduleForm.endTime}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, endTime: e.target.value })
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Slot Duration (min)
              </label>
              <select
                value={scheduleForm.slotDuration}
                onChange={(e) =>
                  setScheduleForm({
                    ...scheduleForm,
                    slotDuration: parseInt(e.target.value),
                  })
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
              >
                <option value={10}>10 min</option>
                <option value={15}>15 min</option>
                <option value={20}>20 min</option>
                <option value={30}>30 min</option>
                <option value={45}>45 min</option>
                <option value={60}>60 min</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Buffer Between Slots (min)
              </label>
              <input
                type="number"
                min={0}
                max={60}
                value={scheduleForm.bufferMinutes}
                onChange={(e) =>
                  setScheduleForm({
                    ...scheduleForm,
                    bufferMinutes: Math.max(
                      0,
                      Math.min(60, parseInt(e.target.value || "0", 10))
                    ),
                  })
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
                placeholder="0"
              />
              <p className="mt-1 text-[10px] text-gray-500">
                Gap added after each slot (e.g. 5 min for room cleaning)
              </p>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              Save Slot
            </button>
            <button
              type="button"
              onClick={() => setShowScheduleForm(false)}
              className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Add Override Form */}
      {showOverrideForm && (
        <form
          onSubmit={handleAddOverride}
          className="mb-6 rounded-xl bg-white p-6 shadow-sm"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Schedule Override</h2>
            <button type="button" onClick={() => setShowOverrideForm(false)}>
              <X size={18} className="text-gray-400" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Date
              </label>
              <input
                type="date"
                required
                value={overrideForm.date}
                onChange={(e) =>
                  setOverrideForm({ ...overrideForm, date: e.target.value })
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Type
              </label>
              <select
                value={overrideForm.isBlocked ? "block" : "modify"}
                onChange={(e) =>
                  setOverrideForm({
                    ...overrideForm,
                    isBlocked: e.target.value === "block",
                  })
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
              >
                <option value="block">Block Entire Day</option>
                <option value="modify">Modify Hours</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Reason (optional)
              </label>
              <input
                type="text"
                value={overrideForm.reason}
                onChange={(e) =>
                  setOverrideForm({ ...overrideForm, reason: e.target.value })
                }
                placeholder="e.g., Leave, Conference"
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            {!overrideForm.isBlocked && (
              <>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">
                    Start Time
                  </label>
                  <input
                    type="time"
                    value={overrideForm.startTime}
                    onChange={(e) =>
                      setOverrideForm({
                        ...overrideForm,
                        startTime: e.target.value,
                      })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">
                    End Time
                  </label>
                  <input
                    type="time"
                    value={overrideForm.endTime}
                    onChange={(e) =>
                      setOverrideForm({
                        ...overrideForm,
                        endTime: e.target.value,
                      })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
              </>
            )}
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              Save Override
            </button>
            <button
              type="button"
              onClick={() => setShowOverrideForm(false)}
              className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Weekly Schedule Grid */}
      {loading ? (
        <div className="p-8 text-center text-gray-500">Loading...</div>
      ) : (
        <div className="mb-8 grid grid-cols-7 gap-3">
          {DAYS.map((day) => {
            const slots = getScheduleForDay(day);
            return (
              <div
                key={day}
                className="rounded-xl bg-white p-4 shadow-sm"
              >
                <h3 className="mb-3 text-center text-sm font-semibold text-gray-700">
                  {DAY_LABELS[day]}
                </h3>
                {slots.length === 0 ? (
                  <p className="text-center text-xs text-gray-400">No slots</p>
                ) : (
                  <div className="space-y-2">
                    {slots.map((slot) => (
                      <div
                        key={slot.id}
                        className="rounded-lg bg-blue-50 p-2 text-center"
                      >
                        <p className="text-xs font-medium text-primary">
                          {slot.startTime} - {slot.endTime}
                        </p>
                        <p className="mt-0.5 flex items-center justify-center gap-1 text-xs text-gray-500">
                          <Clock size={10} />
                          {slot.slotDuration} min slots
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Overrides Section */}
      {overrides.length > 0 && (
        <div>
          <h2 className="mb-3 text-lg font-semibold">Schedule Overrides</h2>
          <div className="rounded-xl bg-white shadow-sm">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-gray-500">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Hours</th>
                  <th className="px-4 py-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.id} className="border-b last:border-0">
                    <td className="px-4 py-3 text-sm font-medium">
                      {new Date(o.date).toLocaleDateString("en-IN", {
                        weekday: "short",
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          o.isBlocked
                            ? "bg-red-100 text-red-700"
                            : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {o.isBlocked ? "Blocked" : "Modified"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {o.isBlocked
                        ? "---"
                        : `${o.startTime || ""} - ${o.endTime || ""}`}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {o.reason || "---"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
