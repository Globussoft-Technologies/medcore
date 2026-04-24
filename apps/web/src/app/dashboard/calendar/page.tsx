"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { formatDoctorName } from "@/lib/format-doctor-name";
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
    | "shift";
  href: string;
  color: string;
  raw?: any;
}

function fmtYmd(d: Date): string {
  return d.toISOString().split("T")[0];
}

function safe<T>(p: string, fb: T): Promise<T> {
  return api.get<T>(p).catch(() => fb);
}

export default function UnifiedCalendarPage() {
  const { user } = useAuthStore();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CalEvent | null>(null);

  // compute month bounds
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
      const [appts, surg, telemed, anc, rxFollow, shifts] = await Promise.all([
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
      ]);

      for (const a of appts.data || []) {
        const d = new Date(a.date);
        collected.push({
          id: `appt-${a.id}`,
          date: fmtYmd(d),
          time: a.slotStart || undefined,
          title: a.patient?.user?.name || "Patient",
          subtitle: `${a.type} · ${a.doctor?.user?.name ? formatDoctorName(a.doctor.user.name) : "—"}`,
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
          const d = new Date(v.scheduledDate);
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
        const d = new Date(rx.followUpDate);
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
        const d = new Date(sh.date);
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

      if (!cancelled) {
        setEvents(collected);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cursor, user]);

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
        <div className="flex items-center gap-2 rounded-lg bg-white p-1 shadow-sm">
          <button
            onClick={() => setCursor(new Date(year, month - 1, 1))}
            className="rounded p-1.5 hover:bg-gray-100"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[140px] text-center text-sm font-semibold">
            {monthLabel}
          </span>
          <button
            onClick={() => setCursor(new Date(year, month + 1, 1))}
            className="rounded p-1.5 hover:bg-gray-100"
          >
            <ChevronRight size={16} />
          </button>
          <button
            onClick={() => {
              const d = new Date();
              setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
            }}
            className="ml-2 rounded-md border px-2 py-0.5 text-xs hover:bg-gray-50"
          >
            Today
          </button>
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
      </div>

      {loading && (
        <div className="rounded-xl bg-white p-4 text-center text-xs text-gray-400 shadow-sm">
          Loading events...
        </div>
      )}

      {/* Month grid */}
      <div className="rounded-xl bg-white p-3 shadow-sm">
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
                <div
                  className={`mb-1 text-[11px] font-semibold ${
                    isToday ? "text-primary" : "text-gray-500"
                  }`}
                >
                  {d.getDate()}
                </div>
                <div className="space-y-0.5">
                  {dayEvents.slice(0, 3).map((e) => (
                    <button
                      key={e.id}
                      onClick={() => setSelected(e)}
                      className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] text-white ${e.color} hover:opacity-90`}
                      title={e.title}
                    >
                      {e.time ? `${e.time} ` : ""}
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
                {new Date(selected.date + "T00:00:00").toLocaleDateString(
                  "en-IN",
                  {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  }
                )}
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
