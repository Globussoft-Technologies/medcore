"use client";

import { useEffect, useState, Fragment } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { formatINR } from "@/lib/currency";
import { Plus, FlaskConical, Inbox } from "lucide-react";
import { extractFieldErrors, type FieldErrorMap } from "@/lib/field-errors";
import { TablePagination } from "@/components/TablePagination";
// Issue #438 (Apr 30 2026): canonicalise dates via the shared formatter so
// the lab tab matches the rest of the app's `DD MMM YYYY` style.
import { formatDate } from "@/lib/format";
import { SkeletonTable, SkeletonText } from "@/components/Skeleton";

// Issue #90: RECEPTION must NOT see lab orders / results / result-entry form.
// Clinical roles + LAB_TECH + PATIENT (own data).
const LAB_ALLOWED = new Set(["ADMIN", "DOCTOR", "NURSE", "LAB_TECH", "PATIENT"]);

interface LabTest {
  id: string;
  name: string;
  category?: string | null;
  normalRange?: string | null;
  unit?: string | null;
  price?: number;
}

interface LabOrder {
  id: string;
  orderNumber?: string;
  orderedAt: string;
  status: string;
  priority?: string;
  stat?: boolean;
  notes?: string | null;
  patient: { id: string; mrNumber?: string; user: { name: string } };
  doctor?: { user: { name: string } };
  items: LabOrderItem[];
}

interface LabOrderItem {
  id: string;
  status: string;
  test: LabTest;
  results?: LabResult[];
}

interface LabResult {
  id: string;
  parameter: string;
  value: string;
  unit?: string | null;
  normalRange?: string | null;
  flag?: "NORMAL" | "LOW" | "HIGH" | "CRITICAL" | null;
  notes?: string | null;
}

interface Patient {
  id: string;
  mrNumber: string;
  user: { name: string; phone: string };
}

type Tab = "orders" | "catalog";

