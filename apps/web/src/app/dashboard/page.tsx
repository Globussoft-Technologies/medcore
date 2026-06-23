"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/api";
import { OnboardingBanner } from "@/components/OnboardingBanner";
// Issue #348 — shared bed-summary helper so dashboard KPI matches the
// Wards & Admissions pages exactly.
import { getBedSummary } from "@/lib/bed-summary";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { formatINR } from "@/lib/currency";
// Issue #438 (Apr 30 2026): canonical `DD MMM YYYY` everywhere — kills the
// DD/MM vs MM/DD inconsistency between the lab/bills/Rx cards.
import { formatDate } from "@/lib/format";
import { getSocket } from "@/lib/socket";
import { SkeletonCard } from "@/components/Skeleton";
import {
  Calendar,
  Users,
  CreditCard,
  Activity,
  BedDouble,
  Siren,
  Droplet,
  Pill,
  FlaskConical,
  Scissors,
  TrendingUp,
  AlertTriangle,
  Package,
  Heart,
  Bell,
  Clock,
  CheckCircle2,
  ArrowRight,
  Syringe,
  FileText,
  Star,
  Video,
  Ambulance as AmbulanceIcon,
  UserCheck,
  Baby,
  Monitor,
} from "lucide-react";

interface DashboardData {
  // OPD
  todayAppointments?: number;
  totalPatients?: number;
  pendingBills?: number;
  inQueueCount?: number;
  todayRevenue?: number;
  // IPD
  currentlyAdmitted?: number;
  bedsOccupied?: number;
  totalBeds?: number;
  // Emergency
  erWaiting?: number;
  erCritical?: number;
  // Pharmacy
  lowStockCount?: number;
  // Issue: PHARMACIST-specific KPIs (replace the OPD strip for pharmacists)
  rxPending?: number;
  rxDispensing?: number;
  rxReady?: number;
  expiringSoonCount?: number;
  pendingPurchaseOrders?: number;
  // Short lists for the pharmacist detail sections (top few each).
  rxQueueItems?: Array<{
    id: string;
    patientLabel?: string;
    topItem?: string;
    extraItems?: number;
    status?: string;
  }>;
  readyItems?: Array<{
    id: string;
    patientLabel?: string;
    topItem?: string;
    extraItems?: number;
    status?: string;
  }>;
  lowStockItems?: Array<{
    id?: string;
    name?: string;
    batchNumber?: string;
    quantity?: number;
    reorderLevel?: number;
  }>;
  expiringItems?: Array<{
    id?: string;
    name?: string;
    batchNumber?: string;
    expiryDate?: string;
    quantity?: number;
  }>;
  supplierItems?: Array<{
    id?: string;
    name?: string;
    openOrders?: number;
    outstandingAmount?: number;
  }>;
  purchaseOrderItems?: Array<{
    id?: string;
    poNumber?: string;
    supplierName?: string;
    status?: string;
    totalAmount?: number;
  }>;
  // Lab
  pendingLabOrders?: number;
  // Issue #629 — LAB_TECH-specific KPIs
  labOrdersInProgress?: number;
  labOrdersStat?: number;
  labOrdersCompletedToday?: number;
  labOrdersSampleCollected?: number;
  // Blood bank
  bloodUnitsAvailable?: number;
  bloodUnitsExpiring?: number;
  // Surgery
  surgeriesScheduledToday?: number;
  surgeriesInProgress?: number;
  // HR
  staffOnDuty?: number;
  pendingLeaves?: number;
  // Feedback
  avgRating?: number;
  openComplaints?: number;
  // Immunization
  overdueImmunizations?: number;
  // Medication
  medicationsDue?: number;
  // Telemedicine
  telemedicineToday?: number;
  // Visitors
  activeVisitors?: number;
}

function safeGet<T>(path: string, fallback: T): Promise<T> {
  return api.get<T>(path).catch(() => fallback);
}

function StatCard({
  title,
  value,
  icon: Icon,
  color,
  href,
  subtitle,
  trend,
}: {
  title: string;
  value: number | string;
  icon: React.ElementType;
  color: string;
  href?: string;
  subtitle?: string;
  trend?: "up" | "down" | "neutral";
}) {
  const content = (
    <div className="h-full rounded-xl bg-white dark:bg-gray-800 p-5 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          {/* Issue #505: title + subtitle were `text-gray-500` only —
              fails WCAG AA on dark mode (2.4:1 on bg-gray-800). Pair
              with `dark:text-gray-300` so both modes pass. */}
          <p className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300">
            {title}
          </p>
          <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
          {subtitle && (
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{subtitle}</p>
          )}
        </div>
        <div className={`rounded-lg p-2.5 ${color}`}>
          <Icon size={20} className="text-white" />
        </div>
      </div>
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}

