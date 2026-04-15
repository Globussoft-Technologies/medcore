"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import { Activity } from "lucide-react";

interface ActivityEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  ipAddress: string | null;
  details: unknown;
  createdAt: string;
}

export default function MyActivityPage() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: ActivityEntry[] }>("/auth/my-activity");
      setEntries(res.data);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const allActions = useMemo(
    () => Array.from(new Set(entries.map((e) => e.action))).sort(),
    [entries]
  );

  const filtered = actionFilter
    ? entries.filter((e) => e.action === actionFilter)
    : entries;

  const grouped = filtered.reduce<Record<string, ActivityEntry[]>>((acc, e) => {
    const day = new Date(e.createdAt).toLocaleDateString();
    if (!acc[day]) acc[day] = [];
    acc[day].push(e);
    return acc;
  }, {});

  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold">
        <Activity size={22} /> My Activity
      </h1>

      <div className="mb-4 flex items-center gap-2">
        <label className="text-sm text-gray-500">Filter by action:</label>
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
        >
          <option value="">All actions</option>
          {allActions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : Object.keys(grouped).length === 0 ? (
        <p className="text-gray-500">No activity yet.</p>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([day, items]) => (
            <div key={day}>
              <h2 className="mb-2 text-sm font-semibold text-gray-500">{day}</h2>
              <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
                {items.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-start justify-between border-b border-gray-100 px-4 py-3 last:border-0 dark:border-gray-700"
                  >
                    <div>
                      <p className="text-sm font-medium">{e.action}</p>
                      <p className="text-xs text-gray-500">
                        {e.entity}
                        {e.entityId ? ` · ${e.entityId.slice(0, 8)}` : ""}
                      </p>
                    </div>
                    <p className="text-xs text-gray-400">
                      {new Date(e.createdAt).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
