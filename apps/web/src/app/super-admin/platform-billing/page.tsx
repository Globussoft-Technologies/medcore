// Operator platform-billing landing — Pearl ERP Stage 1 §8.3
// (gap rows 215-218 closure piece 3-UI, 2026-05-25; extended with
// plan-change UI + KPI tiles + breadcrumb 2026-05-28).
//
// Lives under /dashboard/platform-billing so the operator stays inside
// the regular dashboard shell (sidebar, search, language picker, dark
// mode) instead of jumping into a separate /super-admin chrome. The
// dashboard layout gates the route via SUPER_ADMIN_ONLY_ROUTES —
// tenant ADMINs never see it in the sidebar and a direct hit returns
// the layout's not-authorized redirect. The API enforces the same
// gate independently. Reached from a "Platform Billing" button on
// /dashboard/tenants (next to "Create Tenant").
//   - Subscriptions: cross-tenant TenantSubscription list with inline
//     plan-change controls (calls POST /subscriptions/:id/change-plan
//     which writes a proration line item via applyProration()).
//   - Invoices: cross-tenant PlatformInvoice list, default filtered to
//     ISSUED (the un-paid work queue). Each row has a "Mark Paid"
//     button (status === ISSUED) opening a modal that prompts for
//     `paymentReference` then calls POST /invoices/:id/mark-paid.
//
// API backing: /api/v1/platform-billing/{subscriptions, invoices,
// invoices/:id, invoices/:id/mark-paid, subscriptions/:id/change-plan,
// subscriptions/:id/cancel, subscriptions/:id/reactivate, usage} —
// gated PLATFORM_OPERATOR + PLATFORM_BILLING_OPERATOR (+ SUPER_ADMIN
// for the read-only path). The dashboard layout's SUPER_ADMIN_ONLY_ROUTES
// filter keeps this nav entry off the sidebar for tenant ADMINs.
//
// Mobile-first: every chip + CTA `h-11` (44px) per Pearl §6.2 touch-target rule.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { csrfFetch } from "@/lib/csrf-fetch";
import { toast } from "@/lib/toast";
import {
  AlertCircle,
  Bell,
  Building2,
  CheckCircle2,
  ChevronLeft,
  Clock,
  CreditCard,
  Eye,
  FileText,
  Globe,
  IndianRupee,
  Layers,
  Loader2,
  MoreVertical,
  Pencil,
  Percent,
  Plus,
  Printer,
  Trash2,
  XCircle,
  type LucideIcon,
} from "lucide-react";

type SubscriptionStatus =
  | "trial"
  | "active"
  | "past_due"
  | "suspended"
  | "cancelled";

interface SubscriptionRow {
  id: string;
  tenantId: string;
  // Dynamic `PlatformPlan.key` (STARTER/GROWTH/ENTERPRISE or a custom slug).
  plan: string;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  customPriceMonthlyInPaise: number | null;
  razorpaySubscriptionId: string | null;
  pastDueSince: string | null;
  cancelledAt: string | null;
  createdAt: string;
  tenant: {
    id: string;
    name: string;
    subdomain: string;
    active: boolean;
  } | null;
}

type InvoiceStatus = "DRAFT" | "ISSUED" | "PAID" | "VOID";

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  subtotalInPaise: number;
  cgstInPaise: number;
  sgstInPaise: number;
  igstInPaise: number;
  totalInPaise: number;
  status: InvoiceStatus;
  issuedAt: string | null;
  paidAt: string | null;
  paymentReference: string | null;
  createdAt: string;
  tenant: { id: string; name: string; subdomain: string } | null;
}

// Pearl §8.3 — a dynamic plan-catalog tier (`PlatformPlan`).
interface PlanRow {
  id: string;
  key: string;
  name: string;
  monthlyPriceInPaise: number;
  includedFeatures: string[];
  active: boolean;
  sortOrder: number;
}

interface SubsResponse {
  success: boolean;
  data: { subscriptions: SubscriptionRow[] };
  error: string | null;
}
interface PlansResponse {
  success: boolean;
  data: PlanRow[];
  error: string | null;
}
interface InvoicesResponse {
  success: boolean;
  data: { invoices: InvoiceRow[] };
  error: string | null;
}
interface MarkPaidResponse {
  success: boolean;
  data: {
    transition: "PAID" | "ALREADY_PAID";
    invoice: { id: string; status: string; paymentReference: string | null };
  } | null;
  error: string | null;
}

type Tab = "subscriptions" | "invoices" | "plans";
type InvoiceFilter = "ISSUED" | "PAID" | "all";

const INVOICE_FILTER_CHIPS: Array<{ key: InvoiceFilter; label: string }> = [
  { key: "ISSUED", label: "Unpaid" },
  { key: "PAID", label: "Paid" },
  { key: "all", label: "All" },
];

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