function ModuleSection({
  title,
  icon: Icon,
  iconColor,
  children,
  viewAllHref,
}: {
  title: string;
  icon: React.ElementType;
  iconColor: string;
  children: React.ReactNode;
  viewAllHref?: string;
}) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-800 p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`rounded-lg p-1.5 ${iconColor}`}>
            <Icon size={16} className="text-white" />
          </div>
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        </div>
        {viewAllHref && (
          <Link
            href={viewAllHref}
            className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            View all <ArrowRight size={12} />
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Widget preference helpers ──────────────────────────

type WidgetKey =
  | "kpi_top"
  | "clinical_today"
  | "diagnostics"
  | "operations"
  | "nurse_meds"
  | "reception"
  | "quick_actions";

interface DashboardWidget {
  type: WidgetKey;
  visible?: boolean;
  order?: number;
}

const DEFAULT_WIDGETS: DashboardWidget[] = [
  { type: "kpi_top", visible: true },
  { type: "clinical_today", visible: true },
  { type: "diagnostics", visible: true },
  { type: "operations", visible: true },
  { type: "nurse_meds", visible: true },
  { type: "reception", visible: true },
  { type: "quick_actions", visible: true },
];

const WIDGET_LABELS: Record<WidgetKey, string> = {
  kpi_top: "Top KPI Cards",
  clinical_today: "Clinical Today",
  diagnostics: "Diagnostics & Labs",
  operations: "Operations",
  nurse_meds: "Nurse Medications",
  reception: "Reception Highlights",
  quick_actions: "Quick Actions",
};

function isWidgetVisible(
  prefs: DashboardWidget[] | null,
  type: WidgetKey
): boolean {
  if (!prefs) return true;
  const w = prefs.find((p) => p.type === type);
  if (!w) return true;
  return w.visible !== false;
}

function CustomizeDashboardModal({
  open,
  initial,
  onClose,
  onSave,
  keys,
}: {
  open: boolean;
  initial: DashboardWidget[];
  onClose: () => void;
  onSave: (widgets: DashboardWidget[]) => void;
  // Only show toggles for sections relevant to the current role. When
  // omitted, all sections are shown.
  keys?: WidgetKey[];
}) {
  const [widgets, setWidgets] = useState<DashboardWidget[]>(initial);

  useEffect(() => {
    setWidgets(initial);
  }, [initial, open]);

  if (!open) return null;

  function toggle(k: WidgetKey) {
    setWidgets((ws) => {
      const existing = ws.find((w) => w.type === k);
      if (existing) {
        return ws.map((w) =>
          w.type === k ? { ...w, visible: w.visible === false ? true : false } : w
        );
      }
      return [...ws, { type: k, visible: false }];
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-xl bg-white p-6 shadow-lg dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">Customize Dashboard</h2>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Toggle sections on or off. Your preferences are saved.
        </p>
        <div className="mb-6 space-y-2">
          {(keys ?? (Object.keys(WIDGET_LABELS) as WidgetKey[])).map((k) => {
            const w = widgets.find((x) => x.type === k);
            const visible = !w || w.visible !== false;
            return (
              <label
                key={k}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50"
              >
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={() => toggle(k)}
                  className="h-4 w-4"
                />
                <span className="text-sm text-gray-900 dark:text-gray-100">{WIDGET_LABELS[k]}</span>
              </label>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onSave(widgets);
              onClose();
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            Save Preferences
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const [data, setData] = useState<DashboardData>({});
  const [loading, setLoading] = useState(true);
  const [widgets, setWidgets] = useState<DashboardWidget[]>(DEFAULT_WIDGETS);
  const [showCustomize, setShowCustomize] = useState(false);

  useEffect(() => {
    api
      .get<{ data: { layout: { widgets: DashboardWidget[] } } }>(
        "/users/me/dashboard-preferences"
      )
      .then((r) => {
        const w = r.data?.layout?.widgets;
        if (Array.isArray(w) && w.length > 0) setWidgets(w);
      })
      .catch(() => undefined);
  }, []);

  async function saveWidgets(next: DashboardWidget[]) {
    setWidgets(next);
    try {
      await api.put("/users/me/dashboard-preferences", {
        layout: { widgets: next },
      });
    } catch {
      // silent
    }
  }

  useEffect(() => {
    async function load() {
      const today = new Date().toISOString().split("T")[0];

      // Role-gate admin-only analytics / HR / feedback endpoints so roles
      // that don't render the data never hit them. Previously every non-
      // PATIENT role fired these, which produced repeated 403s in the
      // nurse/doctor Network tab. See GitHub issue #31. We ONLY skip calls
      // client-side — we never widen backend permissions.
      //
      // Issue #621: PHARMACIST also fans out 12+ requests on first paint
      // that always 403 (patients, billing, queue, wards, emergency, lab,
      // bloodbank, shifts, complaints, visitors, immunization). Skip them
      // for PHARMACIST so the dashboard doesn't pollute monitoring with
      // expected 403s on every login. Pharmacist's actual surface
      // (prescriptions, low-stock pharmacy inventory) still loads.
      const role = user?.role;
      const canSeeAnalytics = role === "ADMIN" || role === "RECEPTION";
      const canSeeAdminHR = role === "ADMIN";
      const isPharmacist = role === "PHARMACIST";
      const isLabTech = role === "LAB_TECH";

      const [
        appointments,
        patients,
        pendingInv,
        partialInv,
        queue,
        admissions,
        wards,
        emergencyActive,
        lowStock,
        labOrders,
        bloodInventory,
        surgeryScheduled,
        surgeryInProgress,
        rosterToday,
        pendingLeaves,
        feedbackSummary,
        openComplaints,
        overview,
        medsDue,
        telemed,
        immunSchedule,
        visitorsActive,
      ] = await Promise.all([
        safeGet<any>(`/appointments?date=${today}&limit=1`, { meta: { total: 0 } }),
        // Issue #621: PHARMACIST + LAB_TECH have no read access to the patient
        // roster, billing, queue, wards, emergency, bloodbank, shifts,
        // complaints, visitors, immunization. Short-circuit to a no-op so
        // we don't flood the monitoring/alert channel with 403s.
        isPharmacist || isLabTech
          ? Promise.resolve({ meta: { total: 0 } })
          : safeGet<any>(`/patients?limit=1`, { meta: { total: 0 } }),
        isPharmacist || isLabTech
          ? Promise.resolve({ meta: { total: 0 } })
          : safeGet<any>(`/billing/invoices?status=PENDING&limit=1`, { meta: { total: 0 } }),
        isPharmacist || isLabTech
          ? Promise.resolve({ meta: { total: 0 } })
          : safeGet<any>(`/billing/invoices?status=PARTIAL&limit=1`, { meta: { total: 0 } }),
        isPharmacist || isLabTech
          ? Promise.resolve({ data: [] })
          : safeGet<any>(`/queue`, { data: [] }),
        isPharmacist || isLabTech
          ? Promise.resolve({ meta: { total: 0 } })
          : safeGet<any>(`/admissions?status=ADMITTED&limit=1`, { meta: { total: 0 } }),
        isPharmacist || isLabTech
          ? Promise.resolve({ data: [] })
          : safeGet<any>(`/wards`, { data: [] }),
        isPharmacist || isLabTech
          ? Promise.resolve({ data: [] })
          : safeGet<any>(`/emergency/cases/active`, { data: [] }),
        safeGet<any>(`/pharmacy/inventory?lowStock=true&limit=1`, { meta: { total: 0 } }),
        // Lab orders ARE part of LAB_TECH's surface, so don't gate it for them.
        isPharmacist
          ? Promise.resolve({ meta: { total: 0 } })
          : safeGet<any>(`/lab/orders?status=ORDERED&limit=1`, { meta: { total: 0 } }),
        isPharmacist || isLabTech
          ? Promise.resolve({ data: null })
          : safeGet<any>(`/bloodbank/inventory/summary`, { data: null }),
        isPharmacist || isLabTech
          ? Promise.resolve({ meta: { total: 0 } })
          : safeGet<any>(`/surgery?status=SCHEDULED&from=${today}&to=${today}&limit=1`, { meta: { total: 0 } }),
        isPharmacist || isLabTech
          ? Promise.resolve({ meta: { total: 0 } })
          : safeGet<any>(`/surgery?status=IN_PROGRESS&limit=1`, { meta: { total: 0 } }),
        isPharmacist || isLabTech
          ? Promise.resolve({ data: [] })
          : safeGet<any>(`/shifts/roster?date=${today}`, { data: [] }),
        canSeeAdminHR
          ? safeGet<any>(`/leaves/pending`, { data: [] })
          : Promise.resolve({ data: [] }),
        canSeeAnalytics
          ? safeGet<any>(`/feedback/summary`, { data: null })
          : Promise.resolve({ data: null }),
        isPharmacist || isLabTech
          ? Promise.resolve({ meta: { total: 0 } })
          : safeGet<any>(`/complaints?status=OPEN&limit=1`, { meta: { total: 0 } }),
        canSeeAnalytics
          ? safeGet<any>(`/analytics/overview?from=${today}&to=${today}`, { data: null })
          : Promise.resolve({ data: null }),
        isPharmacist || isLabTech
          ? Promise.resolve({ data: [] })
          : safeGet<any>(`/medication/administrations/due`, { data: [] }),
        isPharmacist || isLabTech
          ? Promise.resolve({ meta: { total: 0 } })
          : safeGet<any>(`/telemedicine?date=${today}&limit=1`, { meta: { total: 0 } }),
        isPharmacist || isLabTech
          ? Promise.resolve({ data: [] })
          : safeGet<any>(`/ehr/immunizations/schedule?filter=overdue`, { data: [] }),
        isPharmacist || isLabTech
          ? Promise.resolve({ data: [] })
          : safeGet<any>(`/visitors/active`, { data: [] }),
      ]);

      // Issue #629 — LAB_TECH-specific KPIs (others get a no-op so we don't
      // pay the extra round-trips for roles that don't render the strip).
      const [
        labInProgress,
        labStat,
        labCompletedToday,
        labSampleCollected,
      ] = isLabTech
        ? await Promise.all([
            safeGet<any>(`/lab/orders?status=IN_PROGRESS&limit=1`, { meta: { total: 0 } }),
            safeGet<any>(`/lab/orders?stat=true&limit=1`, { meta: { total: 0 } }),
            safeGet<any>(`/lab/orders?status=COMPLETED&limit=1`, { meta: { total: 0 } }),
            safeGet<any>(`/lab/orders?status=SAMPLE_COLLECTED&limit=1`, { meta: { total: 0 } }),
          ])
        : [
            { meta: { total: 0 } },
            { meta: { total: 0 } },
            { meta: { total: 0 } },
            { meta: { total: 0 } },
          ];

      // PHARMACIST-specific KPIs — prescription Kanban counts (today),
      // expiring stock, and pending purchase orders. Others skip these
      // round-trips. Kanban returns { data: { columns: { PENDING: [...], … } } }.
      const [
        rxKanban,
        expiringSoon,
        pendingPOs,
        lowStockList,
        supplierList,
        recentPOs,
      ] = isPharmacist
        ? await Promise.all([
            safeGet<any>(`/pharmacy/kanban?todayOnly=true`, {
              data: { columns: {} },
            }),
            safeGet<any>(`/pharmacy/inventory/expiring?days=30`, { data: [] }),
            safeGet<any>(`/purchase-orders?status=PENDING&limit=1`, {
              meta: { total: 0 },
            }),
            safeGet<any>(`/pharmacy/inventory?lowStock=true&limit=6`, {
              data: [],
            }),
            safeGet<any>(`/suppliers?active=true`, { data: [] }),
            safeGet<any>(`/purchase-orders?limit=6`, { data: [] }),
          ])
        : [
            { data: { columns: {} } },
            { data: [] },
            { meta: { total: 0 } },
            { data: [] },
            { data: [] },
            { data: [] },
          ];
      const rxColumns = rxKanban.data?.columns ?? {};
      // Short lists for the pharmacist detail sections. Inventory rows carry
      // the medicine name on the joined `medicine` relation, not on the
      // InventoryItem itself — flatten it here so the UI reads cleanly.
      const rxQueueItems = [
        ...(rxColumns.PENDING ?? []),
        ...(rxColumns.DISPENSING ?? []),
      ].slice(0, 6);
      const readyItems = (rxColumns.READY ?? []).slice(0, 6);
      const lowStockItems = (lowStockList.data ?? [])
        .slice(0, 6)
        .map((it: any) => ({
          id: it.id,
          name: it.medicine?.name ?? it.name,
          batchNumber: it.batchNumber,
          quantity: it.quantity,
          reorderLevel: it.reorderLevel,
        }));
      const expiringItems = (expiringSoon.data ?? [])
        .slice(0, 6)
        .map((it: any) => ({
          id: it.id,
          name: it.medicine?.name ?? it.name,
          batchNumber: it.batchNumber,
          expiryDate: it.expiryDate,
          quantity: it.quantity,
        }));
      const supplierItems = (supplierList.data ?? [])
        .slice(0, 6)
        .map((s: any) => ({
          id: s.id,
          name: s.name,
          openOrders: s._count?.purchaseOrders ?? 0,
          outstandingAmount: s.outstandingAmount ?? 0,
        }));
      const purchaseOrderItems = (recentPOs.data ?? [])
        .slice(0, 6)
        .map((po: any) => ({
          id: po.id,
          poNumber: po.poNumber,
          supplierName: po.supplier?.name,
          status: po.status,
          totalAmount: po.totalAmount,
        }));

      // Compute totals
      const totalInQueue = (queue.data ?? []).reduce(
        (sum: number, doc: any) => sum + (doc.waitingCount || 0),
        0
      );

      // Issue #348 — use the shared helper so this KPI matches Wards
      // and Admissions. Previously each page open-coded the reduce with
      // slightly different fallback paths and disagreed by 1-2 beds.
      const wardStats = getBedSummary(wards.data ?? []);

      const bloodSummary = bloodInventory.data;
      const bloodAvailable = bloodSummary?.totalAvailable ?? bloodSummary?.total ?? 0;
      const bloodExpiring = bloodSummary?.expiringSoon ?? 0;

      const erCases = emergencyActive.data ?? [];
      const erCritical = erCases.filter(
        (c: any) => c.triageLevel === "RESUSCITATION" || c.triageLevel === "EMERGENT"
      ).length;

      const todayRevenue = overview.data?.totalRevenue ?? 0;

      setData({
        todayAppointments: appointments.meta?.total ?? 0,
        totalPatients: patients.meta?.total ?? 0,
        pendingBills: (pendingInv.meta?.total ?? 0) + (partialInv.meta?.total ?? 0),
        inQueueCount: totalInQueue,
        todayRevenue,
        currentlyAdmitted: admissions.meta?.total ?? 0,
        bedsOccupied: wardStats.occupied,
        totalBeds: wardStats.total,
        erWaiting: erCases.length,
        erCritical,
        lowStockCount: lowStock.meta?.total ?? 0,
        // PHARMACIST KPI counts
        rxPending: (rxColumns.PENDING ?? []).length,
        rxDispensing: (rxColumns.DISPENSING ?? []).length,
        rxReady: (rxColumns.READY ?? []).length,
        expiringSoonCount: (expiringSoon.data ?? []).length,
        pendingPurchaseOrders: pendingPOs.meta?.total ?? 0,
        rxQueueItems,
        readyItems,
        lowStockItems,
        expiringItems,
        supplierItems,
        purchaseOrderItems,
        pendingLabOrders: labOrders.meta?.total ?? 0,
        // Issue #629 — LAB_TECH-specific KPI counts
        labOrdersInProgress: labInProgress.meta?.total ?? 0,
        labOrdersStat: labStat.meta?.total ?? 0,
        labOrdersCompletedToday: labCompletedToday.meta?.total ?? 0,
        labOrdersSampleCollected: labSampleCollected.meta?.total ?? 0,
        bloodUnitsAvailable: bloodAvailable,
        bloodUnitsExpiring: bloodExpiring,
        surgeriesScheduledToday: surgeryScheduled.meta?.total ?? 0,
        surgeriesInProgress: surgeryInProgress.meta?.total ?? 0,
        staffOnDuty: (rosterToday.data ?? []).length,
        pendingLeaves: (pendingLeaves.data ?? []).length,
        avgRating: feedbackSummary.data?.avgRating ?? 0,
        openComplaints: openComplaints.meta?.total ?? 0,
        overdueImmunizations: (immunSchedule.data ?? []).length,
        medicationsDue: (medsDue.data ?? []).length,
        telemedicineToday: telemed.meta?.total ?? 0,
        activeVisitors: (visitorsActive.data ?? []).length,
      });
      setLoading(false);
    }
    load().catch(() => setLoading(false));

    // Issue #270: the Pending Bills tile was reading a stale cache after a
    // payment was recorded — the dashboard never re-fetched. Listen for the
    // billing socket events the API emits on every payment / refund and
    // re-fire load() so the tile reconciles within ~100ms.
    const sock = getSocket();
    const refresh = () => load().catch(() => setLoading(false));
    sock.on("payment:received", refresh);
    sock.on("billing:payment-success", refresh);
    sock.on("billing:invoice-updated", refresh);
    return () => {
      sock.off("payment:received", refresh);
      sock.off("billing:payment-success", refresh);
      sock.off("billing:invoice-updated", refresh);
    };
    // Depend on user.role so that once the session hydrates, the load() call
    // re-runs with the correct role-gating for admin-only endpoints (#31).
  }, [user?.role]);

  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isDoctor = role === "DOCTOR";
  const isNurse = role === "NURSE";
  const isReception = role === "RECEPTION";
  const isPatient = role === "PATIENT";
  // Issue #629 — LAB_TECH gets a dedicated KPI strip + quick actions; the
  // generic strip's tiles (appointments / patients / beds / ER / bills) all
  // either link to Access-Denied pages or surface counts irrelevant to lab
  // operations.
  const isLabTechRole = role === "LAB_TECH";
  // PHARMACIST gets a dedicated KPI strip too — the generic OPD tiles
  // (appointments / patients / beds / ER / bills) are 403-gated and
  // irrelevant to pharmacy work.
  const isPharmacistRole = role === "PHARMACIST";

  const fmt = (n?: number) => (n ?? 0).toLocaleString("en-IN");
  // Issue #298: canonical INR formatting (₹1,23,456.00) via shared helper.
  const money = (n?: number) => formatINR(n ?? 0);

  return (
    <div>
      {/* Tenant-admin onboarding nudge (renders only for a tenant admin with
          pending steps; no-op for everyone else). */}
      <OnboardingBanner />

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t("dashboard.home.greeting")}, {user?.name}
          </h1>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {new Date().toLocaleDateString("en-IN", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isPatient && (
            <button
              onClick={() => setShowCustomize(true)}
              className="touch-target rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Customize Dashboard
            </button>
          )}
          {role && (
            <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              {user?.actualRole ?? role}
            </span>
          )}
        </div>
      </div>

      <CustomizeDashboardModal
        open={showCustomize}
        initial={widgets}
        onClose={() => setShowCustomize(false)}
        onSave={saveWidgets}
        // Roles with the trimmed KPI+Quick-Actions dashboard (pharmacist /
        // lab-tech) only have those two sections — don't offer toggles for
        // clinical / nurse / reception sections they never render.
        keys={
          isPharmacistRole || isLabTechRole
            ? ["kpi_top", "quick_actions"]
            : undefined
        }
      />

      {loading && (
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {/* Patient-specific view */}
      {isPatient && <PatientHome />}

      {!isPatient && (
        <>
          {/* Top KPI strip.
              Issue #529 — when the dashboard first paints, the data fetches
              are still in flight and every numeric tile read 0 (the default
              for `fmt(undefined)`). Admins glancing at the dashboard
              interpreted "0 patients / 0 admitted / 0/0 beds" as a wiped
              database. We gate the real KPI grid on `!loading` so the
              SkeletonCard strip rendered above is the ONLY visible
              representation while data fetches are in flight; once `loading`
              flips false the real numbers replace the skeleton. Quick
              Actions and role-specific sections render unconditionally
              because they don't depend on the in-flight data. */}
          {!loading && isWidgetVisible(widgets, "kpi_top") && (
          isLabTechRole ? (
            // Issue #629 — LAB_TECH dashboard: replace the generic strip
            // (appointments/patients/beds/ER/bills — all gated 403 for lab
            // tech and irrelevant to lab work) with lab-operations KPIs.
            <div
              className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6"
              data-testid="kpi-strip-lab-tech"
            >
              <StatCard
                title="Pending Lab Orders"
                value={fmt(data.pendingLabOrders)}
                subtitle="awaiting collection"
                icon={FlaskConical}
                color="bg-primary"
                href="/dashboard/lab?status=ORDERED"
              />
              <StatCard
                title="Sample Collected"
                value={fmt(data.labOrdersSampleCollected)}
                subtitle="ready for analysis"
                icon={CheckCircle2}
                color="bg-blue-600"
                href="/dashboard/lab?status=SAMPLE_COLLECTED"
              />
              <StatCard
                title="In Progress"
                value={fmt(data.labOrdersInProgress)}
                icon={Activity}
                color="bg-indigo-600"
                href="/dashboard/lab?status=IN_PROGRESS"
              />
              <StatCard
                title="STAT"
                value={fmt(data.labOrdersStat)}
                subtitle="urgent"
                icon={AlertTriangle}
                color={data.labOrdersStat ? "bg-red-600" : "bg-orange-600"}
                href="/dashboard/lab?stat=true"
              />
              <StatCard
                title="Completed Today"
                value={fmt(data.labOrdersCompletedToday)}
                icon={CheckCircle2}
                color="bg-emerald-600"
                href="/dashboard/lab?status=COMPLETED"
              />
              <StatCard
                title="QC Queue"
                value={"Open"}
                subtitle="quality control"
                icon={FileText}
                color="bg-secondary"
                href="/dashboard/lab/qc"
              />
            </div>
          ) : isPharmacistRole ? (
            // PHARMACIST dashboard: pharmacy-operations KPIs instead of the
            // generic OPD strip (which is gated/irrelevant for pharmacists).
            <div
              className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6"
              data-testid="kpi-strip-pharmacist"
            >
              <StatCard
                title="New Prescriptions"
                value={fmt(data.rxPending)}
                subtitle="awaiting dispense"
                icon={Pill}
                color="bg-primary"
                href="/dashboard/pharmacy-kanban"
              />
              <StatCard
                title="Dispensing"
                value={fmt(data.rxDispensing)}
                subtitle="in progress"
                icon={Activity}
                color="bg-indigo-600"
                href="/dashboard/pharmacy-kanban"
              />
              <StatCard
                title="Ready for Pickup"
                value={fmt(data.rxReady)}
                subtitle="bagged"
                icon={CheckCircle2}
                color="bg-emerald-600"
                href="/dashboard/pharmacy-kanban"
              />
              <StatCard
                title="Low Stock"
                value={fmt(data.lowStockCount)}
                subtitle="reorder"
                icon={AlertTriangle}
                color={data.lowStockCount ? "bg-red-600" : "bg-orange-600"}
                href="/dashboard/pharmacy?tab=low"
              />
              <StatCard
                title="Expiring (30d)"
                value={fmt(data.expiringSoonCount)}
                subtitle="check batches"
                icon={Package}
                color="bg-secondary"
                href="/dashboard/pharmacy?tab=expiring"
              />
              <StatCard
                title="Pending POs"
                value={fmt(data.pendingPurchaseOrders)}
                subtitle="purchase orders"
                icon={FileText}
                color="bg-accent"
                href="/dashboard/purchase-orders"
              />
            </div>
          ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard
              title={t("dashboard.home.kpi.todayAppointments")}
              value={fmt(data.todayAppointments)}
              subtitle={`${data.inQueueCount ?? 0} ${t("dashboard.home.kpi.inQueue")}`}
              icon={Calendar}
              color="bg-primary"
              href="/dashboard/appointments"
            />
            <StatCard
              title={t("dashboard.home.kpi.totalPatients")}
              value={fmt(data.totalPatients)}
              icon={Users}
              color="bg-secondary"
              href="/dashboard/patients"
            />
            {/* Issue #90: "Today's Revenue" KPI is ADMIN-only — RECEPTION
                must not see financial figures on the home dashboard. */}
            {isAdmin && (
              <StatCard
                title={t("dashboard.home.kpi.todayRevenue")}
                value={money(data.todayRevenue)}
                icon={TrendingUp}
                color="bg-emerald-600"
                href="/dashboard/reports"
              />
            )}
            <StatCard
              title={t("dashboard.home.kpi.bedsOccupied")}
              value={`${fmt(data.bedsOccupied)}/${fmt(data.totalBeds)}`}
              subtitle={
                data.totalBeds
                  ? `${Math.round((data.bedsOccupied! / data.totalBeds) * 100)}% occupancy`
                  : undefined
              }
              icon={BedDouble}
              color="bg-indigo-600"
              href="/dashboard/wards"
            />
            <StatCard
              title={t("dashboard.home.kpi.erWaiting")}
              value={fmt(data.erWaiting)}
              subtitle={
                data.erCritical ? `${data.erCritical} ${t("dashboard.emergency.critical").toLowerCase()}` : "None critical"
              }
              icon={Siren}
              color={data.erCritical ? "bg-red-600" : "bg-orange-600"}
              href="/dashboard/emergency"
            />
            {/* Issue #213-C: tile is "Pending Invoices" (matches DB term),
                links straight to the PENDING tab so the count and the list
                a click later reconcile. The KPI itself remains all-time
                pending+partial — Reports labels its today-scoped variant
                accordingly. */}
            <StatCard
              title={t("dashboard.home.kpi.pendingBills")}
              value={fmt(data.pendingBills)}
              icon={CreditCard}
              color="bg-accent"
              href="/dashboard/billing?status=PENDING"
            />
            {/* Token Display board launcher. RECEPTION has an empty 6th KPI
                slot (Today's Revenue is ADMIN-only), so the live waiting-room
                token board lives here. `?scoped=1` makes the board fetch the
                authenticated, tenant-scoped queue so the receptionist only
                sees their own hospital's doctors. Opens in the same tab;
                Esc / the X button on the board return here. */}
            {isReception && (
              <StatCard
                title="Display Board"
                value="Open"
                subtitle="Live waiting-room board"
                icon={Monitor}
                color="bg-blue-600"
                href="/display?scoped=1"
              />
            )}
          </div>
          )
          )}

          {/* Role-specific primary sections.
              Issue #529 — same hard-zero-flash class as the KPI strip;
              gated on !loading so only the skeleton represents the
              in-flight state. */}
          {!loading && (isDoctor || isAdmin) && isWidgetVisible(widgets, "clinical_today") && (
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <ModuleSection
                title="Clinical — Today"
                icon={Activity}
                iconColor="bg-primary"
                viewAllHref="/dashboard/queue"
              >
                {/* Issue #505: rows here use tinted backgrounds (bg-*-50) that
                    swap to gray-800 in dark mode — bare `text-gray-700` was
                    sub-AA on the dark surface. */}
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between rounded-lg bg-blue-50 px-3 py-2 dark:bg-blue-900/30">
                    <span className="text-gray-800 dark:text-gray-100">In Queue</span>
                    <span className="font-bold text-primary dark:text-blue-300">
                      {fmt(data.inQueueCount)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-indigo-50 px-3 py-2 dark:bg-indigo-900/30">
                    <span className="text-gray-800 dark:text-gray-100">Admitted</span>
                    <span className="font-bold text-indigo-700 dark:text-indigo-300">
                      {fmt(data.currentlyAdmitted)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-purple-50 px-3 py-2 dark:bg-purple-900/30">
                    <span className="text-gray-800 dark:text-gray-100">Telemedicine Today</span>
                    <span className="font-bold text-purple-700 dark:text-purple-300">
                      {fmt(data.telemedicineToday)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-green-50 px-3 py-2 dark:bg-green-900/30">
                    <span className="text-gray-800 dark:text-gray-100">Surgeries Today</span>
                    <span className="font-bold text-green-700 dark:text-green-300">
                      {fmt(data.surgeriesScheduledToday)} scheduled,{" "}
                      {fmt(data.surgeriesInProgress)} active
                    </span>
                  </div>
                </div>
              </ModuleSection>

              <ModuleSection
                title="Diagnostics & Labs"
                icon={FlaskConical}
                iconColor="bg-teal-600"
                viewAllHref="/dashboard/lab"
              >
                {/* Issue #505: panel-row labels were `text-gray-700` only —
                    fine in light mode (~10.3:1 on white) but on the dark
                    `bg-gray-800` card they sat at ~3:1 and read as
                    "barely visible". Pair every label with `dark:text-gray-200`
                    so both modes clear WCAG AA 4.5:1. */}
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700 dark:text-gray-200">Pending Lab Orders</span>
                    <span className="font-bold text-gray-900 dark:text-gray-100">{fmt(data.pendingLabOrders)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700 dark:text-gray-200">Blood Units Available</span>
                    <Link href="/dashboard/bloodbank" className="font-bold text-red-600 dark:text-red-400">
                      {fmt(data.bloodUnitsAvailable)}
                    </Link>
                  </div>
                  {!!data.bloodUnitsExpiring && (
                    <div className="mt-1 flex items-center gap-2 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-200">
                      <AlertTriangle size={14} />
                      {data.bloodUnitsExpiring} blood unit(s) expiring soon
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700 dark:text-gray-200">Overdue Immunizations</span>
                    <Link href="/dashboard/immunization-schedule" className="font-bold text-orange-600 dark:text-orange-400">
                      {fmt(data.overdueImmunizations)}
                    </Link>
                  </div>
                </div>
              </ModuleSection>

              <ModuleSection
                title="Operations"
                icon={Package}
                iconColor="bg-amber-600"
                viewAllHref="/dashboard/pharmacy"
              >
                {/* Issue #505: same dark-mode contrast fix as Diagnostics. */}
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700 dark:text-gray-200">Low Stock Items</span>
                    <Link
                      href="/dashboard/pharmacy"
                      className={`font-bold ${data.lowStockCount ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                    >
                      {fmt(data.lowStockCount)}
                    </Link>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700 dark:text-gray-200">Staff On Duty</span>
                    <Link href="/dashboard/duty-roster" className="font-bold text-gray-900 dark:text-gray-100">
                      {fmt(data.staffOnDuty)}
                    </Link>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700 dark:text-gray-200">Active Visitors</span>
                    <Link href="/dashboard/visitors" className="font-bold text-gray-900 dark:text-gray-100">
                      {fmt(data.activeVisitors)}
                    </Link>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700 dark:text-gray-200">Open Complaints</span>
                    <Link
                      href="/dashboard/complaints"
                      className={`font-bold ${data.openComplaints ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                    >
                      {fmt(data.openComplaints)}
                    </Link>
                  </div>
                </div>
              </ModuleSection>
            </div>
          )}

          {/* Nurse dashboard emphasis. Issue #529 same gate. */}
          {!loading && isNurse && (
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ModuleSection
                title="Medications Due"
                icon={Pill}
                iconColor="bg-pink-600"
                viewAllHref="/dashboard/medication-dashboard"
              >
                <p className="text-3xl font-bold text-pink-700">
                  {fmt(data.medicationsDue)}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  scheduled in the next 30 minutes
                </p>
              </ModuleSection>

              <ModuleSection
                title="Emergency Queue"
                icon={Siren}
                iconColor="bg-red-600"
                viewAllHref="/dashboard/emergency"
              >
                <p className="text-3xl font-bold text-red-700">
                  {fmt(data.erWaiting)}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  {data.erCritical ?? 0} critical awaiting triage
                </p>
              </ModuleSection>

              <ModuleSection
                title="Admitted Patients"
                icon={BedDouble}
                iconColor="bg-indigo-600"
                viewAllHref="/dashboard/admissions"
              >
                <p className="text-3xl font-bold text-indigo-700">
                  {fmt(data.currentlyAdmitted)}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  {data.bedsOccupied}/{data.totalBeds} beds occupied
                </p>
              </ModuleSection>

              <ModuleSection
                title="Overdue Immunizations"
                icon={Syringe}
                iconColor="bg-orange-600"
                viewAllHref="/dashboard/immunization-schedule"
              >
                <p className="text-3xl font-bold text-orange-700">
                  {fmt(data.overdueImmunizations)}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  patients need follow-up
                </p>
              </ModuleSection>
            </div>
          )}

          {/* Reception emphasis. Issue #529 same gate. */}
          {!loading && isReception && (
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <ModuleSection
                title="Pending Billing"
                icon={CreditCard}
                iconColor="bg-accent"
                viewAllHref="/dashboard/billing"
              >
                <p className="text-3xl font-bold text-amber-700">
                  {fmt(data.pendingBills)}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  unpaid invoices
                </p>
              </ModuleSection>

              <ModuleSection
                title="Today's Queue"
                icon={Activity}
                iconColor="bg-primary"
                viewAllHref="/dashboard/queue"
              >
                <p className="text-3xl font-bold text-primary">
                  {fmt(data.inQueueCount)}
                </p>
                <p className="mt-1 text-xs text-gray-500">patients waiting</p>
              </ModuleSection>

              <ModuleSection
                title="Visitors"
                icon={UserCheck}
                iconColor="bg-purple-600"
                viewAllHref="/dashboard/visitors"
              >
                <p className="text-3xl font-bold text-purple-700">
                  {fmt(data.activeVisitors)}
                </p>
                <p className="mt-1 text-xs text-gray-500">currently in-building</p>
              </ModuleSection>
            </div>
          )}

          {/* Pharmacist dashboard detail — the actionable work lists that
              fill the space below the KPI strip + quick actions: scripts to
              dispense, items to reorder, and stock about to expire. */}
          {!loading && isPharmacistRole && (
            <div
              className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3"
              data-testid="pharmacist-sections"
            >
              <ModuleSection
                title="Dispense Queue"
                icon={Pill}
                iconColor="bg-primary"
                viewAllHref="/dashboard/pharmacy-kanban"
              >
                {(data.rxQueueItems?.length ?? 0) > 0 ? (
                  <ul className="space-y-2">
                    {data.rxQueueItems!.map((rx) => (
                      <li
                        key={rx.id}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="truncate text-gray-700 dark:text-gray-200">
                          {rx.patientLabel || "Patient"}
                          {rx.topItem ? ` · ${rx.topItem}` : ""}
                          {rx.extraItems ? ` +${rx.extraItems}` : ""}
                        </span>
                        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                          {rx.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    No prescriptions in the queue.
                  </p>
                )}
              </ModuleSection>

              <ModuleSection
                title="Ready for Pickup"
                icon={CheckCircle2}
                iconColor="bg-green-600"
                viewAllHref="/dashboard/pharmacy-kanban"
              >
                {(data.readyItems?.length ?? 0) > 0 ? (
                  <ul className="space-y-2">
                    {data.readyItems!.map((rx) => (
                      <li
                        key={rx.id}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="truncate text-gray-700 dark:text-gray-200">
                          {rx.patientLabel || "Patient"}
                          {rx.topItem ? ` · ${rx.topItem}` : ""}
                          {rx.extraItems ? ` +${rx.extraItems}` : ""}
                        </span>
                        <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/40 dark:text-green-300">
                          Bagged
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Nothing waiting for pickup.
                  </p>
                )}
              </ModuleSection>

              <ModuleSection
                title="Low Stock"
                icon={AlertTriangle}
                iconColor="bg-red-600"
                viewAllHref="/dashboard/pharmacy?tab=low"
              >
                {(data.lowStockItems?.length ?? 0) > 0 ? (
                  <ul className="space-y-2">
                    {data.lowStockItems!.map((it, i) => (
                      <li
                        key={it.id ?? i}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="truncate text-gray-700 dark:text-gray-200">
                          {it.name || "Medicine"}
                        </span>
                        <span className="shrink-0 text-xs font-medium text-red-600 dark:text-red-400">
                          {fmt(it.quantity)} / {fmt(it.reorderLevel)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    All items are above their reorder level.
                  </p>
                )}
              </ModuleSection>

              <ModuleSection
                title="Expiring Soon (30d)"
                icon={Package}
                iconColor="bg-secondary"
                viewAllHref="/dashboard/pharmacy?tab=expiring"
              >
                {(data.expiringItems?.length ?? 0) > 0 ? (
                  <ul className="space-y-2">
                    {data.expiringItems!.map((it, i) => (
                      <li
                        key={it.id ?? i}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="truncate text-gray-700 dark:text-gray-200">
                          {it.name || "Medicine"}
                        </span>
                        <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                          {it.expiryDate
                            ? new Date(it.expiryDate).toLocaleDateString("en-IN")
                            : "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Nothing expiring in the next 30 days.
                  </p>
                )}
              </ModuleSection>

              <ModuleSection
                title="Suppliers"
                icon={Users}
                iconColor="bg-blue-600"
                viewAllHref="/dashboard/suppliers"
              >
                {(data.supplierItems?.length ?? 0) > 0 ? (
                  <ul className="space-y-2">
                    {data.supplierItems!.map((s, i) => (
                      <li
                        key={s.id ?? i}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="truncate text-gray-700 dark:text-gray-200">
                          {s.name || "Supplier"}
                          {s.openOrders
                            ? ` · ${s.openOrders} order${s.openOrders === 1 ? "" : "s"}`
                            : ""}
                        </span>
                        {s.outstandingAmount ? (
                          <span className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">
                            ₹{fmt(s.outstandingAmount)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    No active suppliers yet.
                  </p>
                )}
              </ModuleSection>

              <ModuleSection
                title="Purchase Orders"
                icon={CreditCard}
                iconColor="bg-amber-600"
                viewAllHref="/dashboard/purchase-orders"
              >
                {(data.purchaseOrderItems?.length ?? 0) > 0 ? (
                  <ul className="space-y-2">
                    {data.purchaseOrderItems!.map((po, i) => (
                      <li
                        key={po.id ?? i}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="truncate text-gray-700 dark:text-gray-200">
                          {po.poNumber || "PO"}
                          {po.supplierName ? ` · ${po.supplierName}` : ""}
                        </span>
                        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                          {po.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    No purchase orders yet.
                  </p>
                )}
              </ModuleSection>
            </div>
          )}

          {/* Admin summary — deeper financial & operational section. Issue
              #529 same gate as the rest of the dashboard. */}
          {!loading && isAdmin && (
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-4">
              <StatCard
                title="Surgeries In Progress"
                value={fmt(data.surgeriesInProgress)}
                icon={Scissors}
                color="bg-red-600"
                href="/dashboard/surgery"
              />
              <StatCard
                title="Patient Rating"
                value={
                  data.avgRating
                    ? `${data.avgRating.toFixed(1)} ★`
                    : "N/A"
                }
                icon={Star}
                color="bg-yellow-500"
                href="/dashboard/feedback"
              />
              <StatCard
                title="Telemedicine"
                value={fmt(data.telemedicineToday)}
                subtitle="scheduled today"
                icon={Video}
                color="bg-purple-600"
                href="/dashboard/telemedicine"
              />
              <StatCard
                title="Pending Leaves"
                value={fmt(data.pendingLeaves)}
                icon={Clock}
                color="bg-blue-600"
                href="/dashboard/leave-management"
              />
            </div>
          )}

          {/* Quick Actions by role.
              Issues #648/#682: when the caller's role is none of
              RECEPTION/ADMIN/DOCTOR/NURSE (e.g. PHARMACIST, LAB_TECH,
              ACCOUNTANT, AMBULANCE_DRIVER), every conditional branch
              below was false and the page rendered an empty grid under
              the "Quick Actions" heading — read by users as a broken
              panel. We now render a placeholder line instead so the
              section explains itself for unmatched roles. */}
          {isWidgetVisible(widgets, "quick_actions") && (
          <div className="mt-8" data-testid="quick-actions-panel">
            <h2 className="mb-4 text-base font-semibold text-gray-900 dark:text-gray-100">
              Quick Actions
            </h2>
            {!(isReception || isAdmin || isDoctor || isNurse || isLabTechRole || isPharmacistRole) ? (
              <p
                className="rounded-xl border border-dashed border-gray-300 bg-white p-4 text-center text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
                data-testid="quick-actions-empty"
              >
                Quick actions will appear here based on your role.
              </p>
            ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {/* Issue #629 — LAB_TECH quick actions: STAT queue, sample
                  collection, result entry, test catalog. Replaces the
                  empty-grid render that was confusing users. */}
              {isLabTechRole && (
                <>
                  <QuickAction href="/dashboard/lab?stat=true" icon={AlertTriangle} label="STAT Queue" />
                  <QuickAction href="/dashboard/lab?status=ORDERED" icon={FlaskConical} label="Collect Samples" />
                  <QuickAction href="/dashboard/lab?status=SAMPLE_COLLECTED" icon={Activity} label="Enter Results" />
                  <QuickAction href="/dashboard/lab?status=IN_PROGRESS" icon={Clock} label="In Progress" />
                  <QuickAction href="/dashboard/lab?status=COMPLETED" icon={CheckCircle2} label="Completed" />
                  <QuickAction href="/dashboard/lab/qc" icon={FileText} label="QC Queue" />
                </>
              )}
              {isPharmacistRole && (
                <>
                  <QuickAction href="/dashboard/pharmacy-kanban" icon={Pill} label="Dispense Queue" />
                  <QuickAction href="/dashboard/prescriptions" icon={FileText} label="Prescriptions" />
                  <QuickAction href="/dashboard/pharmacy" icon={Package} label="Inventory" />
                  <QuickAction href="/dashboard/pharmacy" icon={AlertTriangle} label="Low Stock" />
                  <QuickAction href="/dashboard/purchase-orders" icon={CreditCard} label="Purchase Orders" />
                  <QuickAction href="/dashboard/suppliers" icon={Users} label="Suppliers" />
                </>
              )}
              {(isReception || isAdmin) && (
                <>
                  <QuickAction href="/dashboard/walk-in" icon={Users} label="Walk-in" />
                  <QuickAction href="/dashboard/appointments?book=1" icon={Calendar} label="Book Appt" />
                  <QuickAction href="/dashboard/billing" icon={CreditCard} label="Bills" />
                  <QuickAction href="/dashboard/visitors" icon={UserCheck} label="Check-in Visitor" />
                  <QuickAction href="/dashboard/emergency" icon={Siren} label="ER Intake" />
                  <QuickAction href="/dashboard/ambulance" icon={AmbulanceIcon} label="Dispatch Ambulance" />
                </>
              )}
              {isDoctor && (
                <>
                  <QuickAction href="/dashboard/queue" icon={Activity} label="My Queue" />
                  <QuickAction href="/dashboard/prescriptions" icon={FileText} label="Prescriptions" />
                  <QuickAction href="/dashboard/telemedicine" icon={Video} label="Telemedicine" />
                  <QuickAction href="/dashboard/lab" icon={FlaskConical} label="Order Labs" />
                  <QuickAction href="/dashboard/surgery" icon={Scissors} label="Schedule Surgery" />
                  <QuickAction href="/dashboard/referrals" icon={Heart} label="Refer Patient" />
                </>
              )}
              {isNurse && (
                <>
                  <QuickAction href="/dashboard/vitals" icon={Activity} label="Record Vitals" />
                  <QuickAction href="/dashboard/medication-dashboard" icon={Pill} label="Medications" />
                  <QuickAction href="/dashboard/emergency" icon={Siren} label="ER Triage" />
                  <QuickAction href="/dashboard/admissions" icon={BedDouble} label="Admissions" />
                  <QuickAction href="/dashboard/bloodbank" icon={Droplet} label="Blood Bank" />
                  <QuickAction href="/dashboard/immunization-schedule" icon={Syringe} label="Immunizations" />
                </>
              )}
              {isAdmin && (
                <>
                  <QuickAction href="/dashboard/analytics" icon={TrendingUp} label="Analytics" />
                  <QuickAction href="/dashboard/reports" icon={FileText} label="Reports" />
                  <QuickAction href="/dashboard/users" icon={Users} label="Users" />
                  <QuickAction href="/dashboard/expenses" icon={CreditCard} label="Expenses" />
                  <QuickAction href="/dashboard/purchase-orders" icon={Package} label="POs" />
                  <QuickAction href="/dashboard/audit" icon={CheckCircle2} label="Audit Log" />
                </>
              )}
            </div>
            )}
          </div>
          )}
        </>
      )}
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
}) {
  // Issue #504: the dashed border + light-tinted icon + `text-gray-700` label
  // combined to read as "disabled" on the hosted theme — users perceived the
  // tiles as inactive even though they are functional links. Bumped:
  //   - border tone to `border-gray-300` (light) / `border-gray-600` (dark)
  //   - label to `text-gray-900 dark:text-gray-100` for full WCAG AA on both
  //     `bg-white` (~16:1) and `bg-gray-800` (~14:1).
  //   - card background to solid white / dark gray-800 so the tile doesn't
  //     blend into its parent.
  return (
    <Link
      href={href}
      className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-gray-300 bg-white p-4 text-center transition hover:border-primary hover:bg-blue-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:border-primary dark:hover:bg-blue-900/30"
    >
      <Icon className="text-primary dark:text-blue-300" size={24} aria-hidden="true" />
      <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">{label}</span>
    </Link>
  );
}

// ──────────────────────────────────────────────────────────
// Patient Portal Home
// ──────────────────────────────────────────────────────────

// Issue #867: friendly labels for AppointmentType enum values so the
// patient hero card matches the My Appointments list ("Walk-in", not
// "WALK_IN"). Keep this local — it's used only by the patient dashboard.
const APPT_TYPE_LABELS: Record<string, string> = {
  WALK_IN: "Walk-in",
  TELEMEDICINE: "Telemedicine",
  IN_PERSON: "In-person",
  FOLLOW_UP: "Follow-up",
  EMERGENCY: "Emergency",
  SCHEDULED: "Scheduled",
};
function displayApptType(raw: string | null | undefined): string {
  if (!raw) return "—";
  if (APPT_TYPE_LABELS[raw]) return APPT_TYPE_LABELS[raw];
  // Best-effort fallback: TITLE_CASE → Title case with hyphens.
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function PatientHome() {
  const [upcoming, setUpcoming] = useState<any | null>(null);
  const [bills, setBills] = useState<any[]>([]);
  const [rx, setRx] = useState<any[]>([]);
  const [labs, setLabs] = useState<any[]>([]);
  const [notifs, setNotifs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Issue #404: track which cards failed so we can render an em-dash
  // placeholder instead of a misleading empty state. Previously a single
  // rejected fetch left the whole grid stuck on skeletons because the
  // setLoading(false) call was guarded behind a `Promise.all` that, while
  // each promise had a `.catch`, was still vulnerable to any unhandled
  // throw inside the body (e.g. `.sort()` on a non-array shape from a
  // partially-broken endpoint). We now use Promise.allSettled and unpack
  // each result independently with strict shape checks.
  const [billsFailed, setBillsFailed] = useState(false);
  const [rxFailed, setRxFailed] = useState(false);
  const [labsFailed, setLabsFailed] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const today = new Date().toISOString().split("T")[0];
      const settled = await Promise.allSettled([
        api.get<{ data: any[] }>(
          `/appointments?mine=true&from=${today}&status=BOOKED,CHECKED_IN&limit=5`
        ),
        // /billing/invoices accepts ?mine=true (apps/api/src/routes/billing.ts);
        // PATIENT role is auto-scoped server-side so this is a no-op the
        // server tolerates — kept for self-documentation.
        api.get<{ data: any[] }>(
          `/billing/invoices?mine=true&status=PENDING,PARTIAL&limit=5`
        ),
        // /prescriptions auto-scopes PATIENT to their patientId; ?mine=true
        // is a hint, not enforced.
        api.get<{ data: any[] }>(`/prescriptions?mine=true&limit=5`),
        // /lab/orders ditto — auto-scopes PATIENT inline.
        api.get<{ data: any[] }>(`/lab/orders?mine=true&limit=5`),
        api.get<{ data: any[] }>(`/notifications?unread=true&limit=5`),
      ]);
      const safeArr = (s: PromiseSettledResult<{ data: any[] }>): any[] => {
        if (s.status !== "fulfilled") return [];
        const arr = s.value?.data;
        return Array.isArray(arr) ? arr : [];
      };
      const apArr = safeArr(settled[0]);
      // Issue #546 (2026-05-05) + Issue #865 (2026-05-19): the API filter
      // `from=today` is silently ignored by the appointments list handler
      // (apps/api/src/routes/appointments.ts:303 doesn't read `from`), so a
      // PATIENT's full BOOKED history comes back ordered DESC. Apr-14 rows
      // were still surfacing on the patient dashboard's "My Upcoming" card
      // on May-11+. Belt-and-braces:
      //   1. Drop anything strictly before the start of today's local day.
      //   2. Compare on a YYYY-MM-DD basis (not ISO time) to avoid the
      //      timezone-shift class — `a.date` may arrive as "2026-04-14"
      //      OR "2026-04-14T00:00:00.000Z" depending on the row's storage,
      //      and `new Date("2026-04-14")` parses as UTC midnight which can
      //      land on May-10 in IST around the edge.
      //   3. Restrict to truly upcoming statuses (BOOKED / CHECKED_IN).
      //      A CANCELLED / COMPLETED / NO_SHOW row should never be the
      //      "My Upcoming Appointment" hero.
      //   4. Sort ASCENDING and pick the earliest upcoming row.
      const now = new Date();
      const todayYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const UPCOMING_STATUSES = new Set(["BOOKED", "CHECKED_IN"]);
      const dateYmd = (raw: unknown): string | null => {
        if (typeof raw !== "string") return null;
        // Bare YYYY-MM-DD OR full ISO — just take the first 10 chars,
        // which is always the date in the API's wire format.
        return raw.length >= 10 ? raw.slice(0, 10) : null;
      };
      const futureOnly = apArr.filter((a: any) => {
        const ymd = dateYmd(a?.date);
        if (!ymd) return false;
        if (ymd < todayYmd) return false;
        if (!UPCOMING_STATUSES.has(a?.status)) return false;
        return true;
      });
      const upc = futureOnly.sort((a: any, b: any) => {
        const ay = dateYmd(a.date) ?? "";
        const by = dateYmd(b.date) ?? "";
        if (ay !== by) return ay.localeCompare(by);
        // Tie-break on slotStart so an earlier slot today wins over a
        // later one — keeps the hero card pointed at the next consult.
        const as = String(a.slotStart ?? "");
        const bs = String(b.slotStart ?? "");
        return as.localeCompare(bs);
      })[0];
      setUpcoming(upc || null);
      setBills(safeArr(settled[1]));
      setBillsFailed(settled[1].status === "rejected");
      setRx(safeArr(settled[2]).slice(0, 5));
      setRxFailed(settled[2].status === "rejected");
      setLabs(safeArr(settled[3]).slice(0, 5));
      setLabsFailed(settled[3].status === "rejected");
      setNotifs(safeArr(settled[4]).slice(0, 5));
      setLoading(false);
    })();
  }, []);

  return (
    <div className="space-y-4">
      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <QuickAction
          href="/dashboard/ai-booking"
          icon={Calendar}
          label="Book Appointment"
        />
        <QuickAction
          href="/dashboard/ai-booking?mode=telemedicine"
          icon={Video}
          label="Telemedicine"
        />
        <QuickAction
          href="/dashboard/prescriptions"
          icon={FileText}
          label="My Prescriptions"
        />
        <QuickAction
          href="/dashboard/billing"
          icon={CreditCard}
          label="My Bills"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Upcoming appointment */}
        <div className="rounded-xl bg-white dark:bg-gray-800 p-5 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
            <Calendar size={14} /> My Upcoming Appointment
          </h2>
          {!upcoming ? (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-400 dark:text-gray-500">No upcoming appointments</p>
              <Link
                href="/dashboard/ai-booking"
                className="mt-2 inline-block rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:opacity-90"
              >
                Book one now
              </Link>
            </div>
          ) : (
            <div className="rounded-lg bg-gradient-to-br from-blue-50 to-white p-4 dark:from-blue-900/30 dark:to-gray-800">
              <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">
                {new Date(upcoming.date).toLocaleDateString("en-IN", {
                  weekday: "long",
                  day: "numeric",
                  month: "short",
                })}{" "}
                {upcoming.slotStart && (
                  <span className="text-primary dark:text-primary-300">· {upcoming.slotStart}</span>
                )}
              </p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {upcoming.doctor?.user?.name ? formatDoctorName(upcoming.doctor.user.name) : "—"}
                {upcoming.doctor?.specialization
                  ? ` · ${upcoming.doctor.specialization}`
                  : ""}
              </p>
              {/* Issue #867: don't expose raw enums — map WALK_IN, TELEMEDICINE,
                  IN_PERSON, FOLLOW_UP, EMERGENCY to friendly labels matching
                  the My Appointments list (which already uses "Walk-in"). */}
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                Type: {displayApptType(upcoming.type)}
              </p>
              <div className="mt-3 flex gap-2">
                {upcoming.type === "TELEMEDICINE" && (
                  <Link
                    href={`/dashboard/telemedicine?id=${upcoming.id}`}
                    className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700"
                  >
                    Join Session
                  </Link>
                )}
                {/* Issue #864: CTA was border-only + transparent bg — on the
                    dark surface the chip's text picked up the dark-mode body
                    colour against the dark card and rendered invisible.
                    Force a primary-tinted button with explicit text + bg in
                    both modes. */}
                <Link
                  href={`/dashboard/appointments?id=${upcoming.id}`}
                  className="rounded-lg border border-primary/30 bg-white px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 dark:border-primary-400/40 dark:bg-primary-500/20 dark:text-primary-100 dark:hover:bg-primary-500/30"
                >
                  View Details
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* Pending bills */}
        <div className="rounded-xl bg-white dark:bg-gray-800 p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
              <CreditCard size={14} /> My Pending Bills
            </h2>
            <Link
              href="/dashboard/billing"
              className="text-xs text-primary hover:underline dark:text-primary-300"
            >
              All bills
            </Link>
          </div>
          {bills.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">
              {/* Issue #404: when the fetch fails we no longer want a falsely
                  cheerful "No pending bills" — show the em-dash placeholder
                  the same way `formatINR(null)` would render. */}
              {billsFailed ? "—" : "No pending bills"}
            </p>
          ) : (
            <div className="space-y-2">
              {bills.map((b: any) => (
                <div
                  key={b.id}
                  className="flex items-center gap-3 rounded-lg border border-amber-100 bg-amber-50/40 p-3 dark:border-amber-900/40 dark:bg-amber-900/20"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                      {/* Issue #403: canonical ₹ formatter, no more "Rs." */}
                      {formatINR(b.totalAmount || 0)}
                    </p>
                    {/* Issue #863: subtitle was text-gray-500 — invisible on
                        the dark card. Pair with dark:text-gray-300 for AA. */}
                    <p className="truncate text-[11px] text-gray-500 dark:text-gray-300">
                      {/* Issue #438: shared `DD MMM YYYY` formatter. */}
                      #{b.invoiceNumber} · {formatDate(b.createdAt)}
                    </p>
                  </div>
                  <Link
                    href={`/dashboard/billing?id=${b.id}&pay=1`}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
                  >
                    Pay Online
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Prescriptions */}
        <div className="rounded-xl bg-white dark:bg-gray-800 p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
              <FileText size={14} /> Recent Prescriptions
            </h2>
            <Link
              href="/dashboard/prescriptions"
              className="text-xs text-primary hover:underline dark:text-primary-300"
            >
              All
            </Link>
          </div>
          {rx.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">
              {rxFailed ? "—" : "No prescriptions yet"}
            </p>
          ) : (
            <div className="space-y-2">
              {rx.map((p: any) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg border border-green-100 bg-green-50/40 p-3 dark:border-green-900/40 dark:bg-green-900/20"
                >
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">
                      {p.diagnosis}
                    </p>
                    {/* Issue #863: subtitle was text-gray-500 — invisible on
                        the dark card. Pair with dark:text-gray-300 for AA. */}
                    <p className="truncate text-[11px] text-gray-500 dark:text-gray-300">
                      {/* Issue #438: shared `DD MMM YYYY` formatter. */}
                      {p.doctor?.user?.name ? formatDoctorName(p.doctor.user.name) : "—"} ·{" "}
                      {formatDate(p.createdAt)}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Link
                      href={`/dashboard/prescriptions?id=${p.id}`}
                      className="rounded-lg border px-2 py-1 text-[11px] hover:bg-white dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      View
                    </Link>
                    {p.pdfUrl && (
                      <a
                        href={p.pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg bg-green-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-green-700"
                      >
                        PDF
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Lab results */}
        <div className="rounded-xl bg-white dark:bg-gray-800 p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <FlaskConical size={14} /> Recent Lab Results
            </h2>
            <Link
              href="/dashboard/lab"
              className="text-xs text-primary hover:underline"
            >
              All
            </Link>
          </div>
          {labs.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">
              {labsFailed ? "—" : "No lab results"}
            </p>
          ) : (
            <div className="space-y-2">
              {labs.map((l: any) => (
                <Link
                  key={l.id}
                  href={`/dashboard/lab?id=${l.id}`}
                  className="flex items-center gap-3 rounded-lg border border-gray-100 p-2.5 hover:border-primary/40"
                >
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium">
                      Order #{l.orderNumber}
                    </p>
                    <p className="truncate text-[11px] text-gray-500">
                      {/* Issue #438: shared `DD MMM YYYY` formatter. */}
                      {formatDate(l.orderedAt)} ·{" "}
                      {l.items?.length || 0} test
                      {l.items?.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      l.status === "COMPLETED"
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {l.status}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Notifications */}
        <div className="rounded-xl bg-white dark:bg-gray-800 p-5 shadow-sm lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Bell size={14} /> Notifications
            </h2>
            <Link
              href="/dashboard/notifications"
              className="text-xs text-primary hover:underline"
            >
              View all
            </Link>
          </div>
          {notifs.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-400">
              You&apos;re all caught up
            </p>
          ) : (
            <div className="space-y-1.5">
              {notifs.map((n: any) => (
                <div
                  key={n.id}
                  className="flex items-start gap-3 rounded-lg border border-gray-100 p-2.5"
                >
                  <Bell size={14} className="mt-0.5 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-800">
                      {n.title}
                    </p>
                    <p className="truncate text-[11px] text-gray-500">
                      {n.message}
                    </p>
                  </div>
                  <span className="shrink-0 text-[10px] text-gray-400">
                    {new Date(n.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {loading && (
        <p className="text-center text-xs text-gray-400">Loading…</p>
      )}
    </div>
  );
}
