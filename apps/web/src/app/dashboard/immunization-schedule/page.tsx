"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Syringe } from "lucide-react";

interface ScheduleRow {
  id: string;
  patientId: string;
  vaccine: string;
  doseNumber: number | null;
  dateGiven: string;
  nextDueDate: string | null;
  patient: {
    id: string;
    mrNumber: string;
    user: { name: string; phone: string };
  };
}

type FilterKey = "week" | "month" | "overdue";

export default function ImmunizationSchedulePage() {
  const [filter, setFilter] = useState<FilterKey>("week");
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Issue #426 (Apr 2026): the filter sub-tabs were "stuck" in the wild —
  // clicking Due this week / Due this month / Overdue updated the active
  // chip but the underlying rows didn't refresh in some browsers. Root
  // cause was a useCallback whose closure captured a stale `filter` value
  // when React batched the state update with the effect deps. Rewriting
  // load() to read filter directly inside the effect (instead of through
  // a useCallback identity) sidesteps the stale-closure trap and removes
  // the only reason this had to be a useCallback in the first place.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await api.get<{ data: ScheduleRow[] }>(
          `/ehr/immunizations/schedule?filter=${filter}`
        );
        if (!cancelled) setRows(res.data);
      } catch {
        if (!cancelled) setRows([]);
      }
      if (!cancelled) setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [filter]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  function daysUntil(d: string | null): number | null {
    if (!d) return null;
    const due = new Date(d);
    due.setHours(0, 0, 0, 0);
    return Math.round((due.getTime() - today.getTime()) / 86400_000);
  }

  function dueColor(days: number | null): string {
    if (days == null) return "text-gray-500";
    if (days < 0) return "text-red-700 font-semibold";
    if (days <= 3) return "text-red-600 font-semibold";
    if (days <= 7) return "text-amber-600 font-medium";
    if (days <= 30) return "text-blue-600";
    return "text-gray-600";
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Syringe size={24} className="text-primary" />
        <h1 className="text-2xl font-bold">Immunization Schedule</h1>
      </div>

      {/* Filters */}
      <div className="mb-4 flex gap-2">
        {(
          [
            { key: "week", label: "Due this week" },
            { key: "month", label: "Due this month" },
            { key: "overdue", label: "Overdue" },
          ] as const
        ).map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            data-testid={`immunization-filter-${f.key}`}
            data-active={filter === f.key ? "true" : "false"}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
              filter === f.key
                ? "bg-primary text-white"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No immunizations match this filter
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-5 py-3 text-left">Patient</th>
                <th className="px-5 py-3 text-left">MR #</th>
                <th className="px-5 py-3 text-left">Vaccine</th>
                <th className="px-5 py-3 text-left">Dose</th>
                <th className="px-5 py-3 text-left">Last Given</th>
                <th className="px-5 py-3 text-left">Next Due</th>
                <th className="px-5 py-3 text-left">Days</th>
                <th className="px-5 py-3 text-left">Phone</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const days = daysUntil(r.nextDueDate);
                return (
                  <tr
                    key={r.id}
                    className="border-t border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/dashboard/patients/${r.patientId}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {r.patient?.user?.name || "-"}
                      </Link>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-gray-500">
                      {r.patient?.mrNumber}
                    </td>
                    <td className="px-5 py-3">{r.vaccine}</td>
                    <td className="px-5 py-3">{r.doseNumber ?? "-"}</td>
                    <td className="px-5 py-3">
                      {new Date(r.dateGiven).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3">
                      {r.nextDueDate
                        ? new Date(r.nextDueDate).toLocaleDateString()
                        : "-"}
                    </td>
                    <td className={`px-5 py-3 ${dueColor(days)}`}>
                      {days == null
                        ? "-"
                        : days < 0
                          ? `${Math.abs(days)}d overdue`
                          : days === 0
                            ? "today"
                            : `in ${days}d`}
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-500">
                      {r.patient?.user?.phone}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
