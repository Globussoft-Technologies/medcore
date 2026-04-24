"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { api } from "@/lib/api";
import { formatDoctorName } from "@/lib/format-doctor-name";
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
  // Lab
  pendingLabOrders?: number;
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
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            {title}
          </p>
          <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
          {subtitle && (
            <p className="mt-1 text-xs text-gray-500">{subtitle}</p>
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
}: {
  open: boolean;
  initial: DashboardWidget[];
  onClose: () => void;
  onSave: (widgets: DashboardWidget[]) => void;
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
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold">Customize Dashboard</h2>
        <p className="mb-4 text-sm text-gray-500">
          Toggle sections on or off. Your preferences are saved.
        </p>
        <div className="mb-6 space-y-2">
          {(Object.keys(WIDGET_LABELS) as WidgetKey[]).map((k) => {
            const w = widgets.find((x) => x.type === k);
            const visible = !w || w.visible !== false;
            return (
              <label
                key={k}
                className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={() => toggle(k)}
                  className="h-4 w-4"
                />
                <span className="text-sm">{WIDGET_LABELS[k]}</span>
              </label>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
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
      const role = user?.role;
      const canSeeAnalytics = role === "ADMIN" || role === "RECEPTION";
      const canSeeAdminHR = role === "ADMIN";

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
        safeGet<any>(`/patients?limit=1`, { meta: { total: 0 } }),
        safeGet<any>(`/billing/invoices?status=PENDING&limit=1`, { meta: { total: 0 } }),
        safeGet<any>(`/billing/invoices?status=PARTIAL&limit=1`, { meta: { total: 0 } }),
        safeGet<any>(`/queue`, { data: [] }),
        safeGet<any>(`/admissions?status=ADMITTED&limit=1`, { meta: { total: 0 } }),
        safeGet<any>(`/wards`, { data: [] }),
        safeGet<any>(`/emergency/cases/active`, { data: [] }),
        safeGet<any>(`/pharmacy/inventory?lowStock=true&limit=1`, { meta: { total: 0 } }),
        safeGet<any>(`/lab/orders?status=ORDERED&limit=1`, { meta: { total: 0 } }),
        safeGet<any>(`/bloodbank/inventory/summary`, { data: null }),
        safeGet<any>(`/surgery?status=SCHEDULED&from=${today}&to=${today}&limit=1`, { meta: { total: 0 } }),
        safeGet<any>(`/surgery?status=IN_PROGRESS&limit=1`, { meta: { total: 0 } }),
        safeGet<any>(`/shifts/roster?date=${today}`, { data: [] }),
        canSeeAdminHR
          ? safeGet<any>(`/leaves/pending`, { data: [] })
          : Promise.resolve({ data: [] }),
        canSeeAnalytics
          ? safeGet<any>(`/feedback/summary`, { data: null })
          : Promise.resolve({ data: null }),
        safeGet<any>(`/complaints?status=OPEN&limit=1`, { meta: { total: 0 } }),
        canSeeAnalytics
          ? safeGet<any>(`/analytics/overview?from=${today}&to=${today}`, { data: null })
          : Promise.resolve({ data: null }),
        safeGet<any>(`/medication/administrations/due`, { data: [] }),
        safeGet<any>(`/telemedicine?date=${today}&limit=1`, { meta: { total: 0 } }),
        safeGet<any>(`/ehr/immunizations/schedule?filter=overdue`, { data: [] }),
        safeGet<any>(`/visitors/active`, { data: [] }),
      ]);

      // Compute totals
      const totalInQueue = (queue.data ?? []).reduce(
        (sum: number, doc: any) => sum + (doc.waitingCount || 0),
        0
      );

      const wardStats = (wards.data ?? []).reduce(
        (acc: any, w: any) => {
          const total = w.beds?.length || w.totalBeds || 0;
          const occupied = w.beds?.filter((b: any) => b.status === "OCCUPIED").length ?? w.occupiedBeds ?? 0;
          acc.total += total;
          acc.occupied += occupied;
          return acc;
        },
        { total: 0, occupied: 0 }
      );

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
        pendingLabOrders: labOrders.meta?.total ?? 0,
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
    // Depend on user.role so that once the session hydrates, the load() call
    // re-runs with the correct role-gating for admin-only endpoints (#31).
  }, [user?.role]);

  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isDoctor = role === "DOCTOR";
  const isNurse = role === "NURSE";
  const isReception = role === "RECEPTION";
  const isPatient = role === "PATIENT";

  const fmt = (n?: number) => (n ?? 0).toLocaleString("en-IN");
  const money = (n?: number) =>
    `Rs. ${(n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  return (
    <div>
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
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Customize Dashboard
            </button>
          )}
          {role && (
            <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              {role}
            </span>
          )}
        </div>
      </div>

      <CustomizeDashboardModal
        open={showCustomize}
        initial={widgets}
        onClose={() => setShowCustomize(false)}
        onSave={saveWidgets}
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
          {/* Top KPI strip */}
          {isWidgetVisible(widgets, "kpi_top") && (
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
            <StatCard
              title={t("dashboard.home.kpi.todayRevenue")}
              value={money(data.todayRevenue)}
              icon={TrendingUp}
              color="bg-emerald-600"
              href="/dashboard/reports"
            />
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
            <StatCard
              title={t("dashboard.home.kpi.pendingBills")}
              value={fmt(data.pendingBills)}
              icon={CreditCard}
              color="bg-accent"
              href="/dashboard/billing"
            />
          </div>
          )}

          {/* Role-specific primary sections */}
          {(isDoctor || isAdmin) && isWidgetVisible(widgets, "clinical_today") && (
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <ModuleSection
                title="Clinical — Today"
                icon={Activity}
                iconColor="bg-primary"
                viewAllHref="/dashboard/queue"
              >
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between rounded-lg bg-blue-50 px-3 py-2">
                    <span className="text-gray-700">In Queue</span>
                    <span className="font-bold text-primary">
                      {fmt(data.inQueueCount)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-indigo-50 px-3 py-2">
                    <span className="text-gray-700">Admitted</span>
                    <span className="font-bold text-indigo-700">
                      {fmt(data.currentlyAdmitted)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-purple-50 px-3 py-2">
                    <span className="text-gray-700">Telemedicine Today</span>
                    <span className="font-bold text-purple-700">
                      {fmt(data.telemedicineToday)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-green-50 px-3 py-2">
                    <span className="text-gray-700">Surgeries Today</span>
                    <span className="font-bold text-green-700">
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
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700">Pending Lab Orders</span>
                    <span className="font-bold">{fmt(data.pendingLabOrders)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700">Blood Units Available</span>
                    <Link href="/dashboard/bloodbank" className="font-bold text-red-600">
                      {fmt(data.bloodUnitsAvailable)}
                    </Link>
                  </div>
                  {!!data.bloodUnitsExpiring && (
                    <div className="mt-1 flex items-center gap-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">
                      <AlertTriangle size={14} />
                      {data.bloodUnitsExpiring} blood unit(s) expiring soon
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700">Overdue Immunizations</span>
                    <Link href="/dashboard/immunization-schedule" className="font-bold text-orange-600">
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
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700">Low Stock Items</span>
                    <Link
                      href="/dashboard/pharmacy"
                      className={`font-bold ${data.lowStockCount ? "text-red-600" : "text-green-600"}`}
                    >
                      {fmt(data.lowStockCount)}
                    </Link>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700">Staff On Duty</span>
                    <Link href="/dashboard/duty-roster" className="font-bold">
                      {fmt(data.staffOnDuty)}
                    </Link>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700">Active Visitors</span>
                    <Link href="/dashboard/visitors" className="font-bold">
                      {fmt(data.activeVisitors)}
                    </Link>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-700">Open Complaints</span>
                    <Link
                      href="/dashboard/complaints"
                      className={`font-bold ${data.openComplaints ? "text-red-600" : "text-green-600"}`}
                    >
                      {fmt(data.openComplaints)}
                    </Link>
                  </div>
                </div>
              </ModuleSection>
            </div>
          )}

          {/* Nurse dashboard emphasis */}
          {isNurse && (
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

          {/* Reception emphasis */}
          {isReception && (
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

          {/* Admin summary — deeper financial & operational section */}
          {isAdmin && (
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

          {/* Quick Actions by role */}
          <div className="mt-8">
            <h2 className="mb-4 text-base font-semibold text-gray-900 dark:text-gray-100">
              Quick Actions
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
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
          </div>
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
  return (
    <Link
      href={href}
      className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-gray-200 p-4 text-center transition hover:border-primary hover:bg-blue-50"
    >
      <Icon className="text-primary" size={24} />
      <span className="text-xs font-medium text-gray-700">{label}</span>
    </Link>
  );
}

// ──────────────────────────────────────────────────────────
// Patient Portal Home
// ──────────────────────────────────────────────────────────

function PatientHome() {
  const [upcoming, setUpcoming] = useState<any | null>(null);
  const [bills, setBills] = useState<any[]>([]);
  const [rx, setRx] = useState<any[]>([]);
  const [labs, setLabs] = useState<any[]>([]);
  const [notifs, setNotifs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const today = new Date().toISOString().split("T")[0];
      const [ap, inv, rxRes, labRes, noRes] = await Promise.all([
        api
          .get<{ data: any[] }>(
            `/appointments?mine=true&from=${today}&status=BOOKED,CHECKED_IN&limit=5`
          )
          .catch(() => ({ data: [] })),
        api
          .get<{ data: any[] }>(
            `/billing/invoices?mine=true&status=PENDING,PARTIAL&limit=5`
          )
          .catch(() => ({ data: [] })),
        api
          .get<{ data: any[] }>(`/prescriptions?mine=true&limit=5`)
          .catch(() => ({ data: [] })),
        api
          .get<{ data: any[] }>(`/lab/orders?mine=true&limit=5`)
          .catch(() => ({ data: [] })),
        api
          .get<{ data: any[] }>(`/notifications?unread=true&limit=5`)
          .catch(() => ({ data: [] })),
      ]);
      const upc = (ap.data || []).sort(
        (a: any, b: any) =>
          new Date(a.date).getTime() - new Date(b.date).getTime()
      )[0];
      setUpcoming(upc || null);
      setBills(inv.data || []);
      setRx((rxRes.data || []).slice(0, 5));
      setLabs((labRes.data || []).slice(0, 5));
      setNotifs((noRes.data || []).slice(0, 5));
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
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700">
            <Calendar size={14} /> My Upcoming Appointment
          </h2>
          {!upcoming ? (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-400">No upcoming appointments</p>
              <Link
                href="/dashboard/ai-booking"
                className="mt-2 inline-block rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:opacity-90"
              >
                Book one now
              </Link>
            </div>
          ) : (
            <div className="rounded-lg bg-gradient-to-br from-blue-50 to-white p-4">
              <p className="text-lg font-semibold text-gray-800">
                {new Date(upcoming.date).toLocaleDateString("en-IN", {
                  weekday: "long",
                  day: "numeric",
                  month: "short",
                })}{" "}
                {upcoming.slotStart && (
                  <span className="text-primary">· {upcoming.slotStart}</span>
                )}
              </p>
              <p className="mt-1 text-sm text-gray-600">
                {upcoming.doctor?.user?.name ? formatDoctorName(upcoming.doctor.user.name) : "—"}
                {upcoming.doctor?.specialization
                  ? ` · ${upcoming.doctor.specialization}`
                  : ""}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                Type: {upcoming.type}
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
                <Link
                  href={`/dashboard/appointments?id=${upcoming.id}`}
                  className="rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
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
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <CreditCard size={14} /> My Pending Bills
            </h2>
            <Link
              href="/dashboard/billing"
              className="text-xs text-primary hover:underline"
            >
              All bills
            </Link>
          </div>
          {bills.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">
              No pending bills 🎉
            </p>
          ) : (
            <div className="space-y-2">
              {bills.map((b: any) => (
                <div
                  key={b.id}
                  className="flex items-center gap-3 rounded-lg border border-amber-100 bg-amber-50/40 p-3"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-800">
                      Rs. {(b.totalAmount || 0).toLocaleString("en-IN")}
                    </p>
                    <p className="truncate text-[11px] text-gray-500">
                      #{b.invoiceNumber} ·{" "}
                      {new Date(b.createdAt).toLocaleDateString()}
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
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <FileText size={14} /> Recent Prescriptions
            </h2>
            <Link
              href="/dashboard/prescriptions"
              className="text-xs text-primary hover:underline"
            >
              All
            </Link>
          </div>
          {rx.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">
              No prescriptions yet
            </p>
          ) : (
            <div className="space-y-2">
              {rx.map((p: any) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg border border-green-100 bg-green-50/40 p-3"
                >
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-800">
                      {p.diagnosis}
                    </p>
                    <p className="truncate text-[11px] text-gray-500">
                      {p.doctor?.user?.name ? formatDoctorName(p.doctor.user.name) : "—"} ·{" "}
                      {new Date(p.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Link
                      href={`/dashboard/prescriptions?id=${p.id}`}
                      className="rounded-lg border px-2 py-1 text-[11px] hover:bg-white"
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
              No lab results
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
                      {new Date(l.orderedAt).toLocaleDateString()} ·{" "}
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
