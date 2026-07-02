"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  appointmentRefLabel,
  displayStatusForAppointment,
  formatAppointmentTime,
  isAppointmentPast,
  isAppointmentToday,
} from "@/lib/appointments";
import { SkeletonTable, SkeletonCard } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { TablePagination } from "@/components/TablePagination";
import { EntityPicker } from "@/components/EntityPicker";
import { TenantSelect } from "@/components/TenantSelect";
import { AppointmentRemarksModal } from "@/components/AppointmentRemarksModal";
import { Calendar, MessageSquare, MoreVertical } from "lucide-react";

// ─── Types ─────────────────────────────────────────

// Pearl ERP Stage 1 §3.1 (gap row 71, closed 2026-05-22) — booking channels
// the receptionist can pick for a given doctor. The set of channels actually
// surfaced in the picker is derived per doctor by `availableChannelsFor()`
// below: (mode-semantically-valid channels) ∩ (doctor.enabledChannels ?? all).
type AppointmentChannel = "CALLING" | "SLOT" | "TOKEN" | "WALKIN";

const CHANNEL_LABEL: Record<AppointmentChannel, string> = {
  CALLING: "Calling (arrival queue)",
  SLOT: "Slot (fixed time)",
  TOKEN: "Token (sequential)",
  WALKIN: "Walk-in",
};

interface Doctor {
  id: string;
  user: { name: string };
  specialization: string;
  // Pearl ERP Stage 1 §2.1.2 — TOKEN is the legacy MedCore behaviour;
  // CALLING / SLOT activate alternate booking flows below.
  appointmentMode?: "CALLING" | "TOKEN" | "SLOT";
  // Pearl ERP Stage 1 §3.2 (gap row 77, 2026-05-22) — per-doctor channel
  // allow-list. Empty / undefined = "all mode-valid channels permitted"
  // (back-compat default). Stored as `Doctor.enabledChannels` enum array.
  enabledChannels?: AppointmentChannel[];
  // Token-series config (admin-set). Surfaced from /doctors so the confirm
  // dialog can show the configured prefix even if the /next-token PREVIEW
  // endpoint is unavailable (e.g. an older server build) — the exact
  // sequential number still comes from /next-token when it responds.
  tokenPrefix?: string | null;
  tokenStartNumber?: number | null;
}

// Pearl ERP Stage 1 §3.1 (gap row 71) — channels semantically valid for
// each appointmentMode. Picking a SLOT against a CALLING doctor is
// nonsensical (the API rejects it too), so we never offer it in the UI.
// WALKIN is always paired alongside the primary booking channel because
// every clinic accepts walk-ins regardless of how its scheduling is run.
const MODE_VALID_CHANNELS: Record<
  NonNullable<Doctor["appointmentMode"]>,
  AppointmentChannel[]
> = {
  CALLING: ["CALLING", "WALKIN"],
  TOKEN: ["TOKEN", "WALKIN"],
  SLOT: ["SLOT", "WALKIN"],
};

// Derive the channels actually offered for a given doctor: the intersection
// of (channels valid for the doctor's mode) and (doctor.enabledChannels —
// when explicitly configured). An empty / undefined enabledChannels list
// means "all mode-valid channels permitted" (back-compat), so we return the
// full mode-valid set in that case. If the configured array narrows the set
// to nothing valid (e.g. enabledChannels=["SLOT"] on a CALLING doctor), we
// fall back to the mode's primary channel so the receptionist isn't locked
// out — the API's own enforcement is the authoritative gate.
function availableChannelsFor(doctor: {
  appointmentMode?: Doctor["appointmentMode"];
  enabledChannels?: AppointmentChannel[];
}): AppointmentChannel[] {
  const mode = doctor.appointmentMode ?? "TOKEN";
  const modeValid = MODE_VALID_CHANNELS[mode];
  const configured = doctor.enabledChannels ?? [];
  if (configured.length === 0) return modeValid;
  const intersection = modeValid.filter((c) => configured.includes(c));
  return intersection.length > 0 ? intersection : [modeValid[0]];
}

interface Appointment {
  id: string;
  tokenNumber: number | null;
  // Pearl §2.1.2 — CALLING-mode appointments use an arrival counter
  // instead of a token. Returned from the backend as an int on
  // CALLING rows, null on TOKEN/SLOT rows. Combined with the
  // doctor's appointmentMode (below), the row knows which identifier
  // to render in the # column ("T-7" vs "A-3" vs the slot time).
  arrivalSeq?: number | null;
  date: string;
  slotStart: string | null;
  type: string;
  status: string;
  priority: string;
  patient: { user: { name: string; phone: string }; mrNumber?: string };
  doctor: {
    user: { name: string };
    appointmentMode?: "CALLING" | "TOKEN" | "SLOT";
    tokenPrefix?: string | null;
  };
  // Pearl §2.1.3 — projected from the appointment's Consultation row
  // (1:1 via appointmentId). Lets the row hide Re-consult / Complete
  // once the doctor has signed the SOAP note, even on the rare case
  // where appointment.status drifted from the consult lifecycle.
  consultation?: {
    id: string;
    status: string;
    signedAt: string | null;
  } | null;
  // Pearl §2.1.7 — relation count from the list endpoint, used to badge the
  // Remarks button with the number of threaded remarks on this row.
  _count?: { remarks: number };
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
  BOOKED: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  CHECKED_IN: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300",
  IN_CONSULTATION: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  COMPLETED: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  CANCELLED: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  NO_SHOW: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
};

// SELECTED filter chip — a clean, medium-saturation fill in the status colour
// with white text + a subtle ring & shadow. Vivid enough to read as "active"
// without the harshness of the darkest shade, and consistent in light/dark.
const STATUS_CHIP_ACTIVE: Record<string, string> = {
  BOOKED: "bg-blue-500 text-white ring-1 ring-blue-600 shadow-sm",
  CHECKED_IN: "bg-amber-500 text-white ring-1 ring-amber-600 shadow-sm",
  IN_CONSULTATION: "bg-emerald-500 text-white ring-1 ring-emerald-600 shadow-sm",
  COMPLETED: "bg-gray-500 text-white ring-1 ring-gray-600 shadow-sm",
  CANCELLED: "bg-red-500 text-white ring-1 ring-red-600 shadow-sm",
  NO_SHOW: "bg-orange-500 text-white ring-1 ring-orange-600 shadow-sm",
};

const STATUS_BLOCK_COLORS: Record<string, string> = {
  BOOKED: "bg-blue-500 border-blue-600",
  CHECKED_IN: "bg-yellow-500 border-yellow-600",
  IN_CONSULTATION: "bg-green-500 border-green-600",
  COMPLETED: "bg-gray-400 border-gray-500",
  CANCELLED: "bg-red-500 border-red-600",
  NO_SHOW: "bg-orange-500 border-orange-600",
};

const STATUS_HEX: Record<string, string> = {
  BOOKED: "#3b82f6",
  CHECKED_IN: "#eab308",
  IN_CONSULTATION: "#22c55e",
  COMPLETED: "#6b7280",
  CANCELLED: "#ef4444",
  NO_SHOW: "#f97316",
};

const ALL_STATUSES = [
  "BOOKED",
  "CHECKED_IN",
  "IN_CONSULTATION",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
];

// Status filter chips that don't make sense for a non-today date:
//   - PAST date:   no pending states at all — once the day is over a waiting
//     appointment reads as NO_SHOW (see displayStatusForAppointment), so hide
//     BOOKED / CHECKED IN / IN CONSULTATION.
//   - FUTURE date: a patient can be BOOKED ahead, but it can't be CHECKED IN,
//     IN CONSULTATION or COMPLETED yet — hide those.
const PAST_HIDDEN_STATUSES = new Set([
  "BOOKED",
  "CHECKED_IN",
  "IN_CONSULTATION",
]);
const FUTURE_HIDDEN_STATUSES = new Set([
  "CHECKED_IN",
  "IN_CONSULTATION",
  "COMPLETED",
]);

/** Status chips to hide for the selected date relative to today. */
function hiddenStatusesFor(filterDate: string): Set<string> {
  const today = toISODate(new Date());
  if (filterDate < today) return PAST_HIDDEN_STATUSES;
  if (filterDate > today) return FUTURE_HIDDEN_STATUSES;
  return new Set();
}

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
  return formatDate(s);
}

function dayOfWeekName(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return DAY_NAMES[d.getDay()];
}

