"use client";

/**
 * Ambient chart search — ask a natural-language question over a patient's
 * chart or the doctor's entire panel, get an LLM answer with `[n]` citations
 * to source chunks (consultations, labs, prescriptions).
 *
 * Role-gated to DOCTOR + ADMIN (matches /api/v1/ai/chart-search).
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import {
  Search,
  Brain,
  Loader2,
  User,
  Users,
  FileText,
  FlaskConical,
  Pill,
  BookOpen,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Hit {
  id: string;
  documentType: string;
  title: string;
  content: string;
  tags: string[];
  rank: number;
  patientId: string | null;
  doctorId: string | null;
  date: string | null;
}

interface ChartSearchResponse {
  answer: string;
  hits: Hit[];
  citedChunkIds: string[];
  patientIds: string[];
  totalHits: number;
}

interface PatientOpt {
  id: string;
  user: { name: string; phone?: string | null };
}

type TabKey = "patient" | "cohort";

const DOC_TYPE_META: Record<string, { label: string; icon: React.ElementType; cls: string }> = {
  CONSULTATION: {
    label: "Consultation",
    icon: FileText,
    cls: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  },
  LAB_RESULT: {
    label: "Lab result",
    icon: FlaskConical,
    cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  PRESCRIPTION: {
    label: "Prescription",
    icon: Pill,
    cls: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300",
  },
  DEFAULT: {
    label: "Document",
    icon: BookOpen,
    cls: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  },
};

function docMeta(t: string) {
  return DOC_TYPE_META[t] ?? DOC_TYPE_META.DEFAULT;
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ChartSearchPage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();

  const [tab, setTab] = useState<TabKey>("patient");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChartSearchResponse | null>(null);
  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null);

  // Patient picker (patient tab only)
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<PatientOpt[]>([]);
  const [patient, setPatient] = useState<PatientOpt | null>(null);

  useEffect(() => {
    if (!isLoading && user && !["DOCTOR", "ADMIN"].includes(user.role)) {
      router.push("/dashboard");
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (search.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: PatientOpt[] }>(
          `/patients?search=${encodeURIComponent(search)}`
        );
        setResults(res.data ?? []);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const canAsk = useMemo(() => {
    if (!query.trim()) return false;
    if (tab === "patient" && !patient) return false;
    return true;
  }, [query, tab, patient]);

  async function ask() {
    if (!canAsk) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const path =
        tab === "patient"
          ? `/ai/chart-search/patient/${patient!.id}`
          : "/ai/chart-search/cohort";
      const res = await api.post<{ data: ChartSearchResponse }>(path, {
        query: query.trim(),
        synthesize: true,
      });
      setResult(res.data);
    } catch (err) {
      setError((err as Error).message || "Chart search failed");
    } finally {
      setBusy(false);
    }
  }

  // Map chunk id → hit for citation expand-on-click.
  const hitsById = useMemo(() => {
    const m = new Map<string, Hit>();
    for (const h of result?.hits ?? []) m.set(h.id, h);
    return m;
  }, [result]);

  // Render the LLM answer, replacing [n] tokens with interactive chips.
  function renderAnswer(answer: string) {
    if (!answer) return null;
    const parts = answer.split(/(\[\d+\])/g);
    return parts.map((p, i) => {
      const m = p.match(/^\[(\d+)\]$/);
      if (!m) return <span key={i}>{p}</span>;
      const idx = parseInt(m[1], 10) - 1;
      const citedId = result?.citedChunkIds[idx];
      const hit = citedId ? hitsById.get(citedId) : undefined;
      return (
        <button
          key={i}
          type="button"
          onClick={() =>
            setExpandedChunkId((c) => (c === citedId ? null : citedId ?? null))
          }
          title={hit?.title ?? "Citation"}
          className="mx-0.5 inline-flex items-center rounded-full bg-indigo-100 px-1.5 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300"
        >
          [{m[1]}]
        </button>
      );
    });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }
  if (user && !["DOCTOR", "ADMIN"].includes(user.role)) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center gap-3">
        <Brain className="h-6 w-6 text-indigo-600" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            Ambient Chart Search
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Ask natural-language questions over your patients&apos; charts — get
            grounded answers with source citations.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-gray-200 dark:border-gray-800">
        <button
          role="tab"
          aria-selected={tab === "patient"}
          onClick={() => setTab("patient")}
          className={
            "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium " +
            (tab === "patient"
              ? "border-indigo-600 text-indigo-700 dark:text-indigo-400"
              : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200")
          }
        >
          <User className="h-4 w-4" /> This patient
        </button>
        <button
          role="tab"
          aria-selected={tab === "cohort"}
          onClick={() => setTab("cohort")}
          className={
            "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium " +
            (tab === "cohort"
              ? "border-indigo-600 text-indigo-700 dark:text-indigo-400"
              : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200")
          }
        >
          <Users className="h-4 w-4" /> Cohort
        </button>
      </div>

      {/* Patient picker (patient tab only) */}
      {tab === "patient" && (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <label
            htmlFor="cs-patient"
            className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Patient
          </label>
          {patient ? (
            <div className="flex items-center justify-between rounded-lg bg-indigo-50 px-3 py-2 text-sm dark:bg-indigo-950/40">
              <span>
                <strong>{patient.user.name}</strong>
                <span className="ml-2 font-mono text-xs text-gray-500">
                  {patient.id.slice(0, 8)}…
                </span>
              </span>
              <button
                onClick={() => setPatient(null)}
                className="text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                id="cs-patient"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search patient by name, phone or MRN…"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
              {results.length > 0 && (
                <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white text-sm dark:border-gray-700 dark:bg-gray-800">
                  {results.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => {
                          setPatient(p);
                          setSearch("");
                          setResults([]);
                        }}
                        className="block w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        {p.user.name}{" "}
                        <span className="ml-2 text-xs text-gray-500">
                          {p.user.phone ?? ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {tab === "cohort" && (
        <p className="mb-4 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
          Showing results from your patients only — cohort search is scoped to
          patients you have seen or prescribed for.
        </p>
      )}

      {/* Query bar */}
      <div className="mb-4 flex gap-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canAsk && !busy) ask();
          }}
          placeholder={
            tab === "patient"
              ? "e.g. When did their HbA1c last cross 7?"
              : "e.g. Which of my diabetic patients missed their last visit?"
          }
          className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-sm dark:border-gray-700 dark:bg-gray-800"
        />
        <button
          onClick={ask}
          disabled={!canAsk || busy}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Ask
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {busy && !result && (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900">
          <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-indigo-600" />
          Searching the chart…
        </div>
      )}

      {result && (
        <>
          {/* Answer */}
          <section className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50/50 p-5 dark:border-indigo-900 dark:bg-indigo-950/30">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
              <Brain className="h-4 w-4" /> Answer
            </div>
            <div className="leading-relaxed text-gray-800 dark:text-gray-100">
              {renderAnswer(result.answer) ?? (
                <span className="text-gray-500">
                  No synthesised answer — see source hits below.
                </span>
              )}
            </div>
            {expandedChunkId && hitsById.get(expandedChunkId) && (
              <div className="mt-4 rounded-lg border border-indigo-200 bg-white p-3 text-sm dark:border-indigo-900 dark:bg-gray-900">
                <div className="mb-1 font-medium">
                  Source: {hitsById.get(expandedChunkId)?.title}
                </div>
                <p className="whitespace-pre-line text-gray-700 dark:text-gray-300">
                  {hitsById.get(expandedChunkId)?.content}
                </p>
              </div>
            )}
          </section>

          {/* Hits */}
          <section>
            <h3 className="mb-2 text-sm font-semibold">
              {result.totalHits} source chunk{result.totalHits === 1 ? "" : "s"}
            </h3>
            {result.hits.length === 0 ? (
              <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700">
                No matching chunks found in the chart.
              </p>
            ) : (
              <ul className="space-y-3">
                {result.hits.map((h) => {
                  const meta = docMeta(h.documentType);
                  const Icon = meta.icon;
                  return (
                    <li
                      key={h.id}
                      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <span
                          className={
                            "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium " +
                            meta.cls
                          }
                        >
                          <Icon className="h-3 w-3" /> {meta.label}
                        </span>
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {h.title}
                        </span>
                        {h.date && (
                          <span className="ml-auto text-xs text-gray-400">
                            {new Date(h.date).toLocaleDateString("en-IN", {
                              day: "2-digit",
                              month: "short",
                              year: "numeric",
                            })}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        {h.content}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
