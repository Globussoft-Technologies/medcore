"use client";

// Sprint 2 (2026-04-30): admin-facing Sentiment Analytics dashboard.
// Reads three live endpoints exposed by the AI sentiment pipeline:
//   • GET /api/v1/ai/sentiment/nps-drivers?days=N   — driver themes + total
//   • GET /api/v1/feedback/summary?from=&to=        — NPS, per-category avgs
//   • GET /api/v1/feedback?from=&to=&limit=50       — recent rows + sentiment
// Drivers are server-aggregated; we just render. No recharts dep — CSS bars.
//
// Role gate (Issue #179 pattern): only ADMIN + RECEPTION may view this page.
// Other roles redirect to /dashboard/not-authorized?from=... so the layout
// chrome stays put and the user gets a clear "you don't have access" message
// instead of a half-rendered analytics surface.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

const SENTIMENT_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

const CATEGORIES = [
  "DOCTOR",
  "NURSE",
  "RECEPTION",
  "WAITING_TIME",
  "BILLING",
  "CLEANLINESS",
  "FOOD",
  "OVERALL",
];

interface NpsDriverTheme {
  theme: string;
  count: number;
  sampleQuotes?: string[];
}

interface NpsDriversSummary {
  windowDays: number;
  totalFeedback: number;
  positiveThemes: NpsDriverTheme[];
  negativeThemes: NpsDriverTheme[];
  actionableInsights: string[];
  generatedAt: string;
}

interface FeedbackSummary {
  totalCount: number;
  overallAvg: number;
  avgRatingByCategory: Record<string, number>;
  npsScore: number;
  npsSampleSize: number;
  promoters: number;
  detractors: number;
  passives: number;
  trend: Array<{ month: string; avgRating: number; count: number }>;
}

interface FeedbackRow {
  id: string;
  category: string;
  rating: number;
  nps: number | null;
  comment: string | null;
  submittedAt: string;
  patient?: { user: { name?: string } };
  aiSentiment?: {
    sentiment: "positive" | "neutral" | "negative";
    score?: number;
    themes?: string[];
  } | null;
}

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return isoDate(d);
}

function defaultTo(): string {
  return isoDate(new Date());
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function SentimentScoreBadge({ s }: { s?: FeedbackRow["aiSentiment"] }) {
  if (!s) {
    return (
      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">
        n/a
      </span>
    );
  }
  const color =
    s.sentiment === "positive"
      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
      : s.sentiment === "negative"
        ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
        : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200";
  const score = typeof s.score === "number" ? ` ${s.score.toFixed(2)}` : "";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}>
      {s.sentiment}
      {score}
    </span>
  );
}

