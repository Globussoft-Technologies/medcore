"use client";

/**
 * Sprint 2 — Symptom Diary patient UI.
 *
 * Server contract (apps/api/src/routes/ai-symptom-diary.ts):
 *   POST /ai/symptom-diary  body { symptomDate: ISO, entries:[{symptom, severity 1-10, notes?}] }
 *   GET  /ai/symptom-diary  → last 90 days for the calling patient.
 * Both endpoints are gated by `authorize(Role.PATIENT)` server-side: only a
 * PATIENT can read or write. Staff (DOCTOR/NURSE/RECEPTION) viewing a
 * specific patient's diary via `?patientId=` is read-only and does not hit
 * this endpoint — that path is reserved for a future staff-side admin
 * route. For Sprint 2 we keep staff to a read-only banner; non-allowed
 * roles bounce to /dashboard/not-authorized per the #179 pattern.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { sanitizeUserInput } from "@medcore/shared";
import { extractFieldErrors } from "@/lib/field-errors";
import { Plus, X, Activity, ChevronDown, ChevronRight } from "lucide-react";

// Roles allowed to *view* the diary at all. PATIENT sees their own; staff
// viewing `?patientId=` sees a read-only banner (Sprint 2 placeholder). All
// other roles get redirected to /dashboard/not-authorized.
const VIEW_ALLOWED = new Set(["PATIENT", "DOCTOR", "NURSE", "RECEPTION", "ADMIN"]);

// Server stores `{symptomDate, entries:[{symptom, severity 1-10, notes?}]}`.
// One row per calendar day. We surface each day-row as a single history item.

interface DiaryServerEntry {
  symptom: string;
  severity: number;
  notes?: string;
}

interface DiaryDay {
  id: string;
  patientId: string;
  symptomDate: string;
  entries: DiaryServerEntry[];
  createdAt?: string;
}

const SEVERITY_PILLS = [1, 2, 3, 4, 5] as const;

function severityBadgeClass(sev: number): string {
  if (sev <= 2) return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  if (sev <= 3) return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
  if (sev <= 4) return "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300";
  return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function nowLocalDatetime(): string {
  // datetime-local wants `YYYY-MM-DDTHH:mm` in the browser's local TZ.
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60_000);
  return local.toISOString().slice(0, 16);
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "..." : s;
}

export default function SymptomDiaryPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const viewingPatientId = searchParams?.get("patientId") ?? null;

  const [days, setDays] = useState<DiaryDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isPatient = user?.role === "PATIENT";
  const isStaffViewing = !isPatient && !!viewingPatientId;

  // Issue #179: redirect non-allowed roles, preserving layout chrome.
  useEffect(() => {
    if (isLoading) return;
    if (!user) return;
    if (!VIEW_ALLOWED.has(user.role)) {
      toast.error("Symptom diary is restricted.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/symptom-diary")}`,
      );
      return;
    }
    // Staff role without a `?patientId=` has nothing useful to view here.
    if (!isPatient && !viewingPatientId) {
      toast.error("Open a patient's diary from their profile to view entries.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/symptom-diary")}`,
      );
    }
  }, [user, isLoading, isPatient, viewingPatientId, router, pathname]);

  // Only PATIENT hits the API — server route is gated to PATIENT-only and
  // resolves the patient from the authed user. Staff with `?patientId=` see
  // a read-only banner placeholder until a staff-side endpoint ships.
  useEffect(() => {
    if (isLoading || !user || !isPatient) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<{ data: DiaryDay[] }>("/ai/symptom-diary")
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res.data) ? res.data : [];
        // API already returns symptomDate desc, but defend against drift.
        list.sort(
          (a, b) =>
            new Date(b.symptomDate).getTime() -
            new Date(a.symptomDate).getTime(),
        );
        setDays(list);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.status === 404) {
          // No Patient row linked to this account — render the empty state
          // rather than a scary error banner.
          setDays([]);
        } else {
          setError(err?.message ?? "Failed to load symptom diary");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, isLoading, isPatient]);

  // Stat-row aggregates over the last 7 days (mandatory v1 fallback for the
  // trend chart). Severity is 1-10 server-side; we display the raw mean.
  const weekStats = useMemo(() => {
    if (days.length === 0) return { count: 0, avgSeverity: 0 };
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let count = 0;
    let sumSev = 0;
    let sevN = 0;
    for (const d of days) {
      const t = new Date(d.symptomDate).getTime();
      if (t < cutoff) continue;
      for (const e of d.entries ?? []) {
        count += 1;
        if (Number.isFinite(e.severity)) {
          sumSev += e.severity;
          sevN += 1;
        }
      }
    }
    const avg = sevN === 0 ? 0 : Math.round((sumSev / sevN) * 10) / 10;
    return { count, avgSeverity: avg };
  }, [days]);

  // 30-day per-day count for the simple CSS bar chart.
  const trendBars = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const buckets: { dayKey: string; label: string; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      buckets.push({
        dayKey: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
        count: 0,
      });
    }
    const idx = new Map(buckets.map((b, i) => [b.dayKey, i]));
    for (const day of days) {
      const k = day.symptomDate.slice(0, 10);
      const i = idx.get(k);
      if (i !== undefined) buckets[i].count += (day.entries?.length ?? 0);
    }
    return buckets;
  }, [days]);

  const trendMax = Math.max(1, ...trendBars.map((b) => b.count));

  function handleSaved(saved: DiaryDay) {
    // Server upserts on (patientId, symptomDate). Replace any existing row
    // for that day, otherwise prepend.
    setDays((prev) => {
      const others = prev.filter((d) => d.id !== saved.id);
      const merged = [saved, ...others];
      merged.sort(
        (a, b) =>
          new Date(b.symptomDate).getTime() -
          new Date(a.symptomDate).getTime(),
      );
      return merged;
    });
    setShowLog(false);
  }

  // Don't render anything while the redirect is in flight — avoids a flash
  // of forbidden content.
  if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) return null;
  if (!isLoading && user && !isPatient && !viewingPatientId) return null;

  return (
    <div data-testid="symptom-diary-page" className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Activity
            className="mt-1 h-6 w-6 text-blue-600 dark:text-blue-400"
            aria-hidden="true"
          />
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              Symptom Diary
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Track symptoms over time. Your doctor sees the trend in your next visit.
            </p>
          </div>
        </div>
        {isPatient && (
          <button
            type="button"
            onClick={() => setShowLog(true)}
            data-testid="symptom-diary-log-button"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Log New Entry
          </button>
        )}
      </div>

      {/* Staff read-only banner (Sprint 2 placeholder — staff endpoint TBD) */}
      {isStaffViewing && (
        <div
          className="mb-6 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200"
          data-testid="symptom-diary-staff-banner"
        >
          Read-only view of patient {viewingPatientId}. A staff-facing diary
          API ships in a later sprint — for now, ask the patient to share
          their diary directly.
        </div>
      )}

      {/* Stat row + trend bars */}
      {isPatient && !loading && !error && days.length > 0 && (
        <div
          className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
          data-testid="symptom-diary-trend"
        >
          <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span className="text-gray-700 dark:text-gray-300">
              Entries this week:{" "}
              <strong className="text-gray-900 dark:text-gray-100">
                {weekStats.count}
              </strong>
            </span>
            <span className="text-gray-700 dark:text-gray-300">
              Avg severity:{" "}
              <strong className="text-gray-900 dark:text-gray-100">
                {weekStats.avgSeverity || "—"}
              </strong>
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Last 30 days, entries per day
            </span>
          </div>
          <div className="grid h-24 grid-cols-30 items-end gap-px"
            style={{ gridTemplateColumns: "repeat(30, minmax(0, 1fr))" }}
          >
            {trendBars.map((b) => {
              const h = b.count === 0 ? 4 : Math.round((b.count / trendMax) * 100);
              return (
                <div
                  key={b.dayKey}
                  className="flex h-full items-end"
                  title={`${b.label}: ${b.count}`}
                >
                  <div
                    className={
                      "w-full rounded-sm " +
                      (b.count === 0
                        ? "bg-gray-100 dark:bg-gray-700"
                        : "bg-blue-500 dark:bg-blue-400")
                    }
                    style={{ height: `${h}%` }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Loading / error states */}
      {loading && (
        <div className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
          Loading symptom diary...
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
          {error}
        </div>
      )}

      {/* Empty state */}
      {isPatient && !loading && !error && days.length === 0 && (
        <div
          className="rounded-xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center dark:border-gray-700 dark:bg-gray-800"
          data-testid="symptom-diary-empty"
        >
          <Activity className="mx-auto mb-3 h-10 w-10 text-gray-300 dark:text-gray-600" />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No symptoms logged yet.
          </p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Tap &ldquo;Log New Entry&rdquo; above to start tracking.
          </p>
        </div>
      )}

      {/* History list */}
      {isPatient && !loading && days.length > 0 && (
        <div className="space-y-3">
          {days.map((day) =>
            (day.entries ?? []).map((entry, idx) => {
              const rowId = `${day.id}-${idx}`;
              const isOpen = !!expanded[rowId];
              const fullText = entry.notes ?? entry.symptom ?? "";
              const truncated = truncate(fullText, 120);
              const isTruncated = fullText.length > 120;
              return (
                <div
                  key={rowId}
                  data-testid={`symptom-diary-row-${rowId}`}
                  className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {formatTimestamp(day.symptomDate)}
                        </span>
                        <span
                          className={
                            "rounded-full px-2 py-0.5 text-xs font-medium " +
                            severityBadgeClass(entry.severity)
                          }
                        >
                          Severity {entry.severity}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {entry.symptom}
                      </p>
                      {fullText && (
                        <p
                          className="mt-1 whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-300"
                          data-testid={`symptom-diary-row-${rowId}-text`}
                        >
                          {isOpen || !isTruncated ? fullText : truncated}
                        </p>
                      )}
                    </div>
                    {isTruncated && (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((p) => ({ ...p, [rowId]: !p[rowId] }))
                        }
                        data-testid={`symptom-diary-row-${rowId}-toggle`}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "Collapse" : "Expand"}
                        className="shrink-0 rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                      >
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            }),
          )}
        </div>
      )}

      {showLog && isPatient && (
        <LogEntryModal
          onClose={() => setShowLog(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

// ─── Modal ─────────────────────────────────────────────────────────────────

function LogEntryModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (d: DiaryDay) => void;
}) {
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<number | null>(null);
  const [duration, setDuration] = useState("");
  const [startedAt, setStartedAt] = useState<string>(nowLocalDatetime());
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    const errs: Record<string, string> = {};

    const descTrim = description.trim();
    if (!descTrim) errs.description = "Describe the symptom";
    if (descTrim.length > 1000)
      errs.description = "Keep description under 1000 characters";
    if (severity === null) errs.severity = "Pick a severity (1–5)";
    if (!startedAt) errs.startedAt = "When did the symptom start?";

    // Optional duration — sanitize to keep XSS / control chars out.
    let cleanedDuration = "";
    if (duration.trim().length > 0) {
      const r = sanitizeUserInput(duration, {
        field: "Duration",
        maxLength: 100,
      });
      if (!r.ok) errs.duration = r.error || "Duration is invalid";
      else cleanedDuration = r.value ?? duration.trim();
    }

    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      toast.warning("Please fix the highlighted fields");
      return;
    }

    // Pack the patient-facing fields onto the server contract:
    //   symptom  ← short summary (≤100 chars, server limit)
    //   severity ← 1-5 from pill (server accepts 1-10)
    //   notes    ← full free-text + duration (≤500 server limit)
    const symptomSummary = descTrim.slice(0, 100);
    const notesParts: string[] = [];
    if (descTrim.length > 100) notesParts.push(descTrim);
    if (cleanedDuration) notesParts.push(`Duration: ${cleanedDuration}`);
    const notesJoined = notesParts.join("\n\n").slice(0, 500);

    const symptomDateIso = new Date(startedAt).toISOString();

    setSubmitting(true);
    try {
      const res = await api.post<{ data: DiaryDay }>("/ai/symptom-diary", {
        symptomDate: symptomDateIso,
        entries: [
          {
            symptom: symptomSummary,
            severity: severity!,
            ...(notesJoined ? { notes: notesJoined } : {}),
          },
        ],
      });
      toast.success("Symptom logged");
      onSaved(res.data);
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) {
        setErrors(fields);
        toast.error(Object.values(fields)[0] || "Save failed");
      } else {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="symptom-diary-modal-title"
      data-testid="symptom-diary-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="symptom-diary-modal-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            Log a Symptom
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="symptom-diary-modal-close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              Description <span className="text-red-500">*</span>
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
              data-testid="symptom-diary-description"
              rows={4}
              maxLength={1000}
              placeholder="e.g. Sharp headache behind the right eye, started after lunch"
              aria-invalid={errors.description ? "true" : undefined}
              className={
                "w-full resize-y rounded-lg border px-3 py-2 text-sm dark:bg-gray-900 dark:text-gray-100 " +
                (errors.description
                  ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                  : "border-gray-300 dark:border-gray-600")
              }
            />
            <div className="mt-1 flex items-center justify-between">
              {errors.description ? (
                <p
                  data-testid="error-symptom-diary-description"
                  className="text-xs text-red-600 dark:text-red-400"
                >
                  {errors.description}
                </p>
              ) : (
                <span />
              )}
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {description.length}/1000
              </span>
            </div>
          </label>

          <div>
            <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              Severity (1 = mild, 5 = severe){" "}
              <span className="text-red-500">*</span>
            </span>
            <div
              role="radiogroup"
              aria-label="Severity"
              className="flex flex-wrap gap-2"
              data-testid="symptom-diary-severity-group"
            >
              {SEVERITY_PILLS.map((n) => {
                const active = severity === n;
                return (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setSeverity(n)}
                    data-testid={`symptom-diary-severity-${n}`}
                    className={
                      "min-w-[44px] rounded-full border px-4 py-2 text-sm font-medium transition-colors " +
                      (active
                        ? "border-blue-600 bg-blue-600 text-white dark:border-blue-400 dark:bg-blue-500"
                        : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-700")
                    }
                  >
                    {n}
                  </button>
                );
              })}
            </div>
            {errors.severity && (
              <p
                data-testid="error-symptom-diary-severity"
                className="mt-1 text-xs text-red-600 dark:text-red-400"
              >
                {errors.severity}
              </p>
            )}
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              Duration (optional)
            </span>
            <input
              type="text"
              value={duration}
              onChange={(e) => setDuration(e.target.value.slice(0, 100))}
              data-testid="symptom-diary-duration"
              maxLength={100}
              placeholder='e.g. "30 mins", "2 hrs", "since last night"'
              aria-invalid={errors.duration ? "true" : undefined}
              className={
                "w-full rounded-lg border px-3 py-2 text-sm dark:bg-gray-900 dark:text-gray-100 " +
                (errors.duration
                  ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                  : "border-gray-300 dark:border-gray-600")
              }
            />
            {errors.duration && (
              <p
                data-testid="error-symptom-diary-duration"
                className="mt-1 text-xs text-red-600 dark:text-red-400"
              >
                {errors.duration}
              </p>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              When did it start? <span className="text-red-500">*</span>
            </span>
            <input
              type="datetime-local"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
              data-testid="symptom-diary-started-at"
              required
              aria-invalid={errors.startedAt ? "true" : undefined}
              className={
                "w-full rounded-lg border px-3 py-2 text-sm dark:bg-gray-900 dark:text-gray-100 " +
                (errors.startedAt
                  ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                  : "border-gray-300 dark:border-gray-600")
              }
            />
            {errors.startedAt && (
              <p
                data-testid="error-symptom-diary-started-at"
                className="mt-1 text-xs text-red-600 dark:text-red-400"
              >
                {errors.startedAt}
              </p>
            )}
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="symptom-diary-save"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
            >
              {submitting ? "Saving..." : "Save Entry"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
