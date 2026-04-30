"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

// Issue #207 (Apr 2026): Patient Feedback Analytics is staff-only. The
// previous version routed PATIENT here too, exposing per-doctor NPS and
// negative-theme drivers. Patients now redirect back to the dashboard.
const FEEDBACK_ANALYTICS_ALLOWED = new Set([
  "ADMIN",
  "DOCTOR",
  "NURSE",
  "RECEPTION",
]);

interface Feedback {
  id: string;
  category: string;
  rating: number;
  nps: number | null;
  comment: string | null;
  submittedAt: string;
  patient?: { user: { name: string; phone: string } };
  aiSentiment?: {
    sentiment: "positive" | "neutral" | "negative";
    emotions: string[];
    themes: string[];
  } | null;
}

interface NpsDriversSummary {
  windowDays: number;
  totalFeedback: number;
  positiveThemes: Array<{ theme: string; count: number; sampleQuotes: string[] }>;
  negativeThemes: Array<{ theme: string; count: number; sampleQuotes: string[] }>;
  actionableInsights: string[];
  generatedAt: string;
}

function SentimentBadge({
  sentiment,
}: {
  sentiment?: "positive" | "neutral" | "negative" | null;
}) {
  if (!sentiment) {
    return (
      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">
        analyzing…
      </span>
    );
  }
  const color =
    sentiment === "positive"
      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
      : sentiment === "negative"
        ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
        : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}>
      {sentiment}
    </span>
  );
}

interface Summary {
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

const CATEGORIES = [
  "DOCTOR",
  "NURSE",
  "RECEPTION",
  "CLEANLINESS",
  "FOOD",
  "WAITING_TIME",
  "BILLING",
  "OVERALL",
];

function StarDisplay({ rating }: { rating: number }) {
  return (
    <span className="text-yellow-500">
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n}>{n <= rating ? "\u2605" : "\u2606"}</span>
      ))}
    </span>
  );
}

