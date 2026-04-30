"use client";

/**
 * Sprint 2 — Fraud detection page with resolution workflow.
 *
 * Building on the read-only alert list, this page now lets ADMIN and
 * RECEPTION (billing investigators) walk an alert through a four-step
 * resolution workflow:
 *
 *   NEW ──▶ INVESTIGATING ──┬─▶ RESOLVED   (requires reason)
 *      └────────────────────┴─▶ DISMISSED  (requires reason)
 *
 * RESOLVED / DISMISSED are terminal but ADMINs can re-open them back to
 * INVESTIGATING. Each transition records an audit-log entry server-side.
 *
 * The status pill shows allowed transitions in a dropdown when clicked.
 * Terminal transitions (RESOLVED / DISMISSED) raise an in-DOM resolution
 * modal asking for a 1-line reason (max 200 chars). NEVER use the native
 * window.prompt/alert/confirm — those break browser automation.
 *
 * Clicking a row expands an inline comment thread. Comments POST to
 * /ai/fraud/alerts/:id/comments and refresh in place.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw, ShieldCheck, Siren } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

// ─── Types ────────────────────────────────────────────────

type Severity = "INFO" | "SUSPICIOUS" | "HIGH_RISK";

// New 4-state status vocabulary used by the UI. The server stores values
// in the same `status` column on FraudAlert; legacy values ("OPEN" /
// "ACKNOWLEDGED" / "ESCALATED") are mapped to the new vocab on read.
type Status = "NEW" | "INVESTIGATING" | "RESOLVED" | "DISMISSED";

interface FraudComment {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

interface FraudAlert {
  id: string;
  type: string;
  severity: Severity;
  status: string;
  entityType: string;
  entityId: string;
  description: string;
  evidence: Record<string, unknown> & { comments?: FraudComment[]; llmReason?: string };
  detectedAt: string;
  acknowledgedBy?: string | null;
  acknowledgedAt?: string | null;
  resolutionNote?: string | null;
}

const SEVERITY_COLOR: Record<Severity, string> = {
  HIGH_RISK:
    "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-200 dark:border-red-800",
  SUSPICIOUS:
    "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800",
  INFO:
    "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-800",
};

// Status pill: NEW=gray, INVESTIGATING=yellow, RESOLVED=green, DISMISSED=red.
const STATUS_COLOR: Record<Status, string> = {
  NEW: "bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600",
  INVESTIGATING:
    "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-200 dark:border-yellow-800",
  RESOLVED:
    "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-200 dark:border-green-800",
  DISMISSED:
    "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-200 dark:border-red-800",
};

// Map legacy server-side statuses onto the new four-state UI vocabulary.
function normalizeStatus(raw: string | null | undefined): Status {
  switch ((raw ?? "").toUpperCase()) {
    case "NEW":
    case "OPEN":
    case "":
      return "NEW";
    case "INVESTIGATING":
    case "ACKNOWLEDGED":
    case "ESCALATED":
      return "INVESTIGATING";
    case "RESOLVED":
      return "RESOLVED";
    case "DISMISSED":
      return "DISMISSED";
    default:
      return "NEW";
  }
}

function allowedTransitions(current: Status, role: string | undefined): Status[] {
  switch (current) {
    case "NEW":
      return ["INVESTIGATING", "DISMISSED"];
    case "INVESTIGATING":
      return ["NEW", "RESOLVED", "DISMISSED"];
    case "RESOLVED":
    case "DISMISSED":
      // Re-opening a terminal status is rare; ADMIN-only.
      return role === "ADMIN" ? ["INVESTIGATING"] : [];
    default:
      return [];
  }
}

const REASON_MAX = 200;

// ─── Resolution dialog (in-DOM, NEVER window.prompt) ─────────────────────
function ResolutionModal({
  open,
  status,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  status: Status | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  if (!open || !status) return null;
  const sanitized = reason.replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
  const valid = sanitized.length > 0;
  const verb = status === "RESOLVED" ? "Resolve" : "Dismiss";
  return (
    <div
      data-testid="ai-fraud-resolve-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-fraud-resolve-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <h2
          id="ai-fraud-resolve-title"
          className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {verb} alert
        </h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          A short reason is required and recorded in the audit log.
        </p>
        <label
          htmlFor="ai-fraud-resolve-reason"
          className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
        >
          Reason ({sanitized.length}/{REASON_MAX})
        </label>
        <input
          id="ai-fraud-resolve-reason"
          data-testid="ai-fraud-resolve-reason-input"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={REASON_MAX + 50 /* allow paste, we still cap server-side */}
          placeholder={
            status === "RESOLVED"
              ? "e.g. Confirmed legitimate after billing review"
              : "e.g. False positive — duplicate row from import"
          }
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="ai-fraud-resolve-cancel"
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="ai-fraud-resolve-confirm"
            disabled={!valid}
            onClick={() => valid && onConfirm(sanitized)}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {verb}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Status pill + dropdown ───────────────────────────────────────────────
