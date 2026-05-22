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

// Shared styling for the Add-Slot / Override form controls. These forms render
// on the dark dashboard layout, so without explicit colors the inputs inherit
// the layout's light text (dark:text-gray-100) and wash out on the white card;
// the dark variants give them a legible dark surface.
const MODAL_FIELD =
  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500";

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
    // Issue #458: form is noValidate; mirror HTML5 required for the time inputs.
    if (!scheduleForm.startTime) {
      toast.error("Start time is required");
      return;
    }
    if (!scheduleForm.endTime) {
      toast.error("End time is required");
      return;
    }
    // Issue #178: reject reverse / equal start–end before posting. The API
    // rejects this too, but pre-validating gives the user an inline reason
    // instead of a generic 400.
    if (scheduleForm.startTime >= scheduleForm.endTime) {
      toast.error("End time must be after start time");
      return;
    }
    // Mirror min=0 / max=60 from the buffer input (Issue #458).
    if (
      !Number.isFinite(scheduleForm.bufferMinutes) ||
      scheduleForm.bufferMinutes < 0 ||
      scheduleForm.bufferMinutes > 60
    ) {
      toast.error("Buffer minutes must be between 0 and 60");
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
    // Issue #458: form is noValidate; mirror HTML5 required for the date input
    // and gate "modify hours" mode on a coherent start/end pair.
    if (!overrideForm.date) {
      toast.error("Date is required");
      return;
    }
    if (!overrideForm.isBlocked) {
      if (!overrideForm.startTime || !overrideForm.endTime) {
        toast.error("Start and end time are required when modifying hours");
        return;
      }
      if (overrideForm.startTime >= overrideForm.endTime) {
        toast.error("End time must be after start time");
        return;
      }
    }
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
          <p className="text-sm text-gray-500 dark:text-gray-400">Manage doctor availability</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowOverrideForm(!showOverrideForm)}
            className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
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
          <label htmlFor="schedule-doctor-select" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
            Select Doctor
          </label>
          <select
            id="schedule-doctor-select"
            value={selectedDoctorId}
            onChange={(e) => setSelectedDoctorId(e.target.value)}
            className="rounded-lg border bg-white px-4 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
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
          className="mb-6 rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
          noValidate
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Add Schedule Slot</h2>
            <button type="button" onClick={() => setShowScheduleForm(false)}>
              <X size={18} className="text-gray-400" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <label htmlFor="schedule-day-of-week" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Day of Week
              </label>
              <select
                id="schedule-day-of-week"
                value={scheduleForm.dayOfWeek}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, dayOfWeek: e.target.value })
                }
                className={MODAL_FIELD}
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d.charAt(0) + d.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="schedule-start-time" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Start Time
              </label>
              <input
                id="schedule-start-time"
                type="time"
                required
                value={scheduleForm.startTime}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, startTime: e.target.value })
                }
                className={MODAL_FIELD}
              />
            </div>
            <div>
              <label htmlFor="schedule-end-time" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                End Time
              </label>
              <input
                id="schedule-end-time"
                type="time"
                required
                value={scheduleForm.endTime}
                onChange={(e) =>
                  setScheduleForm({ ...scheduleForm, endTime: e.target.value })
                }
                className={MODAL_FIELD}
              />
            </div>
            <div>
              <label htmlFor="schedule-slot-duration" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Slot Duration (min)
              </label>
              <select
                id="schedule-slot-duration"
                value={scheduleForm.slotDuration}
                onChange={(e) =>
                  setScheduleForm({
                    ...scheduleForm,
                    slotDuration: parseInt(e.target.value),
                  })
                }
                className={MODAL_FIELD}
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
              <label htmlFor="schedule-buffer" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Buffer Between Slots (min)
              </label>
              <input
                id="schedule-buffer"
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
                className={MODAL_FIELD}
                placeholder="0"
              />
              <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
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
              className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
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
          className="mb-6 rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
          noValidate
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Schedule Override</h2>
            <button type="button" onClick={() => setShowOverrideForm(false)}>
              <X size={18} className="text-gray-400" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="schedule-override-date" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Date
              </label>
              <input
                id="schedule-override-date"
                type="date"
                required
                value={overrideForm.date}
                onChange={(e) =>
                  setOverrideForm({ ...overrideForm, date: e.target.value })
                }
                className={MODAL_FIELD}
              />
            </div>
            <div>
              <label htmlFor="schedule-override-type" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Type
              </label>
              <select
                id="schedule-override-type"
                value={overrideForm.isBlocked ? "block" : "modify"}
                onChange={(e) =>
                  setOverrideForm({
                    ...overrideForm,
                    isBlocked: e.target.value === "block",
                  })
                }
                className={MODAL_FIELD}
              >
                <option value="block">Block Entire Day</option>
                <option value="modify">Modify Hours</option>
              </select>
            </div>
            <div>
              <label htmlFor="schedule-override-reason" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Reason (optional)
              </label>
              <input
                id="schedule-override-reason"
                type="text"
                value={overrideForm.reason}
                onChange={(e) =>
                  setOverrideForm({ ...overrideForm, reason: e.target.value })
                }
                placeholder="e.g., Leave, Conference"
                className={MODAL_FIELD}
              />
            </div>
            {!overrideForm.isBlocked && (
              <>
                <div>
                  <label htmlFor="schedule-override-start-time" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                    Start Time
                  </label>
                  <input
                    id="schedule-override-start-time"
                    type="time"
                    value={overrideForm.startTime}
                    onChange={(e) =>
                      setOverrideForm({
                        ...overrideForm,
                        startTime: e.target.value,
                      })
                    }
                    className={MODAL_FIELD}
                  />
                </div>
                <div>
                  <label htmlFor="schedule-override-end-time" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                    End Time
                  </label>
                  <input
                    id="schedule-override-end-time"
                    type="time"
                    value={overrideForm.endTime}
                    onChange={(e) =>
                      setOverrideForm({
                        ...overrideForm,
                        endTime: e.target.value,
                      })
                    }
                    className={MODAL_FIELD}
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
              className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Weekly Schedule Grid */}
      {loading ? (
        <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>
      ) : (
        <div className="mb-8 grid grid-cols-7 gap-3">
          {DAYS.map((day) => {
            const slots = getScheduleForDay(day);
            return (
              <div
                key={day}
                className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800"
              >
                <h3 className="mb-3 text-center text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {DAY_LABELS[day]}
                </h3>
                {slots.length === 0 ? (
                  <p className="text-center text-xs text-gray-400 dark:text-gray-500">No slots</p>
                ) : (
                  <div className="space-y-2">
                    {slots.map((slot) => (
                      <div
                        key={slot.id}
                        className="rounded-lg bg-blue-50 p-2 text-center dark:bg-indigo-900/40 dark:ring-1 dark:ring-indigo-700/40"
                      >
                        <p className="text-xs font-medium text-primary dark:text-indigo-200">
                          {slot.startTime} - {slot.endTime}
                        </p>
                        <p className="mt-0.5 flex items-center justify-center gap-1 text-xs text-gray-500 dark:text-gray-300">
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
          <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Hours</th>
                  <th className="px-4 py-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.id} className="border-b last:border-0 dark:border-gray-700">
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
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
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
