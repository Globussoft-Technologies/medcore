"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { usePrompt } from "@/lib/use-dialog";
import { Syringe, RefreshCw } from "lucide-react";
import { SkeletonCard } from "@/components/Skeleton";

interface DueAdministration {
  id: string;
  scheduledAt: string;
  status: string;
  order: {
    id: string;
    dosage: string;
    route: string;
    medicine: { name: string; genericName?: string | null };
    admission: {
      id: string;
      patient: { user: { name: string }; mrNumber?: string };
      bed?: { bedNumber: string; ward: { id: string; name: string } };
    };
  };
}

interface Ward {
  id: string;
  name: string;
}

function urgencyClass(scheduledAt: string): {
  bg: string;
  label: string;
  order: number;
} {
  const diffMs = new Date(scheduledAt).getTime() - Date.now();
  const diffMin = diffMs / 60000;
  if (diffMin < 0)
    return { bg: "border-l-4 border-red-500 bg-red-50", label: "Overdue", order: 0 };
  if (diffMin <= 30)
    return {
      bg: "border-l-4 border-yellow-500 bg-yellow-50",
      label: "Due soon",
      order: 1,
    };
  return { bg: "border-l-4 border-blue-400 bg-blue-50", label: "Upcoming", order: 2 };
}

export default function MedicationDashboardPage() {
  const promptUser = usePrompt();
  const [items, setItems] = useState<DueAdministration[]>([]);
  const [wards, setWards] = useState<Ward[]>([]);
  const [wardFilter, setWardFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = wardFilter ? `?wardId=${wardFilter}` : "";
      const res = await api.get<{ data: DueAdministration[] }>(
        `/medication/administrations/due${q}`
      );
      setItems(res.data);
      setLastRefresh(new Date());
    } catch {
      // empty
    }
    setLoading(false);
  }, [wardFilter]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, [load]);

  useEffect(() => {
    api
      .get<{ data: Ward[] }>("/wards")
      .then((res) => setWards(res.data))
      .catch(() => {});
  }, []);

  async function updateStatus(id: string, status: string) {
    let notes: string | undefined;
    if (status === "MISSED" || status === "REFUSED" || status === "HOLD") {
      const reason = await promptUser({
        title: `Reason for ${status.toLowerCase()}?`,
        label: "Reason",
        multiline: true,
      });
      if (reason === null) return;
      notes = reason || undefined;
    }
    try {
      await api.patch(`/medication/administrations/${id}`, { status, notes });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  }

  // Group by patient (admission)
  const grouped = items.reduce(
    (acc, it) => {
      const key = it.order.admission.id;
      (acc[key] ||= { admission: it.order.admission, items: [] }).items.push(it);
      return acc;
    },
    {} as Record<
      string,
      { admission: DueAdministration["order"]["admission"]; items: DueAdministration[] }
    >
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
            <Syringe className="text-primary" /> Medication Administration
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Due and upcoming medications · Last refresh:{" "}
            {lastRefresh.toLocaleTimeString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={wardFilter}
            onChange={(e) => setWardFilter(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="">All Wards</option>
            {wards.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <button
            onClick={load}
            className="flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div
          data-testid="medication-dashboard-loading"
          aria-busy="true"
          className="space-y-3"
        >
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
          No medications due.
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([admissionId, group]) => (
            <div
              key={admissionId}
              className="rounded-xl bg-white p-5 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
            >
              <div className="mb-3 flex items-center justify-between border-b border-gray-200 pb-2 dark:border-gray-700">
                <div>
                  <h3 className="font-semibold">
                    {group.admission.patient.user.name}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    MR: {group.admission.patient.mrNumber} ·{" "}
                    {group.admission.bed
                      ? `${group.admission.bed.ward.name} / Bed ${group.admission.bed.bedNumber}`
                      : "—"}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                {group.items
                  .sort(
                    (a, b) =>
                      new Date(a.scheduledAt).getTime() -
                      new Date(b.scheduledAt).getTime()
                  )
                  .map((a) => {
                    const u = urgencyClass(a.scheduledAt);
                    return (
                      <div
                        key={a.id}
                        className={`flex flex-wrap items-center justify-between gap-3 rounded-lg p-3 ${u.bg}`}
                      >
                        <div className="flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold">
                              {a.order.medicine.name}
                            </span>
                            <span className="text-xs text-gray-600">
                              {a.order.dosage} · {a.order.route}
                            </span>
                            <span className="rounded bg-white px-1.5 py-0.5 text-xs font-medium">
                              {u.label}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-gray-600">
                            Scheduled:{" "}
                            {new Date(a.scheduledAt).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <button
                            onClick={() => updateStatus(a.id, "ADMINISTERED")}
                            className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                          >
                            Administer
                          </button>
                          <button
                            onClick={() => updateStatus(a.id, "MISSED")}
                            className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
                          >
                            Missed
                          </button>
                          <button
                            onClick={() => updateStatus(a.id, "REFUSED")}
                            className="rounded bg-orange-500 px-2 py-1 text-xs text-white hover:bg-orange-600"
                          >
                            Refused
                          </button>
                          <button
                            onClick={() => updateStatus(a.id, "HOLD")}
                            className="rounded bg-gray-500 px-2 py-1 text-xs text-white hover:bg-gray-600"
                          >
                            Hold
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
