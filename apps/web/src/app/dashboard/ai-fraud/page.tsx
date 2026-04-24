"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck, Siren } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

// ─── Types ────────────────────────────────────────────────

type Severity = "INFO" | "SUSPICIOUS" | "HIGH_RISK";
type Status = "OPEN" | "ACKNOWLEDGED" | "DISMISSED" | "ESCALATED";

interface FraudAlert {
  id: string;
  type: string;
  severity: Severity;
  status: Status;
  entityType: string;
  entityId: string;
  description: string;
  evidence: Record<string, unknown>;
  detectedAt: string;
  acknowledgedBy?: string | null;
  acknowledgedAt?: string | null;
}

const SEVERITY_COLOR: Record<Severity, string> = {
  HIGH_RISK: "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-200 dark:border-red-800",
  SUSPICIOUS: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800",
  INFO: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-800",
};

const STATUS_COLOR: Record<Status, string> = {
  OPEN: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200",
  ACKNOWLEDGED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200",
  DISMISSED: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
  ESCALATED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-200",
};

export default function AiFraudPage() {
  const { user } = useAuthStore();
  const [alerts, setAlerts] = useState<FraudAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [severity, setSeverity] = useState<string>("");
  const [status, setStatus] = useState<string>("OPEN");
  const [windowDays, setWindowDays] = useState<number>(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (severity) qs.set("severity", severity);
      if (status) qs.set("status", status);
      qs.set("limit", "50");
      const res = await api.get<{ data: FraudAlert[] }>(`/ai/fraud/alerts?${qs.toString()}`);
      setAlerts(res.data || []);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status === 503) {
        toast.error("FraudAlert model not yet migrated. Ask DB admin to run the pending migration.");
      } else {
        toast.error(e.message || "Failed to load fraud alerts");
      }
      setAlerts([]);
    }
    setLoading(false);
  }, [severity, status]);

  useEffect(() => {
    if (user?.role === "ADMIN") load();
  }, [user, load]);

  async function runScan() {
    setScanning(true);
    try {
      const res = await api.post<{ data: { alertCount: number; hitCount: number } }>(
        "/ai/fraud/scan",
        { windowDays }
      );
      toast.success(
        `Scan complete — ${res.data.hitCount} hits, ${res.data.alertCount} persisted`
      );
      await load();
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error(e.message || "Scan failed");
    }
    setScanning(false);
  }

  async function acknowledge(id: string, newStatus: Status) {
    try {
      await api.post(`/ai/fraud/alerts/${id}/acknowledge`, { status: newStatus });
      toast.success(`Alert ${newStatus.toLowerCase()}`);
      await load();
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error(e.message || "Update failed");
    }
  }

  if (user && user.role !== "ADMIN") {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        <ShieldCheck className="mx-auto mb-2 h-10 w-10 text-gray-400" />
        Admin only — fraud alerts are restricted.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Fraud &amp; Anomaly Alerts
        </h1>
        <button
          onClick={runScan}
          disabled={scanning}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-white disabled:opacity-60"
        >
          {scanning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Siren className="h-4 w-4" />}
          Run Scan Now
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Severity</label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">All</option>
            <option value="HIGH_RISK">High Risk</option>
            <option value="SUSPICIOUS">Suspicious</option>
            <option value="INFO">Info</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="ACKNOWLEDGED">Acknowledged</option>
            <option value="ESCALATED">Escalated</option>
            <option value="DISMISSED">Dismissed</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
            Scan Window (days)
          </label>
          <input
            type="number"
            min={1}
            max={365}
            value={windowDays}
            onChange={(e) => setWindowDays(parseInt(e.target.value, 10) || 30)}
            className="w-28 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>
        ) : alerts.length === 0 ? (
          <div
            data-testid="fraud-empty-state"
            className="p-8 text-center text-gray-500 dark:text-gray-400"
          >
            <ShieldCheck className="mx-auto mb-2 h-10 w-10 text-green-500" />
            No matching alerts
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-3">Detected</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr
                  key={a.id}
                  data-testid="fraud-alert-row"
                  className="border-b border-gray-100 last:border-0 dark:border-gray-700"
                >
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                    {new Date(a.detectedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                    {a.type.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${SEVERITY_COLOR[a.severity]}`}
                    >
                      {a.severity === "HIGH_RISK" && <AlertTriangle className="h-3 w-3" />}
                      {a.severity.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[a.status]}`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                    <div>{a.description}</div>
                    {(a.evidence as { llmReason?: string } | undefined)?.llmReason ? (
                      <div className="mt-1 text-xs italic text-gray-500 dark:text-gray-400">
                        AI: {(a.evidence as { llmReason: string }).llmReason}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {a.status === "OPEN" ? (
                      <div className="flex gap-1">
                        <button
                          onClick={() => acknowledge(a.id, "ACKNOWLEDGED")}
                          className="rounded bg-blue-100 px-2 py-1 text-xs text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-200"
                        >
                          Ack
                        </button>
                        <button
                          onClick={() => acknowledge(a.id, "ESCALATED")}
                          className="rounded bg-red-100 px-2 py-1 text-xs text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-200"
                        >
                          Escalate
                        </button>
                        <button
                          onClick={() => acknowledge(a.id, "DISMISSED")}
                          className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200"
                        >
                          Dismiss
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
