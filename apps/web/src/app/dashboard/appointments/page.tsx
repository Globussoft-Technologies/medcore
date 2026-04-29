"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { formatDoctorName } from "@/lib/format-doctor-name";
import {
  displayStatusForAppointment,
  formatAppointmentTime,
} from "@/lib/appointments";
import { SkeletonTable } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { Calendar } from "lucide-react";

// ─── Types ─────────────────────────────────────────

interface Doctor {
  id: string;
  user: { name: string };
  specialization: string;
}

interface Appointment {
  id: string;
  tokenNumber: number;
  date: string;
  slotStart: string | null;
  type: string;
  status: string;
  priority: string;
  patient: { user: { name: string; phone: string }; mrNumber?: string };
  doctor: { user: { name: string } };
}

interface Slot {
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

interface CalendarEvent {
  id: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  startDateTime: string;
  endDateTime: string;
  status: string;
  tokenNumber: number;
  type: string;
  priority: string;
}

interface StatsData {
  totalCount: number;
  byStatus: Record<string, number>;
  completedCount: number;
  cancelledCount: number;
  noShowCount: number;
  avgConsultationTimeMin: number;
  peakHour: number | null;
  peakHourCount: number;
}

type PatientTab = "upcoming" | "past" | "cancelled";
type ViewMode = "list" | "calendar" | "stats";

// ─── Constants ─────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  BOOKED: "bg-blue-100 text-blue-700",
  CHECKED_IN: "bg-yellow-100 text-yellow-700",
  IN_CONSULTATION: "bg-green-100 text-green-700",
  COMPLETED: "bg-gray-100 text-gray-700",
  CANCELLED: "bg-red-100 text-red-700",
  NO_SHOW: "bg-slate-100 text-slate-600",
};

const STATUS_BLOCK_COLORS: Record<string, string> = {
  BOOKED: "bg-blue-500 border-blue-600",
  CHECKED_IN: "bg-yellow-500 border-yellow-600",
  IN_CONSULTATION: "bg-green-500 border-green-600",
  COMPLETED: "bg-gray-400 border-gray-500",
  CANCELLED: "bg-red-500 border-red-600",
  NO_SHOW: "bg-slate-400 border-slate-500",
};

const STATUS_HEX: Record<string, string> = {
  BOOKED: "#3b82f6",
  CHECKED_IN: "#eab308",
  IN_CONSULTATION: "#22c55e",
  COMPLETED: "#6b7280",
  CANCELLED: "#ef4444",
  NO_SHOW: "#64748b",
};

const ALL_STATUSES = [
  "BOOKED",
  "CHECKED_IN",
  "IN_CONSULTATION",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── Date helpers (manual, no deps) ────────────────

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - r.getDay()); // Sunday
  return r;
}