export default function FeedbackPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [npsDrivers, setNpsDrivers] = useState<NpsDriversSummary | null>(null);
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);

  // Issue #207: keep patients out of the staff-side analytics dashboard.
  // Issue #179: target /dashboard/not-authorized so the layout chrome stays.
  useEffect(() => {
    if (!isLoading && user && !FEEDBACK_ANALYTICS_ALLOWED.has(user.role)) {
      toast.error(
        "The feedback analytics dashboard is for staff. Use 'Submit Feedback' instead.",
        5000
      );
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/feedback")}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  useEffect(() => {
    if (user && !FEEDBACK_ANALYTICS_ALLOWED.has(user.role)) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, from, to, user]);

  useEffect(() => {
    // Load AI NPS-drivers widget once on mount. Never blocks the main list.
    // Issue #207: skip for non-staff (we'll be redirecting them).
    if (user && !FEEDBACK_ANALYTICS_ALLOWED.has(user.role)) return;
    api
      .get<{ data: NpsDriversSummary }>("/ai/sentiment/nps-drivers?days=30")
      .then((r) => {
        const d = r.data as NpsDriversSummary | null | undefined;
        if (
          d &&
          Array.isArray(d.positiveThemes) &&
          Array.isArray(d.negativeThemes) &&
          Array.isArray(d.actionableInsights)
        ) {
          setNpsDrivers(d);
        } else {
          setNpsDrivers(null);
        }
      })
      .catch(() => setNpsDrivers(null));
  }, [user]);

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (category) qs.set("category", category);
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      qs.set("limit", "50");

      const [listRes, sumRes] = await Promise.all([
        api.get<{ data: Feedback[] }>(`/feedback?${qs.toString()}`),
        api.get<{ data: Summary }>(
          `/feedback/summary?${from ? `from=${from}` : ""}${to ? `&to=${to}` : ""}`
        ),
      ]);
      setFeedbacks(listRes.data);
      setSummary(sumRes.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  // Issue #207: guard render path for the brief moment between role-check
  // and router.replace firing.
  if (user && !FEEDBACK_ANALYTICS_ALLOWED.has(user.role)) return null;

  const nps = summary?.npsScore ?? 0;
  const npsColor =
    nps > 50
      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
      : nps >= 0
        ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300"
        : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";

  const thisMonthCount =
    summary?.trend?.[summary.trend.length - 1]?.count ?? 0;

  const maxCatAvg = Math.max(
    5,
    ...Object.values(summary?.avgRatingByCategory || {})
  );

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-gray-100">Patient Feedback</h1>

      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className={`rounded-xl p-5 shadow-sm ${npsColor}`}>
          <p className="text-xs font-medium opacity-80">NPS Score</p>
          <p className="mt-1 text-3xl font-bold">{nps}</p>
          <p className="mt-1 text-xs opacity-70">
            {summary?.promoters || 0} promoters,{" "}
            {summary?.detractors || 0} detractors ({summary?.npsSampleSize || 0}{" "}
            responses)
          </p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Overall Avg Rating</p>
          <p className="mt-1 text-3xl font-bold text-gray-800 dark:text-gray-100">
            {summary?.overallAvg != null ? summary.overallAvg.toFixed(2) : "0.00"}
          </p>
          <div className="mt-1 text-sm">
            <StarDisplay rating={Math.round(summary?.overallAvg ?? 0)} />
          </div>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Feedback Count (This Month)
          </p>
          <p className="mt-1 text-3xl font-bold text-gray-800 dark:text-gray-100">
            {thisMonthCount}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Total in range: {summary?.totalCount ?? 0}
          </p>
        </div>
      </div>

      {/* NPS Drivers widget (AI) */}
      {npsDrivers && (
        <div className="mb-6 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">
              NPS Drivers (AI, last {npsDrivers.windowDays} days)
            </h2>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {npsDrivers.totalFeedback} feedback analysed
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div>
              <div className="mb-2 text-xs font-semibold text-green-700 dark:text-green-400">
                Top Positive Themes
              </div>
              <ul className="space-y-1 text-sm">
                {npsDrivers.positiveThemes.length === 0 ? (
                  <li className="text-xs text-gray-400">None</li>
                ) : (
                  npsDrivers.positiveThemes.slice(0, 5).map((t, i) => (
                    <li key={i} className="text-gray-700 dark:text-gray-300">
                      <span className="font-semibold">{t.theme}</span>{" "}
                      <span className="text-xs text-gray-500">({t.count})</span>
                    </li>
                  ))
                )}
              </ul>
            </div>
            <div>
              <div className="mb-2 text-xs font-semibold text-red-700 dark:text-red-400">
                Top Negative Themes
              </div>
              <ul className="space-y-1 text-sm">
                {npsDrivers.negativeThemes.length === 0 ? (
                  <li className="text-xs text-gray-400">None</li>
                ) : (
                  npsDrivers.negativeThemes.slice(0, 5).map((t, i) => (
                    <li key={i} className="text-gray-700 dark:text-gray-300">
                      <span className="font-semibold">{t.theme}</span>{" "}
                      <span className="text-xs text-gray-500">({t.count})</span>
                    </li>
                  ))
                )}
              </ul>
            </div>
            <div>
              <div className="mb-2 text-xs font-semibold text-blue-700 dark:text-blue-400">
                Actionable Insights
              </div>
              <ul className="list-inside list-disc space-y-1 text-xs text-gray-600 dark:text-gray-400">
                {npsDrivers.actionableInsights.length === 0 ? (
                  <li className="text-gray-400">None</li>
                ) : (
                  npsDrivers.actionableInsights.slice(0, 5).map((a, i) => <li key={i}>{a}</li>)
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Category bar chart */}
      <div className="mb-6 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-4 font-semibold text-gray-900 dark:text-gray-100">Average Rating by Category</h2>
        <div className="space-y-3">
          {CATEGORIES.map((c) => {
            const v = summary?.avgRatingByCategory?.[c] ?? 0;
            const pct = (v / 5) * 100;
            return (
              <div key={c} className="flex items-center gap-3">
                <div className="w-32 text-sm text-gray-600 dark:text-gray-300">
                  {c.replace(/_/g, " ")}
                </div>
                <div className="relative h-6 flex-1 rounded bg-gray-100 dark:bg-gray-700">
                  <div
                    className="h-full rounded bg-primary"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="w-12 text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {v.toFixed(2)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
            Category
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
            From
          </label>
          <input
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
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>
        ) : feedbacks.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">No feedback yet</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Rating</th>
                <th className="px-4 py-3">NPS</th>
                <th className="px-4 py-3">Sentiment</th>
                <th className="px-4 py-3">Comment</th>
              </tr>
            </thead>
            <tbody>
              {feedbacks.map((f) => (
                <tr key={f.id} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                    {new Date(f.submittedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                    {f.patient?.user.name || "-"}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                    {f.category.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-3">
                    <StarDisplay rating={f.rating} />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                    {f.nps !== null ? f.nps : "-"}
                  </td>
                  <td className="px-4 py-3">
                    <SentimentBadge sentiment={f.aiSentiment?.sentiment} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                    {f.comment
                      ? f.comment.length > 60
                        ? f.comment.slice(0, 60) + "..."
                        : f.comment
                      : ""}
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
