"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { displayStatusForAppointment } from "@/lib/appointments";
import { containsHtmlOrScript } from "@medcore/shared";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  X,
  Video,
  BedDouble,
  Scissors,
  FileText,
  Baby,
  Users as UsersIcon,
  Stethoscope,
  Plus,
} from "lucide-react";

interface CalEvent {
  id: string;
  date: string; // YYYY-MM-DD
  time?: string;
  title: string;
  subtitle?: string;
  type:
    | "appointment"
    | "surgery"
    | "telemedicine"
    | "anc"
    | "followup"
    | "shift"
    | "custom";
  href: string;
  color: string;
  raw?: any;
}

// Issue #93 (2026-04-26): off-by-one rendering. `d.toISOString()` always
// converts to UTC, so an event at 2026-04-14T00:00+05:30 (IST midnight)
// becomes 2026-04-13T18:30Z and the calendar bucketed it on Apr 13. We
// now read the LOCAL year/month/day so the bucket matches what the user
// sees on the wall clock. For raw YYYY-MM-DD strings (no time/zone), we
// also expose a parser that anchors to local midnight rather than UTC.
function fmtYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse a date the API returned. Accepts ISO datetimes (with offset) and
 * bare YYYY-MM-DD strings — the latter must be anchored at local midnight,
 * not UTC, to avoid the same off-by-one that bit fmtYmd() above.
 */
function parseEventDate(raw: string | Date): Date {
  if (raw instanceof Date) return raw;
  // Bare YYYY-MM-DD → local midnight (new Date("2026-04-14") is parsed
  // as UTC by the spec, which is the off-by-one root cause).
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(raw);
}

/**
 * Issue #855: resolve an appointment's start into a real instant. The API
 * returns `slotStart` either as a bare "HH:mm" wall-clock string or as a
 * full ISO datetime — a bare "HH:mm" is anchored to the appointment's
 * `date` (or today) at local midnight + the given hours/minutes so `hhmm`
 * has an instant to format.
 */
