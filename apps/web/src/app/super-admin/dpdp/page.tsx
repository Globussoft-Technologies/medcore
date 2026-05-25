// Super-admin DPDP erasure-request workbench — Pearl ERP Stage 1 §8.6
// (gap row 224 closure, 2026-05-23).
//
// Lists DPDPErasureRequest rows across all tenants (newest first). The
// super-admin can Execute (runs the cross-table purge) or Reject (with
// a reason) a PENDING request. COMPLETED / FAILED / REJECTED rows are
// read-only.
//
// RBAC: the layout already enforces Role.ADMIN + tenantId == null on
// the client side; the /api/v1/dpdp-workbench routes enforce the same
// on the server. Mobile-first: h-11 (44px) touch targets across action
// buttons + filter chips.

"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
  Trash2,
} from "lucide-react";

type ErasureStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "REJECTED";

interface ErasureRequest {
  id: string;
  tenantId: string;
  patientId: string;
  requestedBy: string;
  requestedByRole: string;
  reason: string | null;
  status: ErasureStatus;
  requestedAt: string;
  executedAt: string | null;
  executedBy: string | null;
  failureReason: string | null;
  executionReceipt: {
    purgedTables?: string[];
    purgedRows?: Record<string, number>;
    anonymizedTables?: string[];
    retainedTables?: string[];
    notes?: string;
  } | null;
}

interface ListResponse {
  success: boolean;
  data: {
    requests: ErasureRequest[];
    nextCursor: string | null;
  };
  error: string | null;
}

type StatusFilter = "ALL" | "PENDING" | "COMPLETED" | "FAILED";

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: "PENDING", label: "Pending" },
  { key: "COMPLETED", label: "Completed" },
  { key: "FAILED", label: "Failed" },
  { key: "ALL", label: "All" },
];

function statusPill(status: ErasureStatus) {
  switch (status) {
    case "PENDING":
      return {
        cls: "bg-amber-50 text-amber-700 border-amber-200",
        Icon: Clock,
      };
    case "IN_PROGRESS":
      return {
        cls: "bg-blue-50 text-blue-700 border-blue-200",
        Icon: Loader2,
      };
    case "COMPLETED":
      return {
        cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
        Icon: CheckCircle2,
      };
    case "FAILED":
      return {
        cls: "bg-rose-50 text-rose-700 border-rose-200",
        Icon: AlertCircle,
      };
    case "REJECTED":
      return {
        cls: "bg-slate-100 text-slate-700 border-slate-200",
        Icon: XCircle,
      };
    default:
      return {
        cls: "bg-slate-100 text-slate-700 border-slate-200",
        Icon: Clock,
      };
  }
}

