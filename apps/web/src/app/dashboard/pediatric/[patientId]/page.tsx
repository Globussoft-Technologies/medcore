"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { ArrowLeft, Plus, Baby } from "lucide-react";

interface GrowthRecord {
  id: string;
  measurementDate: string;
  ageMonths: number;
  weightKg?: number | null;
  heightCm?: number | null;
  headCircumference?: number | null;
  bmi?: number | null;
  weightPercentile?: number | null;
  heightPercentile?: number | null;
  milestoneNotes?: string | null;
  developmentalNotes?: string | null;
}

interface Patient {
  id: string;
  mrNumber: string;
  dateOfBirth?: string | null;
  age?: number | null;
  gender: string;
  user: { name: string; phone?: string };
}

const MILESTONE_MARKERS: Array<{ ageMonths: number; label: string }> = [
  { ageMonths: 2, label: "Smile" },
  { ageMonths: 4, label: "Head Control" },
  { ageMonths: 6, label: "Sit" },
  { ageMonths: 9, label: "Crawl" },
  { ageMonths: 12, label: "Walk" },
  { ageMonths: 18, label: "First Words" },
  { ageMonths: 24, label: "Sentences" },
];

export default function PediatricDetailPage() {
  const params = useParams();
  const patientId = params.patientId as string;
  const { user } = useAuthStore();

  const [patient, setPatient] = useState<Patient | null>(null);
  const [records, setRecords] = useState<GrowthRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    ageMonths: "",
    weightKg: "",
    heightCm: "",
    headCircumference: "",
    milestoneNotes: "",
    developmentalNotes: "",
    measurementDate: new Date().toISOString().slice(0, 10),
  });

  const canEdit =
    user?.role === "DOCTOR" || user?.role === "ADMIN" || user?.role === "NURSE";

  useEffect(() => {
    load();
  }, [patientId]);

  async function load() {
    setLoading(true);
    // Issue #170: each request must succeed-or-be-null independently.
    // Using Promise.all here meant a single 503 from /growth (e.g. for a
    // pediatric patient with zero growth records on a tenant where the
    // table snapshot was empty) tanked the WHOLE detail page and the user
    // never saw any data. allSettled isolates failures so the patient
    // header still renders even if a side-panel call fails.
    const [patRes, growthRes] = await Promise.allSettled([
      api.get<{ data: Patient }>(`/patients/${patientId}`),
      api.get<{ data: GrowthRecord[] }>(`/growth/patient/${patientId}`),
    ]);
    if (patRes.status === "fulfilled") {
      setPatient(patRes.value.data ?? null);
    } else {
      setPatient(null);
    }
    // Defensive: coerce to [] for every iterated array. The minified
    // "TypeError: r is not iterable" was caused by a server response that
    // returned `{ success: true, data: undefined }` for empty growth
    // tables; the spread `[...records.map(...)]` then exploded.
    if (growthRes.status === "fulfilled") {
      setRecords(Array.isArray(growthRes.value?.data) ? growthRes.value.data : []);
    } else {
      setRecords([]);
    }
    setLoading(false);
  }

  // Compute default age months from DOB
  const defaultAgeMonths = useMemo(() => {
    if (!patient?.dateOfBirth) return "";
    const diff = Date.now() - new Date(patient.dateOfBirth).getTime();
    return String(Math.floor(diff / (30.44 * 24 * 60 * 60 * 1000)));
  }, [patient]);

  useEffect(() => {
    if (defaultAgeMonths && !form.ageMonths) {
      setForm((f) => ({ ...f, ageMonths: defaultAgeMonths }));
    }
  }, [defaultAgeMonths]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Issue #220: at least one of weight / height / head-circumference
    // must be present — saving a row with only ageMonths produces a blank
    // growth record that isn't useful for chart trending.
    if (!form.weightKg && !form.heightCm && !form.headCircumference) {
      toast.error(
        "Enter at least one measurement (weight, height, or head circumference)."
      );
      return;
    }
    try {
      await api.post("/growth", {
        patientId,
        measurementDate: form.measurementDate,
        ageMonths: parseInt(form.ageMonths),
        weightKg: form.weightKg ? parseFloat(form.weightKg) : undefined,
        heightCm: form.heightCm ? parseFloat(form.heightCm) : undefined,
        headCircumference: form.headCircumference
          ? parseFloat(form.headCircumference)
          : undefined,
        milestoneNotes: form.milestoneNotes || undefined,
        developmentalNotes: form.developmentalNotes || undefined,
      });
      setShowForm(false);
      setForm({
        ageMonths: defaultAgeMonths,
        weightKg: "",
        heightCm: "",
        headCircumference: "",
        milestoneNotes: "",
        developmentalNotes: "",
        measurementDate: new Date().toISOString().slice(0, 10),
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add measurement");
    }
  }

  // Build chart SVG data
  const chartW = 700;
  const chartH = 260;
  const padL = 40;
  const padR = 20;
  const padT = 20;
  const padB = 30;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;

  function buildChart(
    data: Array<{ ageMonths: number; value: number | null | undefined }>,
    color: string,
    yMax: number,
    yLabel: string
  ) {
    const maxAge = Math.max(
      24,
      ...records.map((r) => r.ageMonths),
      ...MILESTONE_MARKERS.map((m) => m.ageMonths)
    );
    const scaleX = (age: number) => padL + (age / maxAge) * innerW;
    const scaleY = (v: number) => padT + innerH - (v / yMax) * innerH;

    const points = data
      .filter((d) => d.value != null)
      .sort((a, b) => a.ageMonths - b.ageMonths);

    const path = points
      .map(
        (p, i) => `${i === 0 ? "M" : "L"} ${scaleX(p.ageMonths)} ${scaleY(p.value!)}`
      )
      .join(" ");

    return (
      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full">
        {/* Y grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((r) => {
          const y = padT + innerH * (1 - r);
          return (
            <g key={r}>
              <line
                x1={padL}
                x2={chartW - padR}
                y1={y}
                y2={y}
                stroke="#eee"
                strokeWidth={1}
              />
              <text x={5} y={y + 4} fontSize={10} fill="#999">
                {Math.round(yMax * r)}
              </text>
            </g>
          );
        })}
        {/* X axis labels */}
        {[0, 6, 12, 18, 24, 36, 48, 60].filter((m) => m <= maxAge).map((m) => (
          <g key={m}>
            <line
              x1={scaleX(m)}
              x2={scaleX(m)}
              y1={padT}
              y2={padT + innerH}
              stroke="#f3f4f6"
              strokeWidth={1}
            />
            <text x={scaleX(m) - 8} y={chartH - 10} fontSize={10} fill="#999">
              {m}m
            </text>
          </g>
        ))}
        {/* Milestone markers */}
        {MILESTONE_MARKERS.filter((m) => m.ageMonths <= maxAge).map((m) => (
          <g key={m.label}>
            <line
              x1={scaleX(m.ageMonths)}
              x2={scaleX(m.ageMonths)}
              y1={padT}
              y2={padT + innerH}
              stroke="#fbbf24"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <text
              x={scaleX(m.ageMonths) + 2}
              y={padT + 10}
              fontSize={9}
              fill="#b45309"
            >
              {m.label}
            </text>
          </g>
        ))}
        {/* Line + points */}
        {path && <path d={path} fill="none" stroke={color} strokeWidth={2} />}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={scaleX(p.ageMonths)}
            cy={scaleY(p.value!)}
            r={4}
            fill={color}
          />
        ))}
        {/* Axis label */}
        <text x={padL} y={padT - 5} fontSize={11} fill="#374151" fontWeight={600}>
          {yLabel}
        </text>
      </svg>
    );
  }

  if (loading || !patient) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  }

  const weightData = records.map((r) => ({
    ageMonths: r.ageMonths,
    value: r.weightKg,
  }));
  const heightData = records.map((r) => ({
    ageMonths: r.ageMonths,
    value: r.heightCm,
  }));
  const hcData = records.map((r) => ({
    ageMonths: r.ageMonths,
    value: r.headCircumference,
  }));

  const maxWeight = Math.max(20, ...records.map((r) => r.weightKg || 0)) * 1.1;
  const maxHeight = Math.max(120, ...records.map((r) => r.heightCm || 0)) * 1.1;
  const maxHC =
    Math.max(55, ...records.map((r) => r.headCircumference || 0)) * 1.1;

  return (
    <div>
      <Link
        href="/dashboard/pediatric"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-primary"
      >
        <ArrowLeft size={14} /> Back to Pediatric
      </Link>

      {/* Patient Info */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{patient.user.name}</h1>
            <p className="text-sm text-gray-500">
              MR: {patient.mrNumber} · {patient.gender}
              {patient.dateOfBirth &&
                ` · DOB ${new Date(patient.dateOfBirth).toLocaleDateString()}`}
            </p>
            {defaultAgeMonths && (
              <p className="mt-1 text-sm">
                <strong>Current Age:</strong> {defaultAgeMonths} months
              </p>
            )}
          </div>
          {canEdit && (
            <button
              onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
            >
              <Plus size={14} /> Add Measurement
            </button>
          )}
        </div>
      </div>

      {showForm && (
        <form
          onSubmit={submit}
          className="mb-6 rounded-xl bg-white p-5 shadow-sm"
        >
          <h3 className="mb-3 font-semibold">Record Growth Measurement</h3>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium">Date</label>
              <input
                type="date"
                value={form.measurementDate}
                onChange={(e) =>
                  setForm({ ...form, measurementDate: e.target.value })
                }
                className="w-full rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">
                Age (months)
              </label>
              <input
                type="number"
                required
                min={0}
                value={form.ageMonths}
                onChange={(e) => setForm({ ...form, ageMonths: e.target.value })}
                className="w-full rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Weight (kg)</label>
              <input
                type="number"
                step="0.01"
                value={form.weightKg}
                onChange={(e) => setForm({ ...form, weightKg: e.target.value })}
                className="w-full rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Height (cm)</label>
              <input
                type="number"
                step="0.1"
                value={form.heightCm}
                onChange={(e) => setForm({ ...form, heightCm: e.target.value })}
                className="w-full rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">
                Head Circ. (cm)
              </label>
              <input
                type="number"
                step="0.1"
                value={form.headCircumference}
                onChange={(e) =>
                  setForm({ ...form, headCircumference: e.target.value })
                }
                className="w-full rounded border px-2 py-1.5 text-sm"
              />
            </div>
          </div>
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium">
              Milestone Notes
            </label>
            <input
              value={form.milestoneNotes}
              onChange={(e) =>
                setForm({ ...form, milestoneNotes: e.target.value })
              }
              placeholder="e.g. Started walking, saying 3 words"
              className="w-full rounded border px-2 py-1.5 text-sm"
            />
          </div>
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium">
              Developmental Notes
            </label>
            <textarea
              rows={2}
              value={form.developmentalNotes}
              onChange={(e) =>
                setForm({ ...form, developmentalNotes: e.target.value })
              }
              className="w-full rounded border px-2 py-1.5 text-sm"
            />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
            >
              Save Measurement
            </button>
          </div>
        </form>
      )}

      {/* Charts */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold">Weight vs Age</h3>
          {buildChart(weightData, "#3b82f6", maxWeight, "Weight (kg)")}
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold">Height vs Age</h3>
          {buildChart(heightData, "#10b981", maxHeight, "Height (cm)")}
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold">Head Circumference</h3>
          {buildChart(hcData, "#f59e0b", maxHC, "HC (cm)")}
        </div>
      </div>

      {/* Records Table */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <h3 className="mb-4 flex items-center gap-2 font-semibold">
          <Baby size={16} /> Growth Records
        </h3>
        {records.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-500">
            No measurements recorded yet.
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Age (mo)</th>
                <th className="px-3 py-2">Weight</th>
                <th className="px-3 py-2">Wt %ile</th>
                <th className="px-3 py-2">Height</th>
                <th className="px-3 py-2">Ht %ile</th>
                <th className="px-3 py-2">HC</th>
                <th className="px-3 py-2">BMI</th>
                <th className="px-3 py-2">Milestones</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="border-b text-sm last:border-0">
                  <td className="px-3 py-2">
                    {new Date(r.measurementDate).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2">{r.ageMonths}</td>
                  <td className="px-3 py-2">{r.weightKg ? `${r.weightKg} kg` : "—"}</td>
                  <td className="px-3 py-2">
                    {r.weightPercentile != null ? `P${r.weightPercentile}` : "—"}
                  </td>
                  <td className="px-3 py-2">{r.heightCm ? `${r.heightCm} cm` : "—"}</td>
                  <td className="px-3 py-2">
                    {r.heightPercentile != null ? `P${r.heightPercentile}` : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {r.headCircumference ? `${r.headCircumference} cm` : "—"}
                  </td>
                  <td className="px-3 py-2">{r.bmi ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.milestoneNotes || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* New Apr 2026 panels */}
      <FttBanner patientId={patientId} />
      <MilestonesPanel patientId={patientId} canEdit={canEdit} />
      <FeedingLogPanel patientId={patientId} canEdit={canEdit} />
    </div>
  );
}

// ─── Failure-to-Thrive banner ──────────────────────────

function FttBanner({ patientId }: { patientId: string }) {
  const [data, setData] = useState<{
    isFTT: boolean;
    reasons: string[];
    suggestions: string[];
    currentPercentile: number | null;
    velocityKgPerMonth: number | null;
    expectedVelocityKgPerMonth: number | null;
  } | null>(null);

  useEffect(() => {
    api
      .get<{ data: typeof data }>(`/growth/patient/${patientId}/ftt-check`)
      .then((r) => setData(r.data))
      .catch(() => setData(null));
  }, [patientId]);

  if (!data || !data.isFTT) return null;

  return (
    <div className="mb-6 rounded-xl border-l-4 border-red-500 bg-red-50 p-5">
      <h3 className="font-semibold text-red-800">⚠ Failure to Thrive Detected</h3>
      <ul className="mt-2 list-disc pl-6 text-sm text-red-700">
        {data.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      {data.suggestions.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-red-900">Suggestions</p>
          <ul className="list-disc pl-6 text-xs text-red-800">
            {data.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Milestones panel ──────────────────────────────────

interface MilestoneDiffItem {
  ageMonths: number;
  domain: string;
  milestone: string;
  status: "ACHIEVED" | "EXPECTED_NOT_ACHIEVED" | "UPCOMING" | "NOT_YET";
  achieved: boolean;
  achievedAt: string | null;
}

function MilestonesPanel({
  patientId,
  canEdit,
}: {
  patientId: string;
  canEdit: boolean;
}) {
  const [items, setItems] = useState<MilestoneDiffItem[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{
        data: { summary: { total: number; achieved: number; expectedNotAchieved: number }; diff: MilestoneDiffItem[] };
      }>(`/growth/patient/${patientId}/milestones`);
      // Issue #170: defensive — server may return data: null for a
      // pediatric patient missing DOB. Spread/for-of on undefined throws
      // "TypeError: r is not iterable".
      setItems(Array.isArray(res.data?.diff) ? res.data.diff : []);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [patientId]);

  async function toggle(item: MilestoneDiffItem, newAchieved: boolean) {
    try {
      await api.post(`/growth/milestones`, {
        patientId,
        ageMonths: item.ageMonths,
        domain: item.domain,
        milestone: item.milestone,
        achieved: newAchieved,
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  const byDomain = new Map<string, MilestoneDiffItem[]>();
  for (const it of items) {
    const arr = byDomain.get(it.domain) ?? [];
    arr.push(it);
    byDomain.set(it.domain, arr);
  }

  return (
    <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
      <h3 className="mb-3 font-semibold">Developmental Milestones</h3>
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">No data.</p>
      ) : (
        <div className="space-y-4">
          {Array.from(byDomain.entries()).map(([domain, list]) => (
            <div key={domain}>
              <p className="mb-2 text-xs font-semibold uppercase text-gray-600">
                {domain.replace("_", " ")}
              </p>
              <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                {list.map((it, i) => {
                  const statusColor =
                    it.status === "ACHIEVED"
                      ? "border-green-300 bg-green-50"
                      : it.status === "EXPECTED_NOT_ACHIEVED"
                        ? "border-red-300 bg-red-50"
                        : "border-gray-200 bg-white";
                  return (
                    <label
                      key={i}
                      className={`flex items-center gap-2 rounded border px-3 py-1.5 text-sm ${statusColor}`}
                    >
                      <input
                        type="checkbox"
                        checked={it.achieved}
                        disabled={!canEdit}
                        onChange={(e) => toggle(it, e.target.checked)}
                      />
                      <span className="text-xs text-gray-500">
                        {it.ageMonths}m
                      </span>
                      <span className="flex-1">{it.milestone}</span>
                      {it.status === "EXPECTED_NOT_ACHIEVED" && (
                        <span className="text-xs font-semibold text-red-700">
                          OVERDUE
                        </span>
                      )}
                    </label>
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

// ─── Feeding Log panel ─────────────────────────────────

interface FeedingLogItem {
  id: string;
  loggedAt: string;
  feedType: string;
  durationMin?: number | null;
  volumeMl?: number | null;
  foodItem?: string | null;
  notes?: string | null;
}

function FeedingLogPanel({
  patientId,
  canEdit,
}: {
  patientId: string;
  canEdit: boolean;
}) {
  const [logs, setLogs] = useState<FeedingLogItem[]>([]);
  const [daily, setDaily] = useState<
    Array<{ date: string; feeds: number; totalVolumeMl: number; totalDurationMin: number }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    feedType: "BREAST_LEFT",
    durationMin: "",
    volumeMl: "",
    foodItem: "",
    notes: "",
  });

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{
        data: { logs: FeedingLogItem[]; daily: typeof daily };
      }>(`/growth/patient/${patientId}/feeding?limit=100`);
      // Issue #170: defensive coercion — feeding log endpoint can return
      // an empty body for new pediatric patients; iterating undefined
      // throws "r is not iterable" in the daily-summary slice below.
      setLogs(Array.isArray(res.data?.logs) ? res.data.logs : []);
      setDaily(Array.isArray(res.data?.daily) ? res.data.daily : []);
    } catch {
      setLogs([]);
      setDaily([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [patientId]);

  async function add() {
    // Issue #221: empty Log feed previously POSTed an all-undefined row,
    // creating a 0-data feeding entry. Require at least one of duration,
    // volume, or food item before submit.
    if (!form.durationMin && !form.volumeMl && !form.foodItem.trim()) {
      toast.error(
        "Enter at least a duration, volume, or food item before logging."
      );
      return;
    }
    try {
      await api.post(`/growth/patient/${patientId}/feeding`, {
        feedType: form.feedType,
        durationMin: form.durationMin ? Number(form.durationMin) : undefined,
        volumeMl: form.volumeMl ? Number(form.volumeMl) : undefined,
        foodItem: form.foodItem || undefined,
        notes: form.notes || undefined,
      });
      setForm({ feedType: "BREAST_LEFT", durationMin: "", volumeMl: "", foodItem: "", notes: "" });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
      <h3 className="mb-3 font-semibold">Feeding Log</h3>
      {canEdit && (
        <div className="mb-4 rounded-lg border bg-gray-50 p-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <select
              value={form.feedType}
              onChange={(e) => setForm({ ...form, feedType: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            >
              <option value="BREAST_LEFT">Breast (L)</option>
              <option value="BREAST_RIGHT">Breast (R)</option>
              <option value="BOTTLE_FORMULA">Formula</option>
              <option value="BOTTLE_EBM">EBM</option>
              <option value="SOLID_FOOD">Solid food</option>
            </select>
            <input
              type="number"
              placeholder="Duration (min)"
              value={form.durationMin}
              onChange={(e) => setForm({ ...form, durationMin: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              type="number"
              placeholder="Volume (ml)"
              value={form.volumeMl}
              onChange={(e) => setForm({ ...form, volumeMl: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              placeholder="Food item (if solid)"
              value={form.foodItem}
              onChange={(e) => setForm({ ...form, foodItem: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <button
              onClick={add}
              className="rounded-lg bg-primary px-3 py-2 text-sm text-white"
            >
              Log feed
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <>
          {daily.length > 0 && (
            <div className="mb-3">
              <p className="mb-2 text-xs font-semibold text-gray-600">
                Daily Summary (last {daily.length} days)
              </p>
              <div className="flex flex-wrap gap-2 text-xs">
                {daily.slice(-7).map((d) => (
                  <div
                    key={d.date}
                    className="rounded border bg-gray-50 px-2 py-1"
                  >
                    <div className="font-semibold">{d.date}</div>
                    <div>{d.feeds} feeds · {d.totalVolumeMl}ml</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {logs.length === 0 ? (
            <p className="text-sm text-gray-500">No feeds logged yet.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-2 py-1 text-left">Time</th>
                    <th className="px-2 py-1 text-left">Type</th>
                    <th className="px-2 py-1">Duration</th>
                    <th className="px-2 py-1">Volume</th>
                    <th className="px-2 py-1 text-left">Food</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id} className="border-t">
                      <td className="px-2 py-1">
                        {new Date(l.loggedAt).toLocaleString()}
                      </td>
                      <td className="px-2 py-1">{l.feedType.replace("_", " ")}</td>
                      <td className="px-2 py-1 text-center">
                        {l.durationMin ? `${l.durationMin}m` : "-"}
                      </td>
                      <td className="px-2 py-1 text-center">
                        {l.volumeMl ? `${l.volumeMl}ml` : "-"}
                      </td>
                      <td className="px-2 py-1">{l.foodItem ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
