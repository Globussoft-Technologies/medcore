"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { Activity, CheckCircle, XCircle, Plus } from "lucide-react";

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

export default function LabQCPage() {
  const { user } = useAuthStore();
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
      toast.error("Failed to submit QC entry");
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
        { y: scaleY(mean), label: "Mean", color: "#059669" },
        { y: scaleY(mean + 2 * sd), label: "+2SD", color: "#d97706" },
        { y: scaleY(mean - 2 * sd), label: "-2SD", color: "#d97706" },
        { y: scaleY(mean + 3 * sd), label: "+3SD", color: "#dc2626" },
        { y: scaleY(mean - 3 * sd), label: "-3SD", color: "#dc2626" },
      ],
    };
  }, [entries, selectedTest]);

  if (!canView) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-6">
        <p className="text-red-700">Access denied.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="text-primary" size={28} />
          <div>
            <h1 className="text-2xl font-bold">Lab Quality Control</h1>
            <p className="text-sm text-gray-500">Daily QC tracking & Levey-Jennings</p>
          </div>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-2 rounded bg-primary px-4 py-2 text-sm text-white"
        >
          <Plus size={16} /> Record QC
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border bg-white p-4">
          <h2 className="mb-3 font-semibold">New QC Entry</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <select
              className="rounded border px-3 py-1.5 text-sm"
              value={form.testId}
              onChange={(e) => setForm({ ...form, testId: e.target.value })}
            >
              <option value="">Select test</option>
              {tests.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} — {t.name}
                </option>
              ))}
            </select>
            <select
              className="rounded border px-3 py-1.5 text-sm"
              value={form.qcLevel}
              onChange={(e) => setForm({ ...form, qcLevel: e.target.value })}
            >
              <option value="LOW">LOW</option>
              <option value="NORMAL">NORMAL</option>
              <option value="HIGH">HIGH</option>
              <option value="INTERNAL">INTERNAL</option>
            </select>
            <input
              className="rounded border px-3 py-1.5 text-sm"
              placeholder="Instrument"
              value={form.instrument}
              onChange={(e) => setForm({ ...form, instrument: e.target.value })}
            />
            <input
              className="rounded border px-3 py-1.5 text-sm"
              placeholder="Mean value"
              type="number"
              step="any"
              min="0"
              required
              value={form.meanValue}
              onChange={(e) => setForm({ ...form, meanValue: e.target.value })}
            />
            <input
              className="rounded border px-3 py-1.5 text-sm"
              placeholder="Recorded value"
              type="number"
              step="any"
              min="0"
              required
              value={form.recordedValue}
              onChange={(e) => setForm({ ...form, recordedValue: e.target.value })}
            />
            <input
              className="rounded border px-3 py-1.5 text-sm"
              placeholder="CV %"
              type="number"
              step="any"
              min="0"
              max="100"
              value={form.cv}
              onChange={(e) => setForm({ ...form, cv: e.target.value })}
            />
            <input
              className="col-span-2 rounded border px-3 py-1.5 text-sm md:col-span-3"
              placeholder="Notes"
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
              {submitting ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="rounded border px-4 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="mb-6">
        <h2 className="mb-2 font-semibold">Pass rate (last 30 days)</h2>
        {loading ? (
          <p className="text-gray-500">Loading...</p>
        ) : summary.length === 0 ? (
          <p className="text-gray-500">No QC data yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="p-2">Test</th>
                  <th className="p-2">Runs</th>
                  <th className="p-2">Pass</th>
                  <th className="p-2">Pass Rate</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr
                    key={r.testId}
                    className={`border-t ${r.passRate < 90 ? "bg-red-50" : ""}`}
                  >
                    <td className="p-2">
                      <span className="font-mono text-xs">{r.code}</span> {r.name}
                    </td>
                    <td className="p-2">{r.total}</td>
                    <td className="p-2">{r.pass}</td>
                    <td
                      className={`p-2 font-semibold ${
                        r.passRate < 90 ? "text-red-700" : "text-green-700"
                      }`}
                    >
                      {r.passRate}%
                    </td>
                    <td className="p-2">
                      <button
                        onClick={() => setSelectedTest(r.testId)}
                        className="text-xs text-primary underline"
                      >
                        View chart
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
        <div className="mb-6 rounded-lg border bg-white p-4">
          <h2 className="mb-2 font-semibold">
            Levey-Jennings — {tests.find((t) => t.id === selectedTest)?.name}
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
                  strokeDasharray={b.label === "Mean" ? "" : "4 4"}
                  strokeWidth={b.label === "Mean" ? 1.5 : 1}
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
        <h2 className="mb-2 font-semibold">Recent entries</h2>
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="p-2">Date</th>
                <th className="p-2">Test</th>
                <th className="p-2">Level</th>
                <th className="p-2">Mean</th>
                <th className="p-2">Recorded</th>
                <th className="p-2">CV</th>
                <th className="p-2">Status</th>
                <th className="p-2">By</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="p-2">{new Date(e.runDate).toLocaleString()}</td>
                  <td className="p-2">
                    <span className="font-mono text-xs">{e.test.code}</span> {e.test.name}
                  </td>
                  <td className="p-2">{e.qcLevel}</td>
                  <td className="p-2">{e.meanValue}</td>
                  <td className="p-2">{e.recordedValue}</td>
                  <td className="p-2">{e.cv ?? "—"}</td>
                  <td className="p-2">
                    {e.withinRange ? (
                      <span className="inline-flex items-center gap-1 text-green-700">
                        <CheckCircle size={14} /> Pass
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-red-700">
                        <XCircle size={14} /> Fail
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