function subscriptionStatusBadge(s: SubscriptionStatus): {
  cls: string;
  Icon: typeof Clock;
  label: string;
} {
  switch (s) {
    case "trial":
      return { cls: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300", Icon: Clock, label: "Trial" };
    case "active":
      return { cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300", Icon: CheckCircle2, label: "Active" };
    case "past_due":
      return { cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300", Icon: AlertCircle, label: "Past due" };
    case "suspended":
      return { cls: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300", Icon: XCircle, label: "Suspended" };
    case "cancelled":
      return { cls: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300", Icon: XCircle, label: "Cancelled" };
    default:
      return { cls: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300", Icon: Clock, label: s };
  }
}

function invoiceStatusBadge(
  s: InvoiceStatus,
  periodEnd?: string,
): {
  cls: string;
  Icon: typeof Clock;
  label: string;
} {
  // An unpaid (ISSUED) invoice whose billing period has already ended is past
  // due. Derived from the stored `periodEnd` — no separate persisted flag is
  // needed since the date already lives on the row.
  if (
    s === "ISSUED" &&
    periodEnd &&
    new Date(periodEnd).getTime() < Date.now()
  ) {
    return {
      cls: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300",
      Icon: AlertCircle,
      label: "Past due",
    };
  }
  switch (s) {
    case "DRAFT":
      return { cls: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300", Icon: FileText, label: "Draft" };
    case "ISSUED":
      return { cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300", Icon: Clock, label: "Issued (unpaid)" };
    case "PAID":
      return { cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300", Icon: CheckCircle2, label: "Paid" };
    case "VOID":
      return { cls: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300", Icon: XCircle, label: "Void" };
    default:
      return { cls: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300", Icon: FileText, label: s };
  }
}

export default function PlatformBillingPage() {
  // Pearl §8.3 — show the "Tenants / Platform Billing" breadcrumb only
  // when the operator arrived via the Platform-Billing button on the
  // Tenants page (which appends `?from=tenants`). Sidebar / direct-URL
  // hits get no breadcrumb so the page header doesn't suggest a back
  // navigation that wasn't part of the user's flow.
  const searchParams = useSearchParams();
  const cameFromTenants = searchParams?.get("from") === "tenants";

  const [tab, setTab] = useState<Tab>("subscriptions");
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceFilter>("ISSUED");

  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Unpaid total (paise) for the "Unpaid (₹)" KPI — sourced from the
  // ISSUED invoices independently of the active tab / invoice filter so the
  // tile is correct everywhere (the per-tab list alone left it at 0 on the
  // Subscriptions tab).
  const [unpaidTotalPaise, setUnpaidTotalPaise] = useState(0);

  // Modal state for the Mark-Paid action.
  const [markPaidForId, setMarkPaidForId] = useState<string | null>(null);
  const [markPaidRef, setMarkPaidRef] = useState("");
  const [markPaidBusy, setMarkPaidBusy] = useState(false);
  const [markPaidError, setMarkPaidError] = useState<string | null>(null);

  // Pearl §8.3 — per-row action menu (kebab dropdown). Tracks which
  // invoice row currently has its menu open; `null` when closed. Click-
  // outside closes via the backdrop overlay rendered alongside the menu.
  // `actionMenuFlipAbove` keeps the menu visible on bottom rows by
  // flipping it above the trigger when there isn't enough room below.
  const [actionMenuFor, setActionMenuFor] = useState<string | null>(null);
  const [actionMenuFlipAbove, setActionMenuFlipAbove] = useState(false);
  const [reminderBusyFor, setReminderBusyFor] = useState<string | null>(null);

  // Approximate menu height — large enough that we won't open below
  // when the trigger is within this many pixels of the viewport bottom.
  // Five menu items × ~36px each + container padding.
  const ACTION_MENU_HEIGHT_EST = 220;

  function toggleActionMenu(
    invoiceId: string,
    triggerEl: HTMLButtonElement | null,
  ): void {
    setActionMenuFor((cur) => {
      if (cur === invoiceId) return null;
      if (triggerEl && typeof window !== "undefined") {
        const rect = triggerEl.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        setActionMenuFlipAbove(spaceBelow < ACTION_MENU_HEIGHT_EST);
      } else {
        setActionMenuFlipAbove(false);
      }
      return invoiceId;
    });
  }

  // Apply-Discount modal state (mirrors the patient-billing pattern in
  // /dashboard/billing). Operator enters an amount in ₹ + a reason; the
  // backend writes a negative-amount PlatformInvoiceLineItem so the
  // invoice subtotal/GST recompute on the next read.
  const [discountFor, setDiscountFor] = useState<InvoiceRow | null>(null);
  const [discountRupees, setDiscountRupees] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [discountBusy, setDiscountBusy] = useState(false);
  const [discountError, setDiscountError] = useState<string | null>(null);

  // Modal state for the Change-Plan action (Pearl §8.3 piece 3d).
  const [planChangeFor, setPlanChangeFor] = useState<SubscriptionRow | null>(
    null,
  );
  const [planChangeTo, setPlanChangeTo] = useState<string>("");
  const [planChangeBusy, setPlanChangeBusy] = useState(false);
  const [planChangeError, setPlanChangeError] = useState<string | null>(null);

  // Dynamic plan catalog (Pearl §8.3) — drives the Amount column, the
  // change-plan dropdown, and the Plans management tab.
  const [plans, setPlans] = useState<PlanRow[]>([]);
  // Plans-management modal: null = closed, "new" = add, PlanRow = edit.
  const [planEditing, setPlanEditing] = useState<PlanRow | "new" | null>(null);
  const [planFormName, setPlanFormName] = useState("");
  // Price is entered in INR as two fields: whole rupees + paise (00-99).
  const [planFormRupees, setPlanFormRupees] = useState("");
  const [planFormPaise, setPlanFormPaise] = useState("");
  // Features are entered as individual rows (add / remove); empty rows are
  // dropped on submit.
  const [planFormFeatures, setPlanFormFeatures] = useState<string[]>([""]);
  const [planFormSortOrder, setPlanFormSortOrder] = useState("0");
  const [planFormActive, setPlanFormActive] = useState(true);
  const [planFormBusy, setPlanFormBusy] = useState(false);
  const [planFormError, setPlanFormError] = useState<string | null>(null);
  const [planDeleteBusyId, setPlanDeleteBusyId] = useState<string | null>(null);
  // Read-only "view all features" popup for a plan row.
  const [planFeaturesView, setPlanFeaturesView] = useState<PlanRow | null>(null);
  // Plan pending deletion — drives the confirm-delete modal.
  const [planPendingDelete, setPlanPendingDelete] = useState<PlanRow | null>(
    null,
  );

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/platform-billing/subscriptions", {
        credentials: "include",
      });
      const body = (await res.json()) as SubsResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setSubscriptions(body.data.subscriptions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchInvoices = useCallback(async (status: InvoiceFilter) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ status });
      const res = await fetch(
        `/api/v1/platform-billing/invoices?${qs.toString()}`,
        { credentials: "include" },
      );
      const body = (await res.json()) as InvoicesResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setInvoices(body.data.invoices);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "subscriptions") {
      void fetchSubscriptions();
    } else if (tab === "invoices") {
      void fetchInvoices(invoiceFilter);
    }
    // tab === "plans" uses the mount-loaded catalog; no per-tab fetch needed.
  }, [tab, invoiceFilter, fetchSubscriptions, fetchInvoices]);

  // The summary tiles span BOTH subscriptions and invoices, but each tab only
  // loads its own list — so e.g. "Unpaid (₹)" read 0 on the Subscriptions
  // tab. Load the KPI inputs (subscriptions + the unpaid/ISSUED invoice
  // total) independently so all four tiles are correct on every tab.
  const loadKpis = useCallback(async () => {
    try {
      const subsRes = await fetch(
        "/api/v1/platform-billing/subscriptions",
        { credentials: "include" },
      );
      const subsBody = (await subsRes.json()) as SubsResponse;
      if (subsRes.ok && subsBody.success) {
        setSubscriptions(subsBody.data.subscriptions);
      }
      const invRes = await fetch(
        "/api/v1/platform-billing/invoices?status=ISSUED",
        { credentials: "include" },
      );
      const invBody = (await invRes.json()) as InvoicesResponse;
      if (invRes.ok && invBody.success) {
        setUnpaidTotalPaise(
          invBody.data.invoices.reduce(
            (s, i) => s + Math.abs(i.totalInPaise),
            0,
          ),
        );
      }
    } catch {
      /* KPI tiles degrade silently rather than blocking the page */
    }
  }, []);

  useEffect(() => {
    void loadKpis();
  }, [loadKpis]);

  // Pearl §8.3 — load the dynamic plan catalog once on mount (and after any
  // plan mutation). All tiers, including inactive, so the Plans tab can show
  // and reactivate retired ones.
  const fetchPlans = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/platform-billing/plans", {
        credentials: "include",
      });
      const body = (await res.json()) as PlansResponse;
      if (res.ok && body.success) {
        setPlans(body.data);
      }
    } catch {
      /* plan catalog degrades silently — the amount column falls back to — */
    }
  }, []);

  useEffect(() => {
    void fetchPlans();
  }, [fetchPlans]);

  // key → plan lookup for the Amount column + change-plan labels.
  const planByKey = useMemo(() => {
    const m = new Map<string, PlanRow>();
    for (const p of plans) m.set(p.key, p);
    return m;
  }, [plans]);

  // Active tiers only, sorted — for the create/change dropdowns.
  const activePlans = useMemo(
    () =>
      [...plans]
        .filter((p) => p.active)
        .sort(
          (a, b) =>
            a.sortOrder - b.sortOrder ||
            a.monthlyPriceInPaise - b.monthlyPriceInPaise,
        ),
    [plans],
  );

  // Resolve the effective monthly price for a subscription: a bespoke
  // custom price overrides the tier's catalog price.
  function subscriptionMonthlyPaise(s: SubscriptionRow): number | null {
    if (s.customPriceMonthlyInPaise != null) return s.customPriceMonthlyInPaise;
    const p = planByKey.get(s.plan);
    return p ? p.monthlyPriceInPaise : null;
  }

  const openInvoiceCount = useMemo(
    () => invoices.filter((i) => i.status === "ISSUED").length,
    [invoices],
  );

  function openMarkPaid(invoiceId: string): void {
    setMarkPaidForId(invoiceId);
    setMarkPaidRef("");
    setMarkPaidError(null);
  }

  function closeMarkPaid(): void {
    if (markPaidBusy) return;
    setMarkPaidForId(null);
    setMarkPaidRef("");
    setMarkPaidError(null);
  }

  // Pearl §8.3 piece 3d — change-plan modal handlers.
  function openPlanChange(sub: SubscriptionRow): void {
    setPlanChangeFor(sub);
    setPlanChangeTo(sub.plan);
    setPlanChangeError(null);
  }
  function closePlanChange(): void {
    if (planChangeBusy) return;
    setPlanChangeFor(null);
    setPlanChangeError(null);
  }
  async function submitPlanChange(): Promise<void> {
    if (!planChangeFor) return;
    if (planChangeTo === planChangeFor.plan) {
      setPlanChangeError("Pick a different plan to switch to.");
      return;
    }
    setPlanChangeBusy(true);
    setPlanChangeError(null);
    try {
      const res = await csrfFetch(
        `/api/v1/platform-billing/subscriptions/${planChangeFor.id}/change-plan`,
        {
          method: "POST",
          body: JSON.stringify({ plan: planChangeTo }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success: boolean;
        error: string | null;
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      await fetchSubscriptions();
      // Also refresh invoices since proration may have produced a row.
      await fetchInvoices(invoiceFilter);
      void loadKpis();
      setPlanChangeFor(null);
    } catch (err) {
      setPlanChangeError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanChangeBusy(false);
    }
  }

  // Pearl §8.3 — Plans management (add / edit / deactivate / delete).
  // The plan KEY is no longer entered by hand — it is derived from the
  // display name (uppercased, non-alphanumerics → underscore) and made
  // unique against the existing catalog. Only the main super admin can add
  // or manage plans (enforced server-side).
  function deriveUniquePlanKey(name: string): string {
    let base = name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (base.length < 2) base = `PLAN_${base}`.slice(0, 40);
    const taken = new Set(plans.map((p) => p.key));
    if (!taken.has(base)) return base;
    let n = 2;
    let candidate = `${base}_${n}`.slice(0, 40);
    while (taken.has(candidate)) {
      n += 1;
      candidate = `${base}_${n}`.slice(0, 40);
    }
    return candidate;
  }
  function openPlanCreate(): void {
    setPlanEditing("new");
    setPlanFormName("");
    setPlanFormRupees("");
    setPlanFormPaise("");
    setPlanFormFeatures([""]);
    setPlanFormSortOrder(String(plans.length + 1));
    setPlanFormActive(true);
    setPlanFormError(null);
  }
  function openPlanEdit(p: PlanRow): void {
    setPlanEditing(p);
    setPlanFormName(p.name);
    setPlanFormRupees(String(Math.floor(p.monthlyPriceInPaise / 100)));
    setPlanFormPaise(
      String(p.monthlyPriceInPaise % 100).padStart(2, "0"),
    );
    setPlanFormFeatures(
      p.includedFeatures.length > 0 ? [...p.includedFeatures] : [""],
    );
    setPlanFormSortOrder(String(p.sortOrder));
    setPlanFormActive(p.active);
    setPlanFormError(null);
  }
  function closePlanForm(): void {
    if (planFormBusy) return;
    setPlanEditing(null);
    setPlanFormError(null);
  }
  // Feature-row helpers (dynamic add/remove rows).
  function addFeatureRow(): void {
    setPlanFormFeatures((rows) => [...rows, ""]);
  }
  function updateFeatureRow(i: number, value: string): void {
    setPlanFormFeatures((rows) => rows.map((r, idx) => (idx === i ? value : r)));
  }
  function removeFeatureRow(i: number): void {
    setPlanFormFeatures((rows) => {
      const next = rows.filter((_, idx) => idx !== i);
      return next.length > 0 ? next : [""];
    });
  }
  async function submitPlanForm(): Promise<void> {
    if (planEditing == null) return;
    const name = planFormName.trim();
    if (name.length < 2) {
      setPlanFormError("Enter a plan name (at least 2 characters).");
      return;
    }
    const rupees = Number(planFormRupees);
    if (!Number.isInteger(rupees) || rupees < 0) {
      setPlanFormError("Enter a valid whole-rupee amount (0 or more).");
      return;
    }
    const paiseStr = planFormPaise.trim();
    const paise = paiseStr === "" ? 0 : Number(paiseStr);
    if (!Number.isInteger(paise) || paise < 0 || paise > 99) {
      setPlanFormError("Paise must be a whole number between 0 and 99.");
      return;
    }
    const monthlyPriceInPaise = rupees * 100 + paise;
    const includedFeatures = planFormFeatures
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const sortOrder = Number(planFormSortOrder);
    setPlanFormBusy(true);
    setPlanFormError(null);
    try {
      const isNew = planEditing === "new";
      const res = await csrfFetch(
        isNew
          ? "/api/v1/platform-billing/plans"
          : `/api/v1/platform-billing/plans/${planEditing.id}`,
        {
          method: isNew ? "POST" : "PATCH",
          body: JSON.stringify(
            isNew
              ? {
                  // Key auto-derived from the name (no manual entry).
                  key: deriveUniquePlanKey(name),
                  name,
                  monthlyPriceInPaise,
                  includedFeatures,
                  sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
                }
              : {
                  name,
                  monthlyPriceInPaise,
                  includedFeatures,
                  active: planFormActive,
                  sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
                },
          ),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success: boolean;
        error: string | null;
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      await fetchPlans();
      setPlanEditing(null);
    } catch (err) {
      setPlanFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanFormBusy(false);
    }
  }
  // Delete is confirmed via an in-app modal (setPlanPendingDelete) rather than
  // the browser's native confirm dialog.
  async function confirmDeletePlan(): Promise<void> {
    const p = planPendingDelete;
    if (!p) return;
    setPlanDeleteBusyId(p.id);
    try {
      const res = await csrfFetch(
        `/api/v1/platform-billing/plans/${p.id}`,
        { method: "DELETE" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success: boolean;
        error: string | null;
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      await fetchPlans();
      setPlanPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPlanPendingDelete(null);
    } finally {
      setPlanDeleteBusyId(null);
    }
  }
  async function togglePlanActive(p: PlanRow): Promise<void> {
    setPlanDeleteBusyId(p.id);
    try {
      const res = await csrfFetch(
        `/api/v1/platform-billing/plans/${p.id}`,
        { method: "PATCH", body: JSON.stringify({ active: !p.active }) },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success: boolean;
        error: string | null;
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      await fetchPlans();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanDeleteBusyId(null);
    }
  }

  // Pearl §8.3 — manual reminder. Re-emails an ISSUED PlatformInvoice
  // to the tenant's billing contact by calling the dedicated server
  // endpoint (POST /platform-billing/invoices/:id/send-reminder). The
  // backend reuses the same per-invoice renderer the monthly cron uses,
  // and writes a PLATFORM_INVOICE_REMINDER_SENT audit row so the trail
  // distinguishes operator-initiated reminders from scheduled sends.
  // Apply-discount handlers (Pearl §8.3 — operator concession).
  function openDiscount(inv: InvoiceRow): void {
    setDiscountFor(inv);
    setDiscountRupees("");
    setDiscountReason("");
    setDiscountError(null);
  }
  function closeDiscount(): void {
    if (discountBusy) return;
    setDiscountFor(null);
    setDiscountError(null);
  }
  async function submitDiscount(): Promise<void> {
    if (!discountFor) return;
    const rupees = Number(discountRupees);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setDiscountError("Enter a positive discount amount in ₹.");
      return;
    }
    const paise = Math.round(rupees * 100);
    if (paise >= discountFor.totalInPaise) {
      setDiscountError(
        "Discount cannot equal or exceed the invoice total. Mark Paid instead.",
      );
      return;
    }
    const reason = discountReason.trim();
    if (reason.length < 3) {
      setDiscountError("Reason is required (3-200 characters).");
      return;
    }
    setDiscountBusy(true);
    setDiscountError(null);
    try {
      const res = await csrfFetch(
        `/api/v1/platform-billing/invoices/${discountFor.id}/apply-discount`,
        {
          method: "POST",
          body: JSON.stringify({ amountInPaise: paise, reason }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success: boolean;
        error: string | null;
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      await fetchInvoices(invoiceFilter);
      void loadKpis();
      setDiscountFor(null);
    } catch (err) {
      setDiscountError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscountBusy(false);
    }
  }

  async function sendReminder(invoiceId: string): Promise<void> {
    if (reminderBusyFor) return;
    setReminderBusyFor(invoiceId);
    try {
      const res = await csrfFetch(
        `/api/v1/platform-billing/invoices/${invoiceId}/send-reminder`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success: boolean;
        error: string | null;
        data?: { sent: boolean; to: string | null };
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const dest = body.data?.to ?? "the tenant billing contact";
      toast.success(`Reminder sent to ${dest}.`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to send reminder";
      // Special-case the "no billing contact" 412 with a CTA to the
      // tenant drawer so the operator can fix it inline.
      if (/billing contact/i.test(message)) {
        toast.error(
          `${message} — open the tenant in the Tenants page to set it.`,
          8000,
        );
      } else {
        toast.error(message);
      }
    } finally {
      setReminderBusyFor(null);
    }
  }

  async function submitMarkPaid(): Promise<void> {
    if (!markPaidForId) return;
    const ref = markPaidRef.trim();
    if (ref.length === 0) {
      setMarkPaidError("Enter a payment reference (bank ref / Razorpay payment id)");
      return;
    }
    setMarkPaidBusy(true);
    setMarkPaidError(null);
    try {
      const res = await csrfFetch(
        `/api/v1/platform-billing/invoices/${markPaidForId}/mark-paid`,
        {
          method: "POST",
          body: JSON.stringify({ paymentReference: ref }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as MarkPaidResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      // Refresh the invoice list with the same filter.
      await fetchInvoices(invoiceFilter);
      void loadKpis();
      setMarkPaidForId(null);
      setMarkPaidRef("");
    } catch (err) {
      setMarkPaidError(err instanceof Error ? err.message : String(err));
    } finally {
      setMarkPaidBusy(false);
    }
  }

  // Subscription KPI counts from the loaded subscription list; the unpaid
  // total comes from `unpaidTotalPaise` (loaded by loadKpis) so it's correct
  // regardless of the active tab / invoice filter.
  const totalTrial = subscriptions.filter((s) => s.status === "trial").length;
  const totalPastDue = subscriptions.filter(
    (s) => s.status === "past_due",
  ).length;
  const totalActive = subscriptions.filter(
    (s) => s.status === "active",
  ).length;

  return (
    <section
      data-testid="platform-billing-page"
      className="space-y-6 py-4"
    >
      {/* Breadcrumb back to /dashboard/tenants — shown ONLY when the
          operator arrived from the Tenants page via the
          "Platform Billing" button (which sets `?from=tenants`).
          Sidebar navigation and direct URL hits don't render it; the
          sidebar already provides a stable Tenants entry, so a
          back-link in those cases would imply a navigation the user
          didn't take. */}
      {cameFromTenants ? (
        <nav aria-label="Breadcrumb">
          <Link
            href="/dashboard/tenants"
            data-testid="platform-billing-back-to-tenants"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-gray-800 dark:hover:text-slate-100"
          >
            <ChevronLeft size={14} aria-hidden="true" />
            Back to Tenants
          </Link>
        </nav>
      ) : null}

      {/* Hero card — tinted header that matches the dashboard's hero
          pattern (Tenants page, Users page). Icon + title + helper text. */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-primary/5 via-white to-white p-5 shadow-sm dark:border-gray-700 dark:from-primary/10 dark:via-gray-800 dark:to-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary dark:bg-primary/20">
              <IndianRupee size={20} />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                Platform Billing
              </h1>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                Track every hospital&rsquo;s subscription, send the monthly
                invoice and record payment — all in one place.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* KPI tiles — at-a-glance state of the platform billing queue */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Active subs"
          value={totalActive}
          tone="emerald"
          Icon={CheckCircle2}
        />
        <KpiTile
          label="On trial"
          value={totalTrial}
          tone="sky"
          Icon={Clock}
        />
        <KpiTile
          label="Past due"
          value={totalPastDue}
          tone="amber"
          Icon={AlertCircle}
        />
        <KpiTile
          label="Unpaid (₹)"
          value={(unpaidTotalPaise / 100).toLocaleString("en-IN", {
            maximumFractionDigits: 0,
          })}
          tone="rose"
          Icon={IndianRupee}
        />
      </div>

      {/* Tab row */}
      <div
        className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-gray-700"
        role="tablist"
        data-testid="platform-billing-tabs"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "subscriptions"}
          data-testid="platform-billing-tab-subscriptions"
          onClick={() => setTab("subscriptions")}
          className={`-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 ${
            tab === "subscriptions"
              ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
              : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          <Building2 size={14} aria-hidden="true" />
          Subscriptions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "invoices"}
          data-testid="platform-billing-tab-invoices"
          onClick={() => setTab("invoices")}
          className={`-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 ${
            tab === "invoices"
              ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
              : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          <CreditCard size={14} aria-hidden="true" />
          Invoices
          {tab === "invoices" && openInvoiceCount > 0 ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              {openInvoiceCount}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "plans"}
          data-testid="platform-billing-tab-plans"
          onClick={() => setTab("plans")}
          className={`-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 ${
            tab === "plans"
              ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
              : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          <Layers size={14} aria-hidden="true" />
          Plans
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          data-testid="platform-billing-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <div
          className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400"
          data-testid="platform-billing-loading"
        >
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          Loading…
        </div>
      ) : null}

      {/* SUBSCRIPTIONS TAB */}
      {tab === "subscriptions" ? (
        <div
          className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
          data-testid="platform-billing-subscriptions-table-wrapper"
        >
          <table
            className="w-full min-w-[820px] text-left text-sm"
            data-testid="platform-billing-subscriptions-table"
          >
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-slate-400">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Tenant</th>
                <th scope="col" className="px-4 py-3 font-medium">Plan</th>
                <th scope="col" className="px-4 py-3 font-medium">Amount</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Trial end</th>
                <th scope="col" className="px-4 py-3 font-medium">Period start</th>
                <th scope="col" className="px-4 py-3 font-medium">Period end</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-gray-700">
              {subscriptions.length === 0 && !loading ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400"
                    data-testid="platform-billing-subscriptions-empty"
                  >
                    No subscriptions yet.
                  </td>
                </tr>
              ) : null}
              {subscriptions.map((s) => {
                const badge = subscriptionStatusBadge(s.status);
                const canChange =
                  s.status !== "cancelled" && s.status !== "suspended";
                const monthlyPaise = subscriptionMonthlyPaise(s);
                const planName = planByKey.get(s.plan)?.name ?? s.plan;
                return (
                  <tr
                    key={s.id}
                    data-testid={`platform-billing-subscription-row-${s.id}`}
                  >
                    <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                      <div className="flex flex-col">
                        <span>{s.tenant?.name ?? "(unknown tenant)"}</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {s.tenant?.subdomain ?? "—"}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{planName}</td>
                    <td
                      className="px-4 py-3 text-slate-700 dark:text-slate-300"
                      data-testid={`platform-billing-subscription-amount-${s.id}`}
                    >
                      {monthlyPaise != null ? (
                        <span className="inline-flex items-center gap-1">
                          {formatRupees(monthlyPaise)}/mo
                          {s.customPriceMonthlyInPaise != null ? (
                            <span
                              className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                              title="Custom negotiated price overriding the tier default"
                            >
                              custom
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                        data-testid={`platform-billing-subscription-status-${s.id}`}
                      >
                        <badge.Icon size={12} aria-hidden="true" />
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                      {formatDate(s.trialEndsAt)}
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                      {formatDate(s.currentPeriodStart)}
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                      {formatDate(s.currentPeriodEnd)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canChange ? (
                        <button
                          type="button"
                          onClick={() => openPlanChange(s)}
                          data-testid={`platform-billing-change-plan-${s.id}`}
                          className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:bg-gray-700"
                        >
                          Change plan
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* INVOICES TAB */}
      {tab === "invoices" ? (
        <>
          {/* Compact segmented control — three filter pills sharing
              one rounded container. Sized like a normal form input
              rather than a CTA. */}
          <div
            role="tablist"
            aria-label="Invoice filter"
            className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-gray-700 dark:bg-gray-800"
            data-testid="platform-billing-invoice-filters"
          >
            {INVOICE_FILTER_CHIPS.map((chip) => {
              const active = invoiceFilter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`platform-billing-invoice-filter-${chip.key}`}
                  onClick={() => setInvoiceFilter(chip.key)}
                  className={`inline-flex h-8 min-w-[88px] items-center justify-center rounded px-3.5 text-[13px] font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 ${
                    active
                      ? "bg-white text-slate-900 shadow-sm dark:bg-gray-700 dark:text-slate-100"
                      : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                  }`}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>

          <div
            className="rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
            data-testid="platform-billing-invoices-table-wrapper"
          >
            <table
              className="min-w-full text-left text-sm"
              data-testid="platform-billing-invoices-table"
            >
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-slate-400">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Invoice #</th>
                  <th scope="col" className="px-4 py-3 font-medium">Tenant</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Amount</th>
                  <th scope="col" className="px-4 py-3 font-medium">Issued</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-700">
                {invoices.length === 0 && !loading ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400"
                      data-testid="platform-billing-invoices-empty"
                    >
                      No invoices match this filter.
                    </td>
                  </tr>
                ) : null}
                {invoices.map((inv) => {
                  const badge = invoiceStatusBadge(inv.status, inv.periodEnd);
                  return (
                    <tr
                      key={inv.id}
                      data-testid={`platform-billing-invoice-row-${inv.id}`}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-300">
                        <Link
                          href={`/dashboard/platform-billing/invoices/${inv.id}`}
                          className="text-slate-900 underline-offset-2 hover:underline dark:text-slate-100"
                          data-testid={`platform-billing-invoice-link-${inv.id}`}
                        >
                          {inv.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                        <div className="flex flex-col">
                          <span>{inv.tenant?.name ?? "(unknown)"}</span>
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {inv.tenant?.subdomain ?? "—"}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          <IndianRupee size={12} aria-hidden="true" />
                          {formatRupees(Math.abs(inv.totalInPaise)).replace(
                            "₹",
                            "",
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                        {formatDate(inv.issuedAt ?? inv.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                        >
                          <badge.Icon size={12} aria-hidden="true" />
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="relative inline-block text-left">
                          <button
                            type="button"
                            data-testid={`platform-billing-actions-${inv.id}`}
                            aria-haspopup="menu"
                            aria-expanded={actionMenuFor === inv.id}
                            aria-label="Invoice actions"
                            onClick={(e) =>
                              toggleActionMenu(inv.id, e.currentTarget)
                            }
                            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-300 dark:hover:bg-gray-700 dark:hover:text-slate-100"
                          >
                            <MoreVertical size={16} aria-hidden="true" />
                          </button>
                          {actionMenuFor === inv.id ? (
                            <>
                              {/* Click-outside overlay */}
                              <button
                                type="button"
                                aria-hidden="true"
                                tabIndex={-1}
                                className="fixed inset-0 z-30 cursor-default"
                                onClick={() => setActionMenuFor(null)}
                              />
                              <div
                                role="menu"
                                data-testid={`platform-billing-actions-menu-${inv.id}`}
                                className={`absolute right-0 z-40 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white text-left shadow-lg dark:border-gray-700 dark:bg-gray-800 ${
                                  actionMenuFlipAbove
                                    ? "bottom-full mb-1"
                                    : "top-full mt-1"
                                }`}
                              >
                                {inv.status === "ISSUED" ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    data-testid={`platform-billing-action-record-${inv.id}`}
                                    onClick={() => {
                                      setActionMenuFor(null);
                                      openMarkPaid(inv.id);
                                    }}
                                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-gray-700"
                                  >
                                    <CheckCircle2
                                      size={14}
                                      className="text-emerald-600"
                                      aria-hidden="true"
                                    />
                                    Record Payment
                                  </button>
                                ) : null}
                                {inv.status === "ISSUED" ? (
                                  <Link
                                    href={`/dashboard/platform-billing/invoices/${inv.id}?pay=1`}
                                    role="menuitem"
                                    data-testid={`platform-billing-action-payonline-${inv.id}`}
                                    onClick={() => setActionMenuFor(null)}
                                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-gray-700"
                                  >
                                    <Globe
                                      size={14}
                                      className="text-sky-600"
                                      aria-hidden="true"
                                    />
                                    <span>Pay Online</span>
                                    <span className="ml-auto rounded bg-yellow-300 px-1 py-0.5 text-[10px] font-bold text-yellow-900">
                                      TEST
                                    </span>
                                  </Link>
                                ) : null}
                                {inv.status === "ISSUED" ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    data-testid={`platform-billing-action-discount-${inv.id}`}
                                    onClick={() => {
                                      setActionMenuFor(null);
                                      openDiscount(inv);
                                    }}
                                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-gray-700"
                                  >
                                    <Percent
                                      size={14}
                                      className="text-violet-600"
                                      aria-hidden="true"
                                    />
                                    Apply Discount
                                  </button>
                                ) : null}
                                <Link
                                  href={`/dashboard/platform-billing/invoices/${inv.id}?print=1`}
                                  role="menuitem"
                                  data-testid={`platform-billing-action-print-${inv.id}`}
                                  onClick={() => setActionMenuFor(null)}
                                  className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                                >
                                  <Printer
                                    size={14}
                                    className="text-slate-500"
                                    aria-hidden="true"
                                  />
                                  Print Invoice
                                </Link>
                                {inv.status === "ISSUED" ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    data-testid={`platform-billing-action-reminder-${inv.id}`}
                                    disabled={reminderBusyFor === inv.id}
                                    onClick={() => {
                                      setActionMenuFor(null);
                                      void sendReminder(inv.id);
                                    }}
                                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60 dark:text-slate-200 dark:hover:bg-gray-700"
                                  >
                                    <Bell
                                      size={14}
                                      className="text-amber-600"
                                      aria-hidden="true"
                                    />
                                    {reminderBusyFor === inv.id
                                      ? "Sending…"
                                      : "Send Reminder"}
                                  </button>
                                ) : null}
                              </div>
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
        </>
      ) : null}

      {/* PLANS TAB — dynamic plan-catalog management (Pearl §8.3) */}
      {tab === "plans" ? (
        <div className="space-y-3" data-testid="platform-billing-plans-panel">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Create and manage subscription tiers. Prices and included features
              are used everywhere — new tenants, change-plan, proration and
              invoices.
            </p>
            <button
              type="button"
              onClick={openPlanCreate}
              data-testid="platform-billing-add-plan"
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              <Plus size={14} aria-hidden="true" />
              Add plan
            </button>
          </div>
          <div
            className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
            data-testid="platform-billing-plans-table-wrapper"
          >
            <table
              className="w-full min-w-[760px] text-left text-sm"
              data-testid="platform-billing-plans-table"
            >
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-slate-400">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Plan</th>
                  <th scope="col" className="px-4 py-3 font-medium">Price</th>
                  <th scope="col" className="px-4 py-3 font-medium">Features</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-700">
                {plans.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400"
                      data-testid="platform-billing-plans-empty"
                    >
                      No plans yet. Click &ldquo;Add plan&rdquo; to create the
                      first tier.
                    </td>
                  </tr>
                ) : null}
                {[...plans]
                  .sort(
                    (a, b) =>
                      a.sortOrder - b.sortOrder ||
                      a.monthlyPriceInPaise - b.monthlyPriceInPaise,
                  )
                  .map((p) => {
                    const busy = planDeleteBusyId === p.id;
                    return (
                      <tr
                        key={p.id}
                        data-testid={`platform-billing-plan-row-${p.id}`}
                      >
                        <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                          {p.name}
                        </td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                          {formatRupees(p.monthlyPriceInPaise)}/mo
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                          {p.includedFeatures.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => setPlanFeaturesView(p)}
                              data-testid={`platform-billing-view-features-${p.id}`}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:bg-gray-700"
                            >
                              <Eye size={12} aria-hidden="true" />
                              View ({p.includedFeatures.length})
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {p.active ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                              <CheckCircle2 size={12} aria-hidden="true" />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                              <XCircle size={12} aria-hidden="true" />
                              Inactive
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => openPlanEdit(p)}
                              disabled={busy}
                              data-testid={`platform-billing-edit-plan-${p.id}`}
                              className="inline-flex h-9 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:bg-gray-700"
                            >
                              <Pencil size={12} aria-hidden="true" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => togglePlanActive(p)}
                              disabled={busy}
                              data-testid={`platform-billing-toggle-plan-${p.id}`}
                              className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:bg-gray-700"
                            >
                              {p.active ? "Deactivate" : "Activate"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setPlanPendingDelete(p)}
                              disabled={busy}
                              data-testid={`platform-billing-delete-plan-${p.id}`}
                              className="inline-flex h-9 items-center gap-1 rounded-md border border-rose-200 bg-white px-2.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:bg-gray-800 dark:text-rose-300 dark:hover:bg-rose-950/40"
                            >
                              <Trash2 size={12} aria-hidden="true" />
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* MARK-PAID MODAL */}
      {markPaidForId ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="platform-billing-mark-paid-title"
          data-testid="platform-billing-mark-paid-modal"
          onClick={closeMarkPaid}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="platform-billing-mark-paid-title"
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              Record payment
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              This action is audited. The recorded reference will appear on
              the invoice and in the platform audit log.
            </p>
            <label
              htmlFor="platform-billing-payment-reference-input"
              className="mt-4 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Payment reference (bank ref / Razorpay payment id)
            </label>
            <input
              id="platform-billing-payment-reference-input"
              data-testid="platform-billing-payment-reference-input"
              type="text"
              value={markPaidRef}
              onChange={(e) => setMarkPaidRef(e.target.value)}
              maxLength={200}
              placeholder="e.g. pay_OZX9k2 or NEFT-2026042512345"
              className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
            {markPaidError ? (
              <div
                role="alert"
                data-testid="platform-billing-mark-paid-error"
                className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
              >
                {markPaidError}
              </div>
            ) : null}
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="platform-billing-mark-paid-cancel"
                onClick={closeMarkPaid}
                disabled={markPaidBusy}
                className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:border-gray-500"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="platform-billing-mark-paid-submit"
                onClick={submitMarkPaid}
                disabled={markPaidBusy}
                className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {markPaidBusy ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={14} aria-hidden="true" />
                )}
                {markPaidBusy ? "Recording…" : "Record payment"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Apply-discount modal (mirrors patient-billing pattern) */}
      {discountFor ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="platform-billing-discount-title"
          data-testid="platform-billing-discount-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={closeDiscount}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="platform-billing-discount-title"
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              Apply discount — {discountFor.invoiceNumber}
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Writes a negative line item on the invoice. The new subtotal
              and GST are recomputed automatically.
            </p>
            <label
              htmlFor="platform-billing-discount-amount"
              className="mt-4 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Discount amount (₹)
            </label>
            <input
              id="platform-billing-discount-amount"
              data-testid="platform-billing-discount-amount"
              type="number"
              min={0}
              step="0.01"
              value={discountRupees}
              onChange={(e) => setDiscountRupees(e.target.value)}
              placeholder="e.g. 500"
              className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
            <label
              htmlFor="platform-billing-discount-reason"
              className="mt-3 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Reason
            </label>
            <textarea
              id="platform-billing-discount-reason"
              data-testid="platform-billing-discount-reason"
              value={discountReason}
              onChange={(e) => setDiscountReason(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="e.g. Goodwill credit for delayed onboarding"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
            {discountError ? (
              <div
                role="alert"
                data-testid="platform-billing-discount-error"
                className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
              >
                {discountError}
              </div>
            ) : null}
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="platform-billing-discount-cancel"
                onClick={closeDiscount}
                disabled={discountBusy}
                className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:border-gray-500"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="platform-billing-discount-submit"
                onClick={submitDiscount}
                disabled={discountBusy}
                className="inline-flex h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {discountBusy ? "Saving…" : "Apply discount"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Pearl §8.3 piece 3d — Change-plan modal */}
      {planChangeFor ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="platform-billing-change-plan-title"
          data-testid="platform-billing-change-plan-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={closePlanChange}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="platform-billing-change-plan-title"
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              Change plan
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {planChangeFor.tenant?.name ?? "(unknown tenant)"} · current:{" "}
              <strong>
                {planByKey.get(planChangeFor.plan)?.name ?? planChangeFor.plan}
              </strong>
              . A proration line item will be written to the current period.
            </p>
            <label
              htmlFor="platform-billing-change-plan-select"
              className="mt-4 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Switch to
            </label>
            <select
              id="platform-billing-change-plan-select"
              data-testid="platform-billing-change-plan-select"
              value={planChangeTo}
              onChange={(e) => setPlanChangeTo(e.target.value)}
              className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            >
              {/* Always include the current key so a tier that has since been
                  deactivated still shows as the selected value. */}
              {!activePlans.some((p) => p.key === planChangeFor.plan) ? (
                <option value={planChangeFor.plan}>
                  {planByKey.get(planChangeFor.plan)?.name ?? planChangeFor.plan}{" "}
                  (current)
                </option>
              ) : null}
              {activePlans.map((p) => (
                <option key={p.id} value={p.key}>
                  {p.name} — {formatRupees(p.monthlyPriceInPaise)}/mo
                </option>
              ))}
            </select>
            {planChangeError ? (
              <div
                role="alert"
                data-testid="platform-billing-change-plan-error"
                className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
              >
                {planChangeError}
              </div>
            ) : null}
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="platform-billing-change-plan-cancel"
                onClick={closePlanChange}
                disabled={planChangeBusy}
                className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:border-gray-500"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="platform-billing-change-plan-submit"
                onClick={submitPlanChange}
                disabled={planChangeBusy}
                className="inline-flex h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {planChangeBusy ? "Saving…" : "Confirm change"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* PLAN ADD / EDIT MODAL (Pearl §8.3) */}
      {planEditing != null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="platform-billing-plan-form-title"
          data-testid="platform-billing-plan-form-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={closePlanForm}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="platform-billing-plan-form-title"
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              {planEditing === "new" ? "Add plan" : "Edit plan"}
            </h2>

            <label
              htmlFor="platform-billing-plan-name"
              className="mt-4 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Display name
            </label>
            <input
              id="platform-billing-plan-name"
              data-testid="platform-billing-plan-name"
              value={planFormName}
              onChange={(e) => setPlanFormName(e.target.value.toUpperCase())}
              placeholder="e.g. PRO PLUS"
              className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm uppercase focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100"
            />

            <label className="mt-3 block text-xs font-medium text-slate-700 dark:text-slate-300">
              Monthly price (₹)
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                aria-label="Rupees"
                data-testid="platform-billing-plan-price-rupees"
                type="number"
                min={0}
                step="1"
                value={planFormRupees}
                onChange={(e) => setPlanFormRupees(e.target.value)}
                placeholder="24999"
                className="h-11 flex-1 rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100"
              />
              <span className="text-lg font-semibold text-slate-400 dark:text-slate-500">
                .
              </span>
              <input
                aria-label="Paise"
                data-testid="platform-billing-plan-price-paise"
                type="number"
                min={0}
                max={99}
                step="1"
                value={planFormPaise}
                onChange={(e) => setPlanFormPaise(e.target.value)}
                placeholder="00"
                className="h-11 w-20 rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100"
              />
            </div>
            <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
              Whole rupees on the left, paise (00–99) on the right.
            </p>

            <div className="mt-3">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Included features
                </label>
                <button
                  type="button"
                  onClick={addFeatureRow}
                  data-testid="platform-billing-plan-add-feature"
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:bg-gray-700"
                >
                  <Plus size={12} aria-hidden="true" />
                  Add feature
                </button>
              </div>
              {/* p-1 gives the focused input's 2px ring room so the scroll
                  container (overflow-y-auto) doesn't clip it into a
                  broken-looking left/right-only border. */}
              <div className="mt-1 max-h-44 space-y-2 overflow-y-auto p-1">
                {planFormFeatures.map((feat, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      aria-label={`Feature ${i + 1}`}
                      data-testid={`platform-billing-plan-feature-${i}`}
                      value={feat}
                      onChange={(e) => updateFeatureRow(i, e.target.value)}
                      placeholder="e.g. lab"
                      className="h-11 flex-1 rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100"
                    />
                    <button
                      type="button"
                      onClick={() => removeFeatureRow(i)}
                      aria-label={`Remove feature ${i + 1}`}
                      data-testid={`platform-billing-plan-remove-feature-${i}`}
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-400 dark:hover:bg-rose-950/40"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 flex items-end gap-4">
              <div className="flex-1">
                <label
                  htmlFor="platform-billing-plan-sort"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                >
                  Sort order
                </label>
                <input
                  id="platform-billing-plan-sort"
                  data-testid="platform-billing-plan-sort"
                  type="number"
                  min={0}
                  value={planFormSortOrder}
                  onChange={(e) => setPlanFormSortOrder(e.target.value)}
                  className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100"
                />
              </div>
              {planEditing !== "new" ? (
                <label className="inline-flex h-11 items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    data-testid="platform-billing-plan-active"
                    checked={planFormActive}
                    onChange={(e) => setPlanFormActive(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Active
                </label>
              ) : null}
            </div>

            {planFormError ? (
              <div
                role="alert"
                data-testid="platform-billing-plan-form-error"
                className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
              >
                {planFormError}
              </div>
            ) : null}

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="platform-billing-plan-form-cancel"
                onClick={closePlanForm}
                disabled={planFormBusy}
                className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:border-gray-500"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="platform-billing-plan-form-submit"
                onClick={submitPlanForm}
                disabled={planFormBusy}
                className="inline-flex h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {planFormBusy
                  ? "Saving…"
                  : planEditing === "new"
                    ? "Create plan"
                    : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* CONFIRM DELETE PLAN MODAL */}
      {planPendingDelete ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="platform-billing-delete-plan-title"
          data-testid="platform-billing-delete-plan-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => {
            if (planDeleteBusyId == null) setPlanPendingDelete(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
                <Trash2 size={18} aria-hidden="true" />
              </div>
              <div>
                <h2
                  id="platform-billing-delete-plan-title"
                  className="text-lg font-semibold text-slate-900 dark:text-slate-100"
                >
                  Delete plan?
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  This will permanently delete{" "}
                  <strong>{planPendingDelete.name}</strong>. This can&rsquo;t be
                  undone. Plans still in use can&rsquo;t be deleted — deactivate
                  them instead.
                </p>
              </div>
            </div>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="platform-billing-delete-plan-cancel"
                onClick={() => setPlanPendingDelete(null)}
                disabled={planDeleteBusyId != null}
                className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:border-gray-500"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="platform-billing-delete-plan-confirm"
                onClick={confirmDeletePlan}
                disabled={planDeleteBusyId != null}
                className="inline-flex h-11 items-center gap-1 rounded-md bg-rose-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-rose-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-rose-600"
              >
                {planDeleteBusyId != null ? "Deleting…" : "Delete plan"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* PLAN FEATURES VIEW MODAL — read-only list of all included features */}
      {planFeaturesView ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="platform-billing-plan-features-title"
          data-testid="platform-billing-plan-features-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setPlanFeaturesView(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="platform-billing-plan-features-title"
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              {planFeaturesView.name} — included features
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {planFeaturesView.includedFeatures.length} feature
              {planFeaturesView.includedFeatures.length === 1 ? "" : "s"} unlocked
              on this plan.
            </p>
            <ul className="mt-4 max-h-72 space-y-1 overflow-y-auto">
              {planFeaturesView.includedFeatures.map((f) => (
                <li
                  key={f}
                  className="flex items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-gray-800 dark:text-slate-200"
                >
                  <CheckCircle2
                    size={14}
                    className="shrink-0 text-emerald-500"
                    aria-hidden="true"
                  />
                  <span className="font-mono text-xs">{f}</span>
                </li>
              ))}
            </ul>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="platform-billing-plan-features-edit"
                onClick={() => {
                  const p = planFeaturesView;
                  setPlanFeaturesView(null);
                  openPlanEdit(p);
                }}
                className="inline-flex h-11 items-center gap-1 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:bg-gray-700"
              >
                <Pencil size={14} aria-hidden="true" />
                Edit plan
              </button>
              <button
                type="button"
                data-testid="platform-billing-plan-features-close"
                onClick={() => setPlanFeaturesView(null)}
                className="inline-flex h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ─── KPI tile (top-of-page header) ──────────────────────────────────
// Small stat card with a tinted icon disc, label, and value. The
// `tone` prop picks the colour pair so the four tiles stay visually
// distinct (active / trial / past-due / unpaid) without exploding into
// per-tile className soup.
const TONE_CLS: Record<
  "emerald" | "sky" | "amber" | "rose",
  { bg: string; text: string }
> = {
  emerald: { bg: "bg-emerald-100 dark:bg-emerald-900/40", text: "text-emerald-700 dark:text-emerald-300" },
  sky: { bg: "bg-sky-100 dark:bg-sky-900/40", text: "text-sky-700 dark:text-sky-300" },
  amber: { bg: "bg-amber-100 dark:bg-amber-900/40", text: "text-amber-700 dark:text-amber-300" },
  rose: { bg: "bg-rose-100 dark:bg-rose-900/40", text: "text-rose-700 dark:text-rose-300" },
};

function KpiTile({
  label,
  value,
  tone,
  Icon,
}: {
  label: string;
  value: string | number;
  tone: "emerald" | "sky" | "amber" | "rose";
  Icon: LucideIcon;
}) {
  const c = TONE_CLS[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${c.bg} ${c.text}`}
        >
          <Icon size={16} />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {label}
          </p>
          <p className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">
            {value}
          </p>
        </div>
      </div>
    </div>
  );
}
