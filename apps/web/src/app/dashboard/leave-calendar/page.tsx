"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

interface Leave {
  id: string;
  userId: string;
  type: string;
  fromDate: string;
  toDate: string;
  totalDays: number;
  reason: string;
  status: string;
  user?: { id: string; name: string; role: string };
}

const TYPE_COLORS: Record<string, string> = {
  CASUAL: "bg-blue-500",
  SICK: "bg-red-500",
  EARNED: "bg-green-500",
  MATERNITY: "bg-pink-500",
  PATERNITY: "bg-indigo-500",
  UNPAID: "bg-gray-500",
};

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function fmtISODate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function LeaveCalendarPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [anchor, setAnchor] = useState(() => startOfMonth(new Date()));
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, router]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const from = fmtISODate(startOfMonth(anchor));
        const to = fmtISODate(endOfMonth(anchor));
        // Issue #69 — pull APPROVED + PENDING in parallel so pending requests
        // (e.g. Anita Pawar's 5/4–5/6) are visible on the grid with a
        // distinct hatched style. Rejected/cancelled stay hidden.
        const [approvedRes, pendingRes] = await Promise.all([
          api.get<{ data: Leave[] }>(
            `/leaves?status=APPROVED&from=${from}&to=${to}`
          ),
          api
            .get<{ data: Leave[] }>(
              `/leaves?status=PENDING&from=${from}&to=${to}`
            )
            .catch(() => ({ data: [] as Leave[] })),
        ]);
        const merged = [...approvedRes.data, ...pendingRes.data];
        const start = startOfMonth(anchor).getTime();
        const end = endOfMonth(anchor).getTime();
        const filtered = merged.filter((l) => {
          const f = new Date(l.fromDate).getTime();
          const t = new Date(l.toDate).getTime();
          return t >= start && f <= end;
        });
        setLeaves(filtered);
      } catch {
        setLeaves([]);
      }
      setLoading(false);
    }
    if (user?.role === "ADMIN") load();
  }, [anchor, user]);

  const cells = useMemo(() => {
    const first = startOfMonth(anchor);
    const last = endOfMonth(anchor);
    const startWeekday = first.getDay(); // 0=Sun
    const daysInMonth = last.getDate();
    const arr: Array<{ date: Date | null }> = [];
    for (let i = 0; i < startWeekday; i++) arr.push({ date: null });
    for (let d = 1; d <= daysInMonth; d++) {
      arr.push({ date: new Date(anchor.getFullYear(), anchor.getMonth(), d) });
    }
    while (arr.length % 7 !== 0) arr.push({ date: null });
    return arr;
  }, [anchor]);

  function leavesOnDate(d: Date): Leave[] {
    return leaves.filter((l) => {
      const f = new Date(l.fromDate);
      const t = new Date(l.toDate);
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const fStart = new Date(f.getFullYear(), f.getMonth(), f.getDate());
      const tEnd = new Date(t.getFullYear(), t.getMonth(), t.getDate());
      return day >= fStart && day <= tEnd;
    });
  }

  function prevMonth() {
    setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
  }
  function nextMonth() {
    setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
  }

  if (user && user.role !== "ADMIN") return null;

  const selectedLeaves = selectedDate ? leavesOnDate(selectedDate) : [];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Leave Calendar</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={prevMonth}
            className="rounded-lg border bg-white p-2 hover:bg-gray-50"
          >
            <ChevronLeft size={16} />
          </button>
          <p className="min-w-40 text-center font-semibold">
            {anchor.toLocaleString("en-IN", {
              month: "long",
              year: "numeric",
            })}
          </p>
          <button
            onClick={nextMonth}
            className="rounded-lg border bg-white p-2 hover:bg-gray-50"
          >
            <ChevronRight size={16} />
          </button>
          <button
            onClick={() => setAnchor(startOfMonth(new Date()))}
            className="rounded-lg border bg-white px-3 py-2 text-sm hover:bg-gray-50"
          >
            Today
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="mb-4 flex flex-wrap gap-3 rounded-xl bg-white p-3 shadow-sm">
        {Object.entries(TYPE_COLORS).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 text-xs">
            <span className={`h-3 w-3 rounded ${v}`} />
            <span className="text-gray-700">{k}</span>
          </div>
        ))}
        {/* Issue #69 — pending swatch */}
        <div className="flex items-center gap-2 text-xs">
          <span className="h-3 w-3 rounded border border-dashed border-gray-500 bg-gray-300 opacity-60" />
          <span className="text-gray-700">PENDING (awaiting approval)</span>
        </div>
      </div>

      <div className="rounded-xl bg-white p-4 shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : (
          <>
            <div className="mb-1 grid grid-cols-7 text-center text-xs font-semibold text-gray-500">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d} className="py-2">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((c, i) => {
                if (!c.date)
                  return <div key={i} className="h-28 rounded bg-gray-50" />;
                const dayLeaves = leavesOnDate(c.date);
                const isToday = sameDay(c.date, new Date());
                return (
                  <button
                    key={i}
                    onClick={() => setSelectedDate(c.date)}
                    className={`h-28 overflow-hidden rounded border text-left transition hover:border-primary ${
                      isToday
                        ? "border-primary bg-primary/5"
                        : "border-gray-200 bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between px-2 pt-1">
                      <span
                        className={`text-xs font-semibold ${isToday ? "text-primary" : "text-gray-700"}`}
                      >
                        {c.date.getDate()}
                      </span>
                      {dayLeaves.length > 0 && (
                        <span className="rounded-full bg-gray-200 px-1.5 text-xs text-gray-700">
                          {dayLeaves.length}
                        </span>
                      )}
                    </div>
                    <div className="space-y-0.5 px-1 pt-1">
                      {dayLeaves.slice(0, 3).map((l) => {
                        // Issue #69 — pending leaves render at reduced opacity
                        // with a dashed border + striped hatch so admins can
                        // see them and act, but they're clearly not approved.
                        const isPending = l.status === "PENDING";
                        return (
                          <div
                            key={l.id}
                            className={`truncate rounded px-1 py-0.5 text-[10px] font-medium text-white ${
                              TYPE_COLORS[l.type] || "bg-gray-500"
                            } ${
                              isPending
                                ? "opacity-60 border border-dashed border-white/70 bg-stripe-overlay"
                                : ""
                            }`}
                            title={`${l.user?.name || "User"} · ${l.type}${
                              isPending ? " · PENDING" : ""
                            }`}
                            data-status={l.status}
                          >
                            {isPending ? "* " : ""}
                            {l.user?.name || "User"}
                          </div>
                        );
                      })}
                      {dayLeaves.length > 3 && (
                        <div className="px-1 text-[10px] text-gray-500">
                          +{dayLeaves.length - 3} more
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {selectedDate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setSelectedDate(null)}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                Leaves on{" "}
                {selectedDate.toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </h3>
              <button
                onClick={() => setSelectedDate(null)}
                className="rounded p-1 hover:bg-gray-100"
              >
                ×
              </button>
            </div>
            {selectedLeaves.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">
                No one is on leave this day.
              </p>
            ) : (
              <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                {selectedLeaves.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-start gap-3 rounded-lg border p-3"
                  >
                    <span
                      className={`mt-1 h-3 w-3 flex-shrink-0 rounded-full ${
                        TYPE_COLORS[l.type] || "bg-gray-400"
                      }`}
                    />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <p className="font-medium">
                          {l.user?.name || "Unknown"}
                        </p>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                          {l.user?.role}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500">
                        {l.type} · {new Date(l.fromDate).toLocaleDateString()} →{" "}
                        {new Date(l.toDate).toLocaleDateString()} ({l.totalDays}d)
                      </p>
                      {l.reason && (
                        <p className="mt-1 text-xs text-gray-600">
                          &ldquo;{l.reason}&rdquo;
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