// Pull the patient's display name out of an EntityPicker payload. Patient
// rows come back from /patients with a nested `user.name` — fall back to a
// few likely shapes so the Confirm Appointment dialog never renders a blank.
function readPatientName(entity: Record<string, unknown> | null): string {
  if (!entity) return "";
  const user = entity.user as { name?: unknown } | undefined;
  if (user && typeof user.name === "string") return user.name;
  if (typeof entity.name === "string") return entity.name;
  return "";
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
  const strokeW = 28;
  // Leave room for half the stroke width (+small margin) so the donut's outer
  // edge doesn't spill past the viewBox and get clipped flat (lumpy circle).
  const radius = size / 2 - strokeW / 2 - 2;
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
              className="inline-block h-3 w-3 shrink-0 rounded-sm"
              style={{ backgroundColor: seg.color }}
            />
            <span className="whitespace-nowrap text-gray-700 dark:text-gray-200">
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
              <span className="font-medium text-gray-700 dark:text-gray-200">{it.label}</span>
              <span className="text-gray-600 dark:text-gray-300">{it.value}</span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
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

// ─── Doctor dropdown ───────────────────────────────
// Custom replacement for the native <select>. A native popup's open
// direction, height and scrolling are browser-controlled; this renders the
// option list as a panel that always opens DOWNWARD (`top-full`), with a
// fixed max-height and its own scrollbar (`max-h-60 overflow-y-auto`).
function DoctorSelect({
  doctors,
  value,
  placeholder,
  onChange,
}: {
  doctors: Doctor[];
  value: string;
  placeholder: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = doctors.find((d) => d.id === value);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        id="appt-book-doctor"
        data-testid="appt-book-doctor"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      >
        <span
          className={
            selected
              ? "truncate"
              : "truncate text-gray-500 dark:text-gray-400"
          }
        >
          {selected
            ? `${selected.user.name} — ${selected.specialization}`
            : placeholder}
        </span>
        <span aria-hidden className="shrink-0 text-gray-400">
          ▾
        </span>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={placeholder}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={value === ""}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="block w-full px-3 py-2 text-left text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              {placeholder}
            </button>
          </li>
          {doctors.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                role="option"
                aria-selected={value === d.id}
                // Stable per-doctor handle for e2e (replaces the
                // `value={d.id}` that the legacy native <select>
                // exposed). Picked up by pickDoctor() in
                // e2e/doctor-modes-render.spec.ts.
                data-doctor-id={d.id}
                onClick={() => {
                  onChange(d.id);
                  setOpen(false);
                }}
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 ${
                  value === d.id
                    ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-200"
                    : "text-gray-900 dark:text-gray-100"
                }`}
              >
                {d.user.name} — {d.specialization}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────

export default function AppointmentsPage() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const router = useRouter();
  // Pearl §3.3 row 7 — read ?patientId / ?doctorId query params so the
  // booking form can be deep-linked from the lead-convert flow. The
  // effect below applies them once `doctors` is loaded so the doctor's
  // mode + channel set is available to derive the channel correctly.
  const searchParams = useSearchParams();
  const isPatient = user?.role === "PATIENT";
  // Super-admin tenant filter. A super-admin (actualRole SUPER_ADMIN, or the
  // legacy tenant-less ADMIN) bypasses tenant scoping and sees every tenant's
  // appointments; the dropdown in the header lets them narrow to one tenant
  // via `?tenantId=` on the list / stats / calendar fetches. Hidden for
  // tenant-bound staff (already scoped to their own tenant server-side).
  const isSuperAdmin =
    user?.actualRole === "SUPER_ADMIN" ||
    (user?.role === "ADMIN" && !user?.tenantId);
  const [tenants, setTenants] = useState<
    Array<{ id: string; name: string; subdomain: string }>
  >([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  // A logged-in DOCTOR books only for themselves — the booking-form doctor
  // selector is locked to their own record (matched via the shared User name).
  // Other roles (ADMIN/RECEPTION/NURSE) keep the full doctor list.
  const isDoctor = user?.role === "DOCTOR";

  // Issue #491 (2026-05-03): every "future-date" input on this page (book a
  // new appointment, reschedule, waitlist preferred date, recurring start,
  // coordinated visit) needs a `min={today}` so the native date picker stops
  // the user from selecting a past date in the first place. The backend Zod
  // schema also rejects past dates as defence-in-depth, but a UX guard here
  // prevents an invalid pick. Filter and stats inputs deliberately do *not*
  // set this min — those are for querying historical records.
  //
  // For reschedule the floor is still today (a future appointment can even be
  // moved back to today); the one date that's NOT a valid target is the
  // appointment's OWN current date — that's handled separately as a same-date
  // guard on the Reschedule action, since a native date input can't exclude a
  // single date in the middle of its allowed range.
  const todayMin = toISODate(new Date());

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
  // Issue #950 — when the user enters the booking flow via the "Next
  // Available" suggestion, the booking POST must target the exact
  // doctor/date the suggestion advertised — NOT whatever the form's
  // selectedDoctor/selectedDate happen to be by the time the user clicks
  // Confirm (those can drift via DoctorSelect re-renders, channel auto-
  // derivation, or a date input change between confirm-shown and
  // confirm-clicked). When set, this lock is used as a hard override in
  // `confirmPatientIdAndBook` and cleared after the booking completes or
  // the dialog is cancelled. Null = the user is on the normal slot-grid
  // path and the form state IS the source of truth.
  const [nextAvailableLock, setNextAvailableLock] = useState<
    { doctorId: string; date: string } | null
  >(null);
  // Pearl ERP Stage 1 §3.1 (gap row 71, 2026-05-22) — selected booking
  // channel for the current doctor. Auto-derived from `availableChannelsFor`
  // each time the doctor changes (see `onChange` on the DoctorSelect below):
  // single-channel doctors lock the picker; multi-channel doctors render a
  // segmented control and require an explicit pick. Empty string until the
  // first doctor is chosen.
  const [selectedChannel, setSelectedChannel] = useState<AppointmentChannel | "">("");
  const [selectedDate, setSelectedDate] = useState(toISODate(new Date()));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [filterDate, setFilterDate] = useState(toISODate(new Date()));
  const [patientTab, setPatientTab] = useState<PatientTab>("upcoming");
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  // Pearl §3.1 (gap closed 2026-05-29) — cancel requires a reason
  // (server-enforced via Zod, 3-500 chars).
  const [cancelReason, setCancelReason] = useState("");
  // No-show capture — NO_SHOW requires a reason server-side (Zod, 3-500 chars),
  // so marking a not-arrived patient opens a small reason dialog like Cancel.
  const [noShowId, setNoShowId] = useState<string | null>(null);
  const [noShowReason, setNoShowReason] = useState("");
  // Restore a CANCELLED appointment back to BOOKED — captured reason is mirrored
  // into the Remarks thread (no dedicated column for a "restore" reason).
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restoreReason, setRestoreReason] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  // Some status chips are hidden for non-today dates (no pending on a past day;
  // no checked-in/in-consult on a future day). If the active filter becomes
  // hidden after the user changes date, fall back to "ALL" so the list isn't
  // left showing an empty, no-longer-selectable filter.
  useEffect(() => {
    if (hiddenStatusesFor(filterDate).has(statusFilter)) {
      setStatusFilter("ALL");
    }
  }, [filterDate, statusFilter]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // Recurring booking options
  const [isRecurring, setIsRecurring] = useState(false);
  const [recFrequency, setRecFrequency] = useState<"DAILY" | "WEEKLY" | "MONTHLY">("WEEKLY");
  const [recOccurrences, setRecOccurrences] = useState(4);

  const [patientIdInput, setPatientIdInput] = useState("");
  // Display name of the patient most recently picked via the in-form
  // EntityPicker — used to render the Confirm Appointment dialog preview
  // for staff (Doctor/Admin/Reception/Nurse) flows. The picker's onChange
  // emits both the id and the full entity, so we capture the name here.
  const [pickedPatientName, setPickedPatientName] = useState("");
  // Reset counter for the EntityPicker `key` — EntityPicker holds its
  // own `chosenLabel` state and only clears it via an effect on `value`.
  // Bumped after a successful booking or when Cancel clears the picker
  // so the chip/query state doesn't survive into the next booking.
  const [pickerResetKey, setPickerResetKey] = useState(0);
  // Inline error flag for the staff Patient picker — turns the label,
  // picker border, and helper text red when a slot is clicked without
  // a patient picked. Cleared as soon as the user picks one.
  const [patientFieldError, setPatientFieldError] = useState(false);
  const [bookingInFlight, setBookingInFlight] = useState(false);

  // Patient self-booking: when the logged-in user is a PATIENT we resolve
  // their own patientId via /auth/me once and skip the patient-search modal
  // — clicking a slot opens a Confirm Appointment dialog that previews the
  // doctor / date / time / their own name instead.
  const [mePatient, setMePatient] = useState<{ id: string; name: string } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    slotStartTime: string;
    slotEndTime: string;
  }>({ open: false, slotStartTime: "", slotEndTime: "" });
  // For a TOKEN-mode doctor, the exact token (e.g. "R5") is minted server-side
  // from the doctor's prefix/start/limit; preview it in the Confirm dialog via
  // GET /appointments/next-token.
  const [tokenPreview, setTokenPreview] = useState<{
    label: string | null;
    limitReached: boolean;
  } | null>(null);

  // Reschedule modal
  const [reschedTarget, setReschedTarget] = useState<Appointment | null>(null);
  const [reschedDate, setReschedDate] = useState(toISODate(new Date()));
  const [reschedSlots, setReschedSlots] = useState<Slot[]>([]);
  const [reschedLoading, setReschedLoading] = useState(false);
  // Pearl §3.1 (gap closed 2026-05-29) — reschedule now requires a
  // reason (Zod-enforced server side, 3-500 chars). Captured here so
  // the slot-click handler can send it inline with date+slotStart.
  const [reschedReason, setReschedReason] = useState("");
  // TOKEN-mode doctors have no slot grid in the reschedule modal — instead we
  // preview the next sequential token the target date would assign (and the
  // daily-limit state) via /appointments/next-token. null = not a token row.
  const [reschedToken, setReschedToken] = useState<{
    label: string | null;
    limitReached: boolean;
  } | null>(null);
  // The target doctor's booking mode for the reschedule (SLOT / TOKEN /
  // CALLING). Only SLOT shows the timed slot grid; TOKEN and CALLING reschedule
  // without a time — the patient simply joins the target day's queue/token
  // order. null until the next-token preview resolves.
  const [reschedMode, setReschedMode] = useState<string | null>(null);

  // Pearl §2.1.7 — remarks modal target (single appointment).
  const [remarksTarget, setRemarksTarget] = useState<Appointment | null>(null);
  // Per-user "seen" remark counts so the Remarks badge behaves as an UNREAD
  // indicator: it shows only the number of remarks added since this user last
  // opened the thread, and disappears once they've viewed them. Persisted to
  // localStorage (keyed by user id) so it survives reloads; falls back to an
  // empty map when storage is unavailable.
  const [seenRemarks, setSeenRemarks] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!user?.id) return;
    try {
      const raw = localStorage.getItem(`medcore:remark-seen:${user.id}`);
      setSeenRemarks(raw ? JSON.parse(raw) : {});
    } catch {
      setSeenRemarks({});
    }
  }, [user?.id]);
  const markRemarksSeen = useCallback(
    (appointmentId: string, count: number) => {
      if (!user?.id) return;
      setSeenRemarks((prev) => {
        if (prev[appointmentId] === count) return prev;
        const next = { ...prev, [appointmentId]: count };
        try {
          localStorage.setItem(
            `medcore:remark-seen:${user.id}`,
            JSON.stringify(next)
          );
        } catch {
          /* storage full / unavailable — badge just won't persist */
        }
        return next;
      });
    },
    [user?.id]
  );
  // After the remarks modal closes we reload the list; once the refreshed row
  // (with its new remark count) lands, mark that appointment fully seen so any
  // remark the user just added/read in the modal clears the badge too.
  const pendingSeenAppointmentId = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingSeenAppointmentId.current;
    if (!id) return;
    const appt = appointments.find((a) => a.id === id);
    if (appt) {
      markRemarksSeen(id, appt._count?.remarks ?? 0);
      pendingSeenAppointmentId.current = null;
    }
  }, [appointments, markRemarksSeen]);

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
      // Super-admin only: narrow the cross-tenant list to one tenant.
      const tq =
        isSuperAdmin && selectedTenantId
          ? `&tenantId=${encodeURIComponent(selectedTenantId)}`
          : "";
      const endpoint = isPatient
        ? `/appointments?limit=200${tq}`
        : `/appointments?date=${filterDate}&limit=100${tq}`;
      const res = await api.get<{ data: Appointment[] }>(endpoint);
      setAppointments(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }, [isPatient, filterDate, isSuperAdmin, selectedTenantId]);

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
      // Super-admin only: narrow the cross-tenant calendar to one tenant.
      if (isSuperAdmin && selectedTenantId) qs.set("tenantId", selectedTenantId);
      const res = await api.get<{ data: CalendarEvent[] }>(
        `/appointments/calendar?${qs.toString()}`
      );
      setCalEvents(res.data);
    } catch {
      setCalEvents([]);
    }
    setCalLoading(false);
  }, [calWeekStart, calDoctor, isSuperAdmin, selectedTenantId]);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("from", statsFrom);
      qs.set("to", statsTo);
      if (statsDoctor) qs.set("doctorId", statsDoctor);
      // Super-admin only: narrow the cross-tenant stats + calendar to one tenant.
      if (isSuperAdmin && selectedTenantId) qs.set("tenantId", selectedTenantId);
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
  }, [statsFrom, statsTo, statsDoctor, isSuperAdmin, selectedTenantId]);

  // ─── Effects ──────────────────────

  useEffect(() => {
    loadDoctors();
  }, [loadDoctors]);

  // Load the tenant list for the super-admin filter dropdown (GET /tenants is
  // super-admin-only, so we only call it for super-admins; others 403 silently).
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{
          data: Array<{ id: string; name: string; subdomain: string }>;
        }>("/tenants");
        if (!cancelled) setTenants(res.data || []);
      } catch {
        // non-super-admin / endpoint unavailable — leave the list empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin]);

  // Pearl §3.3 row 7 — prefill from `?patientId=...&doctorId=...` so a
  // lead-convert flow (or any other deep-link) lands here with the
  // patient + doctor already chosen. Runs once per unique query-param
  // pair so a later manual edit by the user isn't clobbered on each
  // re-render. doctorId is only applied once the `doctors` list has
  // loaded so we can verify the doctor is real before populating —
  // otherwise the DoctorSelect would clear our preselect.
  const prefillAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    const patientIdParam = searchParams?.get("patientId");
    const doctorIdParam = searchParams?.get("doctorId");
    if (!patientIdParam && !doctorIdParam) return;
    const sig = `${patientIdParam ?? ""}|${doctorIdParam ?? ""}`;
    if (prefillAppliedRef.current === sig) return;
    if (isPatient) return; // staff-only flow
    if (patientIdParam) {
      setPatientIdInput(patientIdParam);
    }
    if (doctorIdParam) {
      // Defer doctor preselect until the doctors list is available
      // (DoctorSelect ignores ids that don't match a row).
      if (doctors.length === 0) return;
      const match = doctors.find((d) => d.id === doctorIdParam);
      if (match) {
        setSelectedDoctor(doctorIdParam);
      }
    }
    prefillAppliedRef.current = sig;
  }, [searchParams, doctors, isPatient]);

  // DOCTOR self-select: a logged-in doctor books only for themselves, so once
  // the doctor list loads, lock the booking form to their own record (matched
  // by the shared User name) and derive its channel. No-op for other roles or
  // if no match (then the full dropdown stays — safe fallback).
  useEffect(() => {
    if (!isDoctor || selectedDoctor || doctors.length === 0) return;
    const mine = doctors.find((d) => d.user?.name === user?.name);
    if (!mine) return;
    setSelectedDoctor(mine.id);
    setSelectedChannel(availableChannelsFor(mine)[0]);
    loadSlots(mine.id, selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDoctor, doctors, user?.name]);

  // Preview the next token (e.g. "R-5") + daily-limit status for a TOKEN-mode
  // doctor — fetched from the doctor's DB token settings. Runs whenever the
  // token booking block is shown OR the Confirm dialog is open, so the
  // "Book (assign token)" button can disable itself when the cap is reached.
  useEffect(() => {
    const dId = nextAvailableLock?.doctorId ?? selectedDoctor;
    const date = nextAvailableLock?.date ?? selectedDate;
    const d = doctors.find((x) => x.id === dId);
    const isTokenDoctor = d?.appointmentMode === "TOKEN";
    const shouldFetch =
      isTokenDoctor &&
      !!dId &&
      !!date &&
      (confirmDialog.open || selectedChannel === "TOKEN");
    if (!shouldFetch) {
      setTokenPreview(null);
      return;
    }
    let cancelled = false;
    api
      .get<{ data: { tokenLabel: string | null; limitReached: boolean } }>(
        `/appointments/next-token?doctorId=${encodeURIComponent(dId)}&date=${encodeURIComponent(date)}`,
      )
      .then((r) => {
        if (cancelled) return;
        setTokenPreview({
          label: r.data?.tokenLabel ?? null,
          limitReached: !!r.data?.limitReached,
        });
      })
      .catch(() => {
        if (!cancelled) setTokenPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    confirmDialog.open,
    selectedChannel,
    selectedDoctor,
    selectedDate,
    nextAvailableLock,
    doctors,
  ]);

  useEffect(() => {
    if (!isPatient) return;
    let cancelled = false;
    (async () => {
      try {
        const me = await api.get<{
          data: { name: string; patient?: { id: string } | null };
        }>("/auth/me");
        if (cancelled) return;
        if (me.data?.patient?.id) {
          setMePatient({ id: me.data.patient.id, name: me.data.name });
        }
      } catch {
        // /auth/me failing here is non-fatal — the existing search modal
        // remains as a fallback if mePatient never resolves.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPatient]);

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

  // Issue #554: deep-link /dashboard/appointments?id=<uuid> from the
  // dashboard "View Details" tile and notification emails. Used to be
  // silently ignored — the list rendered as if no id were supplied. Force
  // list view, scroll the matching row into view, and apply a temporary
  // highlight pulse so the user sees which appointment they were sent to.
  // Highlight clears after 3s on its own. Re-runs whenever the row arrives
  // in the loaded page (idempotent — exact match by id).
  const [highlightedAptId, setHighlightedAptId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (!id) return;
    const exists = appointments.some((apt) => apt.id === id);
    if (!exists) return;
    setView("list");
    setHighlightedAptId(id);
    // Defer scroll until after render — the row may not exist in the DOM
    // yet on the same tick we set view.
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-apt-row="${id}"]`);
      if (el && "scrollIntoView" in el) {
        (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 50);
    const clear = setTimeout(() => setHighlightedAptId(null), 3000);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [appointments]);

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
      // Ignore double-click bursts on the confirm dialog.
      if (confirmDialog.open) return;

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
      // Patient self-booking: surface a Confirm Appointment dialog with a
      // preview of the doctor / date / time / their own name. No patient
      // search needed — they can only book for themselves.
      if (isPatient) {
        if (!mePatient) {
          toast.error("Please complete your patient profile before booking");
          return;
        }
        const slot = slots.find((s) => s.startTime === slotStartTime);
        setConfirmDialog({
          open: true,
          slotStartTime,
          slotEndTime: slot?.endTime ?? "",
        });
        return;
      }
      // Staff flow: patient MUST be pre-picked via the in-form picker.
      // No fallback popup — flag the Patient field in red so the user
      // sees inline where the missing input is. Cleared on next pick.
      if (patientIdInput.trim().length === 0) {
        setPatientFieldError(true);
        return;
      }
      const slot = slots.find((s) => s.startTime === slotStartTime);
      setConfirmDialog({
        open: true,
        slotStartTime,
        slotEndTime: slot?.endTime ?? "",
      });
    },
    [
      confirmDialog.open,
      selectedDate,
      selectedDoctor,
      t,
      patientIdInput,
      isPatient,
      mePatient,
      slots,
    ]
  );

  async function confirmPatientIdAndBook(
    slotOverride?: string,
    patientIdOverride?: string
  ) {
    const patientId = (patientIdOverride ?? patientIdInput).trim();
    if (!patientId) {
      toast.error("Patient ID is required to book an appointment");
      return;
    }
    const slotStartTime = slotOverride ?? confirmDialog.slotStartTime;
    // Issue #950 — if the booking flow was entered via the "Next
    // Available" suggestion, ALWAYS prefer the doctorId + date the
    // suggestion advertised over the form-state pair. Form state can
    // legitimately drift between the dialog being shown and the user
    // clicking Confirm (DoctorSelect re-renders, channel auto-derivation
    // setting `selectedChannel` which re-runs the slot effect, date
    // input edits), and we MUST NOT silently book against a different
    // doctor than the one the user just agreed to in the suggestion
    // confirm prompt.
    const bookDoctorId = nextAvailableLock?.doctorId ?? selectedDoctor;
    const bookDate = nextAvailableLock?.date ?? selectedDate;
    // Pearl ERP Stage 1 §2.1.2 — only SLOT-mode requires a slot time.
    // CALLING (arrival queue) and TOKEN (sequential token — slot optional)
    // both book with no slotStartTime via their own "Book" buttons.
    const doctorMode =
      doctors.find((d) => d.id === bookDoctorId)?.appointmentMode ?? "TOKEN";
    if (doctorMode === "SLOT" && !slotStartTime) {
      toast.error("Please pick a slot before booking");
      return;
    }
    setBookingInFlight(true);
    try {
      if (isRecurring) {
        await api.post("/appointments/recurring", {
          patientId,
          doctorId: bookDoctorId,
          startDate: bookDate,
          slotStart: slotStartTime,
          frequency: recFrequency,
          occurrences: recOccurrences,
        });
        toast.success(`Created ${recOccurrences} recurring appointments.`);
      } else {
        const body: Record<string, unknown> = {
          patientId,
          doctorId: bookDoctorId,
          date: bookDate,
        };
        // Omit slotId for CALLING-mode bookings; the API mints arrivalSeq.
        if (doctorMode !== "CALLING" && slotStartTime) {
          body.slotId = slotStartTime;
        }
        await api.post("/appointments/book", body);
        toast.success("Appointment booked!");
      }
      setConfirmDialog({ open: false, slotStartTime: "", slotEndTime: "" });
      setNextAvailableLock(null);
      setPatientIdInput("");
      setPickedPatientName("");
      setPickerResetKey((k) => k + 1);
      setPatientFieldError(false);
      setShowBooking(false);
      setIsRecurring(false);
      setFilterDate(bookDate);
      loadAppointments();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Booking failed");
    } finally {
      setBookingInFlight(false);
    }
  }

  async function updateStatus(appointmentId: string, status: string) {
    try {
      const res = await api.patch<{ data: { status?: string } | null }>(
        `/appointments/${appointmentId}/status`,
        { status }
      );
      // Update just this row's status from the API response so the rest of the
      // table doesn't reload/flicker (Check In / Undo Check-in / Complete).
      const newStatus = res?.data?.status ?? status;
      setAppointments((prev) =>
        prev.map((a) => (a.id === appointmentId ? { ...a, status: newStatus } : a))
      );
      if (view === "calendar") loadCalendar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    }
  }

  function handleCancelClick(appointmentId: string) {
    setCancellingId(appointmentId);
  }

  // ─── Secondary status actions (⋮ overflow menu) ───────────────────────
  // Primary actions (Remarks / Reschedule / Calendar Invite / Cancel / Check
  // In / Start Consult) stay inline; the less-frequent lifecycle actions move
  // into a per-row kebab menu so the Actions column stays a constant width and
  // doesn't shift the rest of the table when buttons appear/disappear.
  const [statusMenu, setStatusMenu] = useState<{
    id: string;
    top: number;
    left: number;
  } | null>(null);

  type RowStatusAction = {
    key: string;
    label: string;
    ariaLabel: string;
    onClick: () => void;
    tone: "default" | "primary" | "success" | "warn";
  };
  function buildStatusActions(apt: Appointment): RowStatusAction[] {
    const actions: RowStatusAction[] = [];
    // Gate on the EFFECTIVE (displayed) status, not the raw one — a row that
    // renders as NO_SHOW must offer the no-show actions, not the
    // BOOKED/CHECKED_IN ones.
    const effStatus = displayStatusForAppointment({
      status: apt.status,
      slotStart: apt.slotStart,
      date: apt.date,
    });
    // A past appointment is terminal — you can't un-miss it (rebook instead) —
    // so it offers nothing ("No actions available").
    if (isAppointmentPast({ slotStart: apt.slotStart, date: apt.date })) {
      return actions;
    }
    // A FUTURE (upcoming) appointment hasn't happened yet, so the day-of
    // reversal/undo actions don't apply. The only sensible status actions are
    // to cancel the booking or flag it as a no-show ahead of time. (Doctors /
    // nurses don't get the inline Cancel button, so it's exposed here.)
    if (!isAppointmentToday({ date: apt.date })) {
      if (!isPatient && effStatus === "BOOKED") {
        actions.push({
          key: "noshow",
          label: "Mark No-show",
          ariaLabel: `Mark no-show for ${apt.patient.user.name}`,
          onClick: () => setNoShowId(apt.id),
          tone: "warn",
        });
        actions.push({
          key: "cancel",
          label: "Cancel",
          ariaLabel: `Cancel appointment for ${apt.patient.user.name}`,
          onClick: () => handleCancelClick(apt.id),
          tone: "warn",
        });
      }
      return actions;
    }
    // Mark no-show — patient hasn't checked in (still BOOKED); any staff can
    // flag them as a no-show. Opens a reason dialog (server requires a reason).
    if (!isPatient && effStatus === "BOOKED") {
      actions.push({
        key: "noshow",
        label: "Mark No-show",
        ariaLabel: `Mark no-show for ${apt.patient.user.name}`,
        onClick: () => setNoShowId(apt.id),
        tone: "warn",
      });
      // Cancel lives in the ⋮ menu for staff (no separate inline button).
      actions.push({
        key: "cancel",
        label: "Cancel",
        ariaLabel: `Cancel appointment for ${apt.patient.user.name}`,
        onClick: () => handleCancelClick(apt.id),
        tone: "warn",
      });
    }
    // Undo no-show — patient was marked NO_SHOW but actually arrived (or it was
    // a mistake); any staff can put the row back to BOOKED so it can proceed.
    if (!isPatient && effStatus === "NO_SHOW") {
      actions.push({
        key: "undo-noshow",
        label: "Mark as Booked",
        ariaLabel: `Undo no-show for ${apt.patient.user.name}`,
        onClick: () => updateStatus(apt.id, "BOOKED"),
        tone: "warn",
      });
    }
    // Restore a CANCELLED appointment back to BOOKED, with a reason (mirrored
    // into Remarks). Opens a reason dialog like Cancel / No-show.
    if (!isPatient && effStatus === "CANCELLED") {
      actions.push({
        key: "restore",
        label: "Mark as Booked",
        ariaLabel: `Restore to booked for ${apt.patient.user.name}`,
        onClick: () => setRestoreId(apt.id),
        tone: "warn",
      });
    }
    // Undo check-in — any staff, CHECKED_IN.
    if (!isPatient && effStatus === "CHECKED_IN") {
      actions.push({
        key: "undo",
        label: "Undo Check-in",
        ariaLabel: `Undo check-in for ${apt.patient.user.name}`,
        onClick: () => updateStatus(apt.id, "BOOKED"),
        tone: "warn",
      });
    }
    // Undo consult — consult was started by mistake; revert IN_CONSULTATION
    // back to CHECKED_IN. Only while the encounter is still unsigned.
    if (
      !isPatient &&
      effStatus === "IN_CONSULTATION" &&
      apt.consultation?.status !== "SIGNED"
    ) {
      actions.push({
        key: "undo-consult",
        label: "Undo Consult",
        ariaLabel: `Undo consultation start for ${apt.patient.user.name}`,
        onClick: () => updateStatus(apt.id, "CHECKED_IN"),
        tone: "warn",
      });
    }
    return actions;
  }

  async function confirmCancel() {
    if (!cancellingId) return;
    const reason = cancelReason.trim();
    if (reason.length < 3) {
      toast.error("Please enter a cancellation reason (min 3 characters).");
      return;
    }
    try {
      await api.patch(`/appointments/${cancellingId}/status`, {
        status: "CANCELLED",
        cancellationReason: reason,
      });
      setCancellingId(null);
      setCancelReason("");
      loadAppointments();
      if (view === "calendar") loadCalendar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  async function confirmNoShow() {
    if (!noShowId) return;
    const reason = noShowReason.trim();
    if (reason.length < 3) {
      toast.error("Please enter a no-show reason (min 3 characters).");
      return;
    }
    try {
      await api.patch(`/appointments/${noShowId}/status`, {
        status: "NO_SHOW",
        noShowReason: reason,
      });
      // Update just this row (no full reload), consistent with the other
      // status actions. Also bump the remark count so the Remarks badge
      // reflects the no-show reason that was just mirrored into the thread.
      setAppointments((prev) =>
        prev.map((a) =>
          a.id === noShowId
            ? {
                ...a,
                status: "NO_SHOW",
                _count: { remarks: (a._count?.remarks ?? 0) + 1 },
              }
            : a
        )
      );
      setNoShowId(null);
      setNoShowReason("");
      if (view === "calendar") loadCalendar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Mark no-show failed");
    }
  }

  async function confirmRestore() {
    if (!restoreId) return;
    const reason = restoreReason.trim();
    if (reason.length < 3) {
      toast.error("Please enter a reason (min 3 characters).");
      return;
    }
    try {
      await api.patch(`/appointments/${restoreId}/status`, { status: "BOOKED" });
      // Mirror the restore reason into Remarks (best-effort) — there's no
      // dedicated column for it, the Remarks thread is the record.
      try {
        await api.post(`/appointments/${restoreId}/remarks`, {
          body: `Restored to booked: ${reason}`,
          visibility: "ALL_STAFF",
          parentRemarkId: null,
        });
      } catch {
        /* remark is best-effort; the status change already succeeded */
      }
      setAppointments((prev) =>
        prev.map((a) =>
          a.id === restoreId
            ? {
                ...a,
                status: "BOOKED",
                _count: { remarks: (a._count?.remarks ?? 0) + 1 },
              }
            : a
        )
      );
      setRestoreId(null);
      setRestoreReason("");
      if (view === "calendar") loadCalendar();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restore failed");
    }
  }

  function openReschedule(apt: Appointment) {
    setReschedTarget(apt);
    // Open on the appointment's own current date so the same-date guard kicks
    // in immediately (Reschedule disabled + "pick another date") — the user
    // must actively choose a different day before they can confirm.
    const current = apt.date.slice(0, 10);
    setReschedDate(current);
    loadReschedSlots(apt, current);
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
      // Ask the server what the target date would assign. TOKEN doctors have
      // no slots — we render the would-be token instead of a slot grid.
      let preview: {
        mode: string;
        tokenLabel: string | null;
        limitReached: boolean;
      } | null = null;
      try {
        const tk = await api.get<{
          data: { mode: string; tokenLabel: string | null; limitReached: boolean };
        }>(`/appointments/next-token?doctorId=${doctorId}&date=${date}`);
        preview = tk.data;
      } catch {
        preview = null;
      }
      setReschedMode(preview?.mode ?? null);
      if (preview?.mode === "TOKEN") {
        // TOKEN: preview the next sequential token; no slot grid.
        setReschedToken({
          label: preview.tokenLabel,
          limitReached: preview.limitReached,
        });
        setReschedSlots([]);
      } else if (preview?.mode === "SLOT") {
        // SLOT: timed slot grid is the only mode that needs a time pick.
        setReschedToken(null);
        const res = await api.get<{ data: { slots: Slot[] } }>(
          `/doctors/${doctorId}/slots?date=${date}`
        );
        setReschedSlots(res.data.slots);
      } else {
        // CALLING (arrival-order queue): no slot time, no token number — the
        // appointment just moves to the target day's queue (FIFO: the first
        // patient rescheduled lands at the front).
        setReschedToken(null);
        setReschedSlots([]);
      }
    } catch {
      setReschedSlots([]);
      setReschedToken(null);
      setReschedMode(null);
    }
    setReschedLoading(false);
  }

  async function confirmReschedule(slotStart?: string) {
    if (!reschedTarget) return;
    // Pearl §3.1 — reason is required server-side (3-500 chars). Block
    // the request locally so the user gets a clearer message than the
    // server's generic 400.
    const reason = reschedReason.trim();
    if (reason.length < 3) {
      toast.error("Please enter a reason for rescheduling (min 3 characters).");
      return;
    }
    try {
      // TOKEN reschedules send no slotStart — the server mints the next
      // sequential token for the target date. SLOT reschedules carry the
      // chosen HH:MM start.
      const body: { date: string; reason: string; slotStart?: string } = {
        date: reschedDate,
        reason,
      };
      if (slotStart) body.slotStart = slotStart;
      await api.patch(`/appointments/${reschedTarget.id}/reschedule`, body);
      toast.success("Appointment rescheduled.");
      setReschedTarget(null);
      setReschedSlots([]);
      setReschedToken(null);
      setReschedMode(null);
      setReschedReason("");
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

  // The appointment's OWN current date is not a valid reschedule target — you
  // can't move it to the day it's already on. Used to block the TOKEN
  // Reschedule action and prompt the user to pick a different date. (SLOT
  // doctors are unaffected: moving to a different slot on the same day is a
  // legitimate reschedule.)
  const reschedSameDate =
    !!reschedTarget && reschedDate === reschedTarget.date.slice(0, 10);

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
      // Filter on the EFFECTIVE (displayed) status so the chips agree with the
      // STATUS pill: a past booked row that renders as NO_SHOW belongs under
      // the NO SHOW chip, not BOOKED.
      list = list.filter(
        (a) =>
          displayStatusForAppointment({
            status: a.status,
            slotStart: a.slotStart,
            date: a.date,
          }) === statusFilter
      );
    }
    return list;
  }, [appointments, isPatient, patientTab, statusFilter]);

  // List-view pagination over the filtered set.
  const totalPages = Math.max(1, Math.ceil(filteredAppointments.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedAppointments = filteredAppointments.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  useEffect(() => {
    setPage(1);
  }, [statusFilter, patientTab, filterDate, filteredAppointments.length]);

  // ─── CSV export ───────────────────

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
            endTime?: string;
          } | null;
        };
      }>("/appointments/next-available");
      if (!res.data.slot) {
        toast.info("No slots available in the next 14 days.");
        return;
      }
      const s = res.data.slot;
      // Patient gate — same contract as bookAppointment() (line 758).
      // Without it, clicking "Next Available" lets a staff user open the
      // Confirm dialog without ever picking a patient, and the dialog
      // renders Patient = "—". Patients (self-booking) are exempt — they
      // book for themselves via `mePatient`.
      //
      // UX note: don't pre-light the Patient field red here. The red is
      // reserved for actual slot-click attempts that fail the guard
      // (see bookAppointment line 758). On the Next-Available path we
      // open the booking panel CLEAN, with just a toast pointing the
      // user at the picker — the field turns red only if they then
      // click a slot / Next Available again without picking.
      if (!isPatient && patientIdInput.trim().length === 0) {
        if (!showBooking) {
          // Booking form isn't open yet — just open it so the user can pick a
          // patient. No error on this first click.
          setShowBooking(true);
          return;
        }
        // Form is already open but no patient was picked — now show a
        // meaningful prompt pointing the user at the patient picker.
        toast.error(
          t(
            "dashboard.appointments.pickPatientFirst",
            "Please pick a patient first, then try Next Available again.",
          ),
        );
        return;
      }
      if (
        !(await confirm({
          title: "Proceed to book?",
          message: `Next available: ${formatDoctorName(s.doctorName)}${
            s.specialization ? ` (${s.specialization})` : ""
          } on ${s.date} at ${s.startTime}.`,
        }))
      )
        return;
      // Issue #950 — the suggested slot's doctor MUST be the one that
      // ends up booked. Earlier this handler only called
      //   setSelectedDoctor(s.doctorId); setSelectedDate(s.date);
      //   setShowBooking(true);
      // …and relied on the user to (a) re-pick the slot from a slot grid
      // that was NEVER refreshed for the new doctor (loadSlots wasn't
      // called) and (b) trust that React had flushed `selectedDoctor`
      // before they clicked. In practice the slots panel showed the
      // PREVIOUS doctor's slots; the user clicked a stale slot; and
      // because the booking POST reads `selectedDoctor` from state, any
      // re-render that came in between (e.g. DoctorSelect's auto-channel
      // derivation, or a tab refocus) could flip the doctor — yielding
      // the user-visible "I picked Dr A but the row says Dr B" bug.
      //
      // The fix is to remove the round-trip: we book the suggested
      // (doctorId, date, slotStart) tuple DIRECTLY against the API, and
      // the form state is updated only so the post-book "current view"
      // (date filter, opened panel) stays coherent. The PATIENT/staff
      // patient-picker contract is preserved by opening the same
      // Confirm-Appointment dialog with the slot pre-filled — but the
      // dialog handler now also receives the exact doctorId + date as
      // overrides, so even if `selectedDoctor` is later mutated, the
      // booking still targets the doctor the suggestion advertised.
      setSelectedDoctor(s.doctorId);
      setSelectedDate(s.date);
      setShowBooking(true);
      // Refresh the slot grid for the new doctor so it isn't visually
      // out of sync with the dialog the user just confirmed.
      void loadSlots(s.doctorId, s.date);
      // Lock the suggested slot in for the upcoming confirmation step.
      setNextAvailableLock({ doctorId: s.doctorId, date: s.date });
      setConfirmDialog({
        open: true,
        slotStartTime: s.startTime,
        slotEndTime: s.endTime ?? "",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not find next slot");
    }
  }

  function exportCSV() {
    // Issue #558: when the current view has no rows, the previous code
    // still emitted a header-only CSV, which the browser dropped silently
    // because chromium debounces zero-row synthetic downloads. Surface
    // the empty-state explicitly so the user gets feedback.
    if (filteredAppointments.length === 0) {
      toast.info("Nothing to export — the current view is empty.");
      return;
    }
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
      // Issue #981: previously every outcome surfaced a green
      // toast.success even when 0 rows were actually processed. Marking
      // an already-CANCELLED appointment as NO_SHOW (or vice-versa) is
      // an invalid status transition the API skips silently — the
      // user saw "NO SHOW: 0 processed, 1 skipped, 0 errors" in
      // success styling with no explanation of WHY the row was
      // skipped. Pick the toast variant + copy based on the actual
      // outcome so the user can tell whether the action worked.
      const actionLabel = action.replace(/_/g, " ").toLowerCase();
      if (d.errors > 0) {
        toast.error(
          `Could not ${actionLabel} ${d.errors} appointment(s). ` +
            `${d.processed} updated, ${d.skipped} skipped.`,
        );
      } else if (d.processed === 0 && d.skipped > 0) {
        // The most common path that surfaced #981: the selected rows
        // were in a status the action cannot apply to. The bulk-action
        // API does not yet report per-row reasons, so the copy is
        // intentionally general but DOES point the user at the most
        // likely cause (current status). When the API surfaces a
        // `skippedReasons` payload we can enrich this further.
        toast.warning(
          `No appointments were ${actionLabel === "mark as no-show" ? "marked as no-show" : actionLabel + "ed"}. ` +
            `${d.skipped} skipped — likely already in a status that does not allow this action ` +
            `(e.g. an already-CANCELLED appointment cannot be marked as NO SHOW).`,
        );
      } else if (d.skipped > 0) {
        toast.info(
          `${actionLabel.charAt(0).toUpperCase() + actionLabel.slice(1)}: ` +
            `${d.processed} updated, ${d.skipped} skipped (already in a status that does not allow this action).`,
        );
      } else {
        toast.success(
          `${actionLabel.charAt(0).toUpperCase() + actionLabel.slice(1)}: ${d.processed} appointment(s) updated.`,
        );
      }
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

  // Issue #254: 08–20 was too narrow — clinics with early-morning OPDs or
  // late evening telemed slots had appointments hidden off the grid. Show
  // 06:00–22:00 instead; rows outside typical hours stay empty visually.
  const calHours = useMemo(
    () => Array.from({ length: 17 }, (_, i) => 6 + i), // 06:00..22:00
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
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <h3 className="text-lg font-semibold text-gray-800">
              {t("dashboard.actions.cancelAppointment")}
            </h3>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
              {t("dashboard.appointments.cancelConfirm")}
            </p>
            {/* Pearl §3.1 — cancellation reason (required, 3-500 chars). */}
            <div className="mt-4">
              <label
                htmlFor="cancel-reason"
                className="mb-1 block text-sm font-medium"
              >
                Reason <span className="text-red-600">*</span>
              </label>
              <textarea
                id="cancel-reason"
                data-testid="cancel-reason"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="e.g. Patient requested; double-booking; doctor unavailable"
                className="w-full rounded-lg border px-3 py-2 text-sm dark:bg-gray-900 dark:text-gray-100"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {cancelReason.trim().length} / 500 characters
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => {
                  setCancellingId(null);
                  setCancelReason("");
                }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                {t("dashboard.actions.keepAppointment")}
              </button>
              <button
                onClick={confirmCancel}
                disabled={cancelReason.trim().length < 3}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("dashboard.actions.confirmCancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* No-show confirmation dialog — mirrors Cancel; NO_SHOW needs a reason. */}
      {noShowId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <h3 className="text-lg font-semibold text-gray-800">
              Mark as No-show
            </h3>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
              The patient did not check in. Mark this appointment as a no-show?
            </p>
            <div className="mt-4">
              <label
                htmlFor="noshow-reason"
                className="mb-1 block text-sm font-medium"
              >
                Reason <span className="text-red-600">*</span>
              </label>
              <textarea
                id="noshow-reason"
                data-testid="noshow-reason"
                value={noShowReason}
                onChange={(e) => setNoShowReason(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="e.g. Patient did not arrive; no response to call"
                className="w-full rounded-lg border px-3 py-2 text-sm dark:bg-gray-900 dark:text-gray-100"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {noShowReason.trim().length} / 500 characters
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => {
                  setNoShowId(null);
                  setNoShowReason("");
                }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Keep Booked
              </button>
              <button
                onClick={confirmNoShow}
                disabled={noShowReason.trim().length < 3}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Mark No-show
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restore-to-booked dialog — revert a CANCELLED appointment with a
          reason (mirrored into Remarks). */}
      {restoreId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <h3 className="text-lg font-semibold text-gray-800">
              Restore to Booked
            </h3>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
              Re-activate this cancelled appointment and put it back to booked?
            </p>
            <div className="mt-4">
              <label
                htmlFor="restore-reason"
                className="mb-1 block text-sm font-medium"
              >
                Reason <span className="text-red-600">*</span>
              </label>
              <textarea
                id="restore-reason"
                data-testid="restore-reason"
                value={restoreReason}
                onChange={(e) => setRestoreReason(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="e.g. Cancelled by mistake; patient still wants this appointment"
                className="w-full rounded-lg border px-3 py-2 text-sm dark:bg-gray-900 dark:text-gray-100"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {restoreReason.trim().length} / 500 characters
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => {
                  setRestoreId(null);
                  setRestoreReason("");
                }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Keep Cancelled
              </button>
              <button
                onClick={confirmRestore}
                disabled={restoreReason.trim().length < 3}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Restore to Booked
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Appointment dialog — used by both patient self-booking
          AND staff pre-picked-patient flow. Previews doctor / date / time /
          patient name before posting to /book. */}
      {confirmDialog.open && (() => {
        const dialogPatientId = isPatient
          ? mePatient?.id ?? ""
          : patientIdInput.trim();
        const dialogPatientName = isPatient
          ? mePatient?.name ?? ""
          : pickedPatientName;
        // Issue #950 — when the dialog was opened from "Next Available"
        // the doctor shown MUST be the locked suggestion, not whatever
        // the form's selectedDoctor happens to be by now.
        const displayDoctorId = nextAvailableLock?.doctorId ?? selectedDoctor;
        const doctor = doctors.find((x) => x.id === displayDoctorId);
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-appointment-title"
            data-testid="confirm-appointment-dialog"
          >
            <div className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
              <h3
                id="confirm-appointment-title"
                className="text-lg font-semibold text-gray-800 dark:text-gray-100"
              >
                Confirm Appointment
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Please review the details below before confirming.
              </p>
              <dl className="mt-4 space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-700 dark:bg-gray-900">
                <div className="flex justify-between gap-4">
                  <dt className="font-medium text-gray-500 dark:text-gray-400">Patient</dt>
                  <dd
                    className="text-right text-gray-900 dark:text-gray-100"
                    data-testid="confirm-appointment-patient"
                  >
                    {dialogPatientName || "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="font-medium text-gray-500 dark:text-gray-400">Doctor</dt>
                  <dd
                    className="text-right text-gray-900 dark:text-gray-100"
                    data-testid="confirm-appointment-doctor"
                  >
                    {doctor
                      ? `${formatDoctorName(doctor.user.name)} — ${doctor.specialization}`
                      : "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="font-medium text-gray-500 dark:text-gray-400">Date</dt>
                  <dd
                    className="text-right text-gray-900 dark:text-gray-100"
                    data-testid="confirm-appointment-date"
                  >
                    {nextAvailableLock?.date ?? selectedDate}
                  </dd>
                </div>
                {doctor?.appointmentMode === "TOKEN" ? (
                  <div className="flex justify-between gap-4">
                    {/* TOKEN mode has no slot time — a sequential token is
                        minted server-side on confirm, so show "Token" here
                        instead of an empty "Time". */}
                    <dt className="font-medium text-gray-500 dark:text-gray-400">
                      Token
                    </dt>
                    <dd
                      className="text-right text-gray-900 dark:text-gray-100"
                      data-testid="confirm-appointment-token"
                    >
                      {tokenPreview?.limitReached
                        ? "Daily limit reached"
                        : tokenPreview?.label
                          ? tokenPreview.label
                          : doctor?.tokenPrefix
                            ? `Auto-assigned (${doctor.tokenPrefix} series)`
                            : "Auto-assigned (sequential)"}
                    </dd>
                  </div>
                ) : doctor?.appointmentMode === "CALLING" ? null : (
                  /* CALLING mode is an arrival-order queue — no slot time and
                     no token are assigned at booking, so neither row is shown.
                     SLOT (and the no-doctor fallback) keep the Time row. */
                  <div className="flex justify-between gap-4">
                    <dt className="font-medium text-gray-500 dark:text-gray-400">
                      Time
                    </dt>
                    <dd
                      className="text-right text-gray-900 dark:text-gray-100"
                      data-testid="confirm-appointment-time"
                    >
                      {confirmDialog.slotEndTime
                        ? `${confirmDialog.slotStartTime} – ${confirmDialog.slotEndTime}`
                        : confirmDialog.slotStartTime}
                    </dd>
                  </div>
                )}
              </dl>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    // Close the confirm dialog. The in-form Patient picker
                    // (for staff) keeps its current selection so the user
                    // can click a different slot without re-picking. To
                    // change the patient, use the "Change" button on the
                    // in-form picker itself.
                    setConfirmDialog({ open: false, slotStartTime: "", slotEndTime: "" });
                    // Issue #950 — drop the suggestion lock so a follow-up
                    // manual slot click books against form state, not the
                    // stale "Next Available" suggestion.
                    setNextAvailableLock(null);
                  }}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-700"
                  data-testid="confirm-appointment-cancel"
                  disabled={bookingInFlight}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void confirmPatientIdAndBook(confirmDialog.slotStartTime, dialogPatientId)
                  }
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  data-testid="confirm-appointment-confirm"
                  disabled={bookingInFlight || !dialogPatientId}
                >
                  {bookingInFlight ? "Booking…" : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}


      {/* ⋮ overflow menu for a row's secondary status actions. Rendered at
          the root (fixed-positioned at the kebab button) so it isn't clipped
          by the table's overflow-x container. */}
      {statusMenu &&
        (() => {
          const apt = appointments.find((a) => a.id === statusMenu.id);
          if (!apt) return null;
          const rowActions = buildStatusActions(apt);
          const toneText: Record<RowStatusAction["tone"], string> = {
            default: "text-gray-700 dark:text-gray-200",
            primary: "text-indigo-600 dark:text-indigo-400",
            success: "text-green-700 dark:text-green-400",
            warn: "text-amber-700 dark:text-amber-400",
          };
          return (
            <>
              <div
                className="fixed inset-0 z-40"
                aria-hidden="true"
                onClick={() => setStatusMenu(null)}
              />
              <div
                className="fixed z-50 min-w-[160px] -translate-x-full overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
                style={{ top: statusMenu.top, left: statusMenu.left }}
              >
                {rowActions.length === 0 ? (
                  <span className="block px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500">
                    No actions available
                  </span>
                ) : (
                  rowActions.map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      aria-label={a.ariaLabel}
                      onClick={() => {
                        setStatusMenu(null);
                        a.onClick();
                      }}
                      className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-700 ${toneText[a.tone]}`}
                    >
                      {a.label}
                    </button>
                  ))
                )}
              </div>
            </>
          );
        })()}

      {/* Pearl §2.1.7 — Remarks modal */}
      {remarksTarget && (
        <AppointmentRemarksModal
          appointmentId={remarksTarget.id}
          patientName={remarksTarget.patient.user.name}
          onClose={() => {
            // Mark this thread as seen once the refreshed row lands (handled
            // by the pendingSeenAppointmentId effect), so the unread badge
            // clears — including any remark just added in the modal.
            pendingSeenAppointmentId.current = remarksTarget?.id ?? null;
            setRemarksTarget(null);
            // Refresh so the Remarks button's count badge reflects any
            // remark added or deleted while the modal was open.
            loadAppointments();
          }}
        />
      )}


      {/* Reschedule modal */}
      {reschedTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-h-[90vh] overflow-y-auto max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">Reschedule</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {reschedTarget.patient.user.name}
                  {reschedTarget.tokenNumber != null
                    ? ` — Token #${reschedTarget.tokenNumber}`
                    : ""}
                </p>
              </div>
              <button
                onClick={() => {
                  setReschedTarget(null);
                  setReschedSlots([]);
                  setReschedToken(null);
                  setReschedMode(null);
                  setReschedReason("");
                }}
                className="text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
                aria-label={t("common.close")}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
            <div className="mt-4">
              <label htmlFor="resched-new-date" className="mb-1 block text-sm font-medium">New Date</label>
              <input
                id="resched-new-date"
                type="date"
                value={reschedDate}
                min={todayMin}
                onChange={(e) => {
                  setReschedDate(e.target.value);
                  loadReschedSlots(reschedTarget, e.target.value);
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            {/* Pearl §3.1 — reason capture (required, 3-500 chars). */}
            <div className="mt-4">
              <label
                htmlFor="resched-reason"
                className="mb-1 block text-sm font-medium"
              >
                Reason for rescheduling <span className="text-red-600">*</span>
              </label>
              <textarea
                id="resched-reason"
                data-testid="resched-reason"
                value={reschedReason}
                onChange={(e) => setReschedReason(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="e.g. Patient requested; doctor unavailable; emergency"
                className="w-full rounded-lg border px-3 py-2 text-sm dark:bg-gray-900 dark:text-gray-100"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {reschedReason.trim().length} / 500 characters
              </p>
            </div>
            {reschedMode === "SLOT" ? (
              // SLOT-mode doctor: pick a concrete timed slot on the new date.
              <div className="mt-4">
                <p className="mb-2 text-sm font-medium">Available Slots</p>
                {reschedLoading ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
                ) : Object.keys(reschedSlotsByDate).length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">No slots available.</p>
                ) : (
                  Object.entries(reschedSlotsByDate).map(([d, list]) => (
                    <div key={d} className="mb-3">
                      <p className="mb-1 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">
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
            ) : (
              // TOKEN / CALLING doctor: no slot grid and no time pick. The
              // appointment simply moves to the target day's queue — TOKEN keeps
              // its sequential token order; CALLING joins the arrival-order
              // queue (FIFO: the first patient rescheduled lands at the front).
              <div className="mt-4">
                {reschedLoading ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
                ) : reschedSameDate ? (
                  <p
                    data-testid="resched-token-samedate"
                    className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                  >
                    This appointment is already on {formatShortDate(reschedDate)}.
                    Pick another date to reschedule.
                  </p>
                ) : reschedToken?.limitReached ? (
                  <p
                    data-testid="resched-token-limit"
                    className="rounded-lg bg-rose-100 px-3 py-2 text-sm font-medium text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
                  >
                    Daily appointment limit reached for this doctor on{" "}
                    {formatShortDate(reschedDate)} — pick another date.
                  </p>
                ) : (
                  <>
                    <p className="mb-2 text-sm text-gray-600 dark:text-gray-300">
                      {reschedMode === "CALLING" ? (
                        <>
                          This doctor uses an{" "}
                          <strong>arrival-order queue</strong>. No slot time
                          needed — the appointment moves to{" "}
                          {formatShortDate(reschedDate)} and joins that
                          day&apos;s queue in order.
                        </>
                      ) : (
                        <>
                          This doctor uses <strong>sequential token</strong>{" "}
                          booking. No slot time needed — the appointment moves to{" "}
                          {formatShortDate(reschedDate)} keeping its place in
                          that day&apos;s token order.
                        </>
                      )}
                    </p>
                    <button
                      type="button"
                      data-testid="resched-token-confirm"
                      onClick={() => confirmReschedule()}
                      className="w-full rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
                    >
                      Reschedule
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Calendar event details popup */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">
                  Token #{selectedEvent.tokenNumber}
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
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
                <p className="text-gray-500 dark:text-gray-400">Start</p>
                <p className="font-medium">
                  {formatDateTime(selectedEvent.startDateTime)}
                </p>
              </div>
              <div>
                <p className="text-gray-500 dark:text-gray-400">Status</p>
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
                <p className="text-gray-500 dark:text-gray-400">Type</p>
                <p className="font-medium">{selectedEvent.type}</p>
              </div>
              <div>
                <p className="text-gray-500 dark:text-gray-400">Priority</p>
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
          {/* Super-admin only: cross-tenant filter applied to the List /
              Stats / Calendar fetches. Hidden for tenant-bound staff. */}
          {isSuperAdmin && (
            <TenantSelect
              tenants={tenants}
              value={selectedTenantId}
              onChange={setSelectedTenantId}
              allLabel="All tenants"
              className="w-full sm:w-64"
              testId="appointments-tenant-filter"
            />
          )}
          {/* View toggle */}
          <div
            className="inline-flex overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700"
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
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
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
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                All
              </button>
              {ALL_STATUSES.filter(
                // Hide status chips that can't apply to the selected date
                // (no pending on a past day; no checked-in/in-consult on a
                // future day).
                (s) => !hiddenStatusesFor(filterDate).has(s)
              ).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    statusFilter === s
                      ? STATUS_CHIP_ACTIVE[s] ?? "bg-primary text-white"
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
              {/* Issue #344 (May 2026): the booking form previously showed
                  Doctor + Date only — the Patient picker was hidden inside
                  a post-slot-click modal, so users (and bug-bashers) saw an
                  apparent "Book appointment" CTA with no Patient field and
                  reasonably concluded the form was broken. Surface the
                  patient picker as the FIRST field in the form so the
                  required-fields contract is visible at the panel level.
                  When a patient is pre-picked here, clicking a slot books
                  immediately without re-prompting — see bookAppointment().
                  PATIENT role is excluded — they can only book for
                  themselves, so a search picker is unnecessary; the
                  Confirm Appointment dialog handles their flow. */}
              {!isPatient && (
                <div className="mb-4">
                  <label
                    htmlFor="appt-book-patient"
                    className="mb-1 block text-sm font-medium"
                  >
                    Patient *
                  </label>
                  <div
                    className={
                      patientFieldError
                        ? "rounded-lg ring-2 ring-red-500"
                        : ""
                    }
                    data-testid="appt-book-patient-error-wrap"
                    data-error={patientFieldError ? "true" : undefined}
                  >
                    <EntityPicker
                      key={`appt-book-patient-${pickerResetKey}`}
                      endpoint="/patients"
                      labelField="user.name"
                      subtitleField="user.phone"
                      hintField="mrNumber"
                      value={patientIdInput}
                      onChange={(id, entity) => {
                        setPatientIdInput(id);
                        setPickedPatientName(readPatientName(entity));
                        // Clear the inline error as soon as a patient is
                        // actually selected (id non-empty).
                        if (id) setPatientFieldError(false);
                      }}
                      searchPlaceholder="Search patient by name, phone, MR..."
                      testIdPrefix="appt-book-patient"
                    />
                  </div>
                  <p
                    className={`mt-1 text-xs ${
                      patientFieldError
                        ? "text-red-600 dark:text-red-400"
                        : "text-gray-500 dark:text-gray-400"
                    }`}
                  >
                    {patientFieldError
                      ? "Please pick a patient before choosing a slot."
                      : "Required — pick a patient before choosing a slot below."}
                  </p>
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="appt-book-doctor" className="mb-1 block text-sm font-medium">
                    {t("dashboard.appointments.doctor")}
                  </label>
                  {(() => {
                    // A logged-in DOCTOR books only for themselves: show their
                    // name as a static read-only field (no dropdown). The
                    // self-select effect already locked `selectedDoctor`.
                    // Everyone else gets the searchable dropdown. (Fallback to
                    // the dropdown if a doctor has no matching Doctor record.)
                    const myDoctor = isDoctor
                      ? doctors.find((d) => d.user?.name === user?.name)
                      : undefined;
                    if (myDoctor) {
                      return (
                        <div
                          data-testid="appt-book-doctor-self"
                          aria-label={t("dashboard.appointments.doctor")}
                          className="flex min-h-[42px] items-center rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                        >
                          {formatDoctorName(myDoctor.user.name)} —{" "}
                          {myDoctor.specialization}
                        </div>
                      );
                    }
                    return (
                      <DoctorSelect
                        doctors={doctors}
                        value={selectedDoctor}
                        placeholder={t("dashboard.appointments.selectDoctor")}
                        onChange={(id) => {
                          setSelectedDoctor(id);
                          // Issue #950 — the user is now manually choosing a
                          // doctor, so the "Next Available" suggestion lock
                          // is no longer authoritative. Drop it so the next
                          // booking uses the form-state pair.
                          setNextAvailableLock(null);
                          // Pearl §3.1 (gap row 71) — re-derive the booking
                          // channel for the newly-picked doctor.
                          if (id) {
                            const d = doctors.find((x) => x.id === id);
                            if (d) {
                              const avail = availableChannelsFor(d);
                              setSelectedChannel(avail[0]);
                            }
                            loadSlots(id, selectedDate);
                          } else {
                            setSelectedChannel("");
                          }
                        }}
                      />
                    );
                  })()}
                </div>
                <div>
                  <label htmlFor="appt-book-date" className="mb-1 block text-sm font-medium">
                    {t("dashboard.appointments.date")}
                  </label>
                  <input
                    id="appt-book-date"
                    type="date"
                    value={selectedDate}
                    min={todayMin}
                    onChange={(e) => {
                      setSelectedDate(e.target.value);
                      // Issue #950 — drop the "Next Available" lock when
                      // the user picks a different date, so the booking
                      // tracks the new form-state instead of the stale
                      // suggestion.
                      setNextAvailableLock(null);
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
                    <label htmlFor="appt-rec-frequency" className="mb-1 block text-sm font-medium">Frequency</label>
                    <select
                      id="appt-rec-frequency"
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
                    <label htmlFor="appt-rec-occurrences" className="mb-1 block text-sm font-medium">Occurrences</label>
                    <input
                      id="appt-rec-occurrences"
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
                  Pick a doctor to see booking options.
                </div>
              )}

              {/* Pearl ERP Stage 1 §3.1 (gap row 71, closed 2026-05-22) —
                  per-doctor channel picker. Only the channels semantically
                  valid for the doctor's mode AND present in the doctor's
                  enabledChannels[] allow-list (when configured) are shown.
                  Single-channel doctors: the picker auto-selects + hides;
                  multi-channel doctors: a segmented control. */}
              {selectedDoctor &&
                (() => {
                  const d = doctors.find((x) => x.id === selectedDoctor);
                  if (!d) return null;
                  const avail = availableChannelsFor(d);
                  if (avail.length <= 1) return null;
                  return (
                    <div className="mt-4" data-testid="appt-book-channel-picker">
                      <p className="mb-2 text-sm font-medium">Booking channel</p>
                      <div
                        role="radiogroup"
                        aria-label="Booking channel"
                        className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900"
                      >
                        {avail.map((ch) => (
                          <button
                            key={ch}
                            type="button"
                            role="radio"
                            aria-checked={selectedChannel === ch}
                            data-testid={`appt-book-channel-${ch.toLowerCase()}`}
                            onClick={() => setSelectedChannel(ch)}
                            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                              selectedChannel === ch
                                ? "bg-primary text-white"
                                : "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                            }`}
                          >
                            {CHANNEL_LABEL[ch]}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}

              {/* Pearl §3.1 (gap row 71) — WALKIN channel: same shape as
                  CALLING (no slot time), but the API endpoint differs
                  (/appointments/walk-in mints a token + writes WALK_IN
                  type). Surfaced for ANY mode that includes WALKIN in
                  its enabled set. */}
              {selectedDoctor && selectedChannel === "WALKIN" && (
                <div
                  className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-100"
                  data-testid="appt-book-walkin-mode"
                >
                  <p className="mb-3">
                    Register the patient as a <strong>walk-in</strong>. A token is
                    minted for today and the patient joins the in-clinic queue.
                  </p>
                  <button
                    type="button"
                    data-testid="appt-book-walkin-add"
                    disabled={bookingInFlight}
                    onClick={async () => {
                      if (patientIdInput.trim().length === 0) {
                        setPatientFieldError(true);
                        return;
                      }
                      setBookingInFlight(true);
                      try {
                        await api.post("/appointments/walk-in", {
                          patientId: patientIdInput.trim(),
                          doctorId: selectedDoctor,
                        });
                        toast.success("Walk-in registered!");
                        setPatientIdInput("");
                        setPickedPatientName("");
                        setPickerResetKey((k) => k + 1);
                        setPatientFieldError(false);
                        setShowBooking(false);
                        loadAppointments();
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Walk-in failed");
                      } finally {
                        setBookingInFlight(false);
                      }
                    }}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Add to today&apos;s walk-in queue
                  </button>
                </div>
              )}

              {/* Pearl ERP Stage 1 §2.1.2 — CALLING channel (arrival-order
                  queue, no slot time). Reachable for CALLING-mode doctors
                  whose enabledChannels include CALLING. */}
              {selectedDoctor && selectedChannel === "CALLING" && (
                  <div
                    className="mt-4 rounded-lg border border-blue-300 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-100"
                    data-testid="appt-book-calling-mode"
                  >
                    <p className="mb-3">
                      This doctor uses an <strong>arrival-order queue</strong>. No
                      slot time needed — the patient is added to today's queue
                      and seen in arrival order.
                    </p>
                    <button
                      type="button"
                      data-testid="appt-book-calling-add"
                      onClick={() => bookAppointment("")}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Add to today&apos;s queue
                    </button>
                  </div>
                )}

              {/* Pearl §2.1.2 — TOKEN channel: sequential token, slot time is
                  optional → no slot grid. Just a message + a Book button that
                  mints the next token (same no-slot booking path as CALLING). */}
              {selectedDoctor && selectedChannel === "TOKEN" && (
                <div
                  className="mt-4 rounded-lg border border-indigo-300 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-100"
                  data-testid="appt-book-token-mode"
                >
                  <p className="mb-3">
                    This doctor uses <strong>sequential token</strong> booking.
                    No slot time needed — a token number is assigned
                    automatically.
                  </p>
                  {tokenPreview?.limitReached ? (
                    // Daily appointment cap hit — block further token bookings
                    // for this doctor/date.
                    <p
                      data-testid="appt-book-token-limit"
                      className="rounded-lg bg-rose-100 px-3 py-2 text-sm font-medium text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
                    >
                      {isDoctor
                        ? "You've reached your daily appointment limit — no more tokens can be booked today."
                        : "Daily appointment limit reached for this doctor — no more tokens can be booked today."}
                    </p>
                  ) : (
                    <button
                      type="button"
                      data-testid="appt-book-token-add"
                      disabled={bookingInFlight}
                      onClick={() => bookAppointment("")}
                      className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {tokenPreview?.label
                        ? `Book (assign token ${tokenPreview.label})`
                        : "Book (assign token)"}
                    </button>
                  )}
                </div>
              )}

              {selectedDoctor &&
                selectedChannel === "SLOT" &&
                slotsWithPast.length === 0 && (
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

              {selectedDoctor &&
                selectedChannel === "SLOT" &&
                slotsWithPast.length > 0 && (
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
                className="ml-auto rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
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
                    : (() => {
                        const isToday = filterDate === toISODate(new Date());
                        const when = isToday
                          ? "today"
                          : `on ${formatShortDate(filterDate)}`;
                        // The date HAS appointments, but none match the active
                        // status chip → name the filter in plain text. Only
                        // when the whole-date list is genuinely empty do we
                        // say "No appointments <when>".
                        const dateHasData =
                          appointments.length > 0 && statusFilter !== "ALL";
                        // If a "pending" filter is active but nothing pending
                        // remains (e.g. every booking has been completed),
                        // there's nothing to redirect to — just say
                        // "No appointments <when>".
                        const PENDING = ["BOOKED", "CHECKED_IN", "IN_CONSULTATION"];
                        const noPendingLeft = !appointments.some((a) =>
                          PENDING.includes(
                            displayStatusForAppointment({
                              status: a.status,
                              slotStart: a.slotStart,
                              date: a.date,
                            })
                          )
                        );
                        if (PENDING.includes(statusFilter) && noPendingLeft) {
                          return `No appointments ${when}`;
                        }
                        // Word the empty message naturally per status (e.g.
                        // "No patients checked in today", "No consultations in
                        // progress today") rather than a stiff
                        // "<status> appointments".
                        const STATUS_PHRASE: Record<string, string> = {
                          BOOKED: `No booked appointments ${when}`,
                          CHECKED_IN: `No patients checked in ${when}`,
                          IN_CONSULTATION: `No consultations in progress ${when}`,
                          COMPLETED: `No completed appointments ${when}`,
                          CANCELLED: `No cancelled appointments ${when}`,
                          NO_SHOW: `No no-shows ${when}`,
                        };
                        return dateHasData
                          ? STATUS_PHRASE[statusFilter] ??
                              `No appointments ${when}`
                          : `No appointments ${when}`;
                      })()
                }
                description={
                  isPatient
                    ? "Book an appointment with one of our doctors."
                    : "Book a new appointment to get started."
                }
                action={
                  // Always offer "Book appointment" on an empty list for staff —
                  // whether the whole day is empty or just the active filter.
                  !isPatient
                    ? {
                        label: "Book appointment",
                        onClick: () => setShowBooking(true),
                      }
                    : undefined
                }
              />
            ) : (
              <div className="overflow-x-auto">
              <table className="w-full min-w-[860px]">
                <thead>
                  {/* Issue #866: header row was text-gray-700 dark:text-gray-200
                      which is still washed-out grey-on-dark; bump to gray-100
                      on dark and add an explicit bg-gray-50 dark:bg-gray-900/40
                      header band so the table header is clearly demarcated.
                      Also: for the PATIENT role's Past tab every row's Actions
                      cell is empty (no reschedule / cancel for COMPLETED),
                      so we suppress the column entirely on that tab to
                      reclaim the ~120 px and remove the dead affordance. */}
                  <tr className="border-b bg-gray-50 text-left text-sm font-semibold uppercase tracking-wide text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-100">
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
                    {/* Pearl §2.1.2 — neutral "#" header since rows
                        can mix CALLING (A-…), TOKEN (T-…) and SLOT
                        (—) appointments under different doctors. The
                        cell formats per row via appointmentRefLabel(). */}
                    <th className="px-4 py-3">#</th>
                    {!isPatient && <th className="px-4 py-3">{t("dashboard.appointments.col.patient")}</th>}
                    <th className="px-4 py-3">{t("dashboard.appointments.col.doctor")}</th>
                    <th className="px-4 py-3">{t("dashboard.appointments.col.date")}</th>
                    <th className="px-4 py-3">{t("dashboard.appointments.col.time")}</th>
                    <th className="px-4 py-3">{t("dashboard.appointments.col.type")}</th>
                    <th className="px-4 py-3">{t("dashboard.appointments.col.status")}</th>
                    {!(isPatient && patientTab === "past") && (
                      <th className="px-4 py-3">{t("dashboard.appointments.col.actions")}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {pagedAppointments.map((apt) => {
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
                    const isDeepLinkHighlight = highlightedAptId === apt.id;
                    return (
                    <tr
                      key={apt.id}
                      className={`border-b last:border-0 transition-colors ${
                        isDeepLinkHighlight
                          ? "bg-yellow-50 dark:bg-yellow-900/30"
                          : ""
                      }`}
                      data-testid={rowTestId}
                      data-apt-row={apt.id}
                    >
                      {!isPatient && (
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            aria-label={`Select appointment ${appointmentRefLabel(apt)}`}
                            checked={selectedIds.has(apt.id)}
                            onChange={() => toggleSelect(apt.id)}
                            className="h-4 w-4 cursor-pointer accent-primary"
                          />
                        </td>
                      )}
                      <td className="px-4 py-3 font-bold">
                        {appointmentRefLabel(apt)}
                      </td>
                      {!isPatient && (
                        <td className="px-4 py-3">
                          <p className="font-medium">{apt.patient.user.name}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">{apt.patient.user.phone}</p>
                        </td>
                      )}
                      <td className="px-4 py-3 text-sm">{apt.doctor.user.name}</td>
                      <td className="px-4 py-3 text-sm">{apt.date.slice(0, 10)}</td>
                      <td className="px-4 py-3 text-sm">
                        {/* Only WALK_IN rows are labelled "Walk-in"; TOKEN /
                            CALLING bookings have no slot time → show "—". */}
                        {displayTime ||
                          apt.slotStart ||
                          (apt.type === "WALK_IN" ? "Walk-in" : "—")}
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
                      {/* Issue #866: hide the Actions cell entirely for the
                          PATIENT Past tab — past appointments are COMPLETED /
                          CANCELLED / NO_SHOW so none of the row buttons below
                          render anyway, and the dead column was wasting
                          ~120 px of horizontal table real-estate. */}
                      {!(isPatient && patientTab === "past") && (
                      <td className="px-4 py-3">
                        <div className="flex items-start gap-2">
                          <div className="flex flex-wrap gap-1.5">
                          {/* Pearl §2.1.7 — Remarks panel. Any non-PATIENT
                              role can open the threaded remarks for an
                              appointment. The server enforces visibility
                              scoping (DOCTOR_ONLY / RECEPTION_ONLY / PRIVATE
                              are filtered by viewer role). */}
                          {!isPatient && (() => {
                              // Unread = remarks added since this user last
                              // opened the thread. Hidden once seen; reappears
                              // when new remarks arrive.
                              const unseen = Math.max(
                                0,
                                (apt._count?.remarks ?? 0) -
                                  (seenRemarks[apt.id] ?? 0)
                              );
                              return (
                                <button
                                  onClick={() => {
                                    // Opening counts as seeing the current
                                    // thread — clear the badge immediately.
                                    markRemarksSeen(
                                      apt.id,
                                      apt._count?.remarks ?? 0
                                    );
                                    setRemarksTarget(apt);
                                  }}
                                  aria-label={`Open remarks for ${apt.patient.user.name}${
                                    unseen
                                      ? ` (${unseen} new remark${
                                          unseen === 1 ? "" : "s"
                                        })`
                                      : ""
                                  }`}
                                  className="relative flex items-center gap-1 rounded border border-gray-300 bg-white px-1.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                                  title="Threaded remarks"
                                >
                                  <MessageSquare size={12} aria-hidden="true" />
                                  Remarks
                                  {unseen > 0 && (
                                    <span
                                      data-testid="remark-count-badge"
                                      className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-none text-white"
                                    >
                                      {unseen > 99 ? "99+" : unseen}
                                    </span>
                                  )}
                                </button>
                              );
                            })()}
                          {/* Reschedule for BOOKED / CHECKED_IN. Gated on the
                              effective status so a past row showing NO_SHOW
                              doesn't offer it. */}
                          {["BOOKED", "CHECKED_IN"].includes(displayStatus) &&
                            (isPatient ||
                              user?.role === "RECEPTION" ||
                              user?.role === "ADMIN" ||
                              user?.role === "DOCTOR" ||
                              user?.role === "NURSE") && (
                              <button
                                onClick={() => openReschedule(apt)}
                                aria-label={`Reschedule appointment for ${apt.patient.user.name} (token ${apt.tokenNumber})`}
                                className="rounded bg-indigo-600 px-1.5 py-1 text-[11px] text-white hover:bg-indigo-700"
                              >
                                {t("dashboard.actions.reschedule")}
                              </button>
                            )}
                          {/* Patients cancel via this inline button; staff
                              cancel from the ⋮ menu (no separate inline Cancel
                              button for staff). */}
                          {displayStatus === "BOOKED" && isPatient && (
                            <button
                              onClick={() => handleCancelClick(apt.id)}
                              aria-label={`Cancel appointment for ${apt.patient.user.name} (token ${apt.tokenNumber})`}
                              className="rounded bg-red-600 px-1.5 py-1 text-[11px] text-white hover:bg-red-700"
                            >
                              {t("common.cancel")}
                            </button>
                          )}
                          {["BOOKED", "CHECKED_IN"].includes(displayStatus) && (
                            <button
                              onClick={() =>
                                router.push(
                                  `/dashboard/calendar?date=${apt.date.slice(0, 10)}&from=appointments`,
                                )
                              }
                              aria-label={`Open calendar for ${apt.patient.user.name} (token ${apt.tokenNumber})`}
                              className="rounded border border-emerald-300 bg-emerald-50 px-1.5 py-1 text-[11px] text-emerald-800 hover:bg-emerald-100"
                              title="Open the calendar to schedule the next appointment"
                            >
                              {t("dashboard.actions.calendarInvite")}
                            </button>
                          )}
                          {/* Check In is a day-of action — only for TODAY's
                              booked appointments (not future, not past). */}
                          {!isPatient &&
                            displayStatus === "BOOKED" &&
                            isAppointmentToday(apt) && (
                            <button
                              onClick={() => updateStatus(apt.id, "CHECKED_IN")}
                              aria-label={`Check in ${apt.patient.user.name}`}
                              className="rounded bg-yellow-600 px-1.5 py-1 text-[11px] text-white hover:bg-yellow-700"
                            >
                              {t("dashboard.actions.checkIn")}
                            </button>
                          )}
                          {/* Only the DOCTOR conducts the encounter — front
                              desk / nurse / admin never see Start Consult. */}
                          {isDoctor && displayStatus === "CHECKED_IN" && (
                            <button
                              onClick={async () => {
                                // Pearl §2.1.3 — Start Consult now does
                                // BOTH: flip the appointment to
                                // IN_CONSULTATION (server-side state)
                                // AND open the dedicated 3-column
                                // SOAP consult page so the doctor can
                                // actually capture the encounter. Pre-
                                // §2.1.3 this only flipped the status,
                                // which left the consult itself with
                                // nowhere to go in the UI.
                                await updateStatus(apt.id, "IN_CONSULTATION");
                                router.push(
                                  `/dashboard/consult/${apt.id}?from=appointments`,
                                );
                              }}
                              aria-label={`Start consultation for ${apt.patient.user.name}`}
                              className="rounded bg-green-600 px-1.5 py-1 text-[11px] text-white hover:bg-green-700"
                            >
                              {t("dashboard.actions.startConsult")}
                            </button>
                          )}
                          {/* Re-consult stays inline (doctor resumes the SOAP
                              page mid-encounter). Hidden once SIGNED. */}
                          {isDoctor &&
                            displayStatus === "IN_CONSULTATION" &&
                            apt.consultation?.status !== "SIGNED" && (
                              <button
                                onClick={() =>
                                  router.push(
                                    `/dashboard/consult/${apt.id}?from=appointments`,
                                  )
                                }
                                aria-label={`Resume consultation for ${apt.patient.user.name}`}
                                className="rounded bg-indigo-600 px-1.5 py-1 text-[11px] text-white hover:bg-indigo-700"
                              >
                                Re-consult
                              </button>
                            )}
                          {/* Complete — inline. IN_CONSULTATION, not signed. */}
                          {!isPatient &&
                            displayStatus === "IN_CONSULTATION" &&
                            apt.consultation?.status !== "SIGNED" && (
                              <button
                                onClick={() => updateStatus(apt.id, "COMPLETED")}
                                aria-label={`Mark consultation complete for ${apt.patient.user.name}`}
                                className="rounded bg-gray-700 px-1.5 py-1 text-[11px] text-white hover:bg-gray-800"
                              >
                                {t("dashboard.actions.complete")}
                              </button>
                            )}
                          {/* Stale-row recovery: consultation SIGNED but the
                              appointment didn't advance — surface Mark Complete
                              so staff can resolve the row in one click. */}
                          {!isPatient &&
                            displayStatus === "IN_CONSULTATION" &&
                            apt.consultation?.status === "SIGNED" && (
                              <button
                                onClick={() => updateStatus(apt.id, "COMPLETED")}
                                aria-label={`Mark complete for ${apt.patient.user.name}`}
                                className="rounded bg-emerald-600 px-1.5 py-1 text-[11px] text-white hover:bg-emerald-700"
                              >
                                Mark Complete
                              </button>
                            )}
                          </div>
                          {/* ⋮ overflow menu — always present for staff and
                              pinned to the right (ml-auto) so the icon sits in a
                              constant spot on every row. Opens that row's
                              secondary (undo) actions. */}
                          {!isPatient && (
                            <button
                              type="button"
                              aria-haspopup="menu"
                              aria-expanded={statusMenu?.id === apt.id}
                              aria-label={`More actions for ${apt.patient.user.name}`}
                              onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                setStatusMenu((cur) =>
                                  cur?.id === apt.id
                                    ? null
                                    : { id: apt.id, top: r.bottom + 4, left: r.right }
                                );
                              }}
                              className="ml-auto shrink-0 rounded border border-gray-300 bg-white px-1.5 py-1 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                              title="More actions"
                            >
                              <MoreVertical size={14} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                      )}
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
            {!loading && filteredAppointments.length > 0 && (
              <TablePagination
                page={currentPage}
                totalPages={totalPages}
                pageSize={pageSize}
                totalItems={filteredAppointments.length}
                onPageChange={setPage}
                onPageSizeChange={(n) => {
                  setPage(1);
                  setPageSize(n);
                }}
              />
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
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Today
              </button>
              <button
                onClick={() => setCalWeekStart(addDays(calWeekStart, -7))}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                ← Prev Week
              </button>
              <button
                onClick={() => setCalWeekStart(addDays(calWeekStart, 7))}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Next Week →
              </button>
              <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-200">
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

          <div className="overflow-x-auto rounded-xl bg-white shadow-sm dark:bg-gray-800">
            {calLoading ? (
              // Pearl §7.2 skeleton sweep (wave 13, 2026-05-23): replaced the
              // bare "Loading calendar…" text with a `SkeletonCard ×3` block
              // under a stable `appointments-calendar-loading` testid +
              // `aria-busy="true"`. Same pattern as wave-12 `<slug>-loading`.
              <div
                data-testid="appointments-calendar-loading"
                aria-busy="true"
                className="space-y-3 p-4"
              >
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
              </div>
            ) : (
              <div className="min-w-200">
                {/* Header row */}
                <div
                  className="grid border-b bg-gray-50 text-xs font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-200"
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
                    <div className="border-r px-2 py-1 text-right text-gray-500 dark:border-gray-700 dark:text-gray-400">
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
                          className="relative border-l bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700/50"
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
                <span className="text-gray-700 dark:text-gray-200">{s.replace(/_/g, " ")}</span>
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
              <label htmlFor="appt-stats-from" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">From</label>
              <input
                id="appt-stats-from"
                type="date"
                value={statsFrom}
                onChange={(e) => setStatsFrom(e.target.value)}
                className="rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="appt-stats-to" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">To</label>
              <input
                id="appt-stats-to"
                type="date"
                value={statsTo}
                onChange={(e) => setStatsTo(e.target.value)}
                className="rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="appt-stats-doctor" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">Doctor</label>
              <select
                id="appt-stats-doctor"
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
                <StatCard label="Total" value={stats?.totalCount ?? 0} color="bg-blue-50 text-blue-700" />
                <StatCard
                  label="Completed"
                  value={stats?.completedCount ?? 0}
                  color="bg-green-50 text-green-700"
                />
                <StatCard
                  label="Cancelled"
                  value={stats?.cancelledCount ?? 0}
                  color="bg-red-50 text-red-700"
                />
                <StatCard
                  label="No-Show"
                  value={stats?.noShowCount ?? 0}
                  color="bg-slate-50 text-slate-700"
                />
                <StatCard
                  label="Avg Consult (min)"
                  value={stats?.avgConsultationTimeMin ?? 0}
                  color="bg-indigo-50 text-indigo-700"
                />
                <StatCard
                  label="Peak Hour"
                  value={
                    stats?.peakHour != null
                      ? `${String(stats.peakHour).padStart(2, "0")}:00`
                      : "—"
                  }
                  color="bg-amber-50 text-amber-700"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <section className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
                  <h2 className="mb-4 font-semibold">By Status</h2>
                  <DonutChart
                    segments={ALL_STATUSES.map((s) => ({
                      label: s.replace(/_/g, " "),
                      value: stats?.byStatus?.[s] ?? 0,
                      color: STATUS_HEX[s],
                    })).filter((s) => s.value > 0)}
                  />
                </section>

                <section className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
                  <h2 className="mb-4 font-semibold">By Doctor</h2>
                  {statsByDoctor.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">No data.</p>
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

                <section className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
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
      <div className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Join Waitlist</h3>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
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
            <label htmlFor="waitlist-pref-date" className="text-xs text-gray-500 dark:text-gray-400">Preferred Date</label>
            <input
              id="waitlist-pref-date"
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
              <li className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">Searching...</li>
            )}
            {!loading && results.length === 0 && (
              <li className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">No matches</li>
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
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
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
            <li className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">Searching...</li>
          )}
          {!loading && results.length === 0 && (
            <li className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">No matches</li>
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
                <div className="text-[11px] text-gray-500 dark:text-gray-400">
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
      <div className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Group Appointment</h3>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
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
              <label htmlFor="group-appt-date" className="text-xs text-gray-500 dark:text-gray-400">Date</label>
              <input
                id="group-appt-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="group-appt-slot" className="text-xs text-gray-500 dark:text-gray-400">Slot Start</label>
              <input
                id="group-appt-slot"
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
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Coordinate Multi-Doctor Visit</h3>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Patient</label>
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
            <label htmlFor="coord-visit-date" className="text-xs text-gray-500 dark:text-gray-400">Visit Date</label>
            <input
              id="coord-visit-date"
              type="date"
              value={visitDate}
              onChange={(e) => setVisitDate(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">
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