function StatusPill({
  alertId,
  status,
  canWrite,
  role,
  onTransition,
}: {
  alertId: string;
  status: Status;
  canWrite: boolean;
  role: string | undefined;
  onTransition: (next: Status) => void;
}) {
  const [open, setOpen] = useState(false);
  const transitions = canWrite ? allowedTransitions(status, role) : [];
  const buttonClass = `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[status]}`;

  if (!canWrite || transitions.length === 0) {
    return (
      <span data-testid={`ai-fraud-status-${alertId}`} className={buttonClass}>
        {status}
      </span>
    );
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        data-testid={`ai-fraud-status-${alertId}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={buttonClass + " cursor-pointer"}
      >
        {status}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          data-testid={`ai-fraud-status-menu-${alertId}`}
          className="absolute left-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-600 dark:bg-gray-800"
          onClick={(e) => e.stopPropagation()}
        >
          {transitions.map((next) => (
            <button
              key={next}
              type="button"
              data-testid={`ai-fraud-status-option-${alertId}-${next}`}
              onClick={() => {
                setOpen(false);
                onTransition(next);
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              {next}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Comment thread ───────────────────────────────────────────────────────
function CommentThread({
  alertId,
  canWrite,
}: {
  alertId: string;
  canWrite: boolean;
}) {
  const [comments, setComments] = useState<FraudComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: FraudComment[] }>(
        `/ai/fraud/alerts/${alertId}/comments`,
      );
      setComments(res.data || []);
    } catch (err) {
      // Non-fatal — comment thread can be empty if model not yet migrated.
      const e = err as { status?: number; message?: string };
      if (e.status !== 503) {
        toast.error(e.message || "Failed to load comments");
      }
      setComments([]);
    }
    setLoading(false);
  }, [alertId]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit() {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    try {
      const res = await api.post<{ data: FraudComment }>(
        `/ai/fraud/alerts/${alertId}/comments`,
        { body },
      );
      setComments((prev) => [...prev, res.data]);
      setDraft("");
    } catch (err) {
      const e = err as { message?: string };
      toast.error(e.message || "Failed to post comment");
    }
    setPosting(false);
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Comments ({comments.length})
      </h3>
      <div className="space-y-2">
        {loading ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : comments.length === 0 ? (
          <p className="text-xs text-gray-400" data-testid={`ai-fraud-comments-empty-${alertId}`}>
            No comments yet.
          </p>
        ) : (
          comments.map((c) => (
            <div
              key={c.id}
              data-testid={`ai-fraud-comment-${c.id}`}
              className="rounded-lg border border-gray-200 bg-gray-50 p-2 text-xs dark:border-gray-700 dark:bg-gray-900"
            >
              <div className="mb-0.5 flex justify-between text-[11px] text-gray-500 dark:text-gray-400">
                <span className="font-semibold text-gray-700 dark:text-gray-200">
                  {c.authorName}
                </span>
                <span>{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <p className="whitespace-pre-wrap text-gray-700 dark:text-gray-200">
                {c.body}
              </p>
            </div>
          ))
        )}
      </div>
      {canWrite && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <textarea
            data-testid={`ai-fraud-comment-input-${alertId}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment for the audit trail…"
            rows={2}
            className="flex-1 resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
          <button
            type="button"
            data-testid={`ai-fraud-comment-submit-${alertId}`}
            onClick={submit}
            disabled={!draft.trim() || posting}
            className="self-end rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            Add comment
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────
export default function AiFraudPage() {
  const { user } = useAuthStore();
  const role = user?.role;
  const canRead = role === "ADMIN" || role === "RECEPTION";
  const canWrite = canRead; // Same set today; future doctors may read-only.

  const [alerts, setAlerts] = useState<FraudAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [severity, setSeverity] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("NEW");
  const [windowDays, setWindowDays] = useState<number>(30);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Resolution modal state.
  const [resolveTarget, setResolveTarget] = useState<{ id: string; status: Status } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (severity) qs.set("severity", severity);
      if (statusFilter) {
        // Translate UI-status filter to legacy server-side values where needed.
        const serverStatus = statusFilter === "NEW" ? "OPEN" : statusFilter;
        qs.set("status", serverStatus);
      }
      qs.set("limit", "50");
      const res = await api.get<{ data: FraudAlert[] }>(
        `/ai/fraud/alerts?${qs.toString()}`,
      );
      setAlerts(res.data || []);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status === 503) {
        toast.error(
          "FraudAlert model not yet migrated. Ask DB admin to run the pending migration.",
        );
      } else {
        toast.error(e.message || "Failed to load fraud alerts");
      }
      setAlerts([]);
    }
    setLoading(false);
  }, [severity, statusFilter]);

  useEffect(() => {
    if (canRead) load();
  }, [canRead, load]);

  async function runScan() {
    if (role !== "ADMIN") {
      toast.error("Only ADMIN can run a scan");
      return;
    }
    setScanning(true);
    try {
      const res = await api.post<{ data: { alertCount: number; hitCount: number } }>(
        "/ai/fraud/scan",
        { windowDays },
      );
      toast.success(
        `Scan complete — ${res.data.hitCount} hits, ${res.data.alertCount} persisted`,
      );
      await load();
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error(e.message || "Scan failed");
    }
    setScanning(false);
  }

  // Begin a transition. RESOLVED / DISMISSED open the in-DOM modal first;
  // other transitions go straight through.
  function beginTransition(alert: FraudAlert, next: Status) {
    if (next === "RESOLVED" || next === "DISMISSED") {
      setResolveTarget({ id: alert.id, status: next });
      return;
    }
    void applyTransition(alert.id, next, null);
  }

  async function applyTransition(id: string, next: Status, reason: string | null) {
    try {
      await api.patch(`/ai/fraud/alerts/${id}/status`, {
        status: next,
        ...(reason ? { reason } : {}),
      });
      toast.success(`Alert moved to ${next}`);
      setResolveTarget(null);
      await load();
    } catch (err: unknown) {
      const e = err as { message?: string };
      toast.error(e.message || "Status update failed");
    }
  }

  const visibleAlerts = useMemo(() => alerts, [alerts]);

  if (user && !canRead) {
    return (
      <div
        data-testid="ai-fraud-page"
        className="p-8 text-center text-gray-500 dark:text-gray-400"
      >
        <ShieldCheck className="mx-auto mb-2 h-10 w-10 text-gray-400" />
        Restricted — fraud alerts are only visible to admin and reception staff.
      </div>
    );
  }

  return (
    <div data-testid="ai-fraud-page">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Fraud &amp; Anomaly Alerts
        </h1>
        {role === "ADMIN" && (
          <button
            onClick={runScan}
            disabled={scanning}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-white disabled:opacity-60"
          >
            {scanning ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Siren className="h-4 w-4" />
            )}
            Run Scan Now
          </button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
            Severity
          </label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">All</option>
            <option value="HIGH_RISK">High Risk</option>
            <option value="SUSPICIOUS">Suspicious</option>
            <option value="INFO">Info</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
            Status
          </label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">All</option>
            <option value="NEW">New</option>
            <option value="INVESTIGATING">Investigating</option>
            <option value="RESOLVED">Resolved</option>
            <option value="DISMISSED">Dismissed</option>
          </select>
        </div>
        {role === "ADMIN" && (
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              Scan Window (days)
            </label>
            <input
              type="number"
              min={1}
              max={365}
              value={windowDays}
              onChange={(e) => setWindowDays(parseInt(e.target.value, 10) || 30)}
              className="w-28 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
        )}
      </div>

      <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            Loading...
          </div>
        ) : visibleAlerts.length === 0 ? (
          <div
            data-testid="fraud-empty-state"
            className="p-8 text-center text-gray-500 dark:text-gray-400"
          >
            <ShieldCheck className="mx-auto mb-2 h-10 w-10 text-green-500" />
            No matching alerts
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-3 w-8" />
                <th className="px-4 py-3">Detected</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Description</th>
              </tr>
            </thead>
            <tbody>
              {visibleAlerts.map((a) => {
                const uiStatus = normalizeStatus(a.status);
                const isExpanded = expandedId === a.id;
                return (
                  <Fragment key={a.id}>
                    <tr
                      data-testid={`ai-fraud-row-${a.id}`}
                      className="cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
                      onClick={() =>
                        setExpandedId((cur) => (cur === a.id ? null : a.id))
                      }
                    >
                      <td className="px-2 py-3 text-gray-400">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                        {new Date(a.detectedAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                        {a.type.replace(/_/g, " ")}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${SEVERITY_COLOR[a.severity]}`}
                        >
                          {a.severity === "HIGH_RISK" && (
                            <AlertTriangle className="h-3 w-3" />
                          )}
                          {a.severity.replace("_", " ")}
                        </span>
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <StatusPill
                          alertId={a.id}
                          status={uiStatus}
                          canWrite={canWrite}
                          role={role}
                          onTransition={(next) => beginTransition(a, next)}
                        />
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                        <div>{a.description}</div>
                        {a.evidence?.llmReason ? (
                          <div className="mt-1 text-xs italic text-gray-500 dark:text-gray-400">
                            AI: {a.evidence.llmReason}
                          </div>
                        ) : null}
                        {a.resolutionNote ? (
                          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            Resolution: {a.resolutionNote}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr
                        data-testid={`ai-fraud-details-${a.id}`}
                        className="border-b border-gray-100 dark:border-gray-700"
                      >
                        <td colSpan={6} className="bg-gray-50 px-6 py-4 dark:bg-gray-900/40">
                          <CommentThread alertId={a.id} canWrite={canWrite} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ResolutionModal
        open={!!resolveTarget}
        status={resolveTarget?.status ?? null}
        onCancel={() => setResolveTarget(null)}
        onConfirm={(reason) =>
          resolveTarget && applyTransition(resolveTarget.id, resolveTarget.status, reason)
        }
      />
    </div>
  );
}
