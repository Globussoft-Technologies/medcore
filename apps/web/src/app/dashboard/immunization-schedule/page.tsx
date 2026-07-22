"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { Syringe } from "lucide-react";
import { SkeletonTable } from "@/components/Skeleton";

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
  const { t } = useTranslation();
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

  function dueLabel(days: number | null): string {
    if (days == null) return "-";
    if (days < 0) return `${Math.abs(days)}${t("dashboard.immunizationSchedule.daysOverdueSuffix")}`;
    if (days === 0) return t("dashboard.immunizationSchedule.today");
    return `${t("dashboard.immunizationSchedule.daysUntilPrefix")}${days}${t("dashboard.immunizationSchedule.daysUntilSuffix")}`;
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Syringe size={24} className="text-primary" />
        <h1 className="text-2xl font-bold">{t("dashboard.immunizationSchedule.title")}</h1>
      </div>

      {/* Filters */}
      <div className="mb-4 flex gap-2">
        {(
          [
            { key: "week", label: t("dashboard.immunizationSchedule.filter.week") },
            { key: "month", label: t("dashboard.immunizationSchedule.filter.month") },
            { key: "overdue", label: t("dashboard.immunizationSchedule.filter.overdue") },
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
      <div className="overflow-hidden rounded-xl bg-white shadow-sm dark:bg-gray-800">
        {loading ? (
          <div
            data-testid="immunization-schedule-loading"
            aria-busy="true"
            className="p-4"
          >
            <SkeletonTable rows={5} columns={8} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            {t("dashboard.immunizationSchedule.noMatches")}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 dark:bg-gray-900/50 dark:text-gray-400">
              <tr>
                <th className="px-5 py-3 text-left">{t("dashboard.immunizationSchedule.col.patient")}</th>
                <th className="px-5 py-3 text-left">{t("dashboard.immunizationSchedule.col.mr")}</th>
                <th className="px-5 py-3 text-left">{t("dashboard.immunizationSchedule.col.vaccine")}</th>
                <th className="px-5 py-3 text-left">{t("dashboard.immunizationSchedule.col.dose")}</th>
                <th className="px-5 py-3 text-left">{t("dashboard.immunizationSchedule.col.lastGiven")}</th>
                <th className="px-5 py-3 text-left">{t("dashboard.immunizationSchedule.col.nextDue")}</th>
                <th className="px-5 py-3 text-left">{t("dashboard.immunizationSchedule.col.days")}</th>
                <th className="px-5 py-3 text-left">{t("common.phone")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const days = daysUntil(r.nextDueDate);
                return (
                  <tr
                    key={r.id}
                    className="border-t border-gray-100 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/dashboard/patients/${r.patientId}`}
                        className="font-medium text-primary hover:underline dark:text-blue-400"
                      >
                        {r.patient?.user?.name || "-"}
                      </Link>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
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
                      {dueLabel(days)}
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-500 dark:text-gray-400">
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