// Issue #624: status keys must match the LabTestStatus DB enum
// (ORDERED / SAMPLE_COLLECTED / IN_PROGRESS / COMPLETED / CANCELLED /
// SAMPLE_REJECTED). The legacy "PENDING" key was a holdover that meant
// the "Collect" pre-analytical button never rendered (DB rows are
// created with status=ORDERED), so lab orders silently skipped the
// SAMPLE_COLLECTED state.
const STATUS_COLORS: Record<string, string> = {
  ORDERED: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  SAMPLE_COLLECTED: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  IN_PROGRESS: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  COMPLETED: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  CANCELLED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  SAMPLE_REJECTED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

const FLAG_COLORS: Record<string, string> = {
  NORMAL: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  LOW: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  HIGH: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  CRITICAL: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

export default function LabPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  // Issue #90: redirect RECEPTION away — clinical-data exposure.
  // Issue #179: target /dashboard/not-authorized so the layout chrome stays.
  useEffect(() => {
    if (!isLoading && user && !LAB_ALLOWED.has(user.role)) {
      toast.error(t("dashboard.lab.restricted"));
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/lab")}`,
      );
    }
  }, [user, isLoading, router, pathname, t]);
  const [tab, setTab] = useState<Tab>("orders");
  const [orders, setOrders] = useState<LabOrder[]>([]);
  const [tests, setTests] = useState<LabTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showOrderModal, setShowOrderModal] = useState(false);
  // Pearl §2.1.3 — initial patient + appointment passed from the
  // consult page's Flask quick-action so the modal opens already
  // wired to the right encounter. `consultBack` holds the consult
  // page's appointmentId to render a Back-to-Consult chip in the
  // modal header (null = not from consult, no back link).
  const [initialPatientId, setInitialPatientId] = useState<string | null>(null);
  const [initialAppointmentId, setInitialAppointmentId] =
    useState<string | null>(null);
  const [consultBackAppointmentId, setConsultBackAppointmentId] =
    useState<string | null>(null);
  const searchParams = useSearchParams();
  useEffect(() => {
    if (!searchParams) return;
    if (searchParams.get("new") !== "1") return;
    setShowOrderModal(true);
    const pid = searchParams.get("patientId");
    const aid = searchParams.get("appointmentId");
    const fromParam = searchParams.get("from");
    if (pid) setInitialPatientId(pid);
    if (aid) setInitialAppointmentId(aid);
    if (fromParam === "consult" && aid) setConsultBackAppointmentId(aid);
  }, [searchParams]);
  const [statOnly, setStatOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [aiInsights, setAiInsights] = useState<Record<string, {
    loading: boolean;
    data?: {
      interpretation: string;
      trend: string;
      baselineComparison: string;
      recommendedActions: string[];
      urgency: string;
    };
    error?: string;
  }>>({});

  // Issue #459 (A5 RBAC drift, May 2026): server `POST /lab/orders` accepts
  // DOCTOR + ADMIN (lab.ts:243). The UI was hiding the New-Order CTA from
  // ADMIN, blocking ad-hoc orders during admin-led workflows (e.g. front-
  // desk add-on tests, audit reruns). Align with server intent.
  const canOrder = user?.role === "DOCTOR" || user?.role === "ADMIN";
  const canSeeAI = user?.role === "DOCTOR" || user?.role === "ADMIN";
  // Only lab techs and admins may enter results — doctors view, never enter.
  // Mirror of the backend `authorize(LAB_TECH, ADMIN)` on POST /lab/results.
  const canEnterResults = user?.role === "LAB_TECH" || user?.role === "ADMIN";
  // Pearl §2.1.3 — sample collection + processing transitions are the
  // lab-tech / nurse workflow. Doctors place the order but should not
  // perform pre-analytical actions, so the Collect / Process CTAs on
  // each row hide for them (View link still renders so the doctor can
  // monitor progress). Mirrors the backend's `authorize(LAB_TECH,
  // NURSE, ADMIN)` on PATCH /lab/orders/:id/status.
  const canCollect =
    user?.role === "LAB_TECH" ||
    user?.role === "NURSE" ||
    user?.role === "ADMIN";

  async function fetchAIInsights(resultId: string) {
    setAiInsights((m) => ({ ...m, [resultId]: { loading: true } }));
    try {
      const res = await api.get<any>(`/ai/lab-intel/${resultId}`);
      setAiInsights((m) => ({
        ...m,
        [resultId]: { loading: false, data: res.data?.analysis ?? res.data?.data?.analysis },
      }));
    } catch (err: any) {
      setAiInsights((m) => ({
        ...m,
        [resultId]: { loading: false, error: err?.message ?? t("common.error") },
      }));
    }
  }

  useEffect(() => {
    if (tab === "orders") loadOrders();
    else loadTests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, statOnly]);

  // Reset to page 1 whenever the order set changes (tab switch, STAT filter
  // toggle, reload) so the user never lands on an out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [tab, statOnly, orders.length]);

  // Auto-open the order form when the doctor workspace quick-action links
  // here with ?new=1 (companion to issue #11 Write Rx fix).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!canOrder) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") === "1") setShowOrderModal(true);
  }, [canOrder]);

  async function loadOrders() {
    setLoading(true);
    try {
      const qs = statOnly ? "?stat=true" : "";
      const res = await api.get<{ data: LabOrder[] }>(`/lab/orders${qs}`);
      setOrders(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function loadTests() {
    setLoading(true);
    try {
      const res = await api.get<{ data: LabTest[] }>("/lab/tests");
      setTests(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function updateStatus(orderId: string, status: string) {
    try {
      await api.patch(`/lab/orders/${orderId}/status`, { status });
      loadOrders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("dashboard.lab.error.updateFailed"));
    }
  }

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
    }`;

  const labStatusLabel = (status: string) =>
    t(`dashboard.lab.status.${status}`, status.replace(/_/g, " "));

  const testsByCategory = tests.reduce(
    (acc, t) => {
      const cat = t.category || t("dashboard.lab.category.other");
      (acc[cat] ||= []).push(t);
      return acc;
    },
    {} as Record<string, LabTest[]>
  );

  // Client-side pagination over the loaded orders (already STAT-filtered
  // server-side via loadOrders).
  const totalPages = Math.max(1, Math.ceil(orders.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedOrders = orders.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
            <FlaskConical className="text-primary" aria-hidden="true" /> {t("dashboard.lab.title")}
          </h1>
          <p className="text-sm text-gray-700 dark:text-gray-300">{t("dashboard.lab.orders")}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Pearl §2.1.3 — Back to Consult chip on the lab list
              header, persists after the doctor closes/submits the
              order modal so they can return to the SOAP draft. Shows
              only when the page was opened from /dashboard/consult. */}
          {consultBackAppointmentId && (
            <Link
              href={`/dashboard/consult/${consultBackAppointmentId}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:border-primary hover:text-primary dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
              data-testid="lab-back-to-consult"
            >
              {t("dashboard.lab.backToConsult")}
            </Link>
          )}
          {canOrder && tab === "orders" && (
            <button
              onClick={() => setShowOrderModal(true)}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              <Plus size={16} aria-hidden="true" /> {t("dashboard.lab.newOrder")}
            </button>
          )}
        </div>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => setTab("orders")} className={tabClass("orders")}>
          {t("dashboard.lab.tab.orders")}
        </button>
        <button onClick={() => setTab("catalog")} className={tabClass("catalog")}>
          {t("dashboard.lab.tab.catalog")}
        </button>
        {tab === "orders" && (
          <button
            onClick={() => setStatOnly((v) => !v)}
            className={`ml-auto rounded-full border px-3 py-1 text-xs font-semibold ${
              statOnly
                ? "border-red-600 bg-red-600 text-white"
                : "border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:bg-gray-800 dark:text-red-300 dark:hover:bg-red-900/20"
            }`}
          >
            {t("dashboard.lab.statOnly")}
          </button>
        )}
      </div>

      {tab === "catalog" ? (
        <div className="rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
          {loading ? (
            <div data-testid="lab-tests-loading" aria-busy="true">
              <SkeletonText lines={6} />
            </div>
          ) : tests.length === 0 ? (
            <div className="text-center text-gray-500 dark:text-gray-400">{t("dashboard.lab.empty.noTests")}</div>
          ) : (
            Object.entries(testsByCategory).map(([cat, list]) => (
              <div key={cat} className="mb-6">
                <h3 className="mb-2 text-sm font-semibold uppercase text-gray-600 dark:text-gray-300">
                  {cat}
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((t) => (
                    <div
                      key={t.id}
                      className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
                    >
                      <p className="font-medium">{t.name}</p>
                      {/* Issue #631 (2026-05-05): tests without a numeric range
                          previously rendered NO Normal line at all, making the
                          tile look like missing data. Always render the line —
                          show the range when present, "Qualitative" otherwise
                          (covers imaging like Echo/ECG/X-Ray, qualitative
                          serology like HIV/Dengue/Widal, and microscopy where
                          the result is a structured report rather than a
                          number). */}
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {/* Issue #230: extension of #147 — only append the
                            unit when the range string doesn't already
                            contain it. Prevents "0.4-4.0 mIU/L mIU/L". */}
                        {t("dashboard.lab.normal")}: {" "}
                        {t.normalRange ? (
                          <>
                            {t.normalRange}
                            {t.unit &&
                            !t.normalRange.toLowerCase().includes(t.unit.toLowerCase())
                              ? ` ${t.unit}`
                              : ""}
                          </>
                        ) : (
                          <span className="italic">{t("dashboard.lab.qualitative")}</span>
                        )}
                      </p>
                      {t.price !== undefined && (
                        // Issue #403: canonical INR format ("₹1,200.00") via
                        // shared formatINR — was bare "₹1200" before.
                        <p className="mt-1 text-xs">{formatINR(t.price)}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
          {loading ? (
            <div className="p-4" data-testid="lab-orders-list-loading" aria-busy="true">
              <SkeletonTable rows={5} columns={6} />
            </div>
          ) : orders.length === 0 ? (
            // Issue #438 (Apr 30 2026): give the empty state an icon + helper
            // copy instead of a single dashed line.
            <div
              className="flex flex-col items-center justify-center gap-2 p-10 text-gray-500 dark:text-gray-400"
              data-testid="lab-orders-empty-state"
            >
              <Inbox size={28} className="text-gray-400" aria-hidden="true" />
              {/* Issue #625: when STAT-only is on, distinguish "no STAT orders right now"
                  from "no orders at all" so the user understands non-STAT orders aren't
                  missing — they're hidden by the active filter. */}
              <p className="text-sm font-medium">
                {statOnly ? t("dashboard.lab.empty.noStatOrders") : t("dashboard.lab.empty.noOrders")}
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {statOnly
                  ? t("dashboard.lab.empty.noStatOrdersDesc")
                  : t("dashboard.lab.empty.noOrdersDesc")}
              </p>
              {statOnly && (
                <button
                  type="button"
                  onClick={() => setStatOnly(false)}
                  className="mt-2 rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  {t("dashboard.lab.clearStatFilter")}
                </button>
              )}
            </div>
          ) : (
            <>
            <div className="overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead>
                <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-4 py-3">{t("dashboard.lab.col.orderNumber")}</th>
                  <th className="px-4 py-3">{t("dashboard.lab.col.patient")}</th>
                  <th className="px-4 py-3">{t("dashboard.lab.col.doctor")}</th>
                  <th className="px-4 py-3">{t("dashboard.lab.col.tests")}</th>
                  <th className="px-4 py-3">{t("dashboard.lab.col.ordered")}</th>
                  <th className="px-4 py-3">{t("common.status")}</th>
                  <th className="px-4 py-3">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {pagedOrders.map((o) => (
                  <Fragment key={o.id}>
                    <tr
                      data-testid="lab-order-row"
                      data-order-status={o.status}
                      className={`cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700 ${
                        o.stat ? "border-l-4 border-l-red-500 bg-red-50/40 dark:bg-red-900/20" : ""
                      }`}
                      onClick={() =>
                        setExpanded(expanded === o.id ? null : o.id)
                      }
                    >
                      <td className="px-4 py-3 font-medium">
                        <div className="flex items-center gap-2">
                          {o.orderNumber || o.id.slice(0, 8)}
                          {o.stat && (
                            <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                              STAT
                            </span>
                          )}
                          {!o.stat && o.priority === "URGENT" && (
                            <span className="rounded bg-orange-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                              URGENT
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 max-w-[200px]">
                        {/* Issue #438: long patient names overflowed the cell —
                            truncate with a `title` for hover. */}
                        <p
                          className="truncate font-medium"
                          title={o.patient.user.name}
                        >
                          {o.patient.user.name}
                        </p>
                        <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                          {o.patient.mrNumber}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-sm max-w-[160px]">
                        <span
                          className="block truncate"
                          title={o.doctor?.user.name || ""}
                        >
                          {o.doctor?.user.name || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {o.items.length} {t("dashboard.lab.testsCount")}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {/* Issue #438: route through shared formatter for
                            consistent `DD MMM YYYY` across the app. */}
                        {formatDate(o.orderedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[o.status] || ""}`}
                        >
                          {labStatusLabel(o.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div
                          className="flex gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {/* Issue #624: lab order rows start at status
                              ORDERED (not PENDING — the legacy key never
                              matched), so the pre-analytical "Collect"
                              CTA never rendered. Show it for ORDERED, the
                              actual default state, so LAB_TECH/NURSE can
                              capture sample-collected before result entry.
                              Pearl §2.1.3: gated on `canCollect` so the
                              doctor (who placed the order) doesn't see
                              pre-analytical CTAs — they only View. */}
                          {o.status === "ORDERED" && canCollect && (
                            <button
                              data-testid="lab-collect-sample-btn"
                              onClick={() =>
                                updateStatus(o.id, "SAMPLE_COLLECTED")
                              }
                              className="rounded bg-blue-500 px-2 py-1 text-xs text-white hover:bg-blue-600"
                            >
                              {t("dashboard.lab.action.collect")}
                            </button>
                          )}
                          {o.status === "SAMPLE_COLLECTED" && canCollect && (
                            <button
                              onClick={() => updateStatus(o.id, "IN_PROGRESS")}
                              className="rounded bg-indigo-500 px-2 py-1 text-xs text-white hover:bg-indigo-600"
                            >
                              {t("dashboard.lab.action.process")}
                            </button>
                          )}
                          {o.status === "IN_PROGRESS" && canEnterResults && (
                            // Issue #632 (LabTech): the previous markup relied
                            // on the wrapping `<div onClick={stopPropagation}>`
                            // to swallow row-expansion events. On STAT rows
                            // and rows that were just animated into view, the
                            // first click would race the row's expansion
                            // re-render — Next's <Link> would lose its target
                            // mid-paint, leaving the URL unchanged. Pin the
                            // navigation explicitly via onClick + router.push
                            // so the first click ALWAYS navigates regardless
                            // of layout-shift timing, and stop propagation on
                            // both pointer phases (mousedown + click) so the
                            // outer row handler never fires for this CTA.
                            <Link
                              href={`/dashboard/lab/${o.id}`}
                              data-testid="lab-enter-results-link"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                router.push(`/dashboard/lab/${o.id}`);
                              }}
                              className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                            >
                              {t("dashboard.lab.action.enterResults")}
                            </Link>
                          )}
                          <Link
                            href={`/dashboard/lab/${o.id}`}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              router.push(`/dashboard/lab/${o.id}`);
                            }}
                            className="rounded border px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700"
                          >
                            {t("common.view")}
                          </Link>
                        </div>
                      </td>
                    </tr>
                    {expanded === o.id && (
                      <tr>
                        <td colSpan={7} className="bg-gray-50 px-4 py-3 dark:bg-gray-900/40">
                          <div className="space-y-2">
                            {o.items.map((item) => (
                              <div
                                key={item.id}
                                className="rounded-lg border bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
                              >
                                <div className="flex items-center justify-between">
                                  <p className="font-medium">
                                    {item.test.name}
                                  </p>
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[item.status] || ""}`}
                                  >
                                    {labStatusLabel(item.status)}
                                  </span>
                                </div>
                                {item.results && item.results.length > 0 && (
                                  <div className="mt-2 space-y-1">
                                    {item.results.map((r) => {
                                      const insight = aiInsights[r.id];
                                      return (
                                        <div key={r.id} className="text-sm">
                                          <div className="flex items-center gap-2">
                                            <span className="font-medium">
                                              {r.parameter}:
                                            </span>
                                            <span>
                                              {r.value} {r.unit}
                                            </span>
                                            {r.normalRange && (
                                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                                (normal: {r.normalRange})
                                              </span>
                                            )}
                                            {r.flag && (
                                              <span
                                                className={`rounded px-1.5 py-0.5 text-xs font-medium ${FLAG_COLORS[r.flag]}`}
                                              >
                                                {r.flag}
                                              </span>
                                            )}
                                            {canSeeAI && !insight && (
                                              <button
                                                data-testid="lab-ai-insights-btn"
                                                onClick={() => fetchAIInsights(r.id)}
                                                className="text-xs text-indigo-600 hover:underline ml-2 dark:text-indigo-400"
                                              >
                                                {t("dashboard.lab.aiInsights")}
                                              </button>
                                            )}
                                            {insight?.loading && (
                                              <span className="text-xs text-gray-500 ml-2 dark:text-gray-400">
                                                {t("dashboard.lab.analysing")}
                                              </span>
                                            )}
                                          </div>
                                          {insight?.data && (
                                            <div className="mt-1 bg-indigo-50 border border-indigo-100 rounded p-2 text-xs space-y-1 dark:bg-indigo-900/30 dark:border-indigo-800 dark:text-indigo-100">
                                              <p>
                                                <strong>{t("dashboard.lab.ai.interpretation")}:</strong>{" "}
                                                {insight.data.interpretation}
                                              </p>
                                              <p>
                                                <strong>{t("dashboard.lab.ai.trend")}:</strong> {insight.data.trend}{" "}
                                                <span className="text-gray-500 dark:text-gray-400">·</span>{" "}
                                                <strong>{t("dashboard.lab.ai.urgency")}:</strong> {insight.data.urgency}
                                              </p>
                                              <p>
                                                <strong>{t("dashboard.lab.ai.baseline")}:</strong>{" "}
                                                {insight.data.baselineComparison}
                                              </p>
                                              {insight.data.recommendedActions.length > 0 && (
                                                <ul className="list-disc list-inside">
                                                  {insight.data.recommendedActions.map(
                                                    (a, i) => (
                                                      <li key={i}>{a}</li>
                                                    )
                                                  )}
                                                </ul>
                                              )}
                                            </div>
                                          )}
                                          {insight?.error && (
                                            <p className="text-xs text-red-600 mt-1 dark:text-red-400">
                                              {insight.error}
                                            </p>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            </div>
            {orders.length > 0 && (
              <TablePagination
                page={currentPage}
                totalPages={totalPages}
                pageSize={pageSize}
                totalItems={orders.length}
                onPageChange={setPage}
                onPageSizeChange={(n) => {
                  setPage(1);
                  setPageSize(n);
                }}
              />
            )}
            </>
          )}
        </div>
      )}

      {showOrderModal && (
        <NewOrderModal
          onClose={() => setShowOrderModal(false)}
          onSaved={loadOrders}
          initialPatientId={initialPatientId}
          initialAppointmentId={initialAppointmentId}
          consultBackAppointmentId={consultBackAppointmentId}
        />
      )}
    </div>
  );
}

function NewOrderModal({
  onClose,
  onSaved,
  initialPatientId,
  initialAppointmentId: _initialAppointmentId,
  consultBackAppointmentId,
}: {
  onClose: () => void;
  onSaved: () => void;
  // Pearl §2.1.3 — pre-fill the order from the consult page's
  // Flask quick-action so the doctor doesn't re-search the patient.
  // Currently only patientId is wired into the picker; appointmentId
  // is plumbed for future per-encounter scoping.
  initialPatientId?: string | null;
  initialAppointmentId?: string | null;
  // If set, the modal header shows a "{t("dashboard.lab.backToConsult")}" link that
  // routes to /dashboard/consult/<id>.
  consultBackAppointmentId?: string | null;
}) {
  const { t } = useTranslation();
  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);

  // Pre-fetch the patient when initialPatientId is provided (consult
  // page flow). Sets `selectedPatient` so the modal opens with the
  // chip already selected. Silent failure → falls back to manual
  // search, which is what would have happened without the prefill.
  useEffect(() => {
    if (!initialPatientId) return;
    let cancelled = false;
    api
      .get<{ data: Patient }>(`/patients/${initialPatientId}`)
      .then((r) => {
        if (!cancelled && r.data) setSelectedPatient(r.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialPatientId]);
  const [tests, setTests] = useState<LabTest[]>([]);
  const [selectedTests, setSelectedTests] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [priority, setPriority] = useState<"ROUTINE" | "URGENT" | "STAT">("ROUTINE");
  // Issue #223: surface zod field-level errors instead of a single generic
  // "Validation failed" toast.
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});

  useEffect(() => {
    api
      .get<{ data: LabTest[] }>("/lab/tests")
      .then((res) => setTests(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (patientSearch.length < 2) {
      setPatientResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: Patient[] }>(
          `/patients?search=${encodeURIComponent(patientSearch)}&limit=10`
        );
        setPatientResults(res.data);
      } catch {
        setPatientResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [patientSearch]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Issue #545: "Create Order" with empty fields previously emitted a toast
    // and exited silently — receptionists in noisy environments missed the
    // toast and assumed the form was broken. Now we ALSO set inline
    // `fieldErrors` keyed to the same `[data-testid="error-lab-*"]` elements
    // already present in the form, so the user sees a per-field error in
    // the modal itself and the toast is just a secondary confirmation.
    const localErrors: FieldErrorMap = {};
    if (!selectedPatient) localErrors.patientId = t("dashboard.lab.error.selectPatient");
    if (selectedTests.length === 0)
      localErrors.testIds = t("dashboard.lab.error.selectTest");
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      toast.error(
        Object.values(localErrors)[0] || t("dashboard.lab.error.fixHighlighted")
      );
      return;
    }
    setFieldErrors({});
    try {
      await api.post("/lab/orders", {
        patientId: selectedPatient!.id,
        testIds: selectedTests,
        notes: notes || undefined,
        priority,
      });
      onSaved();
      onClose();
    } catch (err) {
      // Issue #223: prefer per-field messages from `error.payload.details[]`
      // over the generic "Validation failed" fallback. The toast still fires
      // (with the first message) so the user is alerted, and the inline
      // hints remain in place under the failing inputs.
      const fields = extractFieldErrors(err);
      if (fields) {
        setFieldErrors(fields);
        toast.error(Object.values(fields)[0] || t("dashboard.lab.error.fixHighlighted"));
        return;
      }
      toast.error(err instanceof Error ? err.message : t("dashboard.lab.error.createOrderFailed"));
    }
  }

  const grouped = tests.reduce(
    (acc, t) => {
      const cat = t.category || t("dashboard.lab.category.other");
      (acc[cat] ||= []).push(t);
      return acc;
    },
    {} as Record<string, LabTest[]>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="lab-new-order-modal"
    >
      <form
        onSubmit={submit}
        noValidate
        className="w-full max-h-[90vh] overflow-y-auto max-w-2xl rounded-2xl bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100"
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t("dashboard.lab.newLabOrder")}
          </h2>
          {/* Pearl §2.1.3 — Back to Consult chip, shown only when
              the modal was opened from the consult page's Flask
              icon. One-click return to the SOAP draft. */}
          {consultBackAppointmentId && (
            <Link
              href={`/dashboard/consult/${consultBackAppointmentId}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition hover:border-primary hover:text-primary dark:border-gray-700 dark:text-gray-300"
            >
              {t("dashboard.lab.backToConsult")}
            </Link>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="lab-patient-search" className="mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100">
              {t("dashboard.lab.col.patient")}
            </label>
            {selectedPatient ? (
              <div className="flex items-center justify-between rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100">
                <span>
                  <strong>{selectedPatient.user.name}</strong> ·{" "}
                  {selectedPatient.mrNumber}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedPatient(null)}
                  className="text-xs font-medium text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                >
                  {t("dashboard.lab.change")}
                </button>
              </div>
            ) : (
              <>
                <input
                  id="lab-patient-search"
                  placeholder={t("dashboard.lab.searchPatient")}
                  value={patientSearch}
                  onChange={(e) => setPatientSearch(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-400"
                />
                {patientResults.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-gray-300 bg-white shadow-sm dark:border-gray-600 dark:bg-gray-700">
                    {patientResults.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setSelectedPatient(p);
                          setPatientResults([]);
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-600"
                      >
                        <strong>{p.user.name}</strong> · {p.mrNumber}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {fieldErrors.patientId && (
              <p
                data-testid="error-lab-patient"
                className="mt-1 text-xs text-red-700 dark:text-red-400"
              >
                {fieldErrors.patientId}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100">
              {t("dashboard.lab.col.tests")}
            </label>
            {fieldErrors.testIds && (
              <p
                data-testid="error-lab-tests"
                className="mb-1 text-xs text-red-700 dark:text-red-400"
              >
                {fieldErrors.testIds}
              </p>
            )}
            {/* Issue #492: test labels were `text-sm` with no explicit color
                so they inherited the form's default ~`text-gray-600`-ish hue
                which fell below WCAG 2.1 AA (4.5:1) on the white modal
                surface. Promote labels to `text-gray-900 dark:text-gray-100`
                (~16:1 / ~14:1) so every test label and category header is
                solidly readable in both modes. */}
            <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-300 p-3 dark:border-gray-600">
              {Object.keys(grouped).length === 0 ? (
                <p className="text-sm text-gray-700 dark:text-gray-300">{t("dashboard.lab.loadingTests")}</p>
              ) : (
                Object.entries(grouped).map(([cat, list]) => (
                  <div key={cat} className="mb-3">
                    <h4
                      data-testid="lab-order-category-header"
                      className="mb-1 text-xs font-semibold uppercase text-gray-700 dark:text-gray-200"
                    >
                      {cat}
                    </h4>
                    <div className="grid grid-cols-2 gap-1">
                      {list.map((t) => (
                        <label
                          key={t.id}
                          data-testid="lab-order-test-label"
                          className="flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100"
                        >
                          <input
                            type="checkbox"
                            checked={selectedTests.includes(t.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedTests([...selectedTests, t.id]);
                              } else {
                                setSelectedTests(
                                  selectedTests.filter((id) => id !== t.id)
                                );
                              }
                            }}
                          />
                          {t.name}
                        </label>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100">
              {t("dashboard.lab.priority")}
            </label>
            <div className="flex gap-2">
              {(["ROUTINE", "URGENT", "STAT"] as const).map((p) => (
                <label
                  key={p}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                    priority === p
                      ? p === "STAT"
                        ? "border-red-600 bg-red-50 text-red-800 dark:border-red-500 dark:bg-red-900/30 dark:text-red-200"
                        : p === "URGENT"
                        ? "border-orange-500 bg-orange-50 text-orange-800 dark:border-orange-500 dark:bg-orange-900/30 dark:text-orange-200"
                        : "border-primary bg-primary/10 text-primary dark:bg-primary/20"
                      : "border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                  }`}
                >
                  <input
                    type="radio"
                    name="lab-priority"
                    value={p}
                    checked={priority === p}
                    onChange={() => setPriority(p)}
                    className="hidden"
                  />
                  {p}
                </label>
              ))}
            </div>
            {priority === "STAT" && (
              <p className="mt-1 text-xs text-red-700 dark:text-red-400">
                {t("dashboard.lab.statNotify")}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="lab-order-notes"
              className="mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100"
            >
              {t("common.notes")}
            </label>
            <textarea
              id="lab-order-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className={`w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-400 ${
                fieldErrors.notes ? "border-red-500 bg-red-50 dark:bg-red-900/20" : ""
              }`}
            />
            {fieldErrors.notes && (
              <p
                data-testid="error-lab-notes"
                className="mt-1 text-xs text-red-700 dark:text-red-400"
              >
                {fieldErrors.notes}
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {/* Issue #492: bare `border` + no foreground color let the Cancel
              button render in browser default `ButtonText` (~#909090 in some
              themes) — well below AA on white. Pin foreground + paired
              dark-mode classes so it stays readable in both modes. */}
          <button
            type="button"
            onClick={onClose}
            data-testid="lab-order-cancel-btn"
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            {t("dashboard.lab.createOrder")}
          </button>
        </div>
      </form>
    </div>
  );
}
