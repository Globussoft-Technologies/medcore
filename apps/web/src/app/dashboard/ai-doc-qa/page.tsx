"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

interface DocQAReport {
  consultationId: string;
  score: number;
  completenessScore?: number;
  icdAccuracyScore?: number;
  medicationScore?: number;
  clarityScore?: number;
  issues: Array<{ category: string; severity: string; description: string }>;
  recommendations: string[];
  auditedAt: string;
}

function scoreColor(score: number): string {
  if (score >= 80) return "text-green-600 dark:text-green-400";
  if (score >= 60) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export default function AiDocQaPage() {
  const { user } = useAuthStore();
  const [reports, setReports] = useState<DocQAReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<DocQAReport | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: DocQAReport[] }>("/ai/doc-qa/reports?limit=50");
      setReports(res.data || []);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status === 503) {
        toast.error("DocQAReport model not yet migrated. See the deferred-migration note.");
      } else {
        toast.error(e.message || "Failed to load reports");
      }
      setReports([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (user?.role === "ADMIN") load();
  }, [user, load]);

  async function runSample() {
    setRunning(true);
    try {
      const res = await api.post<{ data: { sampled: number; audited: number } }>(
        "/ai/doc-qa/run-sample",
        { samplePct: 10, windowDays: 7 }
      );
      toast.success(
        `Sampled ${res.data.sampled} consultations, audited ${res.data.audited}`
      );
      await load();
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error(e.message || "Sample run failed");
    }
    setRunning(false);
  }

  if (user && user.role !== "ADMIN") {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        Admin only — documentation QA reports are restricted.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Clinical Documentation QA
        </h1>
        <button
          onClick={runSample}
          disabled={running}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-white disabled:opacity-60"
        >
          {running ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <ClipboardCheck className="h-4 w-4" />
          )}
          Run Sample Audit
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
            {loading ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>
            ) : reports.length === 0 ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                No reports yet. Click &quot;Run Sample Audit&quot; to generate.
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <th className="px-4 py-3">Audited</th>
                    <th className="px-4 py-3">Consultation ID</th>
                    <th className="px-4 py-3">Score</th>
                    <th className="px-4 py-3">Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr
                      key={r.consultationId}
                      data-testid="docqa-report-row"
                      onClick={() => setSelected(r)}
                      className="cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
                    >
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                        {new Date(r.auditedAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                        {r.consultationId.slice(0, 8)}…
                      </td>
                      <td className={`px-4 py-3 text-sm font-bold ${scoreColor(r.score)}`}>
                        {r.score}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                        {r.issues?.length || 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="lg:col-span-1">
          <div
            data-testid="docqa-detail"
            className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800"
          >
            <h2 className="mb-3 font-semibold text-gray-900 dark:text-gray-100">
              Report Detail
            </h2>
            {selected ? (
              <div>
                <div className="mb-3">
                  <div className="text-xs text-gray-500 dark:text-gray-400">Overall Score</div>
                  <div className={`text-4xl font-bold ${scoreColor(selected.score)}`}>
                    {selected.score}
                  </div>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-gray-50 p-2 dark:bg-gray-700/40">
                    <div className="text-gray-500">Completeness</div>
                    <div className={`font-semibold ${scoreColor(selected.completenessScore ?? 0)}`}>
                      {selected.completenessScore ?? "—"}
                    </div>
                  </div>
                  <div className="rounded bg-gray-50 p-2 dark:bg-gray-700/40">
                    <div className="text-gray-500">ICD</div>
                    <div className={`font-semibold ${scoreColor(selected.icdAccuracyScore ?? 0)}`}>
                      {selected.icdAccuracyScore ?? "—"}
                    </div>
                  </div>
                  <div className="rounded bg-gray-50 p-2 dark:bg-gray-700/40">
                    <div className="text-gray-500">Medication</div>
                    <div className={`font-semibold ${scoreColor(selected.medicationScore ?? 0)}`}>
                      {selected.medicationScore ?? "—"}
                    </div>
                  </div>
                  <div className="rounded bg-gray-50 p-2 dark:bg-gray-700/40">
                    <div className="text-gray-500">Clarity</div>
                    <div className={`font-semibold ${scoreColor(selected.clarityScore ?? 0)}`}>
                      {selected.clarityScore ?? "—"}
                    </div>
                  </div>
                </div>
                {selected.issues?.length > 0 && (
                  <div className="mb-3">
                    <div className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
                      Issues
                    </div>
                    <ul className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                      {selected.issues.map((i, idx) => (
                        <li key={idx}>
                          <span className="font-semibold">[{i.category} / {i.severity}]</span>{" "}
                          {i.description}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {selected.recommendations?.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
                      Recommendations
                    </div>
                    <ul className="list-inside list-disc space-y-1 text-xs text-gray-600 dark:text-gray-400">
                      {selected.recommendations.map((r, idx) => (
                        <li key={idx}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Select a report to see detail.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