export default function SentimentAnalyticsPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  const [from, setFrom] = useState<string>(defaultFrom);
  const [to, setTo] = useState<string>(defaultTo);

  const [drivers, setDrivers] = useState<NpsDriversSummary | null>(null);
  const [summary, setSummary] = useState<FeedbackSummary | null>(null);
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Role gate — redirect non-allowed roles to /dashboard/not-authorized.
  useEffect(() => {
    if (!isLoading && user && !SENTIMENT_ALLOWED.has(user.role)) {
      toast.error(
        "Sentiment Analytics is for staff (Admin / Reception). Redirecting...",
        4000,
      );
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(
          pathname || "/dashboard/sentiment",
        )}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  // Compute window in days for the drivers endpoint from the date range.
  const windowDays = useMemo(() => {
    try {
      const f = new Date(from);
      const t = new Date(to);
      const diff = Math.round((t.getTime() - f.getTime()) / 86_400_000);
      return Math.max(1, Math.min(365, diff || 30));
    } catch {
      return 30;
    }
  }, [from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      qs.set("limit", "50");

      const [driversRes, summaryRes, listRes] = await Promise.all([
        api
          .get<{ data: NpsDriversSummary }>(
            `/ai/sentiment/nps-drivers?days=${windowDays}`,
          )
          .catch(() => ({ data: null as unknown as NpsDriversSummary })),
        api
          .get<{ data: FeedbackSummary }>(
            `/feedback/summary?${from ? `from=${from}` : ""}${to ? `&to=${to}` : ""}`,
          )
          .catch(() => ({ data: null as unknown as FeedbackSummary })),
        api
          .get<{ data: FeedbackRow[] }>(`/feedback?${qs.toString()}`)
          .catch(() => ({ data: [] as FeedbackRow[] })),
      ]);

      const d = (driversRes as { data: NpsDriversSummary | null }).data;
      if (
        d &&
        Array.isArray(d.positiveThemes) &&
        Array.isArray(d.negativeThemes)
      ) {
        setDrivers(d);
      } else {
        setDrivers(null);
      }
      setSummary(
        (summaryRes as { data: FeedbackSummary | null }).data ?? null,
      );
      setRows(
        Array.isArray((listRes as { data: FeedbackRow[] }).data)
          ? (listRes as { data: FeedbackRow[] }).data
          : [],
      );
    } finally {
      setLoading(false);
    }
  }, [from, to, windowDays]);

  // Refetch whenever the date range changes (and on first allowed render).
  useEffect(() => {
    if (user && !SENTIMENT_ALLOWED.has(user.role)) return;
    if (isLoading) return;
    load();
  }, [from, to, user, isLoading, load]);

  // Derive sentiment distribution + flagged feedback from the recent rows.
  // NOTE: every useMemo below must run on every render to satisfy
  // react-hooks/rules-of-hooks. The role-gate render-guard MUST live AFTER
  // all hook calls (moved below `driverBars`).
  const distribution = useMemo(() => {
    let pos = 0;
    let neu = 0;
    let neg = 0;
    for (const r of rows) {
      const s = r.aiSentiment?.sentiment;
      if (s === "positive") pos++;
      else if (s === "negative") neg++;
      else if (s === "neutral") neu++;
    }
    const total = pos + neu + neg;
    return {
      pos,
      neu,
      neg,
      total,
      posPct: total ? (pos / total) * 100 : 0,
      neuPct: total ? (neu / total) * 100 : 0,
      negPct: total ? (neg / total) * 100 : 0,
    };
  }, [rows]);

  const flagged = useMemo(
    () =>
      rows
        .filter((r) => r.aiSentiment?.sentiment === "negative")
        .slice(0, 20),
    [rows],
  );

  // NPS-driver bar chart — order by abs weight desc. Drivers come pre-counted.
  const driverBars = useMemo(() => {
    const pos = (drivers?.positiveThemes ?? []).map((t) => ({
      theme: t.theme,
      weight: t.count,
      sign: 1 as const,
    }));
    const neg = (drivers?.negativeThemes ?? []).map((t) => ({
      theme: t.theme,
      weight: t.count,
      sign: -1 as const,
    }));
    const all = [...pos, ...neg].sort(
      (a, b) => Math.abs(b.weight) - Math.abs(a.weight),
    );
    return all.slice(0, 8);
  }, [drivers]);

  const driverMax = Math.max(1, ...driverBars.map((d) => d.weight));

  // Brief render-guard between role-check and router.replace landing.
  // MUST sit AFTER every useMemo above so the hook call order is stable.
  if (user && !SENTIMENT_ALLOWED.has(user.role)) return null;

  const totalFeedback = drivers?.totalFeedback ?? summary?.totalCount ?? 0;
  const nps = summary?.npsScore ?? 0;
  const npsColor =
    nps > 50
      ? "text-green-700 dark:text-green-300"
      : nps >= 0
        ? "text-yellow-700 dark:text-yellow-300"
        : "text-red-700 dark:text-red-300";

  return (
    <div data-testid="sentiment-page">
      {/* Header + date range */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Sentiment Analytics
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Patient sentiment, NPS drivers, and flagged feedback across all
            categories.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              From
            </label>
            <input
              data-testid="sentiment-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              To
            </label>
            <input
              data-testid="sentiment-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div
          data-testid="sentiment-kpi-nps"
          className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800"
        >
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
            NPS Score
          </p>
          <p className={`mt-1 text-3xl font-bold ${npsColor}`}>{nps}</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {summary?.promoters ?? 0} promoters · {summary?.detractors ?? 0}{" "}
            detractors ({summary?.npsSampleSize ?? 0} responses)
          </p>
        </div>
        <div
          data-testid="sentiment-kpi-total"
          className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800"
        >
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Total Feedback
          </p>
          <p className="mt-1 text-3xl font-bold text-gray-900 dark:text-gray-100">
            {totalFeedback}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            in selected range
          </p>
        </div>
        <div
          data-testid="sentiment-kpi-avg"
          className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800"
        >
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Avg Sentiment
          </p>
          <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              data-testid="sentiment-dist-positive"
              className="h-full bg-green-500 dark:bg-green-400"
              style={{ width: `${distribution.posPct}%` }}
              title={`Positive ${distribution.pos}`}
            />
            <div
              data-testid="sentiment-dist-neutral"
              className="h-full bg-gray-400 dark:bg-gray-500"
              style={{ width: `${distribution.neuPct}%` }}
              title={`Neutral ${distribution.neu}`}
            />
            <div
              data-testid="sentiment-dist-negative"
              className="h-full bg-red-500 dark:bg-red-400"
              style={{ width: `${distribution.negPct}%` }}
              title={`Negative ${distribution.neg}`}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs text-gray-500 dark:text-gray-400">
            <span className="text-green-700 dark:text-green-300">
              {distribution.pos} pos
            </span>
            <span>{distribution.neu} neu</span>
            <span className="text-red-700 dark:text-red-300">
              {distribution.neg} neg
            </span>
          </div>
        </div>
      </div>

      {/* NPS-driver chart */}
      <div className="mb-6 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">
            NPS Drivers
          </h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            top {driverBars.length} themes by weight
          </span>
        </div>
        {driverBars.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No driver themes for the selected window yet.
          </p>
        ) : (
          <div className="space-y-2">
            {driverBars.map((d) => {
              const pct = (d.weight / driverMax) * 100;
              return (
                <div
                  key={`${d.sign}-${d.theme}`}
                  data-testid={`sentiment-driver-${slug(d.theme)}`}
                  className="flex items-center gap-3"
                >
                  <div className="w-40 truncate text-sm text-gray-700 dark:text-gray-200">
                    {d.theme}
                  </div>
                  <div className="relative h-5 flex-1 rounded bg-gray-100 dark:bg-gray-700">
                    <div
                      className={`h-full rounded ${
                        d.sign > 0
                          ? "bg-green-500 dark:bg-green-400"
                          : "bg-red-500 dark:bg-red-400"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div
                    className={`w-14 text-right text-xs font-semibold ${
                      d.sign > 0
                        ? "text-green-700 dark:text-green-300"
                        : "text-red-700 dark:text-red-300"
                    }`}
                  >
                    {d.sign > 0 ? "+" : "-"}
                    {d.weight}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Per-category sentiment trend (avg-rating proxy bar per category). */}
      <div className="mb-6 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 font-semibold text-gray-900 dark:text-gray-100">
          Sentiment by Category
        </h2>
        <div className="space-y-3">
          {CATEGORIES.map((c) => {
            const v = summary?.avgRatingByCategory?.[c] ?? 0;
            const pct = (v / 5) * 100;
            return (
              <div
                key={c}
                data-testid={`sentiment-category-${slug(c)}`}
                className="flex items-center gap-3"
              >
                <div className="w-32 text-sm text-gray-600 dark:text-gray-300">
                  {c.replace(/_/g, " ")}
                </div>
                <div className="relative h-5 flex-1 rounded bg-gray-100 dark:bg-gray-700">
                  <div
                    className="h-full rounded bg-indigo-500 dark:bg-indigo-400"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="w-12 text-right text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {v.toFixed(2)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent flagged (negative-sentiment) feedback. */}
      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">
            Recent Flagged Feedback
          </h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            last {flagged.length} negative items
          </span>
        </div>
        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        ) : flagged.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No negative-sentiment feedback in this range. Nice.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {flagged.map((f) => (
              <li
                key={f.id}
                data-testid={`sentiment-flagged-row-${f.id}`}
                className="flex items-start gap-3 py-3"
              >
                <div className="w-28 shrink-0 text-xs text-gray-500 dark:text-gray-400">
                  {new Date(f.submittedAt).toLocaleString()}
                </div>
                <div className="w-28 shrink-0 text-xs font-medium text-gray-700 dark:text-gray-300">
                  {f.category.replace(/_/g, " ")}
                </div>
                <div className="flex-1 text-sm text-gray-800 dark:text-gray-200">
                  {f.comment
                    ? f.comment.length > 140
                      ? f.comment.slice(0, 140) + "…"
                      : f.comment
                    : <span className="text-gray-400">(no comment)</span>}
                </div>
                <div className="shrink-0">
                  <SentimentScoreBadge s={f.aiSentiment} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
