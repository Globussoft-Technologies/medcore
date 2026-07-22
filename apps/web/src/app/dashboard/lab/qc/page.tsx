"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { Activity, CheckCircle, XCircle, Plus } from "lucide-react";
import { SkeletonTable } from "@/components/Skeleton";

interface LabTest {
  id: string;
  code: string;
  name: string;
}

interface QCEntry {
  id: string;
  testId: string;
  qcLevel: string;
  runDate: string;
  instrument?: string | null;
  meanValue: number;
  recordedValue: number;
  cv?: number | null;
  withinRange: boolean;
  notes?: string | null;
  test: { code: string; name: string };
  user: { id: string; name: string; role: string };
}

interface SummaryRow {
  testId: string;
  code: string;
  name: string;
  total: number;
  pass: number;
  passRate: number;
}

// Shared styling for the New-QC-Entry form controls. The form card renders on
// the dark dashboard layout, so without explicit colors these inputs inherit
// the layout's light text (dark:text-gray-100) and wash out against the white
// card; the dark variants give them a legible dark surface.
const MODAL_FIELD =
  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500";

export default function LabQCPage() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [entries, setEntries] = useState<QCEntry[]>([]);
  const [tests, setTests] = useState<LabTest[]>([]);
  const [selectedTest, setSelectedTest] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    testId: "",
    qcLevel: "NORMAL",
    instrument: "",
    meanValue: "",
    recordedValue: "",
    cv: "",
    notes: "",
  });
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const canView =
    user?.role === "ADMIN" || user?.role === "NURSE" || user?.role === "DOCTOR";

  const qcLevelLabel = (level: string) =>
    t(`dashboard.labQc.level.${level}`, level);
  const passFailLabel = (withinRange: boolean) =>
    withinRange ? t("dashboard.labQc.pass") : t("dashboard.labQc.fail");

  const loadAll = async () => {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([
        api.get<{ data: SummaryRow[] }>("/lab/qc/summary"),
        api.get<{ data: LabTest[] }>("/lab/tests"),
      ]);
      setSummary(s.data ?? []);
      setTests(t.data ?? []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const loadEntries = async () => {
    try {
      const qs = selectedTest ? `?testId=${selectedTest}` : "";
      const resp = await api.get<{ data: QCEntry[] }>(`/lab/qc${qs}`);
      setEntries(resp.data ?? []);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (canView) {
      loadAll();
    }
  }, [canView]);

  useEffect(() => {
    if (canView) loadEntries();
  }, [selectedTest, canView]);

  const submit = async () => {
    setSubmitting(true);
    try {
      const mean = parseFloat(form.meanValue);
      const rec = parseFloat(form.recordedValue);
      const sd = mean > 0 ? Math.abs(rec - mean) : 0;
      const within2sd = mean > 0 ? sd <= 0.2 * mean : true; // crude within-range using 20% of mean
      await api.post("/lab/qc", {
        testId: form.testId,
        qcLevel: form.qcLevel,
        instrument: form.instrument || undefined,
        meanValue: mean,
        recordedValue: rec,
        cv: form.cv ? parseFloat(form.cv) : undefined,
        withinRange: within2sd,
        notes: form.notes || undefined,
      });
      setShowForm(false);
      setForm({
        testId: "",
        qcLevel: "NORMAL",
        instrument: "",
        meanValue: "",
        recordedValue: "",
        cv: "",
        notes: "",
      });
      await loadAll();
      await loadEntries();
    } catch (e) {
      console.error(e);
      toast.error(t("dashboard.labQc.error.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  // Levey-Jennings SVG for selected test
  const chartPoints = useMemo(() => {
    if (!selectedTest) return null;
    const list = entries
      .filter((e) => e.testId === selectedTest)
      .slice(0, 30)
      .reverse();
    if (list.length === 0) return null;
    const mean = list[list.length - 1].meanValue;
    // crude SD: use 10% of mean as proxy
    const sd = Math.max(0.01, 0.1 * mean);
    const min = mean - 4 * sd;
    const max = mean + 4 * sd;
    const w = 600;
    const h = 220;
    const pad = 30;
    const dx = (w - pad * 2) / Math.max(1, list.length - 1);
    const scaleY = (v: number) =>
      h - pad - ((v - min) / (max - min)) * (h - pad * 2);
    const points = list.map((e, i) => ({
      x: pad + i * dx,
      y: scaleY(e.recordedValue),
      v: e.recordedValue,
      within: e.withinRange,
      date: e.runDate,
    }));
    return {
      mean,
      sd,
      min,
      max,
      w,
      h,
      pad,
      points,
      bands: [
        {
          y: scaleY(mean),
          label: t("dashboard.labQc.col.mean"),
          isMean: true,
          color: "#059669",
        },
        { y: scaleY(mean + 2 * sd), label: "+2SD", color: "#d97706" },
        { y: scaleY(mean - 2 * sd), label: "-2SD", color: "#d97706" },
        { y: scaleY(mean + 3 * sd), label: "+3SD", color: "#dc2626" },
        { y: scaleY(mean - 3 * sd), label: "-3SD", color: "#dc2626" },
      ],
    };
  }, [entries, selectedTest, t]);

  if (!canView) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-6">
        <p className="text-red-700">{t("dashboard.labQc.accessDenied")}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="text-primary" size={28} />
          <div>
            <h1 className="text-2xl font-bold">{t("dashboard.labQc.title")}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t("dashboard.labQc.subtitle")}</p>
          </div>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-2 rounded bg-primary px-4 py-2 text-sm text-white"
        >
          <Plus size={16} /> {t("dashboard.labQc.recordQc")}
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border bg-white p-4 text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
          <h2 className="mb-3 font-semibold">{t("dashboard.labQc.newEntry")}</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <select
              className={MODAL_FIELD}
              value={form.testId}
              onChange={(e) => setForm({ ...form, testId: e.target.value })}
            >
              <option value="">{t("dashboard.labQc.selectTest")}</option>
              {tests.map((test) => (
                <option key={test.id} value={test.id}>
                  {test.code} — {test.name}
                </option>
              ))}
            </select>
            <select
              className={MODAL_FIELD}
              value={form.qcLevel}
              onChange={(e) => setForm({ ...form, qcLevel: e.target.value })}
            >
              <option value="LOW">{qcLevelLabel("LOW")}</option>
              <option value="NORMAL">{qcLevelLabel("NORMAL")}</option>
              <option value="HIGH">{qcLevelLabel("HIGH")}</option>
              <option value="INTERNAL">{qcLevelLabel("INTERNAL")}</option>
            </select>
            <input
              className={MODAL_FIELD}
              placeholder={t("dashboard.labQc.instrument")}
              value={form.instrument}
              onChange={(e) => setForm({ ...form, instrument: e.target.value })}
            />
            <input
              className={MODAL_FIELD}
              placeholder={t("dashboard.labQc.meanValue")}
              type="number"
              step="any"
              min="0"
              required
              value={form.meanValue}
              onChange={(e) => setForm({ ...form, meanValue: e.target.value })}
            />
            <input
              className={MODAL_FIELD}
              placeholder={t("dashboard.labQc.recordedValue")}
              type="number"
              step="any"
              min="0"
              required
              value={form.recordedValue}
              onChange={(e) => setForm({ ...form, recordedValue: e.target.value })}
            />
            <input
              className={MODAL_FIELD}
              placeholder={t("dashboard.labQc.cvPercent")}
              type="number"
              step="any"
              min="0"
              max="100"
              value={form.cv}
              onChange={(e) => setForm({ ...form, cv: e.target.value })}
            />
            <input
              className={`col-span-2 md:col-span-3 ${MODAL_FIELD}`}
              placeholder={t("common.notes")}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={submit}
              disabled={submitting || !form.testId || !form.meanValue || !form.recordedValue}
              className="rounded bg-primary px-4 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {submitting ? t("common.saving") : t("common.save")}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="rounded border px-4 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="mb-6">
        <h2 className="mb-2 font-semibold">{t("dashboard.labQc.passRate30")}</h2>
        {loading ? (
          <div
            data-testid="lab-qc-loading"
            aria-busy="true"
            className="overflow-x-auto rounded-lg border bg-white p-2 dark:border-gray-700 dark:bg-gray-800"
          >
            <SkeletonTable rows={5} columns={5} />
          </div>
        ) : summary.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400">{t("dashboard.labQc.noData")}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-white dark:border-gray-700 dark:bg-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-gray-900/40 dark:text-gray-300">
                <tr>
                  <th className="p-2">{t("dashboard.labQc.col.test")}</th>
                  <th className="p-2">{t("dashboard.labQc.col.runs")}</th>
                  <th className="p-2">{t("dashboard.labQc.col.pass")}</th>
                  <th className="p-2">{t("dashboard.labQc.col.passRate")}</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr
                    key={r.testId}
                    className={`border-t dark:border-gray-700 ${r.passRate < 90 ? "bg-red-50" : ""}`}
                  >
                    <td className="p-2">
                      <span className="font-mono text-xs">{r.code}</span> {r.name}
                    </td>
                    <td className="p-2">{r.total}</td>
                    <td className="p-2">{r.pass}</td>
                    <td
                      className={`p-2 font-semibold ${
                        r.passRate < 90 ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400"
                      }`}
                    >
                      {r.passRate}%
                    </td>
                    <td className="p-2">
                      <button
                        onClick={() => setSelectedTest(r.testId)}
                        className="text-xs text-primary underline"
                      >
                        {t("dashboard.labQc.viewChart")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Levey-Jennings chart for selected test */}
      {selectedTest && chartPoints && (
        <div className="mb-6 rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="mb-2 font-semibold">
            {t("dashboard.labQc.chartTitle")} — {tests.find((test) => test.id === selectedTest)?.name}
          </h2>
          <svg
            viewBox={`0 0 ${chartPoints.w} ${chartPoints.h}`}
            className="w-full"
          >
            {chartPoints.bands.map((b, i) => (
              <g key={i}>
                <line
                  x1={chartPoints.pad}
                  x2={chartPoints.w - chartPoints.pad}
                  y1={b.y}
                  y2={b.y}
                  stroke={b.color}
                  strokeDasharray={b.isMean ? "" : "4 4"}
                  strokeWidth={b.isMean ? 1.5 : 1}
                />
                <text x={chartPoints.w - chartPoints.pad + 2} y={b.y + 4} fontSize="10" fill={b.color}>
                  {b.label}
                </text>
              </g>
            ))}
            {chartPoints.points.slice(1).map((p, i) => {
              const prev = chartPoints.points[i];
              return (
                <line
                  key={`l${i}`}
                  x1={prev.x}
                  y1={prev.y}
                  x2={p.x}
                  y2={p.y}
                  stroke="#334155"
                  strokeWidth={1}
                />
              );
            })}
            {chartPoints.points.map((p, i) => (
              <circle
                key={`c${i}`}
                cx={p.x}
                cy={p.y}
                r={4}
                fill={p.within ? "#059669" : "#dc2626"}
                stroke="#fff"
              />
            ))}
          </svg>
        </div>
      )}

      {/* Recent entries */}
      <div>
        <h2 className="mb-2 font-semibold">{t("dashboard.labQc.recentEntries")}</h2>
        <div className="overflow-x-auto rounded-lg border bg-white dark:border-gray-700 dark:bg-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-gray-900/40 dark:text-gray-300">
              <tr>
                <th className="p-2">{t("dashboard.labQc.col.date")}</th>
                <th className="p-2">{t("dashboard.labQc.col.test")}</th>
                <th className="p-2">{t("dashboard.labQc.col.level")}</th>
                <th className="p-2">{t("dashboard.labQc.col.mean")}</th>
                <th className="p-2">{t("dashboard.labQc.col.recorded")}</th>
                <th className="p-2">{t("dashboard.labQc.col.cv")}</th>
                <th className="p-2">{t("common.status")}</th>
                <th className="p-2">{t("dashboard.labQc.col.by")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t dark:border-gray-700">
                  <td className="p-2">{new Date(e.runDate).toLocaleString()}</td>
                  <td className="p-2">
                    <span className="font-mono text-xs">{e.test.code}</span> {e.test.name}
                  </td>
                  <td className="p-2">{qcLevelLabel(e.qcLevel)}</td>
                  <td className="p-2">{e.meanValue}</td>
                  <td className="p-2">{e.recordedValue}</td>
                  <td className="p-2">{e.cv ?? "—"}</td>
                  <td className="p-2">
                    {e.withinRange ? (
                      <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                        <CheckCircle size={14} /> {passFailLabel(e.withinRange)}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
                        <XCircle size={14} /> {passFailLabel(e.withinRange)}
                      </span>
                    )}
                  </td>
                  <td className="p-2">{e.user.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