function formatShortDate(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function dayOfWeekName(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return DAY_NAMES[d.getDay()];
}

// ─── Simple chart components (inline — mirror analytics patterns) ─

function DonutChart({
  segments,
  size = 180,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const radius = size / 2 - 10;
  const strokeW = 28;
  const circumference = 2 * Math.PI * radius;

  if (total === 0) {
    return (
      <div className="flex flex-col items-center">
        <div
          className="flex items-center justify-center rounded-full text-sm text-gray-400"
          style={{ width: size, height: size, border: "28px solid #f3f4f6" }}
        >
          No data
        </div>
      </div>
    );
  }

  let acc = 0;
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`translate(${size / 2}, ${size / 2}) rotate(-90)`}>
          <circle r={radius} fill="none" stroke="#f3f4f6" strokeWidth={strokeW} />
          {segments.map((seg, i) => {
            const frac = seg.value / total;
            const dash = frac * circumference;
            const gap = circumference - dash;
            const c = (
              <circle
                key={i}
                r={radius}
                fill="none"
                stroke={seg.color}
                strokeWidth={strokeW}
                strokeDasharray={`${dash} ${gap}`}
                strokeDashoffset={-acc}
              >
                <title>{`${seg.label}: ${seg.value} (${((frac * 100) | 0)}%)`}</title>
              </circle>
            );
            acc += dash;
            return c;
          })}
        </g>
      </svg>
      <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-1.5 text-xs">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: seg.color }}
            />
            <span className="text-gray-700">
              {seg.label} ({seg.value})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HBarChart({
  items,
}: {
  items: { label: string; value: number; color: string }[];
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-3">
      {items.map((it) => {
        const pct = (it.value / max) * 100;
        return (
          <div key={it.label}>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="font-medium text-gray-700">{it.label}</span>
              <span className="text-gray-600">{it.value}</span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, backgroundColor: it.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────

export default function AppointmentsPage() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const isPatient = user?.role === "PATIENT";

  // View toggle
  const [view, setView] = useState<ViewMode>("list");

  // Shared
  const [doctors, setDoctors] = useState<Doctor[]>([]);

  // ─── List view state ──────────────
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBooking, setShowBooking] = useState(false);
  const [showWaitlistModal, setShowWaitlistModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showCoordModal, setShowCoordModal] = useState(false);
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [selectedDate, setSelectedDate] = useState(toISODate(new Date()));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [filterDate, setFilterDate] = useState(toISODate(new Date()));
  const [patientTab, setPatientTab] = useState<PatientTab>("upcoming");
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // Recurring booking options
  const [isRecurring, setIsRecurring] = useState(false);
  const [recFrequency, setRecFrequency] = useState<"DAILY" | "WEEKLY" | "MONTHLY">("WEEKLY");
  const [recOccurrences, setRecOccurrences] = useState(4);

  // Patient-ID prompt modal (replaces window.prompt so it's testable)
  const [patientIdPrompt, setPatientIdPrompt] = useState<{
    open: boolean;
    slotStartTime: string;
  }>({ open: false, slotStartTime: "" });
  const [patientIdInput, setPatientIdInput] = useState("");
  const [bookingInFlight, setBookingInFlight] = useState(false);

  // Reschedule modal
  const [reschedTarget, setReschedTarget] = useState<Appointment | null>(null);
  const [reschedDate, setReschedDate] = useState(toISODate(new Date()));
  const [reschedSlots, setReschedSlots] = useState<Slot[]>([]);
  const [reschedLoading, setReschedLoading] = useState(false);

  // ─── Calendar view state ──────────
  const [calWeekStart, setCalWeekStart] = useState<Date>(startOfWeek(new Date()));
  const [calDoctor, setCalDoctor] = useState<string>("");
  const [calEvents, setCalEvents] = useState<CalendarEvent[]>([]);
  const [calLoading, setCalLoading] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  // ─── Stats view state ─────────────
  const [statsFrom, setStatsFrom] = useState(toISODate(addDays(new Date(), -30)));
  const [statsTo, setStatsTo] = useState(toISODate(new Date()));
  const [statsDoctor, setStatsDoctor] = useState<string>("");
  const [stats, setStats] = useState<StatsData | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsEvents, setStatsEvents] = useState<CalendarEvent[]>([]);

  // ─── Loaders ──────────────────────

  const loadDoctors = useCallback(async () => {
    try {
      const res = await api.get<{ data: Doctor[] }>("/doctors");
      setDoctors(res.data);
    } catch {
      // empty
    }
  }, []);

  const loadAppointments = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = isPatient
        ? `/appointments?limit=200`
        : `/appointments?date=${filterDate}&limit=100`;
      const res = await api.get<{ data: Appointment[] }>(endpoint);
      setAppointments(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }, [isPatient, filterDate]);

  const loadSlots = useCallback(async (doctorId: string, date: string) => {
    try {
      const res = await api.get<{ data: { slots: Slot[] } }>(
        `/doctors/${doctorId}/slots?date=${date}`
      );
      setSlots(res.data.slots);
    } catch {
      setSlots([]);
    }
  }, []);

  const loadCalendar = useCallback(async () => {
    setCalLoading(true);
    try {
      const from = toISODate(calWeekStart);
      const to = toISODate(addDays(calWeekStart, 6));
      const qs = new URLSearchParams();
      qs.set("from", from);
      qs.set("to", to);
      if (calDoctor) qs.set("doctorId", calDoctor);
      const res = await api.get<{ data: CalendarEvent[] }>(
        `/appointments/calendar?${qs.toString()}`
      );
      setCalEvents(res.data);
    } catch {
      setCalEvents([]);
    }
    setCalLoading(false);
  }, [calWeekStart, calDoctor]);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("from", statsFrom);
      qs.set("to", statsTo);
      if (statsDoctor) qs.set("doctorId", statsDoctor);
      const [sres, cres] = await Promise.all([
        api.get<{ data: StatsData }>(`/appointments/stats?${qs.toString()}`),
        api.get<{ data: CalendarEvent[] }>(`/appointments/calendar?${qs.toString()}`),
      ]);
      setStats(sres.data);
      setStatsEvents(cres.data);
    } catch {
      setStats(null);
      setStatsEvents([]);
    }
    setStatsLoading(false);
  }, [statsFrom, statsTo, statsDoctor]);

  // ─── Effects ──────────────────────

  useEffect(() => {
    loadDoctors();
  }, [loadDoctors]);

  useEffect(() => {
    if (view === "list") loadAppointments();
  }, [view, loadAppointments]);

  useEffect(() => {
    if (view === "calendar") loadCalendar();
  }, [view, loadCalendar]);

  useEffect(() => {
    if (view === "stats") loadStats();
  }, [view, loadStats]);

  // Auto-open the booking form when the dashboard quick-action links here
  // with ?book=1 (issue #7). Only receptionists/admins can book so don't
  // force the modal for patients — they use /dashboard/ai-booking.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isPatient) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("book") === "1") {
      setShowBooking(true);
      setView("list");
    }
  }, [isPatient]);

  // ─── Actions ──────────────────────

  // Issue #35: wrap the click handler in useCallback. The page previously
  // parsed the date inline and re-created the function on every render. When
  // combined with the prompt-modal state change, that could feed a render
  // loop on slower machines — clicking a late-in-the-day slot like 18:00
  // while the Zustand toast store, the prompt state, and the slot list all
  // updated in the same tick would freeze the tab. Using useCallback plus
  // a stable past-slot guard and an early return when the prompt is already
  // open keeps the handler idempotent.
  const bookAppointment = useCallback(
    (slotStartTime: string) => {
      // Ignore double-click bursts: if the prompt is already open for this
      // slot, do nothing. Without this guard, React would batch setState
      // calls against the same modal and the inner form would re-mount.
      if (patientIdPrompt.open) return;

      // Reject past slots defensively (the slot renderer already disables
      // them, but a keyboard user could still hit Enter on a stale button).
      const ms = slotEpochMs(selectedDate, slotStartTime);
      if (Number.isFinite(ms) && ms < Date.now()) {
        toast.error(
          t(
            "dashboard.appointments.slotInPast",
            "This slot is in the past and cannot be booked."
          )
        );
        return;
      }
      if (!selectedDoctor) {
        toast.error(
          t("dashboard.appointments.selectDoctorFirst", "Please select a doctor first")
        );
        return;
      }
      // Open in-page modal (replaces window.prompt so it's testable by
      // browser automation that cannot interact with native dialogs).
      setPatientIdInput("");
      setPatientIdPrompt({ open: true, slotStartTime });
    },
    [patientIdPrompt.open, selectedDate, selectedDoctor, t]
  );

  async function confirmPatientIdAndBook() {
    const patientId = patientIdInput.trim();
    if (!patientId) {
      toast.error("Patient ID is required to book an appointment");
      return;
    }
    const slotStartTime = patientIdPrompt.slotStartTime;
    setBookingInFlight(true);
    try {
      if (isRecurring) {
        await api.post("/appointments/recurring", {
          patientId,
          doctorId: selectedDoctor,
          startDate: selectedDate,
          slotStart: slotStartTime,
          frequency: recFrequency,
          occurrences: recOccurrences,
        });
        toast.success(`Created ${recOccurrences} recurring appointments.`);
      } else {
        await api.post("/appointments/book", {
          patientId,
          doctorId: selectedDoctor,
          date: selectedDate,
          slotId: slotStartTime,
        });
        toast.success("Appointment booked!");
      }
      setPatientIdPrompt({ open: false, slotStartTime: "" });
      setPatientIdInput("");
      setShowBooking(false);
      setIsRecurring(false);
      loadAppointments();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Booking failed");
    } finally {
      setBookingInFlight(false);
    }
  }

  async function updateStatus(appointmentId: string, status: string) {
    try {
      await api.patch(`/appointments/${appointmentId}/status`, { status });
      loadAppointments();
      if (view === "calendar") loadCalendar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    }
  }

  function handleCancelClick(appointmentId: string) {
    setCancellingId(appointmentId);
  }

  async function confirmCancel() {
    if (!cancellingId) return;
    try {
      await api.patch(`/appointments/${cancellingId}/status`, {
        status: "CANCELLED",
      });
      setCancellingId(null);
      loadAppointments();
      if (view === "calendar") loadCalendar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
      setCancellingId(null);
    }
  }

  function openReschedule(apt: Appointment) {
    setReschedTarget(apt);
    setReschedDate(apt.date.slice(0, 10));
    loadReschedSlots(apt, apt.date.slice(0, 10));
  }

  async function loadReschedSlots(apt: Appointment, date: string) {
    setReschedLoading(true);
    try {
      // Find doctor id — appointments include nested doctor but no id on `doctor` due to type
      // We have apt.id but need doctorId; the list endpoint returns doctor with name only in this page.
      // Re-fetch the full appointment to get doctorId.
      const full = await api.get<{ data: { doctorId: string } }>(
        `/appointments/${apt.id}`
      );
      const doctorId = full.data.doctorId;
      const res = await api.get<{ data: { slots: Slot[] } }>(
        `/doctors/${doctorId}/slots?date=${date}`
      );
      setReschedSlots(res.data.slots);
    } catch {
      setReschedSlots([]);
    }
    setReschedLoading(false);
  }

  async function confirmReschedule(slotStart: string) {
    if (!reschedTarget) return;
    try {
      await api.patch(`/appointments/${reschedTarget.id}/reschedule`, {
        date: reschedDate,
        slotStart,
      });
      toast.success("Appointment rescheduled.");
      setReschedTarget(null);
      setReschedSlots([]);
      loadAppointments();
      if (view === "calendar") loadCalendar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reschedule failed");
    }
  }

  // Group reschedule slots by date (even though we only query one date here, the spec says group by date)
  const reschedSlotsByDate = useMemo(() => {
    const map: Record<string, Slot[]> = {};
    if (!reschedSlots.length) return map;
    map[reschedDate] = reschedSlots;
    return map;
  }, [reschedSlots, reschedDate]);

  // ─── Past-slot detection (issue #34) ────────────────────
  // Ticks every 30s so slots that roll into the past while the booking
  // dialog is open become unselectable too. Using an interval instead of
  // reading `Date.now()` inline keeps the list memoizable, and the 30s
  // cadence is plenty fine-grained for typical 15-minute slot sizes.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Convert a YYYY-MM-DD + HH:MM pair into an epoch-ms timestamp, or NaN if
  // either component is malformed. Kept pure (no React state) so it is safe
  // to call in render and in event handlers.
  function slotEpochMs(dateYmd: string, hhmm: string): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) return NaN;
    if (!/^\d{2}:\d{2}$/.test(hhmm)) return NaN;
    const [y, mo, d] = dateYmd.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    // Local-time Date avoids "2026-04-24T18:00" being treated as UTC on
    // some browsers; the schedule uses clinic-local times.
    return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  }

  // Annotate each slot with a precomputed `isPast` flag. Useful both for
  // rendering (grey out, aria-disabled) and for the click handler so we
  // don't have to parse the date twice. Memoized so the mapping only runs
  // when the slot list, the date, or the clock tick changes.
  const slotsWithPast = useMemo(() => {
    return slots.map((s) => {
      const ms = slotEpochMs(selectedDate, s.startTime);
      return {
        ...s,
        isPast: Number.isFinite(ms) && ms < nowMs,
      };
    });
  }, [slots, selectedDate, nowMs]);

  // ─── Derived list ─────────────────

  const filteredAppointments = useMemo(() => {
    let list = appointments;
    if (isPatient) {
      const today = toISODate(new Date());
      switch (patientTab) {
        case "upcoming":
          list = list.filter(
            (a) => ["BOOKED", "CHECKED_IN"].includes(a.status) && a.date.slice(0, 10) >= today
          );
          break;
        case "past":
          // Past tab: explicitly completed OR no-show (event has elapsed
          // and there was no consult), plus any historical BOOKED rows
          // whose start time has passed (display-only via
          // displayStatusForAppointment). Issues #387/#388.
          list = list.filter(
            (a) =>
              a.status === "COMPLETED" ||
              a.status === "NO_SHOW" ||
              (a.status === "BOOKED" && a.date.slice(0, 10) < today)
          );
          break;
        case "cancelled":
          // Issue #387: NO_SHOW rows must NOT appear here. Strict
          // CANCELLED-only filter so the user sees exactly what they
          // cancelled.
          list = list.filter((a) => a.status === "CANCELLED");
          break;
      }
    }
    if (statusFilter !== "ALL") {
      list = list.filter((a) => a.status === statusFilter);
    }
    return list;
  }, [appointments, isPatient, patientTab, statusFilter]);

  // ─── CSV export ───────────────────

  async function downloadCalendarInvite(appointmentId: string) {
    try {
      const token =
        typeof window !== "undefined"
          ? localStorage.getItem("medcore_token")
          : null;
      const base =
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
      const res = await fetch(`${base}/appointments/${appointmentId}/calendar.ics`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error("Failed to download .ics");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `appointment-${appointmentId.slice(0, 8)}.ics`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    }
  }

  async function findNextAvailable() {
    try {
      const res = await api.get<{
        data: {
          slot: {
            doctorId: string;
            doctorName: string;
            specialization: string | null;
            date: string;
            startTime: string;
          } | null;
        };
      }>("/appointments/next-available");
      if (!res.data.slot) {
        toast.info("No slots available in the next 14 days.");
        return;
      }
      const s = res.data.slot;
      if (
        !(await confirm({
          title: "Proceed to book?",
          message: `Next available: ${formatDoctorName(s.doctorName)}${
            s.specialization ? ` (${s.specialization})` : ""
          } on ${s.date} at ${s.startTime}.`,
        }))
      )
        return;
      // Pre-fill the booking form
      setSelectedDoctor(s.doctorId);
      setSelectedDate(s.date);
      setShowBooking(true);
      // The form auto-loads slots when doctor + date change; the user picks the slot.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not find next slot");
    }
  }

  function exportCSV() {
    const rows = [
      ["Token", "Patient", "Phone", "Doctor", "Date", "Time", "Type", "Status", "Priority"],
      ...filteredAppointments.map((a) => [
        String(a.tokenNumber),
        a.patient.user.name,
        a.patient.user.phone ?? "",
        a.doctor.user.name,
        a.date.slice(0, 10),
        a.slotStart ?? "Walk-in",
        a.type,
        a.status,
        a.priority,
      ]),
    ];
    const csv = rows
      .map((r) =>
        r
          .map((cell) => {
            const s = String(cell ?? "");
            if (s.includes(",") || s.includes('"') || s.includes("\n")) {
              return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
          })
          .join(",")
      )
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `appointments-${filterDate}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ─── Bulk actions ────────────────
  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === filteredAppointments.length && filteredAppointments.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredAppointments.map((a) => a.id)));
    }
  }

  async function runBulkAction(action: "CANCEL" | "NO_SHOW" | "SEND_REMINDER") {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const labels: Record<typeof action, string> = {
      CANCEL: "cancel",
      NO_SHOW: "mark as no-show",
      SEND_REMINDER: "send reminder for",
    } as const;
    if (action !== "SEND_REMINDER") {
      const ok = await confirm({
        title: `${labels[action].charAt(0).toUpperCase()}${labels[action].slice(1)} ${ids.length} appointment(s)?`,
        message: "This applies to every appointment you've selected.",
        confirmLabel: labels[action].charAt(0).toUpperCase() + labels[action].slice(1),
        danger: action === "CANCEL" || action === "NO_SHOW",
      });
      if (!ok) return;
    }
    setBulkBusy(true);
    try {
      const res = await api.post<{
        data: {
          requested: number;
          processed: number;
          skipped: number;
          errors: number;
        };
      }>("/appointments/bulk-action", { appointmentIds: ids, action });
      const d = res.data;
      toast.success(
        `${action.replace(/_/g, " ")}: ${d.processed} processed, ${d.skipped} skipped, ${d.errors} errors`
      );
      setSelectedIds(new Set());
      loadAppointments();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk action failed");
    } finally {
      setBulkBusy(false);
    }
  }

  // ─── Calendar grid helpers ────────

  const calDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(calWeekStart, i)),
    [calWeekStart]
  );

  const calHours = useMemo(
    () => Array.from({ length: 13 }, (_, i) => 8 + i), // 08:00..20:00
    []
  );

  // Organize events by day-iso for quick lookup
  const calEventsByDay = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const ev of calEvents) {
      const dayIso = ev.startDateTime.slice(0, 10);
      if (!map[dayIso]) map[dayIso] = [];
      map[dayIso].push(ev);
    }
    return map;
  }, [calEvents]);

  // ─── Stats derivations ────────────

  const statsByDoctor = useMemo(() => {
    const map: Record<string, { name: string; count: number }> = {};
    for (const ev of statsEvents) {
      if (!map[ev.doctorId]) {
        map[ev.doctorId] = { name: ev.doctorName, count: 0 };
      }
      map[ev.doctorId].count += 1;
    }
    return Object.values(map).sort((a, b) => b.count - a.count);
  }, [statsEvents]);

  const statsByDayOfWeek = useMemo(() => {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const ev of statsEvents) {
      const d = new Date(ev.startDateTime);
      if (!isNaN(d.getTime())) counts[d.getDay()] += 1;
    }
    return DAY_NAMES.map((name, i) => ({
      label: name,
      value: counts[i],
      color: "#6366f1",
    }));
  }, [statsEvents]);

  // ─── UI helpers ───────────────────

  const tabClasses = (tab: PatientTab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      patientTab === tab
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  const viewBtnClasses = (v: ViewMode) =>
    `px-4 py-2 text-sm font-medium transition ${
      view === v
        ? "bg-primary text-white"
        : "bg-white text-gray-700 hover:bg-gray-50"
    }`;

  return (
    <div>
      {/* Cancel confirmation dialog */}
      {cancellingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-800">
              {t("dashboard.actions.cancelAppointment")}
            </h3>
            <p className="mt-2 text-sm text-gray-700">
              {t("dashboard.appointments.cancelConfirm")}
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setCancellingId(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {t("dashboard.actions.keepAppointment")}
              </button>
              <button
                onClick={confirmCancel}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                {t("dashboard.actions.confirmCancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Patient-ID prompt modal — replaces window.prompt() so it's
          reachable by Playwright / browser automation / the Claude
          cloud browser, none of which can interact with native dialogs. */}
      {patientIdPrompt.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="patient-id-prompt-title"
          data-testid="patient-id-prompt"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3
              id="patient-id-prompt-title"
              className="text-lg font-semibold text-gray-800"
            >
              Enter Patient ID
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              Paste the Patient ID (MRN or UUID) for this booking.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void confirmPatientIdAndBook();
              }}
              className="mt-4 space-y-4"
            >
              <input
                autoFocus
                type="text"
                value={patientIdInput}
                onChange={(e) => setPatientIdInput(e.target.value)}
                placeholder="e.g. MR-2026-00123"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                data-testid="patient-id-prompt-input"
                aria-label="Patient ID"
                disabled={bookingInFlight}
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPatientIdPrompt({ open: false, slotStartTime: "" });
                    setPatientIdInput("");
                  }}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  data-testid="patient-id-prompt-cancel"
                  disabled={bookingInFlight}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  data-testid="patient-id-prompt-confirm"
                  disabled={bookingInFlight || !patientIdInput.trim()}
                >
                  {bookingInFlight ? "Booking…" : "Book"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reschedule modal */}
      {reschedTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">Reschedule</h3>
                <p className="text-sm text-gray-500">
                  {reschedTarget.patient.user.name} — Token #{reschedTarget.tokenNumber}
                </p>
              </div>
              <button
                onClick={() => {
                  setReschedTarget(null);
                  setReschedSlots([]);
                }}
                className="text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
                aria-label={t("common.close")}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium">New Date</label>
              <input
                type="date"
                value={reschedDate}
                onChange={(e) => {
                  setReschedDate(e.target.value);
                  loadReschedSlots(reschedTarget, e.target.value);
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium">Available Slots</p>
              {reschedLoading ? (
                <p className="text-sm text-gray-500">Loading…</p>
              ) : Object.keys(reschedSlotsByDate).length === 0 ? (
                <p className="text-sm text-gray-500">No slots available.</p>
              ) : (
                Object.entries(reschedSlotsByDate).map(([d, list]) => (
                  <div key={d} className="mb-3">
                    <p className="mb-1 text-xs font-semibold uppercase text-gray-500">
                      {formatShortDate(d)} ({dayOfWeekName(d)})
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {list.map((s) => (
                        <button
                          key={s.startTime}
                          disabled={!s.isAvailable}
                          onClick={() => confirmReschedule(s.startTime)}
                          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                            s.isAvailable
                              ? "bg-green-50 text-green-700 hover:bg-green-100"
                              : "cursor-not-allowed bg-gray-100 text-gray-400 line-through"
                          }`}
                        >
                          {s.startTime} - {s.endTime}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Calendar event details popup */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">
                  Token #{selectedEvent.tokenNumber}
                </h3>
                <p className="text-sm text-gray-500">
                  {selectedEvent.patientName} → {formatDoctorName(selectedEvent.doctorName)}
                </p>
              </div>
              <button
                onClick={() => setSelectedEvent(null)}
                aria-label={t("common.close")}
                className="text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-gray-500">Start</p>
                <p className="font-medium">
                  {new Date(selectedEvent.startDateTime).toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              </div>
              <div>
                <p className="text-gray-500">Status</p>
                <span
                  className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    STATUS_COLORS[
                      displayStatusForAppointment({
                        status: selectedEvent.status,
                        startTime: selectedEvent.startDateTime,
                      })
                    ] || ""
                  }`}
                >
                  {displayStatusForAppointment({
                    status: selectedEvent.status,
                    startTime: selectedEvent.startDateTime,
                  }).replace(/_/g, " ")}
                </span>
              </div>
              <div>
                <p className="text-gray-500">Type</p>
                <p className="font-medium">{selectedEvent.type}</p>
              </div>
              <div>
                <p className="text-gray-500">Priority</p>
                <p className="font-medium">{selectedEvent.priority}</p>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {["BOOKED", "CHECKED_IN"].includes(selectedEvent.status) && !isPatient && (
                <button
                  onClick={() => {
                    // Build a minimal Appointment shape for reschedule
                    const a: Appointment = {
                      id: selectedEvent.id,
                      tokenNumber: selectedEvent.tokenNumber,
                      date: selectedEvent.startDateTime,
                      slotStart: selectedEvent.startDateTime.slice(11, 16),
                      type: selectedEvent.type,
                      status: selectedEvent.status,
                      priority: selectedEvent.priority,
                      patient: { user: { name: selectedEvent.patientName, phone: "" } },
                      doctor: { user: { name: selectedEvent.doctorName } },
                    };
                    setSelectedEvent(null);
                    openReschedule(a);
                  }}
                  className="rounded bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600"
                >
                  Reschedule
                </button>
              )}
              {["BOOKED", "CHECKED_IN"].includes(selectedEvent.status) && (
                <button
                  onClick={() => {
                    setCancellingId(selectedEvent.id);
                    setSelectedEvent(null);
                  }}
                  className="rounded bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600"
                >
                  Cancel
                </button>
              )}
              {selectedEvent.status === "IN_CONSULTATION" && !isPatient && (
                <button
                  onClick={() => {
                    updateStatus(selectedEvent.id, "COMPLETED");
                    setSelectedEvent(null);
                  }}
                  className="rounded bg-gray-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
                >
                  Mark Complete
                </button>
              )}
              <a
                href={`/dashboard/patients`}
                className="rounded bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
              >
                View Patient
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">
          {isPatient
            ? t("dashboard.appointments.titleMine")
            : t("dashboard.appointments.title")}
        </h1>
        <div className="flex items-center gap-3">
          {/* View toggle */}
          <div
            className="inline-flex overflow-hidden rounded-lg border border-gray-200"
            role="group"
            aria-label="View mode"
          >
            <button onClick={() => setView("list")} className={viewBtnClasses("list")}>
              {t("dashboard.common.list")}
            </button>
            <button onClick={() => setView("calendar")} className={viewBtnClasses("calendar")}>
              {t("dashboard.common.calendarView")}
            </button>
            {!isPatient && (
              <button onClick={() => setView("stats")} className={viewBtnClasses("stats")}>
                {t("dashboard.common.statsView")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ───── LIST VIEW ───── */}
      {view === "list" && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {!isPatient && (
                <input
                  type="date"
                  value={filterDate}
                  onChange={(e) => setFilterDate(e.target.value)}
                  aria-label="Filter by date"
                  className="rounded-lg border px-3 py-2 text-sm"
                />
              )}
              <button
                onClick={exportCSV}
                aria-label="Export appointments to CSV"
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Export CSV
              </button>
              <button
                onClick={findNextAvailable}
                className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
                title="Find the earliest open appointment slot across all doctors"
              >
                Next Available
              </button>
            </div>
            {(user?.role === "RECEPTION" || user?.role === "ADMIN") && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setShowBooking(!showBooking)}
                  data-testid="appt-book-toggle"
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
                >
                  {t("dashboard.actions.bookAppointment")}
                </button>
                <button
                  onClick={() => setShowWaitlistModal(true)}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100"
                >
                  Join Waitlist
                </button>
                <button
                  onClick={() => setShowGroupModal(true)}
                  className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-800 hover:bg-blue-100"
                >
                  Group Appointment
                </button>
                {user?.role === "ADMIN" && (
                  <button
                    onClick={() => setShowCoordModal(true)}
                    className="rounded-lg border border-purple-300 bg-purple-50 px-3 py-2 text-sm font-medium text-purple-800 hover:bg-purple-100"
                  >
                    Coordinate Multi-Doctor Visit
                  </button>
                )}
              </div>
            )}
          </div>

          {showWaitlistModal && (
            <WaitlistModal onClose={() => setShowWaitlistModal(false)} doctors={doctors} />
          )}
          {showGroupModal && (
            <GroupAppointmentModal
              onClose={() => setShowGroupModal(false)}
              doctors={doctors}
              onSaved={() => {
                setShowGroupModal(false);
                loadAppointments();
              }}
            />
          )}
          {showCoordModal && (
            <CoordinatedVisitModal
              onClose={() => setShowCoordModal(false)}
              doctors={doctors}
              onSaved={() => {
                setShowCoordModal(false);
                loadAppointments();
              }}
            />
          )}

          {/* Status filter chips */}
          {!isPatient && (
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                onClick={() => setStatusFilter("ALL")}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  statusFilter === "ALL"
                    ? "bg-primary text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                All
              </button>
              {ALL_STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    statusFilter === s
                      ? "bg-primary text-white"
                      : STATUS_COLORS[s] + " hover:opacity-80"
                  }`}
                >
                  {s.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          )}

          {/* Patient filter tabs */}
          {isPatient && (
            <div className="mb-4 flex gap-2">
              <button onClick={() => setPatientTab("upcoming")} className={tabClasses("upcoming")}>
                {t("dashboard.appointments.tab.upcoming")}
              </button>
              <button onClick={() => setPatientTab("past")} className={tabClasses("past")}>
                {t("dashboard.appointments.tab.past")}
              </button>
              <button onClick={() => setPatientTab("cancelled")} className={tabClasses("cancelled")}>
                {t("dashboard.appointments.tab.cancelled")}
              </button>
            </div>
          )}

          {/* Booking form */}
          {showBooking && (
            <div
              className="mb-6 rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
              data-testid="appt-book-panel"
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold">
                  {t("dashboard.appointments.book.title")}
                </h2>
                <button
                  type="button"
                  onClick={() => setShowBooking(false)}
                  className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400"
                  data-testid="appt-book-close"
                >
                  Close
                </button>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="appt-book-doctor" className="mb-1 block text-sm font-medium">
                    {t("dashboard.appointments.doctor")}
                  </label>
                  <select
                    id="appt-book-doctor"
                    value={selectedDoctor}
                    onChange={(e) => {
                      setSelectedDoctor(e.target.value);
                      if (e.target.value) loadSlots(e.target.value, selectedDate);
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  >
                    <option value="">{t("dashboard.appointments.selectDoctor")}</option>
                    {doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.user.name} — {d.specialization}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="appt-book-date" className="mb-1 block text-sm font-medium">
                    {t("dashboard.appointments.date")}
                  </label>
                  <input
                    id="appt-book-date"
                    type="date"
                    value={selectedDate}
                    onChange={(e) => {
                      setSelectedDate(e.target.value);
                      if (selectedDoctor) loadSlots(selectedDoctor, e.target.value);
                    }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    onClick={() => setIsRecurring(!isRecurring)}
                    className={`w-full rounded-lg px-3 py-2 text-sm font-medium ${
                      isRecurring
                        ? "bg-indigo-600 text-white hover:bg-indigo-700"
                        : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-700"
                    }`}
                  >
                    {isRecurring ? "Recurring ON" : "Book Recurring"}
                  </button>
                </div>
              </div>

              {isRecurring && (
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-medium">Frequency</label>
                    <select
                      value={recFrequency}
                      onChange={(e) =>
                        setRecFrequency(e.target.value as "DAILY" | "WEEKLY" | "MONTHLY")
                      }
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    >
                      <option value="DAILY">Daily</option>
                      <option value="WEEKLY">Weekly (same day)</option>
                      <option value="MONTHLY">Monthly</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Occurrences</label>
                    <input
                      type="number"
                      min={2}
                      max={52}
                      value={recOccurrences}
                      onChange={(e) =>
                        setRecOccurrences(Math.max(2, Math.min(52, Number(e.target.value) || 2)))
                      }
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    />
                  </div>
                </div>
              )}

              {/* Issue #350 — earlier the booking form rendered nothing
                  when no doctor was picked OR when the picked date had
                  no slots, so the user appeared to hit a dead-end.
                  Surface explicit guidance + a Cancel escape hatch. */}
              {!selectedDoctor && (
                <div
                  className="mt-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
                  data-testid="appt-book-pick-doctor"
                >
                  Pick a doctor and date above to load available slots.
                </div>
              )}
              {selectedDoctor && slotsWithPast.length === 0 && (
                <div
                  className="mt-4 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
                  data-testid="appt-book-no-slots"
                >
                  No slots available for the selected doctor on this date.
                  Try a different date or use{" "}
                  <button
                    type="button"
                    onClick={findNextAvailable}
                    className="font-medium underline hover:text-amber-900"
                  >
                    Next Available
                  </button>
                  .
                </div>
              )}

              {slotsWithPast.length > 0 && (
                <div className="mt-4" data-testid="appt-book-slots">
                  <p className="mb-2 text-sm font-medium">
                    {isRecurring
                      ? "Pick a start slot (will repeat):"
                      : "Available Slots:"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {slotsWithPast.map((slot) => {
                      // Issue #34: a slot that sits before the current wall
                      // clock must be both visually and functionally dead,
                      // regardless of whether the backend also flagged it
                      // via `isAvailable`.
                      const bookable = slot.isAvailable && !slot.isPast;
                      const title = slot.isPast
                        ? t(
                            "dashboard.appointments.slotInPast",
                            "This slot is in the past and cannot be booked."
                          )
                        : !slot.isAvailable
                          ? t(
                              "dashboard.appointments.slotUnavailable",
                              "Slot unavailable"
                            )
                          : `${slot.startTime} - ${slot.endTime}`;
                      return (
                        <button
                          key={slot.startTime}
                          type="button"
                          disabled={!bookable}
                          aria-disabled={!bookable}
                          data-past={slot.isPast ? "true" : undefined}
                          title={title}
                          onClick={() => bookAppointment(slot.startTime)}
                          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                            bookable
                              ? "bg-green-50 text-green-700 hover:bg-green-100"
                              : slot.isPast
                                ? "cursor-not-allowed bg-gray-50 text-gray-400 line-through opacity-60"
                                : "cursor-not-allowed bg-gray-100 text-gray-400 line-through"
                          }`}
                        >
                          {slot.startTime} - {slot.endTime}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Bulk action bar */}
          {!isPatient && selectedIds.size > 0 && (
            <div
              className="no-print mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3"
              role="region"
              aria-label="Bulk actions"
            >
              <span className="text-sm font-medium text-primary">
                {selectedIds.size} selected
              </span>
              <button
                onClick={() => runBulkAction("CANCEL")}
                disabled={bulkBusy}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              >
                Cancel selected
              </button>
              <button
                onClick={() => runBulkAction("NO_SHOW")}
                disabled={bulkBusy}
                className="rounded-lg bg-slate-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
              >
                Mark as No-Show
              </button>
              <button
                onClick={() => runBulkAction("SEND_REMINDER")}
                disabled={bulkBusy}
                className="rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                Send reminder
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                disabled={bulkBusy}
                className="ml-auto rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
              >
                Clear
              </button>
            </div>
          )}

          {/* Appointments table */}
          <div className="rounded-xl bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
            {loading ? (
              <div className="p-4">
                <SkeletonTable rows={5} columns={isPatient ? 7 : 9} />
              </div>
            ) : filteredAppointments.length === 0 ? (
              <EmptyState
                icon={<Calendar size={28} aria-hidden="true" />}
                title={
                  isPatient
                    ? patientTab === "upcoming"
                      ? "No upcoming appointments"
                      : patientTab === "past"
                        ? "No past appointments"
                        : "No cancelled appointments"
                    : "No appointments today"
                }
                description={
                  isPatient
                    ? "Book an appointment with one of our doctors."
                    : "Book a new appointment to get started."
                }
                action={
                  !isPatient
                    ? {
                        label: "Book appointment",
                        onClick: () => setShowBooking(true),
                      }
                    : undefined
                }
              />
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-gray-700">
                    {!isPatient && (
                      <th className="px-4 py-3 w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all appointments"
                          checked={
                            filteredAppointments.length > 0 &&
                            selectedIds.size === filteredAppointments.length
                          }
                          onChange={toggleSelectAll}
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </th>
                    )}
                    <th className="px-4 py-3">{t("dashboard.appointments.col.token")}</th>
                    {!isPatient && <th className="px-4 py-3">{t("dashboard.appointments.col.patient")}</th>}
                    <th className="px-4 py-3">{t("dashboard.appointments.col.doctor")}</th>
                    <th className="px-4 py-3">{t("dashboard.appointments.col.date")}</th>
                    <th className="px-4 py-3">{t("dashboard.appointments.col.time")}</th>
                    <th className="px-4 py-3">{t("dashboard.appointments.col.type")}</th>
                    <th className="px-4 py-3">{t("dashboard.appointments.col.status")}</th>
                    <th className="px-4 py-3">{t("dashboard.appointments.col.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAppointments.map((apt) => {
                    // Issue #388: a `BOOKED` row whose start time has passed
                    // must read as `COMPLETED` (display layer only).
                    // Issue #389: route every time string through the same
                    // formatter so the calendar tile and this row agree.
                    const displayStatus = displayStatusForAppointment({
                      status: apt.status,
                      slotStart: apt.slotStart,
                      date: apt.date,
                    });
                    const displayTime = apt.slotStart
                      ? formatAppointmentTime(apt.slotStart, apt.date)
                      : "";
                    const rowTestId =
                      isPatient && patientTab === "cancelled"
                        ? "my-appt-cancelled-row"
                        : undefined;
                    return (
                    <tr
                      key={apt.id}
                      className="border-b last:border-0"
                      data-testid={rowTestId}
                    >
                      {!isPatient && (
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            aria-label={`Select appointment ${apt.tokenNumber}`}
                            checked={selectedIds.has(apt.id)}
                            onChange={() => toggleSelect(apt.id)}
                            className="h-4 w-4 cursor-pointer accent-primary"
                          />
                        </td>
                      )}
                      <td className="px-4 py-3 font-bold">{apt.tokenNumber}</td>
                      {!isPatient && (
                        <td className="px-4 py-3">
                          <p className="font-medium">{apt.patient.user.name}</p>
                          <p className="text-xs text-gray-500">{apt.patient.user.phone}</p>
                        </td>
                      )}
                      <td className="px-4 py-3 text-sm">{apt.doctor.user.name}</td>
                      <td className="px-4 py-3 text-sm">{apt.date.slice(0, 10)}</td>
                      <td className="px-4 py-3 text-sm">
                        {displayTime || (apt.slotStart ?? "Walk-in")}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${
                            apt.type === "WALK_IN"
                              ? "bg-orange-100 text-orange-700"
                              : "bg-blue-100 text-blue-700"
                          }`}
                        >
                          {apt.type === "WALK_IN" ? "Walk-in" : "Scheduled"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            STATUS_COLORS[displayStatus] || ""
                          }`}
                        >
                          {displayStatus.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {/* Reschedule for BOOKED / CHECKED_IN */}
                          {["BOOKED", "CHECKED_IN"].includes(apt.status) &&
                            (isPatient ||
                              user?.role === "RECEPTION" ||
                              user?.role === "ADMIN" ||
                              user?.role === "DOCTOR" ||
                              user?.role === "NURSE") && (
                              <button
                                onClick={() => openReschedule(apt)}
                                aria-label={`Reschedule appointment for ${apt.patient.user.name} (token ${apt.tokenNumber})`}
                                className="rounded bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-700"
                              >
                                {t("dashboard.actions.reschedule")}
                              </button>
                            )}
                          {apt.status === "BOOKED" &&
                            (isPatient ||
                              user?.role === "RECEPTION" ||
                              user?.role === "ADMIN") && (
                              <button
                                onClick={() => handleCancelClick(apt.id)}
                                aria-label={`Cancel appointment for ${apt.patient.user.name} (token ${apt.tokenNumber})`}
                                className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700"
                              >
                                {t("common.cancel")}
                              </button>
                            )}
                          {["BOOKED", "CHECKED_IN"].includes(apt.status) && (
                            <button
                              onClick={() => downloadCalendarInvite(apt.id)}
                              aria-label={`Download calendar invite for token ${apt.tokenNumber}`}
                              className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100"
                              title="Download .ics file"
                            >
                              {t("dashboard.actions.calendarInvite")}
                            </button>
                          )}
                          {!isPatient && apt.status === "BOOKED" && (
                            <button
                              onClick={() => updateStatus(apt.id, "CHECKED_IN")}
                              aria-label={`Check in ${apt.patient.user.name}`}
                              className="rounded bg-yellow-600 px-2 py-1 text-xs text-white hover:bg-yellow-700"
                            >
                              {t("dashboard.actions.checkIn")}
                            </button>
                          )}
                          {!isPatient && apt.status === "CHECKED_IN" && (
                            <button
                              onClick={() => updateStatus(apt.id, "IN_CONSULTATION")}
                              aria-label={`Start consultation for ${apt.patient.user.name}`}
                              className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                            >
                              {t("dashboard.actions.startConsult")}
                            </button>
                          )}
                          {!isPatient && apt.status === "IN_CONSULTATION" && (
                            <button
                              onClick={() => updateStatus(apt.id, "COMPLETED")}
                              aria-label={`Mark consultation complete for ${apt.patient.user.name}`}
                              className="rounded bg-gray-700 px-2 py-1 text-xs text-white hover:bg-gray-800"
                            >
                              {t("dashboard.actions.complete")}
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
        </>
      )}

      {/* ───── CALENDAR VIEW ───── */}
      {view === "calendar" && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setCalWeekStart(startOfWeek(new Date()))}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
              >
                Today
              </button>
              <button
                onClick={() => setCalWeekStart(addDays(calWeekStart, -7))}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
              >
                ← Prev Week
              </button>
              <button
                onClick={() => setCalWeekStart(addDays(calWeekStart, 7))}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
              >
                Next Week →
              </button>
              <span className="ml-2 text-sm font-medium text-gray-700">
                {formatShortDate(toISODate(calWeekStart))} –{" "}
                {formatShortDate(toISODate(addDays(calWeekStart, 6)))}
              </span>
            </div>
            <select
              value={calDoctor}
              onChange={(e) => setCalDoctor(e.target.value)}
              aria-label="Filter calendar by doctor"
              className="rounded-lg border px-3 py-2 text-sm"
            >
              <option value="">{t("dashboard.appointments.allDoctors")}</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.user.name}
                </option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
            {calLoading ? (
              <div className="p-8 text-center text-gray-500">Loading calendar…</div>
            ) : (
              <div className="min-w-200">
                {/* Header row */}
                <div
                  className="grid border-b bg-gray-50 text-xs font-semibold text-gray-700"
                  style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}
                >
                  <div className="px-2 py-2" />
                  {calDays.map((d) => {
                    const iso = toISODate(d);
                    const isToday = iso === toISODate(new Date());
                    return (
                      <div
                        key={iso}
                        className={`border-l px-2 py-2 text-center ${
                          isToday ? "bg-blue-50 text-blue-700" : ""
                        }`}
                      >
                        <div>{DAY_NAMES[d.getDay()]}</div>
                        <div className="text-sm font-bold">{d.getDate()}</div>
                      </div>
                    );
                  })}
                </div>

                {/* Hour rows */}
                {calHours.map((h) => (
                  <div
                    key={h}
                    className="grid border-b text-xs"
                    style={{
                      gridTemplateColumns: "60px repeat(7, 1fr)",
                      minHeight: "56px",
                    }}
                  >
                    <div className="border-r px-2 py-1 text-right text-gray-500">
                      {String(h).padStart(2, "0")}:00
                    </div>
                    {calDays.map((d) => {
                      const iso = toISODate(d);
                      const dayEvents = calEventsByDay[iso] || [];
                      const hourEvents = dayEvents.filter((ev) => {
                        const hr = parseInt(ev.startDateTime.slice(11, 13), 10);
                        return hr === h;
                      });
                      return (
                        <div
                          key={iso + "-" + h}
                          className="relative border-l bg-white hover:bg-gray-50"
                        >
                          {hourEvents.map((ev) => {
                            const min = parseInt(ev.startDateTime.slice(14, 16), 10) || 0;
                            const topPct = (min / 60) * 100;
                            const hPct = 25; // ~15min block of 60min row = 25%
                            // Issue #389: route every appointment time through
                            // the same Asia/Kolkata formatter so the week-grid
                            // tile and the list row never disagree.
                            const tileTime = formatAppointmentTime(ev.startDateTime);
                            // Issue #388: a `BOOKED` past event must read as
                            // `COMPLETED` on screen.
                            const tileStatus = displayStatusForAppointment({
                              status: ev.status,
                              startTime: ev.startDateTime,
                            });
                            return (
                              <button
                                key={ev.id}
                                onClick={() => setSelectedEvent(ev)}
                                aria-label={`Token ${ev.tokenNumber}: ${ev.patientName} with ${formatDoctorName(ev.doctorName)} at ${tileTime} — status ${tileStatus.replace(/_/g, " ")}. Open details.`}
                                className={`absolute left-1 right-1 overflow-hidden rounded border px-1.5 py-0.5 text-left text-[10px] font-medium text-white shadow-sm ${
                                  STATUS_BLOCK_COLORS[tileStatus] ||
                                  "bg-gray-400 border-gray-500"
                                }`}
                                style={{
                                  top: `${topPct}%`,
                                  height: `${hPct}%`,
                                  minHeight: "20px",
                                }}
                                title={`${ev.patientName} — ${ev.doctorName} (${tileStatus})`}
                              >
                                <div className="truncate">
                                  #{ev.tokenNumber} {ev.patientName}
                                </div>
                                <div className="truncate opacity-90">
                                  {tileTime} · {formatDoctorName(ev.doctorName)}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {ALL_STATUSES.map((s) => (
              <div key={s} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={{ backgroundColor: STATUS_HEX[s] }}
                />
                <span className="text-gray-700">{s.replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ───── STATS VIEW ───── */}
      {view === "stats" && !isPatient && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">From</label>
              <input
                type="date"
                value={statsFrom}
                onChange={(e) => setStatsFrom(e.target.value)}
                className="rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">To</label>
              <input
                type="date"
                value={statsTo}
                onChange={(e) => setStatsTo(e.target.value)}
                className="rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Doctor</label>
              <select
                value={statsDoctor}
                onChange={(e) => setStatsDoctor(e.target.value)}
                className="rounded-lg border px-3 py-2 text-sm"
              >
                <option value="">All Doctors</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.user.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <button
                onClick={loadStats}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Refresh
              </button>
            </div>
          </div>

          {statsLoading ? (
            <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
              Loading stats…
            </div>
          ) : !stats ? (
            <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
              No data.
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <StatCard label="Total" value={stats.totalCount} color="bg-blue-50 text-blue-700" />
                <StatCard
                  label="Completed"
                  value={stats.completedCount}
                  color="bg-green-50 text-green-700"
                />
                <StatCard
                  label="Cancelled"
                  value={stats.cancelledCount}
                  color="bg-red-50 text-red-700"
                />
                <StatCard
                  label="No-Show"
                  value={stats.noShowCount}
                  color="bg-slate-50 text-slate-700"
                />
                <StatCard
                  label="Avg Consult (min)"
                  value={stats.avgConsultationTimeMin}
                  color="bg-indigo-50 text-indigo-700"
                />
                <StatCard
                  label="Peak Hour"
                  value={
                    stats.peakHour !== null
                      ? `${String(stats.peakHour).padStart(2, "0")}:00`
                      : "—"
                  }
                  color="bg-amber-50 text-amber-700"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <section className="rounded-xl bg-white p-5 shadow-sm">
                  <h2 className="mb-4 font-semibold">By Status</h2>
                  <DonutChart
                    segments={ALL_STATUSES.map((s) => ({
                      label: s.replace(/_/g, " "),
                      value: stats.byStatus[s] || 0,
                      color: STATUS_HEX[s],
                    })).filter((s) => s.value > 0)}
                  />
                </section>

                <section className="rounded-xl bg-white p-5 shadow-sm">
                  <h2 className="mb-4 font-semibold">By Doctor</h2>
                  {statsByDoctor.length === 0 ? (
                    <p className="text-sm text-gray-500">No data.</p>
                  ) : (
                    <HBarChart
                      items={statsByDoctor.map((s) => ({
                        label: s.name,
                        value: s.count,
                        color: "#0ea5e9",
                      }))}
                    />
                  )}
                </section>

                <section className="rounded-xl bg-white p-5 shadow-sm">
                  <h2 className="mb-4 font-semibold">By Day of Week</h2>
                  <HBarChart items={statsByDayOfWeek} />
                </section>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className={`rounded-xl p-4 shadow-sm ${color}`}>
      <p className="text-xs font-medium uppercase opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

// ─── Waitlist / Group / Coordinated Visit Modals ────────

function WaitlistModal({
  onClose,
  doctors,
}: {
  onClose: () => void;
  doctors: Doctor[];
}) {
  const [patientId, setPatientId] = useState("");
  const [doctorId, setDoctorId] = useState(doctors[0]?.id || "");
  const [preferredDate, setPreferredDate] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!patientId || !doctorId) return;
    setSaving(true);
    try {
      await api.post("/waitlist", {
        patientId,
        doctorId,
        preferredDate: preferredDate || undefined,
        reason: reason || undefined,
      });
      toast.success("Added to waitlist");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Join Waitlist</h3>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="text-gray-600 hover:text-gray-800"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="space-y-3">
          <input
            placeholder="Patient ID"
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            aria-label="Patient ID"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
          <select
            value={doctorId}
            onChange={(e) => setDoctorId(e.target.value)}
            aria-label="Doctor"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          >
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {formatDoctorName(d.user.name)} — {d.specialization}
              </option>
            ))}
          </select>
          <div>
            <label className="text-xs text-gray-500">Preferred Date</label>
            <input
              type="date"
              value={preferredDate}
              onChange={(e) => setPreferredDate(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <textarea
            rows={2}
            placeholder="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Reason for waitlist"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !patientId || !doctorId}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Join Waitlist"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Patient picker helpers (shared by group + coordinated modals) ─────

interface PatientPickerItem {
  id: string;
  name: string;
  mrNumber?: string;
  phone?: string;
}

function useDebouncedPatientSearch(query: string) {
  const [results, setResults] = useState<PatientPickerItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{
          data: Array<{
            id: string;
            mrNumber?: string;
            user: { name: string; phone?: string };
          }>;
        }>(`/patients?search=${encodeURIComponent(q)}&limit=10`);
        if (cancelled) return;
        const list = (res.data || []).map((p) => ({
          id: p.id,
          name: p.user?.name || "Patient",
          mrNumber: p.mrNumber,
          phone: p.user?.phone,
        }));
        setResults(list);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  return { results, loading };
}

function MultiPatientPicker({
  selected,
  onChange,
}: {
  selected: PatientPickerItem[];
  onChange: (items: PatientPickerItem[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const { results, loading } = useDebouncedPatientSearch(query);
  const selectedIds = useMemo(() => new Set(selected.map((s) => s.id)), [selected]);

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 text-xs text-blue-800"
            >
              {p.name}
              {p.mrNumber ? (
                <span className="text-blue-500">#{p.mrNumber}</span>
              ) : null}
              <button
                type="button"
                onClick={() => onChange(selected.filter((s) => s.id !== p.id))}
                aria-label={`Remove ${p.name}`}
                className="ml-0.5 rounded-full text-blue-600 hover:text-blue-900"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          type="text"
          value={query}
          placeholder="Search patients by name, phone, MR..."
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className="w-full rounded-lg border px-3 py-2 text-sm"
        />
        {open && query.trim().length >= 2 && (
          <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white text-gray-900 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
            {loading && (
              <li className="px-3 py-2 text-xs text-gray-500">Searching...</li>
            )}
            {!loading && results.length === 0 && (
              <li className="px-3 py-2 text-xs text-gray-500">No matches</li>
            )}
            {!loading &&
              results.map((p) => {
                const already = selectedIds.has(p.id);
                return (
                  <li
                    key={p.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (!already) onChange([...selected, p]);
                      setQuery("");
                    }}
                    className={
                      "cursor-pointer px-3 py-2 text-sm " +
                      (already
                        ? "bg-gray-100 text-gray-400"
                        : "hover:bg-blue-50")
                    }
                  >
                    <div className="font-medium">{p.name}</div>
                    <div className="text-[11px] text-gray-500">
                      {p.mrNumber ? `MR#${p.mrNumber}` : ""}
                      {p.mrNumber && p.phone ? " · " : ""}
                      {p.phone || ""}
                      {already ? "  (already added)" : ""}
                    </div>
                  </li>
                );
              })}
          </ul>
        )}
      </div>
    </div>
  );
}

function SinglePatientPicker({
  selected,
  onChange,
}: {
  selected: PatientPickerItem | null;
  onChange: (item: PatientPickerItem | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const { results, loading } = useDebouncedPatientSearch(query);

  if (selected) {
    return (
      <div className="flex items-center justify-between rounded-lg border bg-blue-50 px-3 py-2">
        <div className="text-sm">
          <div className="font-medium text-blue-900">{selected.name}</div>
          <div className="text-[11px] text-blue-700">
            {selected.mrNumber ? `MR#${selected.mrNumber}` : ""}
            {selected.mrNumber && selected.phone ? " · " : ""}
            {selected.phone || ""}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-xs text-blue-700 hover:text-blue-900"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        placeholder="Search patient by name, phone, MR..."
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full rounded-lg border px-3 py-2 text-sm"
      />
      {open && query.trim().length >= 2 && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white text-gray-900 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
          {loading && (
            <li className="px-3 py-2 text-xs text-gray-500">Searching...</li>
          )}
          {!loading && results.length === 0 && (
            <li className="px-3 py-2 text-xs text-gray-500">No matches</li>
          )}
          {!loading &&
            results.map((p) => (
              <li
                key={p.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(p);
                  setQuery("");
                }}
                className="cursor-pointer px-3 py-2 text-sm hover:bg-blue-50"
              >
                <div className="font-medium">{p.name}</div>
                <div className="text-[11px] text-gray-500">
                  {p.mrNumber ? `MR#${p.mrNumber}` : ""}
                  {p.mrNumber && p.phone ? " · " : ""}
                  {p.phone || ""}
                </div>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function GroupAppointmentModal({
  onClose,
  doctors,
  onSaved,
}: {
  onClose: () => void;
  doctors: Doctor[];
  onSaved: () => void;
}) {
  const [selectedPatients, setSelectedPatients] = useState<PatientPickerItem[]>([]);
  const [doctorId, setDoctorId] = useState(doctors[0]?.id || "");
  const [date, setDate] = useState("");
  const [slotStart, setSlotStart] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    const patientIds = selectedPatients.map((p) => p.id);
    if (patientIds.length === 0 || !doctorId || !date || !slotStart) return;
    setSaving(true);
    try {
      await api.post("/appointments/group", {
        patientIds,
        doctorId,
        date,
        slotStart,
      });
      toast.success(`Created group appointment for ${patientIds.length} patient(s)`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Group Appointment</h3>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="text-gray-600 hover:text-gray-800"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-gray-500">
              Patients ({selectedPatients.length} selected)
            </label>
            <MultiPatientPicker
              selected={selectedPatients}
              onChange={setSelectedPatients}
            />
          </div>
          <select
            value={doctorId}
            onChange={(e) => setDoctorId(e.target.value)}
            aria-label="Doctor"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          >
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {formatDoctorName(d.user.name)} — {d.specialization}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">Slot Start</label>
              <input
                type="time"
                value={slotStart}
                onChange={(e) => setSlotStart(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={
              saving ||
              selectedPatients.length === 0 ||
              !doctorId ||
              !date ||
              !slotStart
            }
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Create Group"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CoordinatedVisitModal({
  onClose,
  doctors,
  onSaved,
}: {
  onClose: () => void;
  doctors: Doctor[];
  onSaved: () => void;
}) {
  const [selectedPatient, setSelectedPatient] = useState<PatientPickerItem | null>(null);
  const [name, setName] = useState("");
  const [visitDate, setVisitDate] = useState("");
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  function toggleDoc(id: string) {
    setSelectedDocs((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    );
  }

  async function save() {
    if (!selectedPatient || !name || !visitDate || selectedDocs.length === 0) return;
    setSaving(true);
    try {
      await api.post("/coordinated-visits", {
        patientId: selectedPatient.id,
        name,
        visitDate,
        doctorIds: selectedDocs,
      });
      toast.success(`Coordinated visit created with ${selectedDocs.length} doctors`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Coordinate Multi-Doctor Visit</h3>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="text-gray-600 hover:text-gray-800"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-gray-500">Patient</label>
            <SinglePatientPicker
              selected={selectedPatient}
              onChange={setSelectedPatient}
            />
          </div>
          <input
            placeholder="Visit Name (e.g. Diabetes Review)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Visit name"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
          <div>
            <label className="text-xs text-gray-500">Visit Date</label>
            <input
              type="date"
              value={visitDate}
              onChange={(e) => setVisitDate(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-gray-600">
              Select Doctors (back-to-back slots):
            </p>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded border p-2">
              {doctors.map((d) => (
                <label key={d.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedDocs.includes(d.id)}
                    onChange={() => toggleDoc(d.id)}
                  />
                  {formatDoctorName(d.user.name)} — {d.specialization}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={
              saving ||
              !selectedPatient ||
              !name ||
              !visitDate ||
              selectedDocs.length === 0
            }
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Create Visit"}
          </button>
        </div>
      </div>
    </div>
  );
}
