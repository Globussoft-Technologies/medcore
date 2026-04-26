"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import {
  Users,
  Calendar,
  DollarSign,
  BedDouble,
  AlertTriangle,
  Stethoscope,
  Activity,
  Pill,
  TrendingUp,
  TrendingDown,
  Siren,
  ClipboardList,
  Star,
  Download,
  Printer,
  X,
  RefreshCw,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────

interface OverviewSnapshot {
  totalPatients: number;
  newPatientsInPeriod: number;
  totalAppointments: number;
  appointmentsByStatus: Record<string, number>;
  totalRevenue: number;
  revenueByMode: Record<string, number>;
  pendingBills: number;
  currentlyAdmitted: number;
  avgConsultationTime: number;
}

type CompareMode = "none" | "previous_period" | "previous_year";

interface OverviewCompareResponse {
  current: OverviewSnapshot;
  previous: OverviewSnapshot;
  deltaPercent: Record<string, number>;
  compareMode: string;
  previousRange: { from: string; to: string };
}

interface ApptPoint {
  date: string;
  count: number;
  scheduled: number;
  walkin: number;
}

interface RevenuePoint {
  date: string;
  total: number;
  cash: number;
  card: number;
  upi: number;
  online: number;
  insurance: number;
}

interface DoctorStat {
  doctorId: string;
  doctorName: string;
  appointmentCount: number;
  completedCount: number;
  avgDurationMin: number;
  revenue: number;
  patientCount: number;
}

interface DiagnosisItem {
  diagnosis: string;
  count: number;
}

interface Demographics {
  byGender: Record<string, number>;
  byAgeGroup: Record<string, number>;
}

interface Occupancy {
  totalBeds: number;
  occupied: number;
  available: number;
  byWard: Array<{ wardName: string; total: number; occupied: number }>;
}

interface LowStockData {
  count: number;
  items: Array<{
    id: string;
    medicineName: string;
    quantity: number;
    reorderLevel: number;
    batchNumber: string;
  }>;
}

interface DispensedItem {
  medicineName: string;
  dispensed: number;
}

interface RevenueBreakdown {
  byType: Record<string, number>;
  byCategory: Record<string, number>;
  byDoctor: Array<{ doctorId: string; doctorName: string; revenue: number }>;
  byWard: Array<{ wardName: string; revenue: number; admissions: number }>;
}

interface PatientGrowthPoint {
  date: string;
  count: number;
  cumulative: number;
}

interface Retention {
  totalActive: number;
  newPatients: number;
  returningPatients: number;
  retentionRate: number;
  distribution: Record<string, number>;
}

interface NoShowData {
  totalAppointments: number;
  noShowCount: number;
  overallRate: number;
  byDoctor: Array<{
    doctorId: string;
    doctorName: string;
    total: number;
    noShow: number;
    rate: number;
  }>;
  byDayOfWeek: Array<{ day: string; total: number; noShow: number; rate: number }>;
  byHour: Array<{ hour: number; total: number; noShow: number; rate: number }>;
}

interface QueueWalkoutsData {
  totalLwbs: number;
  byDoctor: Array<{ doctorId: string; doctorName: string; count: number }>;
  byHour: Array<{ hour: number; count: number }>;
  byReason: Array<{ reason: string; count: number }>;
}

interface DischargeTrends {
  totalAdmissions: number;
  discharged: number;
  deaths: number;
  avgLengthOfStayDays: number;
  mortalityRate: number;
  readmissionRate: number;
  readmissions: number;
  losDistribution: Record<string, number>;
}

interface ErPerformance {
  totalCases: number;
  criticalCases: number;
  avgWaitToTriageMin: number;
  avgWaitToDoctorMin: number;
  byTriage: Record<string, number>;
  byDisposition: Record<string, number>;
}

interface ExpiryItem {
  id: string;
  medicineName: string;
  batchNumber: string;
  quantity: number;
  expiryDate: string;
  daysToExpiry: number;
  valueAtRisk: number;
  bucket: string;
}

interface ExpiryData {
  horizonDays: number;
  valueAtRisk: Record<string, number>;
  countByBucket: Record<string, number>;
  totalAtRisk: number;
  topItems: ExpiryItem[];
  focusItems: ExpiryItem[];
}

interface FeedbackTrends {
  totalResponses: number;
  overallAvgRating: number;
  overallNps: number;
  series: Array<{ date: string; count: number; avgRating: number; nps: number }>;
  categories: Array<{ category: string; count: number; avgRating: number }>;
}

// ─── Formatters ────────────────────────────────────

