"use client";

// Issue #715 — Patient-portal /dashboard/lab-orders page.
//
// Modules consumed:
//   - GET /api/v1/lab/orders                  (auto-scopes to req.user.patientId
//                                              when role === PATIENT; staff see
//                                              broader rows but the page is
//                                              still useful since the same
//                                              filter applies)
//   - GET /api/v1/lab/orders/:id/pdf          (signed/server-rendered HTML
//                                              report — opened in a new tab as
//                                              the "Result" link)
//
// Why this file exists: the issue reported that authenticated patient users
// hit a hard 404 on /dashboard/lab-orders. There was no `page.tsx` under that
// route at all. /dashboard/lab is the operational lab-tech surface (order
// creation, batch sample receive, result entry) and is too heavy for a
// patient-only "list of MY orders" view. This page is the minimum-viable
// patient-facing list with status + result-link columns.

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/EmptyState";
import { FlaskConical, ExternalLink } from "lucide-react";

// PATIENT is the primary audience but we keep clinical staff allowed so the
// route doesn't 403 for someone who navigated from a deep-link. The API
// already self-scopes per role.
const ALLOWED = new Set([
  "ADMIN",
  "DOCTOR",
  "NURSE",
  "LAB_TECH",
  "PATIENT",
]);

interface LabOrderRow {
  id: string;
  orderNumber?: string | null;
  orderedAt: string;
  status: string;
  priority?: string | null;
  stat?: boolean;
  items: Array<{
    id: string;
    status: string;
    test: { id: string; name: string; code?: string | null };
    results?: Array<{ id: string }>;
  }>;
  doctor?: { user: { name: string } } | null;
}

const DATE_FMT = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

function formatOrderedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return DATE_FMT.format(d);
}

function statusTone(status: string): string {
  switch (status) {
    case "REPORTED":
    case "VERIFIED":
      return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300";
    case "IN_PROGRESS":
    case "SAMPLE_RECEIVED":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    case "REJECTED":
    case "CANCELLED":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200";
  }
}

export default function LabOrdersPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [orders, setOrders] = useState<LabOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Issue #179 convention: redirect non-allowed roles to the chrome-wrapped
  // not-authorized page so the dashboard layout stays mounted.
  useEffect(() => {
    if (!isLoading && user && !ALLOWED.has(user.role)) {
      toast.error("Lab orders are restricted.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/lab-orders")}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await api.get<{ data: LabOrderRow[] }>(
          "/lab/orders?page=1&limit=50",
        );
        if (cancelled) return;
        setOrders(res.data ?? []);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load lab orders",
        );
        setOrders([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (user && ALLOWED.has(user.role)) load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  function openReport(orderId: string) {
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
    window.open(`${apiBase}/lab/orders/${orderId}/pdf`, "_blank");
  }

  function hasReportableResult(o: LabOrderRow): boolean {
    // The list endpoint does NOT eager-load `items[].results` (only the
    // single-order GET does). Fall back to a status-based check: REPORTED /
    // VERIFIED / COMPLETED orders are presumed to have results behind the
    // PDF endpoint. Patients clicking "View report" before then would
    // bounce off the API's own 404, which is the right contract.
    const reportableStatuses = new Set([
      "REPORTED",
      "VERIFIED",
      "COMPLETED",
      "RESULT_ENTERED",
    ]);
    if (reportableStatuses.has(o.status)) return true;
    return (o.items ?? []).some((i) => (i.results?.length ?? 0) > 0);
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Lab Orders
        </h1>
      </div>

      {loading ? (
        <div
          className="rounded-xl bg-white p-8 text-center text-gray-500 dark:bg-gray-800 dark:text-gray-400"
          data-testid="lab-orders-loading"
        >
          Loading...
        </div>
      ) : loadError ? (
        <div
          className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          data-testid="lab-orders-error"
          role="alert"
        >
          <p className="font-medium">Could not load lab orders.</p>
          <p className="mt-1 text-xs opacity-80">{loadError}</p>
        </div>
      ) : orders.length === 0 ? (
        <EmptyState
          icon={<FlaskConical size={28} aria-hidden="true" />}
          title="No lab orders yet"
          description="Lab tests ordered for you will appear here once a clinician requests them."
        />
      ) : (
        <div
          className="overflow-x-auto rounded-xl bg-white shadow-sm dark:bg-gray-800"
          data-testid="lab-orders-table-wrap"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Order #</th>
                <th className="px-4 py-3">Tests</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Result</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const tests =
                  (o.items ?? [])
                    .map((i) => i.test?.name)
                    .filter(Boolean)
                    .join(", ") || "—";
                const reportable = hasReportableResult(o);
                return (
                  <tr
                    key={o.id}
                    data-testid={`lab-order-row-${o.id}`}
                    className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
                  >
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-200">
                      {formatOrderedDate(o.orderedAt)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">
                      {o.orderNumber ?? o.id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 text-gray-800 dark:text-gray-100">
                      {tests}
                      {o.stat ? (
                        <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                          STAT
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(o.status)}`}
                      >
                        {o.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {reportable ? (
                        <button
                          type="button"
                          onClick={() => openReport(o.id)}
                          data-testid={`lab-order-report-${o.id}`}
                          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                        >
                          View report
                          <ExternalLink size={14} aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">
                          Pending
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
