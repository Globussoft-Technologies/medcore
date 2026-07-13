"use client";

/**
 * Insurance TPA Claims page — admin + reception.
 *
 * - List claims with filters (status, TPA, date range).
 * - Row click opens a side-drawer showing timeline, docs, cancel button.
 * - "Submit new claim" flow: pick a bill, pick TPA, optional pre-auth, submit.
 *
 * Backend: `/api/v1/claims`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { usePrompt } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { formatINR } from "@/lib/currency";
import { EntityPicker } from "@/components/EntityPicker";
import { SkeletonTable } from "@/components/Skeleton";
import { INDIAN_INSURERS } from "@medcore/shared";
import {
  Receipt,
  Plus,
  RefreshCw,
  X,
  Loader2,
  FileText,
  Ban,
  Search,
  Sparkles,
  Copy,
  Check,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

type Status =
  | "DRAFT"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "PARTIALLY_APPROVED"
  | "DENIED"
  | "SETTLED"
  | "CANCELLED";

interface ClaimRow {
  id: string;
  billId: string;
  patientId: string;
  tpaProvider: string;
  providerClaimRef: string | null;
  insurerName: string;
  policyNumber: string;
  diagnosis: string;
  amountClaimed: number;
  amountApproved: number | null;
  status: Status;
  submittedAt: string | null;
  createdAt: string;
}

interface TimelineEvent {
  id: string;
  status: Status;
  note: string | null;
  source: string;
  timestamp: string;
}

interface ClaimDoc {
  id: string;
  type: string;
  filename: string;
  uploadedAt: string;
}

interface ClaimDetail extends ClaimRow {
  documents: ClaimDoc[];
  timeline: TimelineEvent[];
  deniedReason?: string | null;
  notes?: string | null;
  memberId?: string | null;
  icd10Codes?: string[];
}

const STATUSES: (Status | "")[] = [
  "",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "PARTIALLY_APPROVED",
  "DENIED",
  "SETTLED",
  "CANCELLED",
];

const TPAS = [
  "MEDI_ASSIST",
  "PARAMOUNT",
  "VIDAL",
  "FHPL",
  "ICICI_LOMBARD",
  "STAR_HEALTH",
  "PMJAY",
  "MOCK",
];

const STATUS_CLASSES: Record<Status, string> = {
  DRAFT: "bg-gray-100 text-gray-700",
  SUBMITTED: "bg-blue-100 text-blue-700",
  UNDER_REVIEW: "bg-amber-100 text-amber-700",
  APPROVED: "bg-emerald-100 text-emerald-700",
  PARTIALLY_APPROVED: "bg-emerald-100 text-emerald-700",
  DENIED: "bg-red-100 text-red-700",
  SETTLED: "bg-emerald-200 text-emerald-800",
  CANCELLED: "bg-gray-100 text-gray-500",
};

// Issue #853: legacy claims store `providerClaimRef` as "LEGACY-<uuid>" — a
// ~47-char string that overflows the Claim # column when rendered raw (the
// `?? id.slice(0,8)` fallback never trims it because the value isn't null).
// Render a concise label — the "LEGACY-" prefix + the uuid's first block —
// and keep the full identifier reachable via tooltip + copy button. Non-legacy
// refs (real TPA references, or the row-id fallback) are already short.
function claimRefDisplay(r: ClaimRow): { label: string; full: string } {
  const ref = r.providerClaimRef;
  if (!ref) {
    // No TPA ref assigned yet — fall back to a short slice of the row id.
    return { label: r.id.slice(0, 8), full: r.id };
  }
  if (ref.startsWith("LEGACY-")) {
    const uuid = ref.slice("LEGACY-".length);
    return { label: `LEGACY-${uuid.slice(0, 8)}`, full: ref };
  }
  return { label: ref, full: ref };
}

// Issue #853: copy-to-clipboard control for the Claim # cell so reception can
// lift the full identifier during calls without manual select-and-copy.
// stopPropagation keeps the click off the row's detail-drawer handler.
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy: ${value}`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => toast.error("Copy failed"),
        );
      }}
      className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function InsuranceClaimsPage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();
  const promptUser = usePrompt();

  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState("");
  const [filterTpa, setFilterTpa] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [aiDrafting, setAiDrafting] = useState(false);

  useEffect(() => {
    if (!isLoading && user && !["ADMIN", "RECEPTION"].includes(user.role)) {
      router.push("/dashboard");
    }
  }, [user, isLoading, router]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (filterStatus) p.set("status", filterStatus);
    if (filterTpa) p.set("tpa", filterTpa);
    if (filterFrom) p.set("from", filterFrom);
    if (filterTo) p.set("to", filterTo);
    return p.toString();
  }, [filterStatus, filterTpa, filterFrom, filterTo]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ data: ClaimRow[] }>(
        `/claims${qs ? `?${qs}` : ""}`
      );
      setRows(res.data ?? []);
    } catch (err) {
      setError((err as Error).message || "Failed to load claims");
    } finally {
      setLoading(false);
    }
  }, [qs]);

  useEffect(() => {
    if (!user) return;
    if (!["ADMIN", "RECEPTION"].includes(user.role)) return;
    load();
  }, [user, load]);

  // ── AI Draft flow ─────────────────────────────────────────────────────────
  // Reuses the shared PromptDialog (via `usePrompt`) to ask for a
  // consultationId; on success the claims list refreshes so the newly drafted
  // claim surfaces without a manual refresh. Mirrors the RBAC on the backend
  // route (`ADMIN` + `RECEPTION` only — see `apps/api/src/routes/ai-claims.ts`).
  async function handleAiDraft() {
    const consultationId = await promptUser({
      title: "AI Draft claim",
      label: "Consultation ID",
      message:
        "Enter a consultation ID — the AI coder will draft a claim from its SOAP notes, ICD codes and invoice.",
      placeholder: "e.g. 4b5d6e7f-…",
      required: true,
    });
    if (!consultationId) return;
    setAiDrafting(true);
    try {
      await api.post(`/ai/claims/draft/${consultationId.trim()}`);
      toast.success("AI draft created");
      await load();
    } catch (err) {
      toast.error((err as Error).message || "AI draft failed");
    } finally {
      setAiDrafting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }
  if (user && !["ADMIN", "RECEPTION"].includes(user.role)) return null;

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Receipt className="h-6 w-6 text-blue-600" />
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              Insurance Claims
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Submit, track and reconcile TPA claims.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={handleAiDraft}
            disabled={aiDrafting}
            data-testid="insurance-claims-ai-draft"
            className="flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-60 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-300 dark:hover:bg-violet-900/40"
          >
            {aiDrafting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            AI Draft
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" /> Submit new claim
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 grid gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm md:grid-cols-4 dark:border-gray-800 dark:bg-gray-900">
        <div>
          <label htmlFor="claims-filter-status" className="text-xs text-gray-500">Status</label>
          <select
            id="claims-filter-status"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || "All"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="claims-filter-tpa" className="text-xs text-gray-500">TPA</label>
          <select
            id="claims-filter-tpa"
            value={filterTpa}
            onChange={(e) => setFilterTpa(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="">All</option>
            {TPAS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="claims-filter-from" className="text-xs text-gray-500">From</label>
          <input
            id="claims-filter-from"
            type="date"
            value={filterFrom}
            max={filterTo || undefined}
            onChange={(e) => setFilterFrom(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
        <div>
          <label htmlFor="claims-filter-to" className="text-xs text-gray-500">To</label>
          <input
            id="claims-filter-to"
            type="date"
            value={filterTo}
            min={filterFrom || undefined}
            onChange={(e) => setFilterTo(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
      </div>
      {/* Issue #580 (sub-concern 4): when From > To the API silently
          returns 0 rows. Surface the inverted-range explicitly so the user
          gets feedback instead of an unexplained empty state. */}
      {filterFrom && filterTo && filterFrom > filterTo && (
        <p className="mt-2 text-xs text-red-600">
          The From date is after the To date — please correct the range.
        </p>
      )}

      {/* Table — Pearl §7.2 wave 11: skeleton rows replace the plain text
          so the table footprint is stable while claims load. */}
      {loading && (
        <div
          className="overflow-hidden rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
          data-testid="insurance-claims-loading"
          aria-busy="true"
        >
          <SkeletonTable rows={6} columns={6} />
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}
      {!loading && !error && rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500 dark:border-gray-700">
          <Search className="mx-auto mb-2 h-6 w-6 text-gray-400" />
          No claims match your filters yet.
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800 min-w-[880px]">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  Claim #
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  TPA
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  Insurer
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  Diagnosis
                </th>
                <th className="px-4 py-2 text-right font-medium text-gray-600 dark:text-gray-300">
                  Claimed
                </th>
                <th className="px-4 py-2 text-right font-medium text-gray-600 dark:text-gray-300">
                  Approved
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.map((r) => {
                // Issue #853: concise Claim # label — legacy refs are
                // "LEGACY-<uuid>", far too long to render raw.
                const claimRef = claimRefDisplay(r);
                return (
                <tr
                  key={r.id}
                  data-testid="claim-row"
                  onClick={() => setSelectedId(r.id)}
                  className="cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-950/30"
                >
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        data-testid="claim-ref"
                        className="block max-w-[12rem] truncate font-mono text-xs"
                        title={claimRef.full}
                      >
                        {claimRef.label}
                      </span>
                      <CopyButton value={claimRef.full} label="claim reference" />
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    {r.tpaProvider}
                    {r.tpaProvider === "MOCK" &&
                      !(r.providerClaimRef ?? "").startsWith("LEGACY-") && (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                          MOCK TPA
                        </span>
                      )}
                    {(r.providerClaimRef ?? "").startsWith("LEGACY-") && (
                      <span
                        className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800/60 dark:text-slate-300"
                        title="Pre-V2 row — TPA provider unknown. Migrated from legacy insurance_claims table."
                      >
                        Legacy
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{r.insurerName}</td>
                  <td
                    className="max-w-xs truncate px-4 py-2 text-gray-600"
                    title={r.diagnosis}
                  >
                    {/* Issue #82: hide the noisy "(migrated from legacy —
                        diagnosis unknown)" placeholder, render an em-dash
                        instead so the table reads cleanly. */}
                    {r.diagnosis &&
                    !/migrated from legacy/i.test(r.diagnosis)
                      ? r.diagnosis
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {formatINR(r.amountClaimed)}
                  </td>
                  <td
                    className="px-4 py-2 text-right font-mono"
                    data-testid="claim-approved-cell"
                  >
                    {/*
                      Issue #82: rows whose status is APPROVED / SETTLED /
                      PARTIALLY_APPROVED implicitly carry the claimed amount
                      as the approved amount when the TPA hasn't returned an
                      explicit `amountApproved` yet. Showing "—" was
                      misleading on rows the user can clearly see are
                      approved. We now fall back to `amountClaimed` for
                      those statuses (and tag the cell as fallback so a UI
                      test can assert the behaviour); rows without an
                      approved status still render an em-dash.
                    */}
                    {r.amountApproved != null
                      ? formatINR(r.amountApproved)
                      : ["APPROVED", "PARTIALLY_APPROVED", "SETTLED"].includes(r.status)
                        ? formatINR(r.amountClaimed)
                        : "—"}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        "rounded px-2 py-0.5 text-xs font-medium " +
                        (STATUS_CLASSES[r.status] ??
                          "bg-gray-100 text-gray-700")
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      {selectedId && (
        <ClaimDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}

      {showNew && (
        <NewClaimModal
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── Drawer: detail + timeline + docs ───────────────────────────────────────

function ClaimDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const promptUser = usePrompt();
  const [detail, setDetail] = useState<ClaimDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ data: ClaimDetail }>(`/claims/${id}`);
      setDetail(res.data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function cancel() {
    const reason = await promptUser({
      title: "Cancel claim",
      label: "Cancellation reason",
      required: true,
    });
    if (!reason) return;
    setCancelling(true);
    try {
      await api.post(`/claims/${id}/cancel`, { reason });
      await load();
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-black/40"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        aria-label="Claim detail"
        className="flex w-full max-w-xl flex-col overflow-y-auto bg-white shadow-xl dark:bg-gray-900"
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-gray-200 bg-white px-5 py-3 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold">Claim detail</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 p-5">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {error && (
            <div className="rounded bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          )}
          {detail && (
            <>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Field label="Provider ref" value={detail.providerClaimRef ?? "—"} />
                <Field label="TPA" value={detail.tpaProvider} />
                <Field label="Insurer" value={detail.insurerName} />
                <Field label="Policy #" value={detail.policyNumber} />
                <Field label="Diagnosis" value={detail.diagnosis} />
                <Field label="Claimed" value={formatINR(detail.amountClaimed)} />
                <Field
                  label="Approved"
                  value={formatINR(detail.amountApproved)}
                />
                <Field label="Status" value={detail.status} />
              </dl>

              {detail.deniedReason && (
                <p className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  Denied: {detail.deniedReason}
                </p>
              )}

              <h3 className="mt-6 mb-2 text-sm font-semibold">Timeline</h3>
              {detail.timeline.length === 0 ? (
                <p className="text-sm text-gray-500">No events yet.</p>
              ) : (
                <ol className="space-y-2 border-l border-gray-200 pl-4 dark:border-gray-700">
                  {detail.timeline.map((e) => (
                    <li key={e.id} className="text-sm">
                      <div className="font-medium">{e.status}</div>
                      {e.note && (
                        <div className="text-xs text-gray-500">{e.note}</div>
                      )}
                      <div className="text-xs text-gray-400">
                        {new Date(e.timestamp).toLocaleString()}
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              <h3 className="mt-6 mb-2 text-sm font-semibold">Documents</h3>
              {detail.documents.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No supporting documents uploaded yet.
                </p>
              ) : (
                <ul className="space-y-1">
                  {detail.documents.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                    >
                      <FileText className="h-4 w-4 text-gray-400" />
                      {d.filename}
                      <span className="ml-2 text-xs text-gray-400">
                        ({d.type})
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {!["CANCELLED", "SETTLED", "DENIED"].includes(detail.status) && (
                <button
                  onClick={cancel}
                  disabled={cancelling}
                  className="mt-6 flex items-center gap-2 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950/40"
                >
                  {cancelling ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Ban className="h-4 w-4" />
                  )}
                  Cancel claim
                </button>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {value}
      </dd>
    </div>
  );
}

// ─── Modal: submit new claim ────────────────────────────────────────────────

interface Icd10Option {
  id: string;
  code: string;
  description: string;
}

function NewClaimModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [billId, setBillId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [tpa, setTpa] = useState("MOCK");
  const [insurer, setInsurer] = useState("");
  const [policy, setPolicy] = useState("");
  // diagnosis: free description (the API still receives a string), but we
  // suggest values from the ICD-10 catalogue.
  const [diagnosis, setDiagnosis] = useState("");
  const [icd10Code, setIcd10Code] = useState("");
  const [diagSuggestions, setDiagSuggestions] = useState<Icd10Option[]>([]);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Non-PMJAY optional member id.
  const [memberId, setMemberId] = useState("");
  // Insurer master (InsuranceProvider table) for the non-PMJAY dropdown.
  const [providers, setProviders] = useState<string[]>([]);
  // PM-JAY: verified beneficiary (auto-filled) + HBP package selection.
  const [pmjayBen, setPmjayBen] = useState<{
    ayushmanCardNumber: string;
    beneficiaryId: string | null;
    familyId: string | null;
  } | null>(null);
  const [benChecked, setBenChecked] = useState(false);
  const [packages, setPackages] = useState<{ packageCode: string; packageName: string }[]>([]);
  const [packageCode, setPackageCode] = useState("");

  const isPmjay = tpa === "PMJAY";
  const packageName = packages.find((p) => p.packageCode === packageCode)?.packageName ?? "";
  const insurerOptions = providers.length > 0 ? providers : INDIAN_INSURERS;

  // Debounced ICD-10 lookup. Endpoint already exists at
  // GET /api/v1/icd10?q=… (see apps/api/src/routes/icd10.ts).
  useEffect(() => {
    const q = diagnosis.trim();
    if (q.length < 2 || icd10Code) {
      setDiagSuggestions([]);
      return;
    }
    let cancelled = false;
    setDiagLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: Icd10Option[] }>(
          `/icd10?q=${encodeURIComponent(q)}&limit=8`
        );
        if (!cancelled) setDiagSuggestions(res.data ?? []);
      } catch {
        if (!cancelled) setDiagSuggestions([]);
      } finally {
        if (!cancelled) setDiagLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [diagnosis, icd10Code]);

  // Load the insurer master (InsuranceProvider). Falls back to the curated
  // INDIAN_INSURERS list when the table is empty (no regression).
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ data: { name: string; isActive?: boolean }[] }>("/insurance-providers")
      .then((r) => {
        if (!cancelled) setProviders((r.data ?? []).filter((p) => p.isActive !== false).map((p) => p.name));
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // PM-JAY: load the HBP package master for the package picker.
  useEffect(() => {
    if (!isPmjay) return;
    let cancelled = false;
    api
      .get<{ data: { packageCode: string; packageName: string }[] }>("/pmjay/packages")
      .then((r) => {
        if (!cancelled) setPackages(r.data ?? []);
      })
      .catch(() => {
        /* leave empty */
      });
    return () => {
      cancelled = true;
    };
  }, [isPmjay]);

  // PM-JAY: auto-fill the patient's verified, eligible beneficiary.
  useEffect(() => {
    if (!isPmjay || !patientId) {
      setPmjayBen(null);
      setBenChecked(false);
      return;
    }
    let cancelled = false;
    setBenChecked(false);
    api
      .get<{ data: { ayushmanCardNumber: string; beneficiaryId: string | null; familyId: string | null } | null }>(
        `/pmjay/beneficiary?patientId=${patientId}`
      )
      .then((r) => {
        if (!cancelled) {
          setPmjayBen(r.data ?? null);
          setBenChecked(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPmjayBen(null);
          setBenChecked(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isPmjay, patientId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    // Issue #302: the EntityPicker components for Bill and Patient don't
    // participate in HTML5 `required` validation, so the form would happily
    // POST with an empty billId/patientId. Block client-side and surface a
    // single readable message before bothering the server.
    if (!billId) {
      setErr("Please select a Bill (invoice) before submitting.");
      return;
    }
    if (!patientId) {
      setErr("Please select a Patient before submitting.");
      return;
    }
    if (!amount || Number.isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      setErr("Please enter the amount claimed (in INR).");
      return;
    }
    if (!diagnosis.trim()) {
      setErr("Please enter a diagnosis (ICD-10 recommended).");
      return;
    }
    // TPA-specific validation. Issue #458: these fields rely on React-side
    // checks (the form is noValidate).
    if (isPmjay) {
      if (!pmjayBen) {
        setErr(
          "This patient has no verified, eligible PM-JAY beneficiary. Verify eligibility in the PM-JAY module first."
        );
        return;
      }
      if (!packageCode) {
        setErr("Please select an HBP package.");
        return;
      }
    } else {
      if (!insurer) {
        setErr("Please pick an insurer.");
        return;
      }
      if (!policy.trim()) {
        setErr("Please enter the policy number.");
        return;
      }
    }
    setSubmitting(true);
    try {
      // PM-JAY maps onto the SAME InsuranceClaim2 fields (no model change):
      // insurerName = scheme, policyNumber = Ayushman card, memberId =
      // beneficiary id, procedureName = HBP package code.
      const base = {
        billId,
        patientId,
        tpaProvider: tpa,
        diagnosis,
        ...(icd10Code ? { icd10Codes: [icd10Code] } : {}),
        amountClaimed: parseFloat(amount),
      };
      const payload = isPmjay
        ? {
            ...base,
            insurerName: "PM-JAY (Ayushman Bharat)",
            policyNumber: pmjayBen!.ayushmanCardNumber,
            ...(pmjayBen!.beneficiaryId ? { memberId: pmjayBen!.beneficiaryId } : {}),
            procedureName: packageCode,
          }
        : {
            ...base,
            insurerName: insurer,
            policyNumber: policy,
            ...(memberId.trim() ? { memberId: memberId.trim() } : {}),
          };
      await api.post("/claims", payload);
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={submit}
        noValidate
        className="w-full max-h-[90vh] overflow-y-auto max-w-lg rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Submit new claim</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-3">
          {/* Bill (Invoice) — searchable picker. The /invoices endpoint
              accepts `?search=<invoiceNumber>` and returns `{ id,
              invoiceNumber, totalAmount, patientId, patient.user.name }`. */}
          <div>
            <label className="block text-sm font-medium">
              Bill (invoice) <span className="text-red-500">*</span>
            </label>
            <EntityPicker
              endpoint="/billing/invoices"
              labelField="invoiceNumber"
              subtitleField="patient.user.name"
              hintField="totalAmount"
              value={billId}
              onChange={(id, entity) => {
                setBillId(id);
                // Auto-fill patient + amount from the chosen invoice when
                // available — saves the user typing.
                if (entity) {
                  const pid = (entity as Record<string, unknown>).patientId;
                  if (typeof pid === "string") setPatientId(pid);
                  const amt = (entity as Record<string, unknown>).totalAmount;
                  if (typeof amt === "number") setAmount(String(amt));
                }
              }}
              searchPlaceholder="Search by invoice number..."
              testIdPrefix="claim-bill-picker"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium">
              Patient <span className="text-red-500">*</span>
            </label>
            <EntityPicker
              endpoint="/patients"
              labelField="user.name"
              subtitleField="user.phone"
              hintField="mrNumber"
              value={patientId}
              onChange={(id) => setPatientId(id)}
              searchPlaceholder="Search by name, phone, MR..."
              testIdPrefix="claim-patient-picker"
              required
            />
          </div>
          <div>
            <label htmlFor="claim-tpa" className="block text-sm font-medium">TPA</label>
            <select
              id="claim-tpa"
              value={tpa}
              onChange={(e) => setTpa(e.target.value)}
              data-testid="claim-tpa-select"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            >
              {TPAS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {tpa === "MOCK" && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Using the mock TPA adapter — no external request is made.
              </p>
            )}
          </div>

          {!isPmjay ? (
            <>
              {/* Insurer — from the InsuranceProvider master; falls back to the
                  curated INDIAN_INSURERS list when the table is empty. */}
              <div>
                <label htmlFor="claim-insurer" className="block text-sm font-medium">
                  Insurer <span className="text-red-500">*</span>
                </label>
                <select
                  id="claim-insurer"
                  value={insurer}
                  onChange={(e) => setInsurer(e.target.value)}
                  data-testid="claim-insurer-select"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                >
                  <option value="">Select insurer...</option>
                  {insurerOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <Input label="Policy number" value={policy} onChange={setPolicy} />
              <Input label="Member ID (if available)" value={memberId} onChange={setMemberId} />
            </>
          ) : (
            <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
              <p
                className="text-xs text-amber-700 dark:text-amber-300"
                data-testid="claim-pmjay-banner"
              >
                PM-JAY beneficiaries must first be verified from the{" "}
                <Link href="/dashboard/pmjay" className="underline">
                  PM-JAY module
                </Link>
                . After eligibility verification, submit the claim using the verified beneficiary
                and the selected HBP package.
              </p>

              {!patientId ? (
                <p className="text-xs text-gray-500">
                  Select a patient to load their verified beneficiary.
                </p>
              ) : !benChecked ? (
                <p className="text-xs text-gray-500">Checking beneficiary eligibility…</p>
              ) : !pmjayBen ? (
                <p
                  className="text-xs font-medium text-red-600 dark:text-red-400"
                  data-testid="claim-pmjay-noben"
                >
                  No verified, eligible PM-JAY beneficiary for this patient. Verify in the{" "}
                  <Link href="/dashboard/pmjay" className="underline">
                    PM-JAY module
                  </Link>{" "}
                  first.
                </p>
              ) : (
                <dl
                  className="grid grid-cols-3 gap-y-1 text-xs"
                  data-testid="claim-pmjay-beneficiary"
                >
                  <dt className="text-gray-500">Verified beneficiary</dt>
                  <dd className="col-span-2 text-right font-medium text-green-700 dark:text-green-400">
                    Eligible ✓
                  </dd>
                  <dt className="text-gray-500">Beneficiary ID</dt>
                  <dd className="col-span-2 text-right font-mono">{pmjayBen.beneficiaryId ?? "—"}</dd>
                  <dt className="text-gray-500">Ayushman card</dt>
                  <dd className="col-span-2 text-right font-mono">{pmjayBen.ayushmanCardNumber}</dd>
                </dl>
              )}

              <div>
                <label htmlFor="claim-pmjay-package" className="block text-sm font-medium">
                  HBP package code <span className="text-red-500">*</span>
                </label>
                <select
                  id="claim-pmjay-package"
                  value={packageCode}
                  onChange={(e) => setPackageCode(e.target.value)}
                  data-testid="claim-pmjay-package-select"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                >
                  <option value="">Select HBP package...</option>
                  {packages.map((p) => (
                    <option key={p.packageCode} value={p.packageCode}>
                      {p.packageCode} — {p.packageName}
                    </option>
                  ))}
                </select>
                {packages.length === 0 && (
                  <p className="mt-1 text-xs text-gray-500">
                    No packages loaded — sync the package master in the PM-JAY module.
                  </p>
                )}
              </div>
              {packageCode && (
                <div>
                  <label htmlFor="claim-pmjay-package-name" className="block text-sm font-medium">
                    HBP package name
                  </label>
                  <input
                    id="claim-pmjay-package-name"
                    readOnly
                    value={packageName}
                    data-testid="claim-pmjay-package-name"
                    className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800/50"
                  />
                </div>
              )}
            </div>
          )}
          {/* Diagnosis — bound to the ICD-10 catalogue. The user may still
              type free text (the API field stays a `String`); when an ICD
              row is picked we additionally send `icd10Codes: [code]`. */}
          <div className="relative">
            <label htmlFor="claim-diagnosis" className="block text-sm font-medium">
              Diagnosis <span className="text-red-500">*</span>
            </label>
            <input
              id="claim-diagnosis"
              type="text"
              value={diagnosis}
              onChange={(e) => {
                setDiagnosis(e.target.value);
                setIcd10Code("");
                setDiagOpen(true);
              }}
              onFocus={() => setDiagOpen(true)}
              onBlur={() => window.setTimeout(() => setDiagOpen(false), 150)}
              placeholder="Search ICD-10 (e.g. I10, diabetes)..."
              data-testid="claim-diagnosis-input"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
            {icd10Code && (
              <span
                data-testid="claim-diagnosis-icd"
                className="mt-1 inline-block rounded bg-emerald-50 px-2 py-0.5 text-xs font-mono text-emerald-700"
              >
                {icd10Code}
              </span>
            )}
            {diagOpen &&
              !icd10Code &&
              diagnosis.trim().length >= 2 && (
                <ul
                  data-testid="claim-diagnosis-dropdown"
                  className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
                >
                  {diagLoading && (
                    <li className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Searching ICD-10...
                    </li>
                  )}
                  {!diagLoading && diagSuggestions.length === 0 && (
                    <li className="px-3 py-2 text-xs text-gray-500">
                      No ICD-10 match — diagnosis will be saved as free text.
                    </li>
                  )}
                  {!diagLoading &&
                    diagSuggestions.map((s) => (
                      <li
                        key={s.id}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setDiagnosis(s.description);
                          setIcd10Code(s.code);
                          setDiagOpen(false);
                        }}
                        data-testid="claim-diagnosis-option"
                        className="cursor-pointer px-3 py-2 text-sm hover:bg-blue-50 dark:hover:bg-blue-950/30"
                      >
                        <div className="font-medium">{s.description}</div>
                        <div className="font-mono text-xs text-gray-500">
                          {s.code}
                        </div>
                      </li>
                    ))}
                </ul>
              )}
          </div>
          <Input
            label="Amount claimed (INR)"
            value={amount}
            onChange={setAmount}
            type="number"
          />
        </div>

        {err && (
          <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {err}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />} Submit
          </button>
        </div>
      </form>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  const inputId = `claim-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  return (
    <div>
      <label htmlFor={inputId} className="block text-sm font-medium">{label}</label>
      <input
        id={inputId}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
      />
    </div>
  );
}
