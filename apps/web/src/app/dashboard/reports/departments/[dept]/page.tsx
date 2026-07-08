"use client";

// Expanded per-department report (admin only). Drill-down target of the
// Reports → Departments tab. Shows, for one department over a date range:
//   • KPI tiles (appointments / completed / patients / revenue)
//   • Appointments-over-time column chart (with completed overlay)
//   • Revenue-over-time column chart
//   • Appointment status breakdown
//   • Top doctors, top medicines, top lab tests, top diagnoses (ranked bars)
// The quick-range presets (Today/7d/1mo/1yr/All) + From/To pickers work
// together and drive GET /analytics/departments/:department. ADMIN-gated both
// here (redirect) and server-side (authorize(Role.ADMIN)).

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { ArrowLeft, Calendar, Users, CheckCircle, DollarSign } from "lucide-react";
import { SkeletonCard } from "@/components/Skeleton";
import { RankedBars, TimeSeriesBars } from "../../_charts";

interface DeptDetail {
  department: string;
  doctorCount: number;
  appointmentsByDay: Array<{ day: string; count: number; completed: number }>;
  statusBreakdown: Record<string, number>;
  revenueByDay: Array<{ day: string; revenue: number }>;
  totals: { appointments: number; completed: number; patients: number; revenue: number };
  topDoctors: Array<{ doctorId: string; doctorName: string; appointmentCount: number }>;
  topMedicines: Array<{ name: string; count: number }>;
  topLabTests: Array<{ name: string; count: number }>;
  topDiagnoses: Array<{ name: string; count: number }>;
}

type QuickRange = "today" | "7d" | "1mo" | "1yr" | "all";
const QUICK_RANGES: Array<{ key: QuickRange; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "1mo", label: "1 month" },
  { key: "1yr", label: "1 year" },
  { key: "all", label: "All" },
];