function formatTs(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function anonymizedPatientLabel(patientId: string): string {
  // We don't fetch full patient PII into this UI; show a stable short
  // suffix so a regulator browsing the workbench can correlate by id
  // without us re-leaking the very PII the erasure removed.
  return `PT-${patientId.slice(0, 8)}`;
}

export default function SuperAdminDpdpPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("PENDING");
  const [requests, setRequests] = useState<ErasureRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    params.set("limit", "100");
    return params.toString();
  }, [statusFilter]);

  async function fetchRequests(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/dpdp-workbench/requests?${queryString}`,
        { credentials: "include" },
      );
      const body = (await res.json()) as ListResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setRequests(body.data.requests);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  async function executeRequest(row: ErasureRequest): Promise<void> {
    if (
      !window.confirm(
        `EXECUTE erasure for ${anonymizedPatientLabel(row.patientId)}? This anonymizes the patient and hard-deletes child rows. Action cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy((p) => ({ ...p, [row.id]: true }));
    try {
      const res = await fetch(
        `/api/v1/dpdp-workbench/requests/${row.id}/execute`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? `Execute failed (${res.status})`);
      }
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((p) => {
        const { [row.id]: _, ...rest } = p;
        return rest;
      });
    }
  }

  async function submitReject(): Promise<void> {
    if (!rejectId || !rejectReason.trim()) return;
    setBusy((p) => ({ ...p, [rejectId]: true }));
    try {
      const res = await fetch(
        `/api/v1/dpdp-workbench/requests/${rejectId}/reject`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: rejectReason.trim() }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? `Reject failed (${res.status})`);
      }
      setRejectId(null);
      setRejectReason("");
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      const id = rejectId;
      setBusy((p) => {
        const { [id!]: _, ...rest } = p;
        return rest;
      });
    }
  }

  return (
    <section data-testid="super-admin-dpdp" className="space-y-6 py-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          DPDP Erasure Workbench
        </h1>
        <p className="text-sm text-slate-600">
          Right-to-erasure tickets (DPDP Act 2023 §17). Execute runs an
          atomic cross-table purge: child rows hard-deleted, Patient + User
          anonymized, AuditLog retained per regulatory requirement.
        </p>
      </header>

      <div
        className="flex flex-wrap gap-2"
        data-testid="dpdp-status-filters"
      >
        {STATUS_CHIPS.map((chip) => {
          const active = statusFilter === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              data-testid={`dpdp-filter-status-${chip.key.toLowerCase()}`}
              aria-pressed={active}
              onClick={() => setStatusFilter(chip.key)}
              className={`inline-flex h-11 min-w-[80px] items-center justify-center rounded-full border px-4 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-slate-900 ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div
          data-testid="dpdp-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      <div
        className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm"
        data-testid="dpdp-table-wrapper"
      >
        <table className="min-w-full text-left text-sm" data-testid="dpdp-table">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Patient
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Tenant
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Requested-by
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Requested-at
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Executed-at
              </th>
              <th scope="col" className="px-4 py-3 font-medium text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {requests.length === 0 && !loading ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  data-testid="dpdp-empty"
                >
                  No erasure requests in this view.
                </td>
              </tr>
            ) : null}
            {requests.map((row) => {
              const pill = statusPill(row.status);
              const Icon = pill.Icon;
              const isBusy = !!busy[row.id];
              const canExecute =
                row.status === "PENDING" || row.status === "FAILED";
              const canReject = row.status === "PENDING";
              // Pearl §12 row 382 — auditable receipt only meaningful
              // once the purge has executed (any non-PENDING, non-IN_PROGRESS
              // state has an executionReceipt or a final outcome to report).
              const canDownloadReceipt = row.status === "COMPLETED";
              return (
                <tr
                  key={row.id}
                  data-testid={`dpdp-row-${row.id}`}
                  data-status={row.status}
                >
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">
                    {anonymizedPatientLabel(row.patientId)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">
                    {row.tenantId
                      ? row.tenantId.slice(0, 8)
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${pill.cls}`}
                      data-testid={`dpdp-status-pill-${row.id}`}
                    >
                      <Icon
                        size={12}
                        aria-hidden="true"
                        className={
                          row.status === "IN_PROGRESS" ? "animate-spin" : ""
                        }
                      />
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {row.requestedByRole}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatTs(row.requestedAt)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {formatTs(row.executedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center justify-end gap-2">
                      {canExecute ? (
                        <button
                          type="button"
                          data-testid={`dpdp-execute-${row.id}`}
                          disabled={isBusy}
                          onClick={() => executeRequest(row)}
                          className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-md border border-rose-300 bg-rose-50 px-3 text-xs font-medium text-rose-700 hover:border-rose-400 hover:bg-rose-100 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-rose-600"
                        >
                          <Trash2
                            size={14}
                            aria-hidden="true"
                            className={isBusy ? "animate-spin" : ""}
                          />
                          Execute
                        </button>
                      ) : null}
                      {canReject ? (
                        <button
                          type="button"
                          data-testid={`dpdp-reject-${row.id}`}
                          disabled={isBusy}
                          onClick={() => {
                            setRejectId(row.id);
                            setRejectReason("");
                          }}
                          className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
                        >
                          Reject
                        </button>
                      ) : null}
                      {canDownloadReceipt ? (
                        <>
                          <button
                            type="button"
                            data-testid={`dpdp-receipt-json-${row.id}`}
                            onClick={() =>
                              window.open(
                                `/api/v1/dpdp-workbench/requests/${row.id}/receipt.json`,
                                "_blank",
                                "noopener,noreferrer",
                              )
                            }
                            className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
                          >
                            Receipt (JSON)
                          </button>
                          <button
                            type="button"
                            data-testid={`dpdp-receipt-pdf-${row.id}`}
                            onClick={() =>
                              window.open(
                                `/api/v1/dpdp-workbench/requests/${row.id}/receipt.pdf`,
                                "_blank",
                                "noopener,noreferrer",
                              )
                            }
                            className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
                          >
                            Receipt (PDF)
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span
          className="text-xs text-slate-500"
          data-testid="dpdp-count-summary"
        >
          {requests.length} request{requests.length === 1 ? "" : "s"} shown
        </span>
      </div>

      {/* Reject modal */}
      {rejectId ? (
        <div
          data-testid="dpdp-reject-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold">Reject erasure request</h2>
            <p className="text-xs text-slate-600">
              The reason is persisted on the request row and emitted in the
              DPDP_ERASURE_REJECTED audit log.
            </p>
            <textarea
              data-testid="dpdp-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="e.g. duplicate; recipient not the patient"
              className="w-full rounded-md border border-slate-300 bg-white p-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="dpdp-reject-cancel"
                onClick={() => {
                  setRejectId(null);
                  setRejectReason("");
                }}
                className="inline-flex h-11 items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-400"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="dpdp-reject-confirm"
                disabled={!rejectReason.trim()}
                onClick={() => void submitReject()}
                className="inline-flex h-11 items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                Reject request
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