function parseEventTime(
  slotStart: string | null | undefined,
  date?: string | null
): Date | null {
  if (!slotStart) return null;
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(slotStart)) {
    const [h, m] = slotStart.split(":").map(Number);
    const base =
      date && /^\d{4}-\d{2}-\d{2}/.test(date)
        ? new Date(`${date.slice(0, 10)}T00:00:00`)
        : new Date();
    base.setHours(h, m, 0, 0);
    return Number.isNaN(base.getTime()) ? null : base;
  }
  const d = new Date(slotStart);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Issue #855: every event TIME on the calendar must render in ONE format.
 * Previously the calendar mixed 12-hour and 24-hour tokens on the same
 * view — appointment tiles routed through `formatAppointmentTime` (which
 * uses `hour12: true` → "02:30 PM") while surgery / telemedicine / custom
 * tiles used `toISOString().substring(11,16)` (24-hour "14:30"), and
 * shifts used the raw "HH:mm" `startTime` string. A single month/week/day
 * view therefore showed "02:30 PM" next to "14:30".
 *
 * `hhmm()` is the calendar's canonical event-time formatter: it renders
 * any instant as a 24-hour `HH:mm` string in Asia/Kolkata, matching the
 * app-wide `formatDateTime` style ("27 Apr 2026, 14:30"). All event-time
 * rendering on the calendar now routes through here so the view never
 * mixes time tokens.
 *
 * Issue #593: `Date.prototype.toISOString()` throws `RangeError: Invalid
 * time value` for an invalid Date — the old `safeHHMM` builders crashed
 * the whole IIFE if ANY one row had a bad `scheduledAt`. `hhmm()` keeps
 * that guard: bad rows just lose their time, the rest still renders.
 */
const HHMM_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});

function hhmm(d: Date): string | undefined {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return undefined;
  try {
    // en-GB + hour12:false yields "HH:mm"; normalize the "24:xx" midnight
    // edge case some engines emit back to "00:xx".
    return HHMM_FORMATTER.format(d).replace(/^24:/, "00:");
  } catch {
    return undefined;
  }
}

function safe<T>(p: string, fb: T): Promise<T> {
  return api.get<T>(p).catch(() => fb);
}

// Issue #431: calendar lacked an explicit view-mode (Day/Week/Month) — the
// month grid was the only renderable view, so the toggle in the header (which
// users expect on every calendar UI) had no state to flip and the screen
// looked frozen. We now keep `viewMode` as a top-level piece of state and
// render Week and Day variants alongside the existing Month grid.
type ViewMode = "month" | "week" | "day";

export default function UnifiedCalendarPage() {
  const { user } = useAuthStore();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [viewMode, setViewMode] = useState<ViewMode>("month");
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CalEvent | null>(null);
  // Issue #718: New-Event dialog. The calendar previously had no create
  // affordance — neither a "+ New Event" toolbar button nor click-to-create
  // on date cells. Both are now wired. Because the calendar surfaces six
  // different event archetypes (appointment / surgery / telemed / ANC /
  // follow-up / shift), the dialog is a category picker that deep-links
  // into the matching dashboard page with the chosen date pre-applied via
  // query param. Each downstream page already exposes an Add/Schedule
  // dialog, so this routes the user to the form that actually owns the
  // event type rather than reinventing a meta-form here.
  const [newEventDate, setNewEventDate] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Issue #749: holidays defined at /dashboard/holidays were invisible on
  // the calendar grid. We fetch them on mount via the new public-read
  // /api/v1/holidays endpoint (admin-managed via /hr-ops/holidays, but
  // every authed role needs to SEE the holiday cells), bucket by
  // YYYY-MM-DD, and render them as a tinted background cell + tooltip
  // alongside (not instead of) any events that fall on the same date.
  const [holidaysByDate, setHolidaysByDate] = useState<
    Record<string, { id: string; name: string; type: string }>
  >({});
  const canCreate =
    user?.role === "ADMIN" ||
    user?.role === "DOCTOR" ||
    user?.role === "RECEPTION";

  // compute month bounds (also used as the data-fetch window for week/day —
  // we always pull a full month and let the renderer slice it, which keeps
  // the network footprint stable when the user just toggles view mode).
  const month = cursor.getMonth();
  const year = cursor.getFullYear();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Issue #593 (May 2026): RECEPTION (and any role) saw the calendar
      // stuck on "Loading events..." forever when ANY downstream data
      // shape threw mid-mapping (e.g. a malformed `scheduledAt` causing
      // `new Date(...).toISOString()` to throw `RangeError: Invalid time
      // value`). The IIFE had no try/catch, so the rejection skipped
      // `setLoading(false)` and the loader pinned. Wrap the whole body in
      // try/finally so we always clear the loader, regardless of what any
      // single event-mapping line does.
      try {
      const from = fmtYmd(first);
      const to = fmtYmd(last);
      const collected: CalEvent[] = [];

      // Appointments + holidays (Issue #749: holidays surface as a
      // separate read so the existing event-fetching code is untouched —
      // the merge happens in the renderer via `holidaysByDate`).
      const [appts, surg, telemed, anc, rxFollow, shifts, custom, holidays] = await Promise.all([
        safe<any>(`/appointments?from=${from}&to=${to}&limit=500`, { data: [] }),
        safe<any>(`/surgery?from=${from}&to=${to}&limit=500`, { data: [] }),
        safe<any>(`/telemedicine?from=${from}&to=${to}&limit=500`, { data: [] }),
        user.role === "PATIENT" || user.role === "DOCTOR" || user.role === "ADMIN"
          ? safe<any>(`/antenatal?from=${from}&to=${to}&limit=500`, { data: [] })
          : Promise.resolve({ data: [] }),
        safe<any>(`/prescriptions?followUpFrom=${from}&followUpTo=${to}&limit=500`, {
          data: [],
        }),
        user.role === "ADMIN"
          ? safe<any>(`/shifts?from=${from}&to=${to}&limit=1000`, { data: [] })
          : Promise.resolve({ data: [] }),
        // Issue #718: ad-hoc admin events (training, closures, etc.).
        // Open to every authed staff role on the API; PATIENT just gets
        // an empty list because the route doesn't authorize them.
        user.role === "PATIENT"
          ? Promise.resolve({ data: [] })
          : safe<any>(`/calendar-events?from=${from}&to=${to}&limit=500`, {
              data: [],
            }),
        // Issue #749: holidays (public-read for any authed role) within
        // the same window as the events fetch. We pass `from` and `to`
        // so multi-month windows return correctly.
        safe<any>(`/holidays?from=${from}&to=${to}`, { data: [] }),
      ]);

      for (const a of appts.data || []) {
        // Appointments come back with a YYYY-MM-DD `date` — parse with
        // the local-midnight helper so `fmtYmd` doesn't round it down a
        // day in negative-offset timezones.
        const d = parseEventDate(a.date);
        // Issue #389 / #855: anchor the appointment's start to a real
        // instant, then render it through the calendar's canonical 24-hour
        // `hhmm` formatter so the tile uses the SAME time token as every
        // other event type on the view (surgery / telemedicine / custom /
        // shift) — no more 12-hour "02:30 PM" next to 24-hour "14:30".
        const apptInstant = parseEventTime(a.slotStart, a.date);
        const apptTime = apptInstant ? hhmm(apptInstant) : undefined;
        // Issue #388: a `BOOKED` appointment whose start has passed should
        // render as `COMPLETED` (display only).
        const apptStatus = displayStatusForAppointment({
          status: a.status,
          slotStart: a.slotStart,
          date: a.date,
        });
        // Issue #871: for a PATIENT viewer the chip's `title` was the
        // patient's OWN name — useless on their own calendar. Pivot the
        // chip composition by role: PATIENTs see "<type> · Dr. <name>"
        // (the doctor + appointment type are what matters to them);
        // staff see the patient's name as before so they can scan their
        // schedule by patient. The full row (date/time/type/status) is
        // still in the subtitle that the detail popup renders.
        const apptTypeLabel = String(a.type || "").replace(/_/g, " ").toLowerCase();
        const doctorDisplay = a.doctor?.user?.name
          ? formatDoctorName(a.doctor.user.name)
          : "—";
        const titleForViewer =
          user.role === "PATIENT"
            ? `${apptTypeLabel} · ${doctorDisplay}`
            : a.patient?.user?.name || "Patient";
        collected.push({
          id: `appt-${a.id}`,
          date: fmtYmd(d),
          time: apptTime,
          title: titleForViewer,
          subtitle: `${apptTypeLabel} · ${doctorDisplay} · ${apptStatus}`,
          type: "appointment",
          href: `/dashboard/appointments?id=${a.id}`,
          color: "bg-blue-500",
          raw: a,
        });
      }
      for (const s of surg.data || []) {
        const d = new Date(s.scheduledAt);
        if (Number.isNaN(d.getTime())) continue; // Issue #593: skip bad rows
        collected.push({
          id: `surg-${s.id}`,
          date: fmtYmd(d),
          time: hhmm(d),
          title: s.procedure,
          subtitle: `${s.caseNumber} · ${s.patient?.user?.name || ""}`,
          type: "surgery",
          href: `/dashboard/surgery?id=${s.id}`,
          color: "bg-rose-500",
          raw: s,
        });
      }
      for (const t of telemed.data || []) {
        const d = new Date(t.scheduledAt || t.startedAt || Date.now());
        if (Number.isNaN(d.getTime())) continue; // Issue #593: skip bad rows
        // Issue #871: a PATIENT viewer was seeing "Telemedicine · <ownName>"
        // on every chip — their own name added no information. Show the
        // doctor for PATIENT, the patient for staff.
        const teleDoctor = t.doctor?.user?.name
          ? formatDoctorName(t.doctor.user.name)
          : "—";
        const telePatient = t.patient?.user?.name || "";
        collected.push({
          id: `tele-${t.id}`,
          date: fmtYmd(d),
          time: hhmm(d),
          title:
            user.role === "PATIENT"
              ? `Telemedicine · ${teleDoctor}`
              : `Telemedicine · ${telePatient}`,
          subtitle:
            user.role === "PATIENT" ? telePatient || teleDoctor : teleDoctor,
          type: "telemedicine",
          href: `/dashboard/telemedicine?id=${t.id}`,
          color: "bg-purple-500",
          raw: t,
        });
      }
      for (const a of anc.data || []) {
        const visits = a.visits || [];
        for (const v of visits) {
          if (!v.scheduledDate) continue;
          const d = parseEventDate(v.scheduledDate);
          if (d < first || d > last) continue;
          collected.push({
            id: `anc-${v.id}`,
            date: fmtYmd(d),
            title: `ANC Visit · ${a.patient?.user?.name || ""}`,
            subtitle: `GA ${v.gestationalAge || "—"}w`,
            type: "anc",
            href: `/dashboard/antenatal?id=${a.id}`,
            color: "bg-pink-500",
            raw: v,
          });
        }
      }
      for (const rx of rxFollow.data || []) {
        if (!rx.followUpDate) continue;
        const d = parseEventDate(rx.followUpDate);
        // Issue #871: PATIENT viewers were getting "Follow-up · <ownName>"
        // chips — show the diagnosis (their actual reason to come in) and
        // doctor instead, which is the information they need at a glance.
        const rxDoctor = rx.doctor?.user?.name
          ? formatDoctorName(rx.doctor.user.name)
          : "—";
        collected.push({
          id: `followup-${rx.id}`,
          date: fmtYmd(d),
          title:
            user.role === "PATIENT"
              ? `Follow-up · ${rx.diagnosis || rxDoctor}`
              : `Follow-up · ${rx.patient?.user?.name || ""}`,
          subtitle:
            user.role === "PATIENT"
              ? `${rxDoctor}`
              : `For ${rx.diagnosis}`,
          type: "followup",
          href: `/dashboard/prescriptions?id=${rx.id}`,
          color: "bg-emerald-500",
          raw: rx,
        });
      }
      for (const sh of shifts.data || []) {
        const d = parseEventDate(sh.date);
        collected.push({
          id: `shift-${sh.id}`,
          date: fmtYmd(d),
          time: sh.startTime,
          title: `${sh.user?.name || "Staff"} · ${sh.type}`,
          subtitle: `${sh.startTime}-${sh.endTime}`,
          type: "shift",
          href: `/dashboard/duty-roster`,
          color: "bg-gray-500",
          raw: sh,
        });
      }
      // Issue #718: ad-hoc admin events created via the New-Event dialog.
      for (const ev of custom.data || []) {
        const start = new Date(ev.startAt);
        if (Number.isNaN(start.getTime())) continue; // Issue #593
        collected.push({
          id: `custom-${ev.id}`,
          date: fmtYmd(start),
          time: hhmm(start),
          title: ev.title,
          subtitle: ev.category
            ? `${String(ev.category).replace(/_/g, " ").toLowerCase()}${ev.description ? ` · ${ev.description}` : ""}`
            : ev.description || undefined,
          type: "custom",
          href: `/dashboard/calendar`,
          color: ev.color || "bg-amber-500",
          raw: ev,
        });
      }

      // Issue #749: bucket holidays by YYYY-MM-DD so the renderer can
      // overlay a holiday tint + tooltip on each matching cell.
      const holidayMap: Record<string, { id: string; name: string; type: string }> = {};
      for (const h of holidays.data || []) {
        if (!h.date) continue;
        const d = parseEventDate(h.date);
        holidayMap[fmtYmd(d)] = {
          id: h.id,
          name: h.name,
          type: h.type || "PUBLIC",
        };
      }

      if (!cancelled) {
        setEvents(collected);
        setHolidaysByDate(holidayMap);
      }
      } catch (err) {
        // Issue #593: log but never block render — the loader MUST clear
        // even on a per-row mapping crash so the user can refresh / pick
        // a different month rather than stare at a frozen "Loading..."
        // forever.
        console.error("[calendar] failed to assemble events", err);
        if (!cancelled) {
          setEvents([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // refreshKey is bumped after a successful New-Event POST so the
    // calendar re-fetches and renders the just-created row.
  }, [cursor, user, refreshKey]);

  // Group events by date
  const byDate = useMemo(() => {
    const map: Record<string, CalEvent[]> = {};
    for (const e of events) {
      (map[e.date] ||= []).push(e);
    }
    return map;
  }, [events]);

  // Build month grid (Sun-start)
  const startDay = first.getDay();
  const cells: Array<Date | null> = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= last.getDate(); d++) {
    cells.push(new Date(year, month, d));
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = cursor.toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });

  const todayYmd = fmtYmd(new Date());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {/* Issue #876: the H1 was previously colored `text-gray-900` with
              no dark-mode override, so on dark backgrounds the heading
              rendered near-black on near-black and was effectively invisible
              to sighted users (screen readers still announced it, hence the
              "no H1" report). Inherit the layout's body color instead — that
              already has a light/dark pair wired up — and bump the subtitle
              one notch lighter than gray-500 so it scans cleanly in dark mode. */}
          <h1 className="text-2xl font-bold">Calendar</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Unified view of all scheduled events
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Issue #431: Day/Week/Month view toggle. Previously absent — the
              calendar only rendered a month grid, so users clicking the
              toggle saw nothing happen. */}
          {/* Issue #876 continued: every pill / card / control in the
              calendar header was bg-white with no dark variant. In dark
              mode the white pill rendered against a dark page, but the
              text inside the pill inherited the layout's light body
              color — white-on-white, invisible. Same fix pattern as the
              #886 Duty Roster + Census sweep: add dark:bg-gray-800 for
              card surfaces, dark:hover:bg-gray-700 for hover states, and
              dark:text-gray-200 for muted text. */}
          <div
            role="tablist"
            aria-label="Calendar view"
            className="flex items-center gap-1 rounded-lg bg-white p-1 shadow-sm dark:bg-gray-800"
          >
            {(["day", "week", "month"] as ViewMode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={viewMode === m}
                data-testid={`cal-view-${m}`}
                onClick={() => setViewMode(m)}
                className={`rounded px-2 py-1 text-xs font-medium capitalize ${
                  viewMode === m
                    ? "bg-primary text-white"
                    : "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-white p-1 shadow-sm dark:bg-gray-800">
            <button
              type="button"
              data-testid="cal-prev"
              aria-label="Previous month"
              onClick={() => setCursor(new Date(year, month - 1, 1))}
              className="rounded p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-[140px] text-center text-sm font-semibold">
              {monthLabel}
            </span>
            <button
              type="button"
              data-testid="cal-next"
              aria-label="Next month"
              onClick={() => setCursor(new Date(year, month + 1, 1))}
              className="rounded p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              data-testid="cal-today"
              onClick={() => {
                const d = new Date();
                setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
              }}
              className="ml-2 rounded-md border px-2 py-0.5 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700"
            >
              Today
            </button>
          </div>
          {canCreate && (
            <button
              type="button"
              data-testid="cal-new-event"
              aria-label="New Event"
              onClick={() => setNewEventDate(todayYmd)}
              className="flex min-h-[40px] items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
            >
              <Plus size={16} aria-hidden="true" /> New Event
            </button>
          )}
        </div>
      </div>

      {/* Legend */}
      {/* Issue #659: the legend used to show every event category to every
          role, including PHARMACIST who has no surgical / ANC / follow-up
          context (and the calendar API doesn't even emit those event types
          for pharmacist). For pharmacist + lab-tech the legend collapses to
          the categories they can actually see — appointments, custom events
          and holidays — and stays self-documenting. */}
      <div className="flex flex-wrap gap-3 rounded-xl bg-white p-3 text-xs shadow-sm dark:bg-gray-800">
        <Legend color="bg-blue-500" Icon={CalendarIcon} label="Appointment" />
        {/* Issue #870: hide clinical-workflow categories (Surgery, ANC)
            from the PATIENT legend — these are staff/clinical taxonomy
            and have no place on a patient-facing calendar. Telemedicine
            and Follow-up are patient-relevant so they stay. */}
        {user?.role !== "PHARMACIST" && user?.role !== "LAB_TECH" && (
          <>
            {user?.role !== "PATIENT" && (
              <Legend color="bg-rose-500" Icon={Scissors} label="Surgery" />
            )}
            <Legend color="bg-purple-500" Icon={Video} label="Telemedicine" />
            {user?.role !== "PATIENT" && (
              <Legend color="bg-pink-500" Icon={Baby} label="ANC" />
            )}
            <Legend color="bg-emerald-500" Icon={FileText} label="Follow-up" />
          </>
        )}
        {user?.role === "ADMIN" && (
          <Legend color="bg-gray-500" Icon={UsersIcon} label="Shifts" />
        )}
        {/* Issue #718: ad-hoc events surfaced in the calendar. */}
        <Legend color="bg-amber-500" Icon={CalendarIcon} label="Custom Event" />
        {/* Issue #749: holiday cells render with a rose tint — included
            in the legend so the visual cue is self-documenting. */}
        <Legend color="bg-rose-200" Icon={CalendarIcon} label="Holiday" />
      </div>

      {loading && (
        <div className="rounded-xl bg-white p-4 text-center text-xs text-gray-400 shadow-sm dark:bg-gray-800 dark:text-gray-500">
          Loading events...
        </div>
      )}

      {/* Issue #431: Day / Week views — sliced from the same `byDate` map.
          The "Today" anchor for week view is `cursor` (set by the prev/next
          buttons); for the Day view we pin to today's date so toggling Day
          jumps you back to the live picture. */}
      {viewMode === "day" && (() => {
        // Issue #869: the Day view was a single "No events scheduled today"
        // banner with a near-invisible header in dark mode and no notion of
        // time-of-day at all — users had no way to see when slots would fit.
        // Render an 06:00–22:00 hour grid (matching the booking-page slot
        // window), bucket the day's events by hour, and pair every surface
        // with a dark: token so the date header is legible on a dark card.
        const dayEvents = byDate[todayYmd] || [];
        const HOUR_START = 6;
        const HOUR_END = 22;
        const eventsByHour: Record<number, CalEvent[]> = {};
        for (const ev of dayEvents) {
          const hh = ev.time ? parseInt(ev.time.slice(0, 2), 10) : NaN;
          const bucket = Number.isFinite(hh) ? hh : -1;
          if (!eventsByHour[bucket]) eventsByHour[bucket] = [];
          eventsByHour[bucket].push(ev);
        }
        const hours: number[] = [];
        for (let h = HOUR_START; h <= HOUR_END; h++) hours.push(h);
        const untimedEvents = eventsByHour[-1] || [];
        return (
          <div
            data-testid="cal-day-view"
            className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800"
          >
            <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
              {new Date().toLocaleDateString("en-IN", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </h2>
            {dayEvents.length === 0 && (
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                No events scheduled today.
              </p>
            )}
            {untimedEvents.length > 0 && (
              <div className="mb-3">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  All day
                </p>
                <ul className="space-y-1">
                  {untimedEvents.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(e)}
                        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-white ${e.color}`}
                      >
                        <span>{e.title}</span>
                        {e.subtitle && (
                          <span className="ml-auto truncate opacity-90">
                            {e.subtitle}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="rounded-lg border border-gray-200 dark:border-gray-700">
              {hours.map((h) => {
                const hourEvents = eventsByHour[h] || [];
                return (
                  <div
                    key={h}
                    className="grid grid-cols-[60px_1fr] border-b border-gray-200 last:border-b-0 dark:border-gray-700"
                    style={{ minHeight: "44px" }}
                  >
                    <div className="border-r border-gray-200 px-2 py-1 text-right text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
                      {String(h).padStart(2, "0")}:00
                    </div>
                    <div className="space-y-1 px-2 py-1">
                      {hourEvents.length === 0 ? (
                        <span className="block h-full" aria-hidden="true" />
                      ) : (
                        hourEvents.map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => setSelected(e)}
                            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-white ${e.color}`}
                          >
                            {e.time && (
                              <span className="font-semibold">{e.time}</span>
                            )}
                            <span className="truncate">{e.title}</span>
                            {e.subtitle && (
                              <span className="ml-auto truncate opacity-90">
                                {e.subtitle}
                              </span>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {viewMode === "week" && (() => {
        // Issue #868: Week view previously rendered a 7-cell strip with
        // NO hour grid and was anchored to `new Date()` regardless of the
        // user's prev/next navigation — clicking Week always jumped you
        // to "this week" and showed nothing if today's week had no events.
        // Two fixes here:
        //   1. Anchor the week to `cursor` (the same state prev/next
        //      drives) so the user's navigation is honored. If `cursor`
        //      sits in the same month as today, prefer today so the
        //      "Today" button feels natural; otherwise pick the first
        //      day of the cursor's month.
        //   2. Render an 06:00-22:00 hour grid (matching Day view and
        //      the booking-slot window) so events bucket into their
        //      start hour and the user can see when slots fit.
        const today = new Date();
        const anchor =
          cursor.getMonth() === today.getMonth() &&
          cursor.getFullYear() === today.getFullYear()
            ? today
            : new Date(cursor.getFullYear(), cursor.getMonth(), 1);
        const sun = new Date(anchor);
        sun.setDate(anchor.getDate() - anchor.getDay());
        const days: Date[] = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(sun);
          d.setDate(sun.getDate() + i);
          days.push(d);
        }
        const HOUR_START = 6;
        const HOUR_END = 22;
        const hours: number[] = [];
        for (let h = HOUR_START; h <= HOUR_END; h++) hours.push(h);
        // Bucket each day's events into hour rows — same shape as the
        // Day view so the user gets a real time-grid, not a flat strip.
        const dayBuckets = days.map((d) => {
          const ymd = fmtYmd(d);
          const evs = byDate[ymd] || [];
          const byHour: Record<number, CalEvent[]> = {};
          const untimed: CalEvent[] = [];
          for (const ev of evs) {
            if (!ev.time) {
              untimed.push(ev);
              continue;
            }
            const hh = parseInt(ev.time.slice(0, 2), 10);
            if (!Number.isFinite(hh)) {
              untimed.push(ev);
              continue;
            }
            const bucketHour = Math.min(Math.max(hh, HOUR_START), HOUR_END);
            (byHour[bucketHour] ||= []).push(ev);
          }
          return { d, ymd, byHour, untimed };
        });
        return (
          <div
            data-testid="cal-week-view"
            className="overflow-x-auto rounded-xl bg-white p-3 shadow-sm dark:bg-gray-800"
          >
            {/* Day-of-week header row */}
            <div
              className="grid border-b border-gray-200 dark:border-gray-700"
              style={{ gridTemplateColumns: "60px repeat(7, minmax(0, 1fr))" }}
            >
              <div />
              {dayBuckets.map(({ d, ymd, untimed }) => {
                const isToday = ymd === todayYmd;
                return (
                  <div
                    key={`hdr-${ymd}`}
                    className={`px-2 py-1.5 text-center text-[11px] font-semibold ${
                      isToday
                        ? "text-primary dark:text-blue-300"
                        : "text-gray-700 dark:text-gray-200"
                    }`}
                  >
                    <div>
                      {d.toLocaleDateString("en-IN", { weekday: "short" })}
                    </div>
                    <div className="text-sm font-bold">{d.getDate()}</div>
                    {untimed.length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {untimed.slice(0, 2).map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => setSelected(e)}
                            className={`block w-full truncate rounded px-1 py-0.5 text-left text-[9px] text-white ${e.color}`}
                            title={e.title}
                          >
                            {e.title}
                          </button>
                        ))}
                        {untimed.length > 2 && (
                          <p className="text-[9px] text-gray-500 dark:text-gray-400">
                            +{untimed.length - 2}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Hour-row time grid */}
            <div className="rounded-b-lg border-x border-b border-gray-200 dark:border-gray-700">
              {hours.map((h) => (
                <div
                  key={h}
                  className="grid border-b border-gray-200 last:border-b-0 dark:border-gray-700"
                  style={{
                    gridTemplateColumns: "60px repeat(7, minmax(0, 1fr))",
                    minHeight: "48px",
                  }}
                >
                  <div className="border-r border-gray-200 px-2 py-1 text-right text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    {String(h).padStart(2, "0")}:00
                  </div>
                  {dayBuckets.map(({ ymd, byHour }) => {
                    const cellEvents = byHour[h] || [];
                    return (
                      <div
                        key={`${ymd}-${h}`}
                        className="space-y-0.5 border-r border-gray-100 px-1 py-0.5 last:border-r-0 dark:border-gray-700"
                      >
                        {cellEvents.map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => setSelected(e)}
                            className={`block w-full truncate rounded px-1 py-0.5 text-left text-[10px] text-white ${e.color}`}
                            title={
                              e.time
                                ? `${e.time} — ${e.title}${e.subtitle ? ` · ${e.subtitle}` : ""}`
                                : e.title
                            }
                          >
                            {e.time && (
                              <span className="font-semibold">{e.time} · </span>
                            )}
                            {e.title}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Month grid */}
      {viewMode === "month" && (
      <div data-testid="cal-month-view" className="rounded-xl bg-white p-3 shadow-sm dark:bg-gray-800">
        <div className="mb-1 grid grid-cols-7 gap-1 text-center text-xs font-semibold text-gray-500 dark:text-gray-400">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="py-1">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (!d) return <div key={i} className="min-h-[96px] bg-gray-50/40" />;
            const ymd = fmtYmd(d);
            const dayEvents = byDate[ymd] || [];
            const isToday = ymd === todayYmd;
            // Issue #749: overlay holiday cells with a distinct rose
            // tint + tooltip so users see at a glance that the office
            // is closed / no slots are bookable. The tint sits BELOW
            // the today-highlight so the today bias still wins on a
            // day that happens to also be a holiday.
            const holiday = holidaysByDate[ymd];
            const cellTint = isToday
              ? "border-primary bg-blue-50/40"
              : holiday
                ? "border-rose-200 bg-rose-50/60"
                : "border-gray-100";
            return (
              <div
                key={i}
                title={holiday ? `${holiday.name} (${holiday.type})` : undefined}
                data-testid={holiday ? `cal-holiday-${ymd}` : undefined}
                data-holiday={holiday ? holiday.name : undefined}
                className={`min-h-[96px] rounded-lg border p-1.5 ${cellTint}`}
              >
                {/* Issue #749: holiday badge — tiny inline label so the
                    holiday is visible even if the user's pointer never
                    hovers the cell to surface the tooltip. */}
                {holiday && (
                  <div
                    className="mb-0.5 truncate text-[9px] font-semibold uppercase tracking-wide text-rose-700"
                    aria-label={`Holiday: ${holiday.name}`}
                  >
                    {holiday.name}
                  </div>
                )}
                {/* Issue #718: clicking a date cell's number opens the
                    New-Event dialog with that date pre-applied. The event
                    pills below own their own onClick (open detail), so we
                    keep the create affordance scoped to the date label
                    instead of the whole cell to avoid stealing clicks. */}
                {canCreate ? (
                  <button
                    type="button"
                    data-testid={`cal-cell-${ymd}`}
                    aria-label={`New event on ${d.toLocaleDateString("en-IN", { day: "numeric", month: "long" })}`}
                    onClick={() => setNewEventDate(ymd)}
                    className={`mb-1 block text-[11px] font-semibold hover:underline ${
                      isToday ? "text-primary" : "text-gray-500"
                    }`}
                  >
                    {d.getDate()}
                  </button>
                ) : (
                  <div
                    className={`mb-1 text-[11px] font-semibold ${
                      isToday ? "text-primary" : "text-gray-500"
                    }`}
                  >
                    {d.getDate()}
                  </div>
                )}
                <div className="space-y-0.5">
                  {dayEvents.slice(0, 3).map((e) => (
                    <button
                      key={e.id}
                      onClick={() => setSelected(e)}
                      className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] text-white ${e.color} hover:opacity-90`}
                      title={e.time ? `${e.time} — ${e.title}` : e.title}
                    >
                      {/* Issue #397: always surface the appointment start
                          time on the tile, not just the patient/doctor name.
                          The time is bolded so it's the first thing the user
                          parses. Falls back to title-only for events that
                          truly have no time (e.g. all-day ANC visits). */}
                      {e.time && (
                        <span className="font-semibold">{e.time} · </span>
                      )}
                      {e.title}
                    </button>
                  ))}
                  {dayEvents.length > 3 && (
                    <p className="text-[10px] font-medium text-gray-500 dark:text-gray-400">
                      +{dayEvents.length - 3} more
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      )}

      {/* Detail popup */}
      {selected && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-xl bg-white shadow-xl dark:bg-gray-800"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="flex items-center gap-2 font-semibold">
                <span className={`inline-block h-3 w-3 rounded ${selected.color}`} />
                {selected.title}
              </h3>
              <button
                onClick={() => setSelected(null)}
                className="text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200"
              >
                <X size={16} />
              </button>
            </div>
            <div className="space-y-2 p-4 text-sm">
              {selected.subtitle && <p>{selected.subtitle}</p>}
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {parseEventDate(selected.date).toLocaleDateString("en-IN", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
                {selected.time ? ` · ${selected.time}` : ""}
              </p>
              <p className="text-xs uppercase tracking-wide text-gray-400">
                {selected.type}
              </p>
              <Link
                href={selected.href}
                onClick={() => setSelected(null)}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
              >
                Open <Stethoscope size={14} />
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Issue #718: New-Event dialog. */}
      {newEventDate && canCreate && (
        <NewEventDialog
          initialDate={newEventDate}
          onClose={() => setNewEventDate(null)}
          onCreated={() => {
            setNewEventDate(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

// Issue #718: New-Event dialog. Title + start + end + category + color
// hint. End must strictly exceed start (mirrors the server-side Zod
// schema in @medcore/shared so we avoid a 400 round-trip). Category is
// fixed to the curated list — same enum the server validates against.
const NEW_EVENT_CATEGORIES = [
  { value: "TRAINING", label: "Training" },
  { value: "CLOSURE", label: "Closure" },
  { value: "TOWN_HALL", label: "Town Hall" },
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "MARKETING", label: "Marketing" },
  { value: "OTHER", label: "Other" },
] as const;

const NEW_EVENT_COLORS = [
  { value: "bg-amber-500", label: "Amber" },
  { value: "bg-sky-500", label: "Sky" },
  { value: "bg-violet-500", label: "Violet" },
  { value: "bg-rose-500", label: "Rose" },
  { value: "bg-emerald-500", label: "Emerald" },
  { value: "bg-slate-500", label: "Slate" },
] as const;

function NewEventDialog({
  initialDate,
  onClose,
  onCreated,
}: {
  initialDate: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] =
    useState<(typeof NEW_EVENT_CATEGORIES)[number]["value"]>("OTHER");
  const [date, setDate] = useState(initialDate);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [color, setColor] = useState<string>(NEW_EVENT_COLORS[0].value);
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const trimmed = title.trim();
    if (trimmed.length < 2) errs.title = "Title must be at least 2 characters";
    // Issue #944: surface the reject-not-strip contract in the UI so a
    // `<script>...</script>` paste shows an inline error instead of being
    // silently laundered into the saved title. Mirrors the server-side
    // refine in `createCalendarEventSchema` so the user can't bypass it.
    else if (containsHtmlOrScript(trimmed))
      errs.title = "Title contains disallowed characters or HTML";
    const trimmedDesc = description.trim();
    if (trimmedDesc && containsHtmlOrScript(trimmedDesc))
      errs.description = "Description contains disallowed characters or HTML";
    if (!date) errs.date = "Date is required";
    if (!startTime) errs.startTime = "Start time is required";
    if (!endTime) errs.endTime = "End time is required";
    // End-must-be-after-start: gate locally so we don't roundtrip a 400.
    const startISO = date && startTime ? `${date}T${startTime}:00` : "";
    const endISO = date && endTime ? `${date}T${endTime}:00` : "";
    const start = Date.parse(startISO);
    const end = Date.parse(endISO);
    if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
      errs.endTime = "End must be after start";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      await api.post("/calendar-events", {
        title: trimmed,
        category,
        startAt: new Date(startISO).toISOString(),
        endAt: new Date(endISO).toISOString(),
        color,
        description: description.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setErrors({
        _: err instanceof Error ? err.message : "Could not create event",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cal-new-event-title"
      data-testid="cal-new-event-modal"
    >
      <form
        onSubmit={submit}
        noValidate
        className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="cal-new-event-title" className="text-lg font-semibold">
            New Event
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label htmlFor="cal-new-event-title-input" className="block text-xs font-medium">
              Title
            </label>
            <input
              id="cal-new-event-title-input"
              data-testid="cal-new-event-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                errors.title ? "border-red-500" : "border-gray-200"
              }`}
            />
            {errors.title && (
              <p className="mt-1 text-xs text-red-600">{errors.title}</p>
            )}
          </div>
          <div>
            <label htmlFor="cal-new-event-category" className="block text-xs font-medium">
              Category
            </label>
            <select
              id="cal-new-event-category"
              data-testid="cal-new-event-category"
              value={category}
              onChange={(e) =>
                setCategory(
                  e.target.value as (typeof NEW_EVENT_CATEGORIES)[number]["value"]
                )
              }
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              {NEW_EVENT_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="cal-new-event-date" className="block text-xs font-medium">
              Date
            </label>
            <input
              id="cal-new-event-date"
              data-testid="cal-new-event-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                errors.date ? "border-red-500" : "border-gray-200"
              }`}
            />
            {errors.date && (
              <p className="mt-1 text-xs text-red-600">{errors.date}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="cal-new-event-start" className="block text-xs font-medium">
                Start
              </label>
              <input
                id="cal-new-event-start"
                data-testid="cal-new-event-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                  errors.startTime ? "border-red-500" : "border-gray-200"
                }`}
              />
            </div>
            <div>
              <label htmlFor="cal-new-event-end" className="block text-xs font-medium">
                End
              </label>
              <input
                id="cal-new-event-end"
                data-testid="cal-new-event-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                  errors.endTime ? "border-red-500" : "border-gray-200"
                }`}
              />
              {errors.endTime && (
                <p className="mt-1 text-xs text-red-600">{errors.endTime}</p>
              )}
            </div>
          </div>
          <div>
            <label htmlFor="cal-new-event-color" className="block text-xs font-medium">
              Color
            </label>
            <select
              id="cal-new-event-color"
              data-testid="cal-new-event-color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              {NEW_EVENT_COLORS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="cal-new-event-description" className="block text-xs font-medium">
              Description (optional)
            </label>
            <textarea
              id="cal-new-event-description"
              data-testid="cal-new-event-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm dark:bg-gray-900 dark:text-gray-100 ${
                errors.description
                  ? "border-red-500"
                  : "border-gray-200 dark:border-gray-700"
              }`}
            />
            {errors.description && (
              <p className="mt-1 text-xs text-red-600">{errors.description}</p>
            )}
          </div>
          {errors._ && (
            <p className="text-xs text-red-600">{errors._}</p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            data-testid="cal-new-event-save"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Saving..." : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Legend({
  color,
  Icon,
  label,
}: {
  color: string;
  Icon: React.ElementType;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 rounded ${color}`} />
      <Icon size={12} className="text-gray-500 dark:text-gray-400" />
      <span className="text-gray-700 dark:text-gray-200">{label}</span>
    </div>
  );
}