function formatCurrency(n: number): string {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatShortDate(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// ─── Chart Components ──────────────────────────────

interface LineChartProps {
  data: Array<Record<string, number | string>>;
  xKey: string;
  yKeys: Array<{ key: string; label: string; color: string }>;
  height?: number;
  yFormat?: (n: number) => string;
  onPointClick?: (point: Record<string, number | string>, key: string) => void;
}

function LineChart({ data, xKey, yKeys, height = 220, yFormat, onPointClick }: LineChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-gray-400" style={{ height }}>
        No data for this period
      </div>
    );
  }

  const width = 800;
  const padL = 50;
  const padR = 20;
  const padT = 20;
  const padB = 40;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const maxY = Math.max(
    1,
    ...data.flatMap((d) => yKeys.map((k) => Number(d[k.key] || 0)))
  );
  const step = data.length > 1 ? innerW / (data.length - 1) : innerW;

  const yTicks = 4;
  const tickVals = Array.from({ length: yTicks + 1 }, (_, i) => (maxY * i) / yTicks);
  const fmt = yFormat || ((n: number) => Math.round(n).toLocaleString());
  const xLabelStride = Math.max(1, Math.ceil(data.length / 8));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height + 20 }}>
      {tickVals.map((tv, i) => {
        const y = padT + innerH - (tv / maxY) * innerH;
        return (
          <g key={i}>
            <line
              x1={padL}
              x2={padL + innerW}
              y1={y}
              y2={y}
              stroke="#e5e7eb"
              strokeDasharray="3,3"
            />
            <text x={padL - 8} y={y + 4} textAnchor="end" fontSize="10" fill="#6b7280">
              {fmt(tv)}
            </text>
          </g>
        );
      })}

      <line
        x1={padL}
        x2={padL + innerW}
        y1={padT + innerH}
        y2={padT + innerH}
        stroke="#9ca3af"
      />

      {data.map((d, i) => {
        if (i % xLabelStride !== 0 && i !== data.length - 1) return null;
        const x = padL + i * step;
        return (
          <text
            key={i}
            x={x}
            y={padT + innerH + 18}
            textAnchor="middle"
            fontSize="10"
            fill="#6b7280"
          >
            {formatShortDate(String(d[xKey]))}
          </text>
        );
      })}

      {yKeys.map((yk) => {
        const points = data
          .map((d, i) => {
            const x = padL + i * step;
            const y = padT + innerH - (Number(d[yk.key] || 0) / maxY) * innerH;
            return `${x},${y}`;
          })
          .join(" ");
        return (
          <g key={yk.key}>
            <polyline fill="none" stroke={yk.color} strokeWidth="2" points={points} />
            {data.map((d, i) => {
              const x = padL + i * step;
              const y = padT + innerH - (Number(d[yk.key] || 0) / maxY) * innerH;
              return (
                <circle
                  key={i}
                  cx={x}
                  cy={y}
                  r="3.5"
                  fill={yk.color}
                  style={onPointClick ? { cursor: "pointer" } : undefined}
                  onClick={onPointClick ? () => onPointClick(d, yk.key) : undefined}
                >
                  <title>{`${formatShortDate(String(d[xKey]))}: ${yk.label} = ${d[yk.key]}`}</title>
                </circle>
              );
            })}
          </g>
        );
      })}

      <g>
        {yKeys.map((yk, i) => (
          <g key={yk.key} transform={`translate(${padL + i * 120}, ${padT - 5})`}>
            <rect width="10" height="10" fill={yk.color} />
            <text x="14" y="9" fontSize="11" fill="#374151">
              {yk.label}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

interface BarCategory {
  key: string;
  label: string;
  color: string;
}

interface BarChartProps {
  categories: BarCategory[];
  values: Record<string, number>;
  formatValue?: (n: number) => string;
  onBarClick?: (key: string, value: number) => void;
}

function BarChart({ categories, values, formatValue, onBarClick }: BarChartProps) {
  const max = Math.max(1, ...categories.map((c) => values[c.key] || 0));
  const fmt = formatValue || ((n: number) => String(n));
  return (
    <div className="space-y-3">
      {categories.map((c) => {
        const v = values[c.key] || 0;
        const pct = (v / max) * 100;
        return (
          <div
            key={c.key}
            className={onBarClick ? "cursor-pointer" : undefined}
            onClick={onBarClick ? () => onBarClick(c.key, v) : undefined}
          >
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="font-medium text-gray-700">{c.label}</span>
              <span className="text-gray-600">{fmt(v)}</span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, backgroundColor: c.color }}
                title={`${c.label}: ${fmt(v)}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  centerText?: string;
  size?: number;
  onSegmentClick?: (label: string, value: number) => void;
  // Issue #78: label-side value formatter. Defaults to the raw count, but the
  // revenue donuts pass `formatCurrency` so the legend renders rupees and the
  // tooltip renders both rupees and percentage instead of a misleading
  // "(count)".
  formatValue?: (value: number) => string;
  // When true, segment legends + tooltips use percentages instead of raw
  // values. Used by the revenue donuts where the absolute value is already
  // surfaced in the centre.
  showPercent?: boolean;
}

function DonutChart({
  segments,
  centerText,
  size = 180,
  onSegmentClick,
  formatValue,
  showPercent,
}: DonutChartProps) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const radius = size / 2 - 10;
  const strokeW = 28;
  const circumference = 2 * Math.PI * radius;

  if (total === 0) {
    return (
      <div className="flex flex-col items-center">
        <div
          className="flex items-center justify-center rounded-full text-sm text-gray-400"
          style={{ width: size, height: size, border: "28px solid #f3f4f6" }}
        >
          No data
        </div>
      </div>
    );
  }

  let accOffset = 0;

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`translate(${size / 2}, ${size / 2}) rotate(-90)`}>
          <circle r={radius} fill="none" stroke="#f3f4f6" strokeWidth={strokeW} />
          {segments.map((seg, i) => {
            const fraction = seg.value / total;
            const dash = fraction * circumference;
            const gap = circumference - dash;
            const circ = (
              <circle
                key={i}
                r={radius}
                fill="none"
                stroke={seg.color}
                strokeWidth={strokeW}
                strokeDasharray={`${dash} ${gap}`}
                strokeDashoffset={-accOffset}
                style={onSegmentClick ? { cursor: "pointer" } : undefined}
                onClick={onSegmentClick ? () => onSegmentClick(seg.label, seg.value) : undefined}
              >
                <title>
                  {`${seg.label}: ${
                    formatValue ? formatValue(seg.value) : seg.value
                  } (${((fraction * 100) | 0)}%)`}
                </title>
              </circle>
            );
            accOffset += dash;
            return circ;
          })}
        </g>
        {centerText && (
          <text
            x={size / 2}
            y={size / 2 + 5}
            textAnchor="middle"
            fontSize="14"
            fontWeight="600"
            fill="#111827"
          >
            {centerText}
          </text>
        )}
      </svg>
      <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1">
        {segments.map((seg) => {
          // Issue #78: revenue donuts were showing raw numbers as "(count)"
          // — meaningless for currency. We now respect either an explicit
          // formatter (e.g. INR formatting) or a percent-mode flag.
          let display: string;
          if (showPercent) {
            const pct = total > 0 ? Math.round((seg.value / total) * 100) : 0;
            display = `${pct}%`;
          } else if (formatValue) {
            display = formatValue(seg.value);
          } else {
            display = String(seg.value);
          }
          return (
            <div key={seg.label} className="flex items-center gap-1.5 text-xs">
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: seg.color }}
              />
              <span className="text-gray-700">
                {seg.label} ({display})
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Hour heatmap (single row of 24 cells)
function HourHeatmap({
  data,
}: {
  data: Array<{ hour: number; total: number; noShow: number; rate: number }>;
}) {
  const max = Math.max(1, ...data.map((d) => d.rate));
  return (
    <div className="overflow-x-auto">
      <div className="flex gap-0.5 min-w-150">
        {data.map((d) => {
          const intensity = d.rate / max;
          const bg = d.total === 0
            ? "#f3f4f6"
            : `rgba(220, 38, 38, ${0.15 + intensity * 0.75})`;
          return (
            <div key={d.hour} className="flex-1">
              <div
                title={`${d.hour}:00 - ${d.total} appts, ${d.noShow} no-show (${d.rate}%)`}
                className="h-10 rounded"
                style={{ backgroundColor: bg }}
              />
              <div className="mt-1 text-center text-[10px] text-gray-500">
                {String(d.hour).padStart(2, "0")}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Section card wrapper ──────────────────────────

function Card({
  title,
  children,
  icon: Icon,
  className,
  right,
}: {
  title?: string;
  children: React.ReactNode;
  icon?: React.ElementType;
  className?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl bg-white p-6 shadow-sm ${className || ""}`}>
      {(title || right) && (
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {Icon && <Icon size={18} className="text-gray-500" />}
            {title && <h2 className="font-semibold text-gray-800">{title}</h2>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────

const MODE_COLORS: Record<string, string> = {
  CASH: "#059669",
  CARD: "#2563eb",
  UPI: "#7c3aed",
  ONLINE: "#f59e0b",
  INSURANCE: "#dc2626",
};

const GENDER_COLORS: Record<string, string> = {
  MALE: "#2563eb",
  FEMALE: "#ec4899",
  OTHER: "#6b7280",
};

const AGE_COLORS: Record<string, string> = {
  "0-18": "#60a5fa",
  "19-35": "#059669",
  "36-55": "#f59e0b",
  "56+": "#dc2626",
};

const TRIAGE_COLORS: Record<string, string> = {
  RESUSCITATION: "#b91c1c",
  EMERGENT: "#ea580c",
  URGENT: "#f59e0b",
  LESS_URGENT: "#0ea5e9",
  NON_URGENT: "#10b981",
  UNTRIAGED: "#6b7280",
};

const CATEGORY_COLORS = [
  "#2563eb",
  "#059669",
  "#f59e0b",
  "#dc2626",
  "#7c3aed",
  "#0ea5e9",
  "#ec4899",
  "#6b7280",
];

function occupancyColor(pct: number): string {
  if (pct < 60) return "#059669";
  if (pct < 85) return "#f59e0b";
  return "#dc2626";
}

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return isoDate(d);
}

function today() {
  return isoDate(new Date());
}

// Date range presets
type PresetKey =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "lastMonth"
  | "last30"
  | "last90"
  | "thisYear"
  | "custom";

const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "thisWeek", label: "This Week" },
  { key: "lastWeek", label: "Last Week" },
  { key: "thisMonth", label: "This Month" },
  { key: "lastMonth", label: "Last Month" },
  { key: "last30", label: "Last 30 Days" },
  { key: "last90", label: "Last 90 Days" },
  { key: "thisYear", label: "This Year" },
  { key: "custom", label: "Custom" },
];

function presetRange(key: PresetKey): { from: string; to: string } | null {
  const now = new Date();
  const startOfDay = (d: Date) => {
    const n = new Date(d);
    n.setHours(0, 0, 0, 0);
    return n;
  };
  if (key === "today") return { from: isoDate(now), to: isoDate(now) };
  if (key === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { from: isoDate(y), to: isoDate(y) };
  }
  if (key === "thisWeek") {
    const start = startOfDay(now);
    start.setDate(start.getDate() - start.getDay());
    return { from: isoDate(start), to: isoDate(now) };
  }
  if (key === "lastWeek") {
    const end = startOfDay(now);
    end.setDate(end.getDate() - end.getDay() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    return { from: isoDate(start), to: isoDate(end) };
  }
  if (key === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: isoDate(start), to: isoDate(now) };
  }
  if (key === "lastMonth") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: isoDate(start), to: isoDate(end) };
  }
  if (key === "last30") {
    const s = new Date(now);
    s.setDate(s.getDate() - 30);
    return { from: isoDate(s), to: isoDate(now) };
  }
  if (key === "last90") {
    const s = new Date(now);
    s.setDate(s.getDate() - 90);
    return { from: isoDate(s), to: isoDate(now) };
  }
  if (key === "thisYear") {
    const s = new Date(now.getFullYear(), 0, 1);
    return { from: isoDate(s), to: isoDate(now) };
  }
  return null;
}

// Drill-down modal types
interface DrillDown {
  title: string;
  breadcrumbs: string[];
  rows: Array<Record<string, string | number>>;
  columns: Array<{ key: string; label: string; isCurrency?: boolean }>;
}

export default function AnalyticsPage() {
  const { user } = useAuthStore();
  const router = useRouter();

  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(today());
  const [pendingFrom, setPendingFrom] = useState(from);
  const [pendingTo, setPendingTo] = useState(to);
  const [preset, setPreset] = useState<PresetKey>("last30");
  const [compareMode, setCompareMode] = useState<CompareMode>("previous_period");

  // Data state
  const [overview, setOverview] = useState<OverviewSnapshot | null>(null);
  const [prevOverview, setPrevOverview] = useState<OverviewSnapshot | null>(null);
  const [deltaPercent, setDeltaPercent] = useState<Record<string, number>>({});

  const [appointments, setAppointments] = useState<ApptPoint[]>([]);
  const [revenue, setRevenue] = useState<RevenuePoint[]>([]);
  const [doctors, setDoctors] = useState<DoctorStat[]>([]);
  const [diagnoses, setDiagnoses] = useState<DiagnosisItem[]>([]);
  const [demographics, setDemographics] = useState<Demographics | null>(null);
  const [occupancy, setOccupancy] = useState<Occupancy | null>(null);
  const [lowStock, setLowStock] = useState<LowStockData | null>(null);
  const [dispensed, setDispensed] = useState<DispensedItem[]>([]);

  const [revenueBreakdown, setRevenueBreakdown] = useState<RevenueBreakdown | null>(null);
  const [patientGrowth, setPatientGrowth] = useState<PatientGrowthPoint[]>([]);
  const [retention, setRetention] = useState<Retention | null>(null);
  const [noShow, setNoShow] = useState<NoShowData | null>(null);
  const [walkouts, setWalkouts] = useState<QueueWalkoutsData | null>(null);
  const [discharge, setDischarge] = useState<DischargeTrends | null>(null);
  const [erPerf, setErPerf] = useState<ErPerformance | null>(null);
  const [expiry, setExpiry] = useState<ExpiryData | null>(null);
  const [feedback, setFeedback] = useState<FeedbackTrends | null>(null);

  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<keyof DoctorStat>("appointmentCount");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [drillDown, setDrillDown] = useState<DrillDown | null>(null);

  useEffect(() => {
    if (user && user.role !== "ADMIN" && user.role !== "RECEPTION") {
      router.push("/dashboard");
    }
  }, [user, router]);

  function applyPreset(key: PresetKey) {
    setPreset(key);
    if (key === "custom") return;
    const r = presetRange(key);
    if (r) {
      setFrom(r.from);
      setTo(r.to);
      setPendingFrom(r.from);
      setPendingTo(r.to);
    }
  }

  const loadAll = useCallback(async () => {
    setLoading(true);
    // Issue #78: previously `from`/`to` were captured in component state at
    // mount (defaultFrom() = today-30d, today() = today), so a tab left open
    // for 8 days kept fetching the original window — the Appointment Trends
    // chart looked stale because it really WAS stale by 8 days. We now
    // recompute the active preset's range on every refresh so the dates
    // float forward with wall-clock time. Custom ranges are passed through
    // unchanged.
    let effectiveFrom = from;
    let effectiveTo = to;
    if (preset !== "custom") {
      const fresh = presetRange(preset);
      if (fresh) {
        effectiveFrom = fresh.from;
        effectiveTo = fresh.to;
        if (fresh.from !== from || fresh.to !== to) {
          setFrom(fresh.from);
          setTo(fresh.to);
          setPendingFrom(fresh.from);
          setPendingTo(fresh.to);
        }
      }
    }
    const params = new URLSearchParams({ from: effectiveFrom, to: effectiveTo });
    const qs = params.toString();

    try {
      const overviewUrl =
        compareMode === "none"
          ? `/analytics/overview?${qs}`
          : `/analytics/overview?${qs}&compareMode=${compareMode}`;

      const [
        ovRes,
        apptRes,
        revRes,
        docRes,
        diagRes,
        demoRes,
        occRes,
        lowRes,
        dispRes,
        revBreakRes,
        growthRes,
        retentionRes,
        noShowRes,
        dischargeRes,
        erRes,
        expiryRes,
        feedbackRes,
        walkoutsRes,
      ] = await Promise.all([
        api
          .get<{ data: OverviewSnapshot | OverviewCompareResponse }>(overviewUrl)
          .catch(() => null),
        api.get<{ data: ApptPoint[] }>(`/analytics/appointments?${qs}&groupBy=day`).catch(() => null),
        api.get<{ data: RevenuePoint[] }>(`/analytics/revenue?${qs}&groupBy=day`).catch(() => null),
        api.get<{ data: DoctorStat[] }>(`/analytics/doctors?${qs}`).catch(() => null),
        api.get<{ data: DiagnosisItem[] }>(`/analytics/top-diagnoses?${qs}&limit=10`).catch(() => null),
        api.get<{ data: Demographics }>(`/analytics/patient-demographics`).catch(() => null),
        api.get<{ data: Occupancy }>(`/analytics/ipd/occupancy`).catch(() => null),
        api.get<{ data: LowStockData }>(`/analytics/pharmacy/low-stock`).catch(() => null),
        api.get<{ data: DispensedItem[] }>(`/analytics/pharmacy/top-dispensed?limit=10`).catch(() => null),
        api.get<{ data: RevenueBreakdown }>(`/analytics/revenue/breakdown?${qs}`).catch(() => null),
        api.get<{ data: PatientGrowthPoint[] }>(`/analytics/patients/growth?${qs}&groupBy=month`).catch(() => null),
        api.get<{ data: Retention }>(`/analytics/patients/retention?${qs}`).catch(() => null),
        api.get<{ data: NoShowData }>(`/analytics/appointments/no-show-rate?${qs}`).catch(() => null),
        api.get<{ data: DischargeTrends }>(`/analytics/ipd/discharge-trends?${qs}`).catch(() => null),
        api.get<{ data: ErPerformance }>(`/analytics/er/performance?${qs}`).catch(() => null),
        api.get<{ data: ExpiryData }>(`/analytics/pharmacy/expiry?days=30`).catch(() => null),
        api.get<{ data: FeedbackTrends }>(`/analytics/feedback/trends?${qs}&groupBy=month`).catch(() => null),
        api.get<{ data: QueueWalkoutsData }>(`/analytics/queue-walkouts?${qs}`).catch(() => null),
      ]);

      if (ovRes?.data) {
        if (compareMode === "none") {
          setOverview(ovRes.data as OverviewSnapshot);
          setPrevOverview(null);
          setDeltaPercent({});
        } else {
          const d = ovRes.data as OverviewCompareResponse;
          setOverview(d.current);
          setPrevOverview(d.previous);
          setDeltaPercent(d.deltaPercent || {});
        }
      } else {
        setOverview(null);
      }

      setAppointments(apptRes?.data || []);
      setRevenue(revRes?.data || []);
      setDoctors(docRes?.data || []);
      setDiagnoses(diagRes?.data || []);
      setDemographics(demoRes?.data || null);
      setOccupancy(occRes?.data || null);
      setLowStock(lowRes?.data || null);
      setDispensed(dispRes?.data || []);
      setRevenueBreakdown(revBreakRes?.data || null);
      setPatientGrowth(growthRes?.data || []);
      setRetention(retentionRes?.data || null);
      setNoShow(noShowRes?.data || null);
      setDischarge(dischargeRes?.data || null);
      setErPerf(erRes?.data || null);
      setExpiry(expiryRes?.data || null);
      setFeedback(feedbackRes?.data || null);
      setWalkouts(walkoutsRes?.data || null);
    } finally {
      setLoading(false);
    }
  }, [from, to, compareMode, preset]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const sortedDoctors = useMemo(() => {
    const rows = [...doctors];
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return rows;
  }, [doctors, sortKey, sortDir]);

  function toggleSort(key: keyof DoctorStat) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  // CSV download helper (uses current auth token)
  function downloadCsv(path: string, filename: string) {
    const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
    const token = typeof window !== "undefined" ? localStorage.getItem("medcore_token") : null;
    fetch(`${base}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (r) => {
        if (!r.ok) throw new Error("Export failed");
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      })
      .catch(() => toast.error("Failed to export"));
  }

  if (user && user.role !== "ADMIN" && user.role !== "RECEPTION") return null;

  return (
    <div className="analytics-page">
      {/* Print styles */}
      <style jsx global>{`
        @media print {
          aside,
          header,
          .no-print,
          button {
            display: none !important;
          }
          body,
          .analytics-page {
            background: white !important;
          }
          .analytics-page .rounded-xl {
            box-shadow: none !important;
            border: 1px solid #e5e7eb !important;
            page-break-inside: avoid;
          }
        }
      `}</style>

      {/* Header + filter bar */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Analytics Dashboard</h1>
          <p className="text-sm text-gray-500">
            Insights and trends across hospital operations
          </p>
        </div>

        <div className="no-print flex flex-wrap items-center gap-2">
          <button
            onClick={() => loadAll()}
            className="flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm hover:bg-gray-50"
            title="Refresh"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={() => downloadCsv(`/analytics/export/revenue.csv?from=${from}&to=${to}`, `revenue-${from}_${to}.csv`)}
            className="flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm hover:bg-gray-50"
          >
            <Download size={14} /> Revenue CSV
          </button>
          <button
            onClick={() =>
              downloadCsv(`/analytics/export/appointments.csv?from=${from}&to=${to}`, `appointments-${from}_${to}.csv`)
            }
            className="flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm hover:bg-gray-50"
          >
            <Download size={14} /> Appointments CSV
          </button>
          <button
            onClick={() => downloadCsv("/analytics/export/patients.csv", "patients.csv")}
            className="flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm hover:bg-gray-50"
          >
            <Download size={14} /> Patients CSV
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm hover:bg-gray-50"
          >
            <Printer size={14} /> Print
          </button>
          <button
            onClick={() => router.push("/dashboard/analytics/reports")}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <ClipboardList size={14} /> Report Builder
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="no-print mb-6 rounded-xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-xs text-gray-500">Preset</label>
            <select
              value={preset}
              onChange={(e) => applyPreset(e.target.value as PresetKey)}
              className="rounded-lg border px-3 py-2 text-sm"
            >
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">From</label>
            <input
              type="date"
              value={pendingFrom}
              onChange={(e) => {
                setPendingFrom(e.target.value);
                setPreset("custom");
              }}
              className="rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">To</label>
            <input
              type="date"
              value={pendingTo}
              onChange={(e) => {
                setPendingTo(e.target.value);
                setPreset("custom");
              }}
              className="rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={() => {
              setFrom(pendingFrom);
              setTo(pendingTo);
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Apply
          </button>

          <div className="ml-auto">
            <label className="mb-1 block text-xs text-gray-500">Comparison</label>
            <div className="inline-flex overflow-hidden rounded-lg border text-sm">
              {(["none", "previous_period", "previous_year"] as CompareMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setCompareMode(m)}
                  className={`px-3 py-2 ${
                    compareMode === m
                      ? "bg-primary text-white"
                      : "bg-white text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {m === "none" ? "No Comparison" : m === "previous_period" ? "vs Previous Period" : "vs Previous Year"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Total Patients"
          value={overview?.totalPatients ?? 0}
          sub={`+${overview?.newPatientsInPeriod ?? 0} new`}
          deltaPct={compareMode !== "none" ? deltaPercent.totalPatients : undefined}
          prevValue={prevOverview?.totalPatients}
          icon={Users}
          bg="bg-blue-100"
          color="text-blue-600"
          loading={loading}
        />
        <KpiCard
          label="Appointments"
          value={overview?.totalAppointments ?? 0}
          sub={`${overview?.appointmentsByStatus?.COMPLETED ?? 0} completed`}
          deltaPct={compareMode !== "none" ? deltaPercent.totalAppointments : undefined}
          prevValue={prevOverview?.totalAppointments}
          icon={Calendar}
          bg="bg-purple-100"
          color="text-purple-600"
          loading={loading}
        />
        <KpiCard
          label="Revenue"
          value={formatCurrency(overview?.totalRevenue ?? 0)}
          sub={`${overview?.pendingBills ?? 0} pending bills`}
          deltaPct={compareMode !== "none" ? deltaPercent.totalRevenue : undefined}
          prevValue={prevOverview ? formatCurrency(prevOverview.totalRevenue) : undefined}
          icon={DollarSign}
          bg="bg-green-100"
          color="text-green-600"
          loading={loading}
        />
        <KpiCard
          label="Currently Admitted"
          value={overview?.currentlyAdmitted ?? 0}
          sub={`Avg consult ${overview?.avgConsultationTime ?? 0} min`}
          deltaPct={compareMode !== "none" ? deltaPercent.currentlyAdmitted : undefined}
          prevValue={prevOverview?.currentlyAdmitted}
          icon={BedDouble}
          bg="bg-amber-100"
          color="text-amber-600"
          loading={loading}
        />
      </div>

      {/* Appointment Trends + Revenue over time */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Appointment Trends" icon={Calendar}>
          {loading ? (
            <Loader />
          ) : (
            <LineChart
              data={appointments as unknown as Array<Record<string, number | string>>}
              xKey="date"
              yKeys={[
                { key: "scheduled", label: "Scheduled", color: "#2563eb" },
                { key: "walkin", label: "Walk-in", color: "#f59e0b" },
              ]}
              onPointClick={(p, k) =>
                setDrillDown({
                  title: `Appointments on ${formatShortDate(String(p.date))}`,
                  breadcrumbs: ["Appointments", String(p.date), k],
                  rows: [
                    { metric: "Scheduled", value: Number(p.scheduled) },
                    { metric: "Walk-in", value: Number(p.walkin) },
                    { metric: "Total", value: Number(p.count) },
                  ],
                  columns: [
                    { key: "metric", label: "Metric" },
                    { key: "value", label: "Value" },
                  ],
                })
              }
            />
          )}
        </Card>

        <Card title="Revenue Over Time" icon={TrendingUp}>
          {loading ? (
            <Loader />
          ) : (
            <LineChart
              data={revenue as unknown as Array<Record<string, number | string>>}
              xKey="date"
              yKeys={[{ key: "total", label: "Daily Revenue", color: "#059669" }]}
              yFormat={(n) => formatCurrency(n)}
              onPointClick={(p) =>
                setDrillDown({
                  title: `Revenue on ${formatShortDate(String(p.date))}`,
                  breadcrumbs: ["Revenue", String(p.date)],
                  rows: [
                    { mode: "Cash", amount: Number(p.cash) },
                    { mode: "Card", amount: Number(p.card) },
                    { mode: "UPI", amount: Number(p.upi) },
                    { mode: "Online", amount: Number(p.online) },
                    { mode: "Insurance", amount: Number(p.insurance) },
                    { mode: "Total", amount: Number(p.total) },
                  ],
                  columns: [
                    { key: "mode", label: "Mode" },
                    { key: "amount", label: "Amount", isCurrency: true },
                  ],
                })
              }
            />
          )}
        </Card>
      </div>

      {/* Benchmarks + Forecast (Apr 2026) */}
      <div className="mb-6">
        <BenchmarkAndForecastPanel />
      </div>

      {/* Revenue breakdown + Demographics */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Revenue Breakdown by Mode" icon={DollarSign}>
          {loading ? (
            <Loader />
          ) : overview ? (
            <>
              <p className="mb-4 text-2xl font-bold text-gray-800">
                {formatCurrency(overview.totalRevenue)}
              </p>
              <BarChart
                categories={[
                  { key: "CASH", label: "Cash", color: MODE_COLORS.CASH },
                  { key: "CARD", label: "Card", color: MODE_COLORS.CARD },
                  { key: "UPI", label: "UPI", color: MODE_COLORS.UPI },
                  { key: "ONLINE", label: "Online", color: MODE_COLORS.ONLINE },
                  { key: "INSURANCE", label: "Insurance", color: MODE_COLORS.INSURANCE },
                ]}
                values={overview.revenueByMode}
                formatValue={formatCurrency}
                onBarClick={(k, v) =>
                  setDrillDown({
                    title: `Revenue by Mode: ${k}`,
                    breadcrumbs: ["Revenue", "By Mode", k],
                    rows: [{ mode: k, amount: v }],
                    columns: [
                      { key: "mode", label: "Mode" },
                      { key: "amount", label: "Amount", isCurrency: true },
                    ],
                  })
                }
              />
            </>
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card title="Patient Demographics" icon={Users}>
          {loading ? (
            <Loader />
          ) : demographics ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="mb-2 text-center text-xs font-medium text-gray-500">By Gender</p>
                <DonutChart
                  segments={Object.entries(demographics.byGender).map(([k, v]) => ({
                    label: k,
                    value: v,
                    color: GENDER_COLORS[k] || "#6b7280",
                  }))}
                  centerText={String(
                    Object.values(demographics.byGender).reduce((a, b) => a + b, 0)
                  )}
                />
              </div>
              <div>
                <p className="mb-2 text-center text-xs font-medium text-gray-500">By Age Group</p>
                <DonutChart
                  segments={Object.entries(demographics.byAgeGroup).map(([k, v]) => ({
                    label: k,
                    value: v,
                    color: AGE_COLORS[k] || "#6b7280",
                  }))}
                  centerText={String(
                    Object.values(demographics.byAgeGroup).reduce((a, b) => a + b, 0)
                  )}
                />
              </div>
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>
      </div>

      {/* Revenue sources deep breakdown */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Revenue by Appointment Type" icon={Calendar}>
          {loading ? (
            <Loader />
          ) : revenueBreakdown ? (
            // Issue #78: revenue donut now formats segment values as
            // currency in the legend (was rendering raw rupee numbers as
            // "(count)" — misleading because the same component is used for
            // count-based donuts elsewhere).
            <DonutChart
              segments={Object.entries(revenueBreakdown.byType).map(([k, v], i) => ({
                label: k === "WALK_IN" ? "Walk-in" : "Scheduled",
                value: Math.round(v),
                color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
              }))}
              centerText={formatCurrency(
                Object.values(revenueBreakdown.byType).reduce((a, b) => a + b, 0)
              )}
              formatValue={formatCurrency}
            />
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card title="Revenue by Service Category" icon={DollarSign}>
          {loading ? (
            <Loader />
          ) : revenueBreakdown && Object.keys(revenueBreakdown.byCategory).length > 0 ? (
            <BarChart
              categories={Object.keys(revenueBreakdown.byCategory).map((k, i) => ({
                key: k,
                label: k,
                color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
              }))}
              values={revenueBreakdown.byCategory}
              formatValue={formatCurrency}
            />
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card title="Revenue by Ward (IPD)" icon={BedDouble}>
          {loading ? (
            <Loader />
          ) : revenueBreakdown && revenueBreakdown.byWard.length > 0 ? (
            <div className="space-y-2 text-sm">
              {revenueBreakdown.byWard.slice(0, 8).map((w) => (
                <div key={w.wardName} className="flex items-center justify-between border-b pb-1">
                  <span className="font-medium">{w.wardName}</span>
                  <span className="text-right">
                    <span className="block text-gray-800">{formatCurrency(w.revenue)}</span>
                    <span className="text-xs text-gray-400">{w.admissions} admissions</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>
      </div>

      {/* Patient Growth & Retention */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Patient Growth" icon={Users}>
          {loading ? (
            <Loader />
          ) : (
            <LineChart
              data={patientGrowth as unknown as Array<Record<string, number | string>>}
              xKey="date"
              yKeys={[
                { key: "count", label: "New Patients", color: "#2563eb" },
                { key: "cumulative", label: "Cumulative", color: "#059669" },
              ]}
            />
          )}
        </Card>

        <Card title="Retention" icon={TrendingUp}>
          {loading ? (
            <Loader />
          ) : retention ? (
            <div className="space-y-3">
              <StatRow label="New Patients" value={retention.newPatients} />
              <StatRow label="Returning Patients" value={retention.returningPatients} />
              <StatRow
                label="Retention Rate"
                value={`${retention.retentionRate}%`}
                color={retention.retentionRate >= 50 ? "text-green-600" : "text-amber-600"}
              />
              <div className="pt-2">
                <p className="mb-2 text-xs font-medium text-gray-500">Visit Frequency</p>
                <BarChart
                  categories={[
                    { key: "1", label: "1 visit", color: "#60a5fa" },
                    { key: "2-3", label: "2-3 visits", color: "#059669" },
                    { key: "4+", label: "4+ visits", color: "#dc2626" },
                  ]}
                  values={retention.distribution}
                />
              </div>
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>
      </div>

      {/* Doctor performance */}
      <div className="mb-6">
        <Card title="Doctor Performance" icon={Stethoscope}>
          {loading ? (
            <Loader />
          ) : doctors.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <SortableTh
                      label="Doctor"
                      active={sortKey === "doctorName"}
                      dir={sortDir}
                      onClick={() => toggleSort("doctorName")}
                    />
                    <SortableTh
                      label="Appointments"
                      active={sortKey === "appointmentCount"}
                      dir={sortDir}
                      onClick={() => toggleSort("appointmentCount")}
                    />
                    <SortableTh
                      label="Completed %"
                      active={sortKey === "completedCount"}
                      dir={sortDir}
                      onClick={() => toggleSort("completedCount")}
                    />
                    <SortableTh
                      label="Avg Time"
                      active={sortKey === "avgDurationMin"}
                      dir={sortDir}
                      onClick={() => toggleSort("avgDurationMin")}
                    />
                    <SortableTh
                      label="Patients"
                      active={sortKey === "patientCount"}
                      dir={sortDir}
                      onClick={() => toggleSort("patientCount")}
                    />
                    <SortableTh
                      label="Revenue"
                      active={sortKey === "revenue"}
                      dir={sortDir}
                      onClick={() => toggleSort("revenue")}
                    />
                  </tr>
                </thead>
                <tbody>
                  {sortedDoctors.map((d) => {
                    const pct =
                      d.appointmentCount > 0
                        ? Math.round((d.completedCount / d.appointmentCount) * 100)
                        : 0;
                    return (
                      <tr
                        key={d.doctorId}
                        className="cursor-pointer border-b last:border-0 hover:bg-gray-50"
                        onClick={() =>
                          setDrillDown({
                            title: `Doctor: ${d.doctorName}`,
                            breadcrumbs: ["Doctors", d.doctorName],
                            rows: [
                              { metric: "Appointments", value: d.appointmentCount },
                              { metric: "Completed", value: d.completedCount },
                              { metric: "Completed %", value: `${pct}%` },
                              { metric: "Patients", value: d.patientCount },
                              { metric: "Avg Duration", value: `${d.avgDurationMin} min` },
                              { metric: "Revenue", value: formatCurrency(d.revenue) },
                            ],
                            columns: [
                              { key: "metric", label: "Metric" },
                              { key: "value", label: "Value" },
                            ],
                          })
                        }
                      >
                        <td className="px-3 py-2 font-medium text-gray-800">{d.doctorName}</td>
                        <td className="px-3 py-2">{d.appointmentCount}</td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2">
                            <span className="w-10 text-gray-600">{pct}%</span>
                            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-100">
                              <span
                                className="block h-full rounded-full bg-green-500"
                                style={{ width: `${pct}%` }}
                              />
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-2">{d.avgDurationMin} min</td>
                        <td className="px-3 py-2">{d.patientCount}</td>
                        <td className="px-3 py-2 font-medium text-gray-800">
                          {formatCurrency(d.revenue)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Appointment No-Show Analysis */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="No-Show by Doctor" icon={Calendar}>
          {loading ? (
            <Loader />
          ) : noShow && noShow.byDoctor.length > 0 ? (
            <BarChart
              categories={noShow.byDoctor.slice(0, 8).map((d, i) => ({
                key: d.doctorId,
                label: d.doctorName,
                color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
              }))}
              values={Object.fromEntries(noShow.byDoctor.map((d) => [d.doctorId, d.rate]))}
              formatValue={(n) => `${n}%`}
            />
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card title="No-Show by Day of Week" icon={Calendar}>
          {loading ? (
            <Loader />
          ) : noShow ? (
            <BarChart
              categories={noShow.byDayOfWeek.map((d, i) => ({
                key: d.day,
                label: d.day,
                color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
              }))}
              values={Object.fromEntries(noShow.byDayOfWeek.map((d) => [d.day, d.rate]))}
              formatValue={(n) => `${n}%`}
            />
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card
          title="No-Show Overall"
          icon={AlertTriangle}
          right={
            noShow ? (
              <span className="rounded-full bg-red-50 px-3 py-1 text-sm font-semibold text-red-700">
                {noShow.overallRate}%
              </span>
            ) : null
          }
        >
          {loading ? (
            <Loader />
          ) : noShow ? (
            <div className="space-y-3">
              <StatRow label="Total Appointments" value={noShow.totalAppointments} />
              <StatRow label="No-Shows" value={noShow.noShowCount} color="text-red-600" />
              <p className="pt-2 text-xs font-medium text-gray-500">No-Show Rate by Hour</p>
              <HourHeatmap data={noShow.byHour} />
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>
      </div>

      {/* Queue Walkouts (LWBS) */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card
          title="Queue Walkouts (LWBS)"
          icon={AlertTriangle}
          right={
            walkouts ? (
              <span className="rounded-full bg-red-50 px-3 py-1 text-sm font-semibold text-red-700">
                {walkouts.totalLwbs} total
              </span>
            ) : null
          }
        >
          {loading ? (
            <Loader />
          ) : walkouts && walkouts.byDoctor.length > 0 ? (
            <BarChart
              categories={walkouts.byDoctor.slice(0, 8).map((d, i) => ({
                key: d.doctorId,
                label: d.doctorName,
                color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
              }))}
              values={Object.fromEntries(
                walkouts.byDoctor.map((d) => [d.doctorId, d.count])
              )}
            />
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card title="Walkouts by Hour" icon={Calendar}>
          {loading ? (
            <Loader />
          ) : walkouts && walkouts.byHour.some((h) => h.count > 0) ? (
            <div className="flex h-40 items-end gap-1">
              {walkouts.byHour.map((h) => {
                const maxCount = Math.max(
                  1,
                  ...walkouts.byHour.map((x) => x.count)
                );
                const heightPct = (h.count / maxCount) * 100;
                return (
                  <div
                    key={h.hour}
                    className="flex-1 rounded-t bg-red-400"
                    style={{ height: `${heightPct}%`, minHeight: h.count > 0 ? 4 : 0 }}
                    title={`${h.hour}:00 · ${h.count} walkouts`}
                  />
                );
              })}
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card title="Walkout Reasons" icon={ClipboardList}>
          {loading ? (
            <Loader />
          ) : walkouts && walkouts.byReason.length > 0 ? (
            <div className="space-y-2">
              {walkouts.byReason.slice(0, 10).map((r, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded border-l-4 border-red-300 bg-red-50 px-3 py-1.5 text-sm"
                >
                  <span className="truncate pr-2" title={r.reason}>
                    {r.reason}
                  </span>
                  <span className="font-semibold text-red-700">{r.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>
      </div>

      {/* ER Performance */}
      <div className="mb-6">
        <Card title="ER Performance Dashboard" icon={Siren}>
          {loading ? (
            <Loader />
          ) : erPerf ? (
            <>
              <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
                <MiniKpi label="Wait to Triage" value={`${erPerf.avgWaitToTriageMin} min`} />
                <MiniKpi label="Triage to Doctor" value={`${erPerf.avgWaitToDoctorMin} min`} />
                <MiniKpi label="Total Cases" value={erPerf.totalCases} />
                <MiniKpi
                  label="Critical Cases"
                  value={erPerf.criticalCases}
                  highlight="text-red-600"
                />
              </div>
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs font-medium text-gray-500">Triage Level Distribution</p>
                  <DonutChart
                    segments={Object.entries(erPerf.byTriage)
                      .filter(([, v]) => v > 0)
                      .map(([k, v]) => ({
                        label: k,
                        value: v,
                        color: TRIAGE_COLORS[k] || "#6b7280",
                      }))}
                    centerText={String(erPerf.totalCases)}
                  />
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium text-gray-500">Dispositions</p>
                  {Object.keys(erPerf.byDisposition).length === 0 ? (
                    <EmptyState />
                  ) : (
                    <BarChart
                      categories={Object.keys(erPerf.byDisposition).map((k, i) => ({
                        key: k,
                        label: k,
                        color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
                      }))}
                      values={erPerf.byDisposition}
                    />
                  )}
                </div>
              </div>
            </>
          ) : (
            <EmptyState />
          )}
        </Card>
      </div>

      {/* IPD Deep Dive */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="IPD Key Metrics" icon={BedDouble}>
          {loading ? (
            <Loader />
          ) : discharge ? (
            <div className="space-y-3">
              <StatRow label="Admissions" value={discharge.totalAdmissions} />
              <StatRow label="Discharged" value={discharge.discharged} />
              <StatRow
                label="Avg LOS"
                value={`${discharge.avgLengthOfStayDays} days`}
                color="text-blue-600"
              />
              <StatRow
                label="Readmission Rate"
                value={`${discharge.readmissionRate}%`}
                color={discharge.readmissionRate > 10 ? "text-red-600" : "text-green-600"}
              />
              <StatRow
                label="Mortality Rate"
                value={`${discharge.mortalityRate}%`}
                color="text-gray-600"
              />
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card title="Length of Stay Distribution" icon={Activity}>
          {loading ? (
            <Loader />
          ) : discharge ? (
            <BarChart
              categories={[
                { key: "1-3", label: "1-3 days", color: "#60a5fa" },
                { key: "4-7", label: "4-7 days", color: "#059669" },
                { key: "8-14", label: "8-14 days", color: "#f59e0b" },
                { key: "15+", label: "15+ days", color: "#dc2626" },
              ]}
              values={discharge.losDistribution}
            />
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card title="IPD Occupancy" icon={BedDouble}>
          {loading ? (
            <Loader />
          ) : !occupancy || occupancy.totalBeds === 0 ? (
            <EmptyState />
          ) : (
            <>
              <div className="mb-4 flex items-center gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Total: </span>
                  <span className="font-semibold">{occupancy.totalBeds}</span>
                </div>
                <div>
                  <span className="text-gray-500">Occupied: </span>
                  <span className="font-semibold text-amber-600">{occupancy.occupied}</span>
                </div>
                <div>
                  <span className="text-gray-500">Available: </span>
                  <span className="font-semibold text-green-600">{occupancy.available}</span>
                </div>
              </div>
              <div className="space-y-3">
                {occupancy.byWard.map((w) => {
                  const pct = w.total > 0 ? (w.occupied / w.total) * 100 : 0;
                  return (
                    <div key={w.wardName}>
                      <div className="mb-1 flex justify-between text-xs">
                        <span className="font-medium text-gray-700">{w.wardName}</span>
                        <span className="text-gray-500">
                          {w.occupied}/{w.total} ({Math.round(pct)}%)
                        </span>
                      </div>
                      <div className="h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: occupancyColor(pct),
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Top diagnoses + low stock */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Top Diagnoses" icon={Activity}>
          {loading ? (
            <Loader />
          ) : diagnoses.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-2">
              {diagnoses.map((d) => {
                const max = diagnoses[0]?.count || 1;
                const pct = (d.count / max) * 100;
                return (
                  <div key={d.diagnosis}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="truncate pr-2 font-medium text-gray-700">
                        {d.diagnosis}
                      </span>
                      <span className="text-gray-500">{d.count}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Low Stock Alert" icon={AlertTriangle}>
          {loading ? (
            <Loader />
          ) : lowStock ? (
            <div>
              <div
                className={`mb-3 rounded-lg p-4 ${
                  lowStock.count > 0
                    ? "bg-red-50 text-red-700"
                    : "bg-green-50 text-green-700"
                }`}
              >
                <p className="text-xs uppercase tracking-wide">Items below reorder level</p>
                <p className="text-3xl font-bold">{lowStock.count}</p>
              </div>
              {lowStock.items.length > 0 && (
                <ul className="space-y-1 text-xs">
                  {lowStock.items.slice(0, 6).map((it) => (
                    <li
                      key={it.id}
                      className="flex items-center justify-between rounded bg-gray-50 px-2 py-1.5"
                    >
                      <span className="truncate pr-2 font-medium text-gray-700">
                        {it.medicineName}
                      </span>
                      <span className="text-red-600">
                        {it.quantity} / {it.reorderLevel}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>
      </div>

      {/* Pharmacy expiry risk + dispensed */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Pharmacy Expiry Risk" icon={AlertTriangle}>
          {loading ? (
            <Loader />
          ) : expiry ? (
            <div className="space-y-3">
              <div className="rounded-lg bg-red-50 p-3">
                <p className="text-xs text-red-700">Total value at risk (90 days)</p>
                <p className="text-xl font-bold text-red-700">
                  {formatCurrency(expiry.totalAtRisk)}
                </p>
              </div>
              <StatRow
                label="Already Expired"
                value={formatCurrency(expiry.valueAtRisk.expired)}
                color="text-red-600"
              />
              <StatRow
                label="Expires in 30 days"
                value={formatCurrency(expiry.valueAtRisk["30"])}
                color="text-amber-600"
              />
              <StatRow
                label="Expires in 60 days"
                value={formatCurrency(expiry.valueAtRisk["60"])}
                color="text-yellow-600"
              />
              <StatRow
                label="Expires in 90 days"
                value={formatCurrency(expiry.valueAtRisk["90"])}
              />
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card className="lg:col-span-2" title="Top Expiring Items" icon={Pill}>
          {loading ? (
            <Loader />
          ) : expiry && expiry.topItems.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="px-2 py-1.5">Medicine</th>
                    <th className="px-2 py-1.5">Batch</th>
                    <th className="px-2 py-1.5">Qty</th>
                    <th className="px-2 py-1.5">Expires</th>
                    <th className="px-2 py-1.5">Days</th>
                    <th className="px-2 py-1.5 text-right">Value at Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {expiry.topItems.slice(0, 10).map((it) => (
                    <tr key={it.id} className="border-b last:border-0">
                      <td className="px-2 py-1.5 font-medium text-gray-800">
                        {it.medicineName}
                      </td>
                      <td className="px-2 py-1.5 text-gray-500">{it.batchNumber}</td>
                      <td className="px-2 py-1.5">{it.quantity}</td>
                      <td className="px-2 py-1.5">{it.expiryDate}</td>
                      <td
                        className={`px-2 py-1.5 font-medium ${
                          it.daysToExpiry <= 0
                            ? "text-red-600"
                            : it.daysToExpiry <= 30
                              ? "text-amber-600"
                              : "text-gray-700"
                        }`}
                      >
                        {it.daysToExpiry <= 0 ? "EXPIRED" : `${it.daysToExpiry}d`}
                      </td>
                      <td className="px-2 py-1.5 text-right font-medium">
                        {formatCurrency(it.valueAtRisk)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>
      </div>

      {/* Top Dispensed */}
      <div className="mb-6">
        <Card title="Top Dispensed Medicines" icon={Pill}>
          {loading ? (
            <Loader />
          ) : dispensed.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-2">
              {dispensed.map((d) => {
                const max = dispensed[0]?.dispensed || 1;
                const pct = (d.dispensed / max) * 100;
                return (
                  <div key={d.medicineName}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="truncate pr-2 font-medium text-gray-700">
                        {d.medicineName}
                      </span>
                      <span className="text-gray-500">{d.dispensed} units</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full bg-secondary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Feedback Trends */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Feedback Summary" icon={Star}>
          {loading ? (
            <Loader />
          ) : feedback ? (
            <div className="space-y-3">
              <StatRow label="Total Responses" value={feedback.totalResponses} />
              <StatRow
                label="Avg Rating"
                value={`${feedback.overallAvgRating} / 5`}
                color="text-amber-600"
              />
              <StatRow
                label="Net Promoter Score"
                value={feedback.overallNps}
                color={
                  feedback.overallNps > 30
                    ? "text-green-600"
                    : feedback.overallNps < 0
                      ? "text-red-600"
                      : "text-gray-700"
                }
              />
            </div>
          ) : (
            <EmptyState />
          )}
        </Card>

        <Card className="lg:col-span-2" title="NPS & Rating Trend" icon={TrendingUp}>
          {loading ? (
            <Loader />
          ) : feedback && feedback.series.length > 0 ? (
            <LineChart
              data={feedback.series as unknown as Array<Record<string, number | string>>}
              xKey="date"
              yKeys={[
                { key: "nps", label: "NPS", color: "#059669" },
                { key: "avgRating", label: "Avg Rating", color: "#f59e0b" },
              ]}
            />
          ) : (
            <EmptyState />
          )}
        </Card>
      </div>

      <div className="mb-6">
        <Card title="Feedback by Category" icon={Star}>
          {loading ? (
            <Loader />
          ) : feedback && feedback.categories.length > 0 ? (
            <BarChart
              categories={feedback.categories.map((c, i) => ({
                key: c.category,
                label: c.category,
                color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
              }))}
              values={Object.fromEntries(feedback.categories.map((c) => [c.category, c.avgRating]))}
              formatValue={(n) => `${n.toFixed(2)} / 5`}
            />
          ) : (
            <EmptyState />
          )}
        </Card>
      </div>

      {/* Drill-down modal */}
      {drillDown && (
        <DrillDownModal data={drillDown} onClose={() => setDrillDown(null)} />
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────

function Loader() {
  return <div className="py-8 text-center text-sm text-gray-400">Loading...</div>;
}

function EmptyState() {
  return <p className="py-4 text-sm text-gray-400">No data for this period</p>;
}

function StatRow({
  label,
  value,
  color,
}: {
  label: string;
  value: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b pb-2 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm font-semibold ${color || "text-gray-800"}`}>{value}</span>
    </div>
  );
}

function MiniKpi({
  label,
  value,
  highlight,
}: {
  label: string;
  value: React.ReactNode;
  highlight?: string;
}) {
  return (
    <div className="rounded-lg bg-gray-50 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${highlight || "text-gray-900"}`}>{value}</p>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  deltaPct,
  prevValue,
  icon: Icon,
  bg,
  color,
  loading,
}: {
  label: string;
  value: number | string;
  sub?: string;
  deltaPct?: number;
  prevValue?: number | string;
  icon: React.ElementType;
  bg: string;
  color: string;
  loading?: boolean;
}) {
  const showDelta = deltaPct !== undefined;
  const positive = (deltaPct || 0) >= 0;
  return (
    <div className="rounded-xl bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${bg}`}>
          <Icon size={20} className={color} />
        </div>
        {showDelta && (
          <span
            className={`flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium ${
              positive ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
            }`}
            title={prevValue !== undefined ? `Previous: ${prevValue}` : undefined}
          >
            {positive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {Math.abs(deltaPct!).toFixed(1)}%
          </span>
        )}
      </div>
      <p className="mt-3 text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900">{loading ? "..." : value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
      {prevValue !== undefined && showDelta && (
        <p className="mt-1 text-[10px] text-gray-400">Previous: {prevValue}</p>
      )}
    </div>
  );
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th
      className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide hover:text-gray-700"
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && <span className="text-[10px]">{dir === "asc" ? "▲" : "▼"}</span>}
      </span>
    </th>
  );
}

function DrillDownModal({ data, onClose }: { data: DrillDown; onClose: () => void }) {
  return (
    <div
      className="no-print fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">{data.title}</h3>
            <p className="mt-1 text-xs text-gray-500">
              {data.breadcrumbs.map((b, i) => (
                <span key={i}>
                  {i > 0 && <span className="mx-1">›</span>}
                  <span>{b}</span>
                </span>
              ))}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-6">
          {data.rows.length === 0 ? (
            <p className="text-sm text-gray-400">No data available</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  {data.columns.map((c) => (
                    <th key={c.key} className="px-3 py-2 font-medium">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {data.columns.map((c) => (
                      <td key={c.key} className="px-3 py-2 text-gray-700">
                        {c.isCurrency && typeof row[c.key] === "number"
                          ? formatCurrency(Number(row[c.key]))
                          : String(row[c.key] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Benchmarks & Forecasting Panel (Apr 2026) ─────────

interface BenchmarkData {
  metric: string;
  period: string;
  current: number;
  prior: number;
  yoy: number;
  rolling3Avg: number;
  percentile: number;
  label: string;
  deltaVsPriorPct: number;
  deltaVsYoyPct: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  sampleCount: number;
}

interface ForecastData {
  metric: string;
  groupBy: string;
  historical: Array<{ date: string; value: number }>;
  forecast: Array<{ period: string; value: number; confidence: string }>;
  model: { slope: number; intercept: number; r2: number };
  confidence: string;
}

function BenchmarkAndForecastPanel() {
  const [metric, setMetric] = useState<"revenue" | "appointments" | "admissions">(
    "revenue"
  );
  const [period, setPeriod] = useState<"day" | "week" | "month">("day");
  const [bench, setBench] = useState<BenchmarkData | null>(null);
  const [forecast, setForecast] = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const b = await api.get<{ data: BenchmarkData }>(
          `/analytics/benchmarks?metric=${metric}&period=${period}`
        );
        if (!cancelled) setBench(b.data);
        if (metric !== "admissions") {
          const f = await api.get<{ data: ForecastData }>(
            `/analytics/forecast?metric=${metric}&periods=7&groupBy=day`
          );
          if (!cancelled) setForecast(f.data);
        } else {
          setForecast(null);
        }
      } catch {
        if (!cancelled) {
          setBench(null);
          setForecast(null);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [metric, period]);

  function fmtValue(n: number): string {
    if (metric === "revenue") {
      return `Rs. ${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
    }
    return n.toLocaleString("en-IN");
  }

  const badgeColor = (pct: number) => {
    if (pct >= 90) return "bg-emerald-100 text-emerald-800";
    if (pct >= 75) return "bg-green-100 text-green-700";
    if (pct <= 10) return "bg-red-100 text-red-700";
    if (pct <= 25) return "bg-amber-100 text-amber-700";
    return "bg-gray-100 text-gray-600";
  };

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Benchmarks & Forecast</h2>
          <p className="text-xs text-gray-500">
            Compared vs prior periods and past year distribution
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as typeof metric)}
            className="rounded-lg border px-3 py-1.5 text-xs"
          >
            <option value="revenue">Revenue</option>
            <option value="appointments">Appointments</option>
            <option value="admissions">Admissions</option>
          </select>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as typeof period)}
            className="rounded-lg border px-3 py-1.5 text-xs"
          >
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
        </div>
      </div>

      {loading && <p className="text-sm text-gray-400">Loading...</p>}

      {bench && !loading && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="rounded-lg bg-blue-50 p-4">
            <p className="text-xs font-medium text-blue-600">Current</p>
            <p className="mt-1 text-2xl font-bold text-blue-900">
              {fmtValue(bench.current)}
            </p>
            <span
              className={`mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${badgeColor(bench.percentile)}`}
            >
              {bench.label}
            </span>
            <p className="mt-1 text-xs text-gray-500">
              {bench.percentile}th percentile · {bench.sampleCount} samples
            </p>
          </div>
          <div className="rounded-lg bg-gray-50 p-4">
            <p className="text-xs font-medium text-gray-500">Prior Period</p>
            <p className="mt-1 text-xl font-semibold">{fmtValue(bench.prior)}</p>
            <p className="mt-1 text-xs">
              <span
                className={
                  bench.deltaVsPriorPct >= 0 ? "text-green-600" : "text-red-600"
                }
              >
                {bench.deltaVsPriorPct >= 0 ? "+" : ""}
                {bench.deltaVsPriorPct}%
              </span>{" "}
              vs prior
            </p>
          </div>
          <div className="rounded-lg bg-gray-50 p-4">
            <p className="text-xs font-medium text-gray-500">Year over Year</p>
            <p className="mt-1 text-xl font-semibold">{fmtValue(bench.yoy)}</p>
            <p className="mt-1 text-xs">
              <span
                className={
                  bench.deltaVsYoyPct >= 0 ? "text-green-600" : "text-red-600"
                }
              >
                {bench.deltaVsYoyPct >= 0 ? "+" : ""}
                {bench.deltaVsYoyPct}%
              </span>{" "}
              YoY
            </p>
          </div>
          <div className="rounded-lg bg-gray-50 p-4">
            <p className="text-xs font-medium text-gray-500">3-Period Rolling</p>
            <p className="mt-1 text-xl font-semibold">
              {fmtValue(bench.rolling3Avg)}
            </p>
            <p className="mt-2 text-xs text-gray-500">
              P50: {fmtValue(bench.p50)} · P90: {fmtValue(bench.p90)}
            </p>
          </div>
        </div>
      )}

      {forecast && !loading && (
        <div className="mt-6 border-t pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Next 7 Days Forecast</h3>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                forecast.confidence === "high"
                  ? "bg-emerald-100 text-emerald-700"
                  : forecast.confidence === "medium"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-gray-100 text-gray-600"
              }`}
            >
              Confidence: {forecast.confidence} (R²{" "}
              {forecast.model.r2.toFixed(2)})
            </span>
          </div>
          <div className="grid grid-cols-7 gap-2">
            {forecast.forecast.map((p) => (
              <div
                key={p.period}
                className="rounded-lg border border-dashed border-blue-200 bg-blue-50/40 p-3 text-center"
              >
                <p className="text-xs text-gray-500">{p.period.slice(5)}</p>
                <p className="mt-1 text-sm font-semibold text-blue-900">
                  {fmtValue(p.value)}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500">
            Trend slope: {forecast.model.slope} per period · Based on 30-day linear
            regression
          </p>
        </div>
      )}
    </div>
  );
}
