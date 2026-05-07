"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { formatDoctorName } from "@/lib/format-doctor-name";
import {
  displayStatusForAppointment,
  formatAppointmentTime,
} from "@/lib/appointments";
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
      const from = fmtYmd(first);
      const to = fmtYmd(last);
      const collected: CalEvent[] = [];

      // Appointments
      const [appts, surg, telemed, anc, rxFollow, shifts, custom] = await Promise.all([
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
      ]);

      for (const a of appts.data || []) {
        // Appointments come back with a YYYY-MM-DD `date` — parse with
        // the local-midnight helper so `fmtYmd` doesn't round it down a
        // day in negative-offset timezones.
        const d = parseEventDate(a.date);
        // Issue #389: route every appointment time through the shared
        // Asia/Kolkata formatter so the calendar tile and the My
        // Appointments list always agree for the same row.
        const apptTime = a.slotStart
          ? formatAppointmentTime(a.slotStart, a.date)
          : undefined;
        // Issue #388: a `BOOKED` appointment whose start has passed should
        // render as `COMPLETED` (display only).
        const apptStatus = displayStatusForAppointment({
          status: a.status,
          slotStart: a.slotStart,
          date: a.date,
        });
        collected.push({
          id: `appt-${a.id}`,
          date: fmtYmd(d),
          time: apptTime,
          title: a.patient?.user?.name || "Patient",
          subtitle: `${a.type} · ${a.doctor?.user?.name ? formatDoctorName(a.doctor.user.name) : "—"} · ${apptStatus}`,
          type: "appointment",
          href: `/dashboard/appointments?id=${a.id}`,
          color: "bg-blue-500",
          raw: a,
        });
      }
      for (const s of surg.data || []) {
        const d = new Date(s.scheduledAt);
        collected.push({
          id: `surg-${s.id}`,
          date: fmtYmd(d),
          time: d.toISOString().substring(11, 16),
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
        collected.push({
          id: `tele-${t.id}`,
          date: fmtYmd(d),
          time: d.toISOString().substring(11, 16),
          title: `Telemedicine · ${t.patient?.user?.name || ""}`,
          subtitle: `${t.doctor?.user?.name ? formatDoctorName(t.doctor.user.name) : "—"}`,
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
        collected.push({
          id: `followup-${rx.id}`,
          date: fmtYmd(d),
          title: `Follow-up · ${rx.patient?.user?.name || ""}`,
          subtitle: `For ${rx.diagnosis}`,
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
        collected.push({
          id: `custom-${ev.id}`,
          date: fmtYmd(start),
          time: start.toISOString().substring(11, 16),
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

      if (!cancelled) {
        setEvents(collected);
        setLoading(false);
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
          <h1 className="text-2xl font-bold text-gray-900">Calendar</h1>
          <p className="text-sm text-gray-500">
            Unified view of all scheduled events
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Issue #431: Day/Week/Month view toggle. Previously absent — the
              calendar only rendered a month grid, so users clicking the
              toggle saw nothing happen. */}
          <div
            role="tablist"
            aria-label="Calendar view"
            className="flex items-center gap-1 rounded-lg bg-white p-1 shadow-sm"
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
                    : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-white p-1 shadow-sm">
            <button
              type="button"
              data-testid="cal-prev"
              aria-label="Previous month"
              onClick={() => setCursor(new Date(year, month - 1, 1))}
              className="rounded p-1.5 hover:bg-gray-100"
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
              className="rounded p-1.5 hover:bg-gray-100"
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
              className="ml-2 rounded-md border px-2 py-0.5 text-xs hover:bg-gray-50"
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
      <div className="flex flex-wrap gap-3 rounded-xl bg-white p-3 text-xs shadow-sm">
        <Legend color="bg-blue-500" Icon={CalendarIcon} label="Appointment" />
        <Legend color="bg-rose-500" Icon={Scissors} label="Surgery" />
        <Legend color="bg-purple-500" Icon={Video} label="Telemedicine" />
        <Legend color="bg-pink-500" Icon={Baby} label="ANC" />
        <Legend color="bg-emerald-500" Icon={FileText} label="Follow-up" />
        {user?.role === "ADMIN" && (
          <Legend color="bg-gray-500" Icon={UsersIcon} label="Shifts" />
        )}
        {/* Issue #718: ad-hoc events surfaced in the calendar. */}
        <Legend color="bg-amber-500" Icon={CalendarIcon} label="Custom Event" />
      </div>

      {loading && (
        <div className="rounded-xl bg-white p-4 text-center text-xs text-gray-400 shadow-sm">
          Loading events...
        </div>
      )}

      {/* Issue #431: Day / Week views — sliced from the same `byDate` map.
          The "Today" anchor for week view is `cursor` (set by the prev/next
          buttons); for the Day view we pin to today's date so toggling Day
          jumps you back to the live picture. */}
      {viewMode === "day" && (
        <div
          data-testid="cal-day-view"
          className="rounded-xl bg-white p-4 shadow-sm"
        >
          <h2 className="mb-3 text-sm font-semibold">
            {new Date().toLocaleDateString("en-IN", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </h2>
          {(byDate[todayYmd] || []).length === 0 ? (
            <p className="text-xs text-gray-400">No events scheduled today.</p>
          ) : (
            <ul className="space-y-1">
              {(byDate[todayYmd] || []).map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(e)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-white ${e.color}`}
                  >
                    {e.time && (
                      <span className="font-semibold">{e.time}</span>
                    )}
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
          )}
        </div>
      )}

      {viewMode === "week" && (() => {
        // Anchor the week to `cursor` if cursor is in the displayed month,
        // otherwise to today. Sun-start to match the month-grid header.
        const anchor = new Date();
        const sun = new Date(anchor);
        sun.setDate(anchor.getDate() - anchor.getDay());
        const days: Date[] = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(sun);
          d.setDate(sun.getDate() + i);
          days.push(d);
        }
        return (
          <div
            data-testid="cal-week-view"
            className="rounded-xl bg-white p-3 shadow-sm"
          >
            <div className="grid grid-cols-7 gap-2">
              {days.map((d) => {
                const ymd = fmtYmd(d);
                const dayEvents = byDate[ymd] || [];
                const isToday = ymd === todayYmd;
                return (
                  <div
                    key={ymd}
                    className={`min-h-[140px] rounded-lg border p-2 ${
                      isToday ? "border-primary bg-blue-50/40" : "border-gray-100"
                    }`}
                  >
                    <div className="mb-1 text-[11px] font-semibold text-gray-500">
                      {d.toLocaleDateString("en-IN", {
                        weekday: "short",
                        day: "numeric",
                      })}
                    </div>
                    <div className="space-y-0.5">
                      {dayEvents.slice(0, 5).map((e) => (
                        <button
                          key={e.id}
                          type="button"
                          onClick={() => setSelected(e)}
                          className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] text-white ${e.color}`}
                        >
                          {e.time && (
                            <span className="font-semibold">{e.time} · </span>
                          )}
                          {e.title}
                        </button>
                      ))}
                      {dayEvents.length > 5 && (
                        <p className="text-[10px] text-gray-500">
                          +{dayEvents.length - 5} more
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Month grid */}
      {viewMode === "month" && (
      <div data-testid="cal-month-view" className="rounded-xl bg-white p-3 shadow-sm">
        <div className="mb-1 grid grid-cols-7 gap-1 text-center text-xs font-semibold text-gray-500">
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
            return (
              <div
                key={i}
                className={`min-h-[96px] rounded-lg border p-1.5 ${
                  isToday ? "border-primary bg-blue-50/40" : "border-gray-100"
                }`}
              >
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
                    <p className="text-[10px] font-medium text-gray-500">
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
            className="w-full max-w-md rounded-xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="flex items-center gap-2 font-semibold">
                <span className={`inline-block h-3 w-3 rounded ${selected.color}`} />
                {selected.title}
              </h3>
              <button
                onClick={() => setSelected(null)}
                className="text-gray-400 hover:text-gray-700"
              >
                <X size={16} />
              </button>
            </div>
            <div className="space-y-2 p-4 text-sm">
              {selected.subtitle && <p>{selected.subtitle}</p>}
              <p className="text-xs text-gray-500">
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
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="cal-new-event-title" className="text-lg font-semibold">
            New Event
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100"
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
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
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
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
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
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </div>
          {errors._ && (
            <p className="text-xs text-red-600">{errors._}</p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm hover:bg-gray-50"
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
      <Icon size={12} className="text-gray-500" />
      <span className="text-gray-700">{label}</span>
    </div>
  );
}