function fmtCurrency(n: number): string {
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export default function DepartmentDetailPage() {
  const params = useParams();
  const search = useSearchParams();
  const router = useRouter();
  const { user } = useAuthStore();

  const deptParam = decodeURIComponent(
    Array.isArray(params.dept) ? params.dept[0] : (params.dept as string) || ""
  );

  const [from, setFrom] = useState<string>(() => {
    const q = search.get("from");
    if (q) return q;
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().split("T")[0];
  });
  const [to, setTo] = useState<string>(
    () => search.get("to") || new Date().toISOString().split("T")[0]
  );
  const [preset, setPreset] = useState<QuickRange | null>(null);
  const [data, setData] = useState<DeptDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // ADMIN-only (mirrors the server authorize + the parent Reports page).
  useEffect(() => {
    if (user && user.role !== "ADMIN") router.push("/dashboard");
  }, [user, router]);

  const applyQuickRange = useCallback((p: QuickRange) => {
    setPreset(p);
    const today = new Date();
    const start = new Date(today);
    if (p === "today") {
      /* from == to */
    } else if (p === "7d") start.setDate(start.getDate() - 6);
    else if (p === "1mo") start.setMonth(start.getMonth() - 1);
    else if (p === "1yr") start.setFullYear(start.getFullYear() - 1);
    else if (p === "all") start.setFullYear(2000, 0, 1);
    setFrom(start.toISOString().split("T")[0]);
    setTo(today.toISOString().split("T")[0]);
  }, []);

  const load = useCallback(async () => {
    if (!deptParam) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", new Date(from).toISOString());
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        qs.set("to", end.toISOString());
      }
      const res = await api.get<{ data: DeptDetail }>(
        `/analytics/departments/${encodeURIComponent(deptParam)}?${qs.toString()}`
      );
      setData(res?.data ?? null);
    } catch {
      setData(null);
    }
    setLoading(false);
  }, [deptParam, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  if (user && user.role !== "ADMIN") return null;

  const statusEntries = data ? Object.entries(data.statusBreakdown) : [];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <Link
          href="/dashboard/reports"
          className="mb-2 inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
        >
          <ArrowLeft size={16} /> Back to reports
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {deptParam} department
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {data ? `${data.doctorCount} doctor(s)` : "Loading department activity…"}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {QUICK_RANGES.map((q) => (
            <button
              key={q.key}
              type="button"
              onClick={() => applyQuickRange(q.key)}
              aria-pressed={preset === q.key}
              data-testid={`detail-range-${q.key}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                preset === q.key
                  ? "bg-primary text-white"
                  : "border bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              }`}
            >
              {q.label}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => {
              setPreset(null);
              setFrom(e.target.value);
            }}
            data-testid="detail-from"
            className="rounded-lg border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
          <span className="pb-2 text-gray-400">→</span>
          <input
            type="date"
            value={to}
            min={from}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => {
              setPreset(null);
              setTo(e.target.value);
            }}
            data-testid="detail-to"
            className="rounded-lg border px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : !data ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-gray-500 dark:border-gray-700">
          Could not load this department&apos;s report.
        </div>
      ) : (
        <>
          {/* KPI tiles */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiTile
              icon={<Calendar size={18} />}
              label="Appointments"
              value={data.totals.appointments.toLocaleString("en-IN")}
              tone="blue"
            />
            <KpiTile
              icon={<CheckCircle size={18} />}
              label="Completed"
              value={data.totals.completed.toLocaleString("en-IN")}
              tone="green"
            />
            <KpiTile
              icon={<Users size={18} />}
              label="Patients"
              value={data.totals.patients.toLocaleString("en-IN")}
              tone="indigo"
            />
            <KpiTile
              icon={<DollarSign size={18} />}
              label="Revenue"
              value={fmtCurrency(data.totals.revenue)}
              tone="amber"
            />
          </div>

          {/* Time series */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Appointments over time">
              <TimeSeriesBars
                points={data.appointmentsByDay.map((d) => ({
                  day: d.day,
                  value: d.count,
                  overlay: d.completed,
                }))}
                color="#93c5fd"
                overlayColor="#2563eb"
              />
              <p className="mt-2 text-xs text-gray-400">
                Light = total · dark = completed
              </p>
            </Card>
            <Card title="Revenue over time">
              <TimeSeriesBars
                points={data.revenueByDay.map((d) => ({ day: d.day, value: d.revenue }))}
                color="#fbbf24"
                formatValue={fmtCurrency}
              />
            </Card>
          </div>

          {/* Status + doctors */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Appointment status">
              <RankedBars
                items={statusEntries.map(([label, value]) => ({ label, value }))}
                color="#8b5cf6"
                emptyLabel="No appointments in this range"
              />
            </Card>
            <Card title="Top doctors">
              <RankedBars
                items={data.topDoctors.map((d) => ({
                  label: d.doctorName,
                  value: d.appointmentCount,
                }))}
                color="#3b82f6"
                emptyLabel="No doctor activity in this range"
              />
            </Card>
          </div>

          {/* Medicines + lab + diagnoses */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Top medicines dispensed">
              <RankedBars
                items={data.topMedicines.map((m) => ({ label: m.name, value: m.count }))}
                color="#10b981"
                emptyLabel="No prescriptions in this range"
              />
            </Card>
            <Card title="Top lab / diagnostics">
              <RankedBars
                items={data.topLabTests.map((t) => ({ label: t.name, value: t.count }))}
                color="#f59e0b"
                emptyLabel="No lab orders in this range"
              />
            </Card>
            <Card title="Top diagnoses">
              <RankedBars
                items={data.topDiagnoses.map((d) => ({ label: d.name, value: d.count }))}
                color="#ec4899"
                emptyLabel="No diagnoses in this range"
              />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

const TONE_CLASSES: Record<string, string> = {
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
};

function KpiTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: keyof typeof TONE_CLASSES;
}) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm dark:border dark:border-gray-700 dark:bg-gray-800">
      <div className={`mb-2 inline-flex rounded-lg p-2 ${TONE_CLASSES[tone]}`}>{icon}</div>
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm dark:border dark:border-gray-700 dark:bg-gray-800">
      <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">{title}</h2>
      {children}
    </div>
  );
}
