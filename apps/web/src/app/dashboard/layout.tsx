"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
import { useThemeStore } from "@/lib/theme";
import { useTranslation } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { DialogProvider } from "@/lib/use-dialog";
import { KeyboardShortcutsModal } from "@/components/KeyboardShortcutsModal";
import { Tooltip } from "@/components/Tooltip";
import { HelpPanel } from "@/components/HelpPanel";
import {
  OnboardingTour,
  hasCompletedTour,
  resetTour,
} from "@/components/OnboardingTour";
import {
  LayoutDashboard,
  Calendar,
  Users,
  UserPlus,
  CreditCard,
  FileText,
  Activity,
  Monitor,
  LogOut,
  Stethoscope,
  BarChart3,
  UserCog,
  CalendarClock,
  Bell,
  Shield,
  TrendingUp,
  Hotel,
  BedDouble,
  Syringe,
  Pill,
  Package,
  FlaskConical,
  ArrowRightLeft,
  Scissors,
  Building,
  Gift,
  Truck,
  ShoppingCart,
  Wallet,
  CalendarDays,
  Users2,
  PlaneTakeoff,
  Baby,
  LineChart,
  Droplet,
  Ambulance,
  Wrench,
  Video,
  Siren,
  Star,
  AlertTriangle,
  MessageCircle,
  UserCheck,
  Undo2,
  Search,
  CalendarRange,
  Briefcase,
  PiggyBank,
  Megaphone,
  CalendarOff,
  ShieldAlert,
  Sun,
  Moon,
  Keyboard,
  Menu,
  Settings as SettingsIcon,
  Award,
  ClipboardList,
  FileCheck,
  Percent,
  Clock,
  Bot,
  Mic,
  Brain,
  Sparkles,
  FileJson,
  Workflow,
  Globe,
  ShieldCheck,
  Radio,
  Languages,
  ScanLine,
  FlaskRound,
  Bell as BellIcon,
  HeartPulse,
} from "lucide-react";
import clsx from "clsx";
import { SearchPalette } from "./_components/search-palette";

// Role-based bottom nav shortcuts (5 items, mobile only)
const bottomNavByRole: Record<
  string,
  Array<{ href: string; label: string; icon: React.ElementType }>
> = {
  ADMIN: [
    { href: "/dashboard", label: "Home", icon: LayoutDashboard },
    { href: "/dashboard/appointments", label: "Appts", icon: Calendar },
    { href: "/dashboard/patients", label: "Patients", icon: Users },
    { href: "/dashboard/analytics", label: "Stats", icon: TrendingUp },
    { href: "/dashboard/settings", label: "Settings", icon: SettingsIcon },
  ],
  DOCTOR: [
    { href: "/dashboard/workspace", label: "Workspace", icon: Briefcase },
    { href: "/dashboard/queue", label: "Queue", icon: Monitor },
    { href: "/dashboard/prescriptions", label: "Rx", icon: FileText },
    { href: "/dashboard/schedule", label: "Schedule", icon: CalendarClock },
    { href: "/dashboard/settings", label: "Profile", icon: SettingsIcon },
  ],
  NURSE: [
    { href: "/dashboard/workstation", label: "Work", icon: Activity },
    { href: "/dashboard/medication-dashboard", label: "Meds", icon: Syringe },
    { href: "/dashboard/vitals", label: "Vitals", icon: Activity },
    { href: "/dashboard/patients", label: "Patients", icon: Users },
    { href: "/dashboard/settings", label: "Profile", icon: SettingsIcon },
  ],
  RECEPTION: [
    { href: "/dashboard", label: "Home", icon: LayoutDashboard },
    { href: "/dashboard/appointments", label: "Appts", icon: Calendar },
    { href: "/dashboard/walk-in", label: "Walk-in", icon: UserPlus },
    { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
    { href: "/dashboard/visitors", label: "Visitors", icon: UserCheck },
  ],
  PATIENT: [
    { href: "/dashboard", label: "Home", icon: LayoutDashboard },
    { href: "/dashboard/appointments", label: "Appts", icon: Calendar },
    { href: "/dashboard/prescriptions", label: "Rx", icon: FileText },
    { href: "/dashboard/billing", label: "Bills", icon: CreditCard },
    { href: "/dashboard/settings", label: "Profile", icon: SettingsIcon },
  ],
};

const navByRole: Record<
  string,
  Array<{ href: string; label: string; icon: React.ElementType }>
> = {
  ADMIN: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/admin-console", label: "Admin Console", icon: LayoutDashboard },
    { href: "/dashboard/calendar", label: "Calendar", icon: CalendarRange },
    { href: "/dashboard/appointments", label: "Appointments", icon: Calendar },
    { href: "/dashboard/patients", label: "Patients", icon: Users },
    { href: "/dashboard/queue", label: "Queue", icon: Monitor },
    { href: "/dashboard/wards", label: "Wards", icon: Hotel },
    { href: "/dashboard/admissions", label: "Admissions", icon: BedDouble },
    { href: "/dashboard/medicines", label: "Medicines", icon: Pill },
    { href: "/dashboard/pharmacy", label: "Pharmacy", icon: Package },
    { href: "/dashboard/lab", label: "Lab", icon: FlaskConical },
    { href: "/dashboard/lab/qc", label: "Lab QC", icon: Activity },
    { href: "/dashboard/controlled-substances", label: "Controlled Register", icon: ShieldAlert },
    { href: "/dashboard/immunization-schedule", label: "Immunizations", icon: Syringe },
    { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
    { href: "/dashboard/refunds", label: "Refunds", icon: Undo2 },
    { href: "/dashboard/payment-plans", label: "Payment Plans", icon: CreditCard },
    { href: "/dashboard/preauth", label: "Pre-Authorization", icon: FileCheck },
    { href: "/dashboard/discount-approvals", label: "Discount Approvals", icon: Percent },
    { href: "/dashboard/packages", label: "Packages", icon: Gift },
    { href: "/dashboard/suppliers", label: "Suppliers", icon: Truck },
    { href: "/dashboard/purchase-orders", label: "Purchase Orders", icon: ShoppingCart },
    { href: "/dashboard/expenses", label: "Expenses", icon: Wallet },
    { href: "/dashboard/prescriptions", label: "Prescriptions", icon: FileText },
    { href: "/dashboard/doctors", label: "Doctors", icon: Stethoscope },
    { href: "/dashboard/referrals", label: "Referrals", icon: ArrowRightLeft },
    { href: "/dashboard/surgery", label: "Surgery", icon: Scissors },
    { href: "/dashboard/ot", label: "OTs", icon: Building },
    { href: "/dashboard/antenatal", label: "Antenatal", icon: Baby },
    { href: "/dashboard/pediatric", label: "Pediatric", icon: LineChart },
    { href: "/dashboard/bloodbank", label: "Blood Bank", icon: Droplet },
    { href: "/dashboard/ambulance", label: "Ambulance", icon: Ambulance },
    { href: "/dashboard/assets", label: "Assets", icon: Wrench },
    { href: "/dashboard/telemedicine", label: "Telemedicine", icon: Video },
    { href: "/dashboard/emergency", label: "Emergency", icon: Siren },
    { href: "/dashboard/users", label: "Users", icon: UserCog },
    { href: "/dashboard/duty-roster", label: "Duty Roster", icon: Users2 },
    { href: "/dashboard/leave-management", label: "Leave Requests", icon: PlaneTakeoff },
    { href: "/dashboard/leave-calendar", label: "Leave Calendar", icon: CalendarDays },
    { href: "/dashboard/holidays", label: "Holidays", icon: CalendarOff },
    { href: "/dashboard/payroll", label: "Payroll", icon: Wallet },
    { href: "/dashboard/certifications", label: "Certifications", icon: Award },
    { href: "/dashboard/census", label: "Census Report", icon: ClipboardList },
    { href: "/dashboard/budgets", label: "Budgets", icon: PiggyBank },
    { href: "/dashboard/broadcasts", label: "Broadcasts", icon: Megaphone },
    { href: "/dashboard/schedule", label: "Schedule", icon: CalendarClock },
    { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
    { href: "/dashboard/scheduled-reports", label: "Scheduled Reports", icon: Clock },
    { href: "/dashboard/analytics", label: "Analytics", icon: TrendingUp },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/audit", label: "Audit Log", icon: Shield },
    { href: "/dashboard/feedback", label: "Feedback", icon: Star },
    { href: "/dashboard/complaints", label: "Complaints", icon: AlertTriangle },
    { href: "/dashboard/chat", label: "Chat", icon: MessageCircle },
    { href: "/dashboard/visitors", label: "Visitors", icon: UserCheck },
    { href: "/dashboard/ai-booking", label: "AI Booking", icon: Bot },
    { href: "/dashboard/scribe", label: "AI Scribe", icon: Mic },
    { href: "/dashboard/ai/chart-search", label: "Chart Search", icon: Brain },
    { href: "/dashboard/ai-analytics", label: "AI Analytics", icon: Sparkles },
    { href: "/dashboard/predictions", label: "No-Show Predictions", icon: TrendingUp },
    { href: "/dashboard/er-triage", label: "ER Triage", icon: Siren },
    { href: "/dashboard/pharmacy-forecast", label: "Pharmacy Forecast", icon: FlaskRound },
    { href: "/dashboard/letters", label: "AI Letters", icon: FileText },
    { href: "/dashboard/lab-explainer", label: "Lab Explainer", icon: Languages },
    { href: "/dashboard/ai-radiology", label: "AI Radiology", icon: ScanLine },
    { href: "/dashboard/adherence", label: "Adherence", icon: BellIcon },
    { href: "/dashboard/abdm", label: "ABDM / ABHA", icon: ShieldCheck },
    { href: "/dashboard/fhir-export", label: "FHIR Export", icon: FileJson },
    { href: "/dashboard/insurance-claims", label: "Insurance Claims", icon: Workflow },
  ],
  DOCTOR: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/workspace", label: "Workspace", icon: Briefcase },
    { href: "/dashboard/calendar", label: "Calendar", icon: CalendarRange },
    { href: "/dashboard/queue", label: "My Queue", icon: Monitor },
    { href: "/dashboard/appointments", label: "Appointments", icon: Calendar },
    { href: "/dashboard/admissions", label: "Admissions", icon: BedDouble },
    { href: "/dashboard/prescriptions", label: "Prescriptions", icon: FileText },
    { href: "/dashboard/patients", label: "Patients", icon: Users },
    { href: "/dashboard/medicines", label: "Medicines", icon: Pill },
    { href: "/dashboard/lab", label: "Lab", icon: FlaskConical },
    { href: "/dashboard/immunization-schedule", label: "Immunizations", icon: Syringe },
    { href: "/dashboard/referrals", label: "Referrals", icon: ArrowRightLeft },
    { href: "/dashboard/surgery", label: "Surgery", icon: Scissors },
    { href: "/dashboard/antenatal", label: "Antenatal", icon: Baby },
    { href: "/dashboard/pediatric", label: "Pediatric", icon: LineChart },
    { href: "/dashboard/bloodbank", label: "Blood Bank", icon: Droplet },
    { href: "/dashboard/telemedicine", label: "Telemedicine", icon: Video },
    { href: "/dashboard/emergency", label: "Emergency", icon: Siren },
    { href: "/dashboard/chat", label: "Chat", icon: MessageCircle },
    { href: "/dashboard/schedule", label: "Schedule", icon: CalendarClock },
    { href: "/dashboard/my-schedule", label: "My Schedule", icon: CalendarDays },
    { href: "/dashboard/my-leaves", label: "My Leaves", icon: PlaneTakeoff },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/scribe", label: "AI Scribe", icon: Mic },
    { href: "/dashboard/ai/chart-search", label: "Chart Search", icon: Brain },
    { href: "/dashboard/predictions", label: "No-Show Predictions", icon: TrendingUp },
    { href: "/dashboard/er-triage", label: "ER Triage", icon: Siren },
    { href: "/dashboard/lab-explainer", label: "Lab Explainer", icon: Languages },
    { href: "/dashboard/letters", label: "AI Letters", icon: FileText },
    { href: "/dashboard/ai-radiology", label: "AI Radiology", icon: ScanLine },
    { href: "/dashboard/abdm", label: "ABDM / ABHA", icon: ShieldCheck },
  ],
  RECEPTION: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/calendar", label: "Calendar", icon: CalendarRange },
    { href: "/dashboard/appointments", label: "Appointments", icon: Calendar },
    { href: "/dashboard/walk-in", label: "Walk-in", icon: UserPlus },
    { href: "/dashboard/patients", label: "Patients", icon: Users },
    { href: "/dashboard/queue", label: "Queue", icon: Monitor },
    { href: "/dashboard/wards", label: "Wards", icon: Hotel },
    { href: "/dashboard/admissions", label: "Admissions", icon: BedDouble },
    { href: "/dashboard/pharmacy", label: "Pharmacy", icon: Package },
    { href: "/dashboard/controlled-substances", label: "Controlled Register", icon: ShieldAlert },
    { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
    { href: "/dashboard/refunds", label: "Refunds", icon: Undo2 },
    { href: "/dashboard/payment-plans", label: "Payment Plans", icon: CreditCard },
    { href: "/dashboard/preauth", label: "Pre-Authorization", icon: FileCheck },
    { href: "/dashboard/packages", label: "Packages", icon: Gift },
    { href: "/dashboard/purchase-orders", label: "Purchase Orders", icon: ShoppingCart },
    { href: "/dashboard/expenses", label: "Expenses", icon: Wallet },
    { href: "/dashboard/telemedicine", label: "Telemedicine", icon: Video },
    { href: "/dashboard/emergency", label: "Emergency", icon: Siren },
    { href: "/dashboard/ambulance", label: "Ambulance", icon: Ambulance },
    { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
    { href: "/dashboard/feedback", label: "Feedback", icon: Star },
    { href: "/dashboard/complaints", label: "Complaints", icon: AlertTriangle },
    { href: "/dashboard/chat", label: "Chat", icon: MessageCircle },
    { href: "/dashboard/visitors", label: "Visitors", icon: UserCheck },
    { href: "/dashboard/my-schedule", label: "My Schedule", icon: CalendarDays },
    { href: "/dashboard/my-leaves", label: "My Leaves", icon: PlaneTakeoff },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/ai-booking", label: "AI Booking", icon: Bot },
    { href: "/dashboard/predictions", label: "No-Show Predictions", icon: TrendingUp },
    { href: "/dashboard/insurance-claims", label: "Insurance Claims", icon: Workflow },
    { href: "/dashboard/abdm", label: "ABDM / ABHA", icon: ShieldCheck },
  ],
  NURSE: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/workstation", label: "Workstation", icon: Activity },
    { href: "/dashboard/calendar", label: "Calendar", icon: CalendarRange },
    { href: "/dashboard/queue", label: "Queue", icon: Monitor },
    { href: "/dashboard/wards", label: "Wards", icon: Hotel },
    { href: "/dashboard/admissions", label: "Admissions", icon: BedDouble },
    { href: "/dashboard/medication-dashboard", label: "Medication", icon: Syringe },
    { href: "/dashboard/lab", label: "Lab", icon: FlaskConical },
    { href: "/dashboard/immunization-schedule", label: "Immunizations", icon: Syringe },
    { href: "/dashboard/surgery", label: "Surgery", icon: Scissors },
    { href: "/dashboard/antenatal", label: "Antenatal", icon: Baby },
    { href: "/dashboard/pediatric", label: "Pediatric", icon: LineChart },
    { href: "/dashboard/vitals", label: "Vitals", icon: Activity },
    { href: "/dashboard/emergency", label: "Emergency", icon: Siren },
    { href: "/dashboard/bloodbank", label: "Blood Bank", icon: Droplet },
    { href: "/dashboard/ambulance", label: "Ambulance", icon: Ambulance },
    { href: "/dashboard/patients", label: "Patients", icon: Users },
    { href: "/dashboard/chat", label: "Chat", icon: MessageCircle },
    { href: "/dashboard/my-schedule", label: "My Schedule", icon: CalendarDays },
    { href: "/dashboard/my-leaves", label: "My Leaves", icon: PlaneTakeoff },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
  ],
  PATIENT: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/calendar", label: "Calendar", icon: CalendarRange },
    { href: "/dashboard/appointments", label: "My Appointments", icon: Calendar },
    { href: "/dashboard/telemedicine", label: "Telemedicine", icon: Video },
    { href: "/dashboard/prescriptions", label: "Prescriptions", icon: FileText },
    { href: "/dashboard/billing", label: "Bills", icon: CreditCard },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/ai-booking", label: "AI Booking", icon: Bot },
    { href: "/dashboard/adherence", label: "Medication Reminders", icon: BellIcon },
    // Lab Explainer is a doctor/admin approval queue — patients receive the
    // approved explanation via notification, so the sidebar entry used to
    // render a "Forbidden" toast for them. See GitHub issue #23.
  ],
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading, loadSession, logout } = useAuthStore();
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const toggleTheme = useThemeStore((s) => s.toggle);

  // Track multi-key sequences (e.g. "g h" for go home)
  const seqRef = useRef<{ key: string; ts: number } | null>(null);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // Issue #33: on direct URL navigation the auth store hydrates asynchronously.
  // Once `isLoading` clears and there is still no user, bounce to /login but
  // (a) preserve the originally-requested path as ?redirect=<path> so the
  //     login page can send the user back there after they authenticate, and
  // (b) surface a toast explaining *why* they were bounced. A direct hit on a
  //     dashboard URL with an empty store used to silently drop the user at
  //     the login page with no context at all.
  const sessionToastShownRef = useRef(false);
  useEffect(() => {
    if (isLoading || user) return;
    // Build the redirect query param from the current URL so nested routes
    // like /dashboard/appointments?foo=bar survive the round-trip.
    let redirectTarget = pathname || "/dashboard";
    if (typeof window !== "undefined") {
      const search = window.location.search || "";
      const hash = window.location.hash || "";
      redirectTarget = `${pathname}${search}${hash}`;
    }
    // Never redirect back to /login itself (would cause a loop after sign-in).
    if (!redirectTarget || redirectTarget.startsWith("/login")) {
      redirectTarget = "/dashboard";
    }
    if (!sessionToastShownRef.current) {
      sessionToastShownRef.current = true;
      toast.info(t("auth.sessionExpired", "Your session has expired. Please sign in again."));
    }
    const qs = new URLSearchParams({ redirect: redirectTarget });
    router.push(`/login?${qs.toString()}`);
  }, [user, isLoading, router, pathname, t]);

  // Auto-launch first-time tour after session loads
  useEffect(() => {
    if (!isLoading && user && !hasCompletedTour(user.role)) {
      setTourOpen(true);
    }
  }, [isLoading, user]);

  // Glossary tooltips for jargon abbreviations in the sidebar
  const SIDEBAR_TIPS: Record<string, string> = {
    "/dashboard/admissions":
      "Admissions — IPD (In-Patient Department): patients admitted to a bed.",
    "/dashboard/queue":
      "Queue — OPD (Out-Patient Department) live token queue.",
    "/dashboard/ot": "OT — Operating Theatre live status board.",
    "/dashboard/walk-in": "Walk-in OPD — register patients without an appointment.",
  };

  // Keyboard shortcuts
  useEffect(() => {
    function isTyping(): boolean {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (el.isContentEditable ?? false)
      );
    }

    function onKey(e: KeyboardEvent) {
      // Ctrl+K / Cmd+K — search
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }

      // Esc — close modals
      if (e.key === "Escape") {
        if (shortcutsOpen) setShortcutsOpen(false);
        if (searchOpen) setSearchOpen(false);
        return;
      }

      if (isTyping()) return;

      // ? — help
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // n — new (context-aware)
      if (e.key === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (pathname.includes("/appointments")) {
          // Navigate to appointments booking — we just route there; the page handles showing booking panel
          router.push("/dashboard/appointments");
          return;
        }
        if (pathname.includes("/patients")) {
          router.push("/dashboard/patients");
          return;
        }
      }

      // Sequence shortcuts: "g" then [h|a|p|q]
      const now = Date.now();
      if (e.key === "g") {
        seqRef.current = { key: "g", ts: now };
        return;
      }
      if (
        seqRef.current &&
        seqRef.current.key === "g" &&
        now - seqRef.current.ts < 2000
      ) {
        const k = e.key.toLowerCase();
        if (k === "h") {
          router.push("/dashboard");
          seqRef.current = null;
          e.preventDefault();
          return;
        }
        if (k === "a") {
          router.push("/dashboard/appointments");
          seqRef.current = null;
          e.preventDefault();
          return;
        }
        if (k === "p") {
          router.push("/dashboard/patients");
          seqRef.current = null;
          e.preventDefault();
          return;
        }
        if (k === "q") {
          router.push("/dashboard/queue");
          seqRef.current = null;
          e.preventDefault();
          return;
        }
        seqRef.current = null;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname, router, shortcutsOpen, searchOpen]);

  if (isLoading || !user) {
    // Issue #33: show a spinner while the auth store rehydrates from
    // localStorage. Previously this was just a "Loading..." text which was
    // easy to miss — and on slower machines the flash of logged-out state
    // could trigger the /login redirect before the session was ever checked.
    return (
      <div
        className="flex h-screen items-center justify-center bg-bg dark:bg-gray-900"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="flex flex-col items-center gap-3">
          <div
            className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-primary dark:border-gray-700 dark:border-t-primary"
            aria-hidden="true"
          />
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("common.loading")}
          </p>
        </div>
      </div>
    );
  }

  // Translate the static role-based nav labels via a small lookup. The lookup
  // intentionally only covers the most common labels; anything not present
  // falls back to its English source string so unmapped items still render.
  const NAV_LABEL_TO_KEY: Record<string, string> = {
    Dashboard: "dashboard.nav.dashboard",
    "Admin Console": "dashboard.nav.adminConsole",
    Calendar: "dashboard.nav.calendar",
    Appointments: "dashboard.nav.appointments",
    "My Appointments": "dashboard.nav.myAppointments",
    Patients: "dashboard.nav.patients",
    Queue: "dashboard.nav.queue",
    "My Queue": "dashboard.nav.myQueue",
    Wards: "dashboard.nav.wards",
    Admissions: "dashboard.nav.admissions",
    Medicines: "dashboard.nav.medicines",
    Pharmacy: "dashboard.nav.pharmacy",
    Lab: "dashboard.nav.lab",
    "Lab QC": "dashboard.nav.labQc",
    "Controlled Register": "dashboard.nav.controlledSubstances",
    Immunizations: "dashboard.nav.immunizations",
    Billing: "dashboard.nav.billing",
    Refunds: "dashboard.nav.refunds",
    "Payment Plans": "dashboard.nav.paymentPlans",
    "Pre-Authorization": "dashboard.nav.preauth",
    "Discount Approvals": "dashboard.nav.discountApprovals",
    Packages: "dashboard.nav.packages",
    Suppliers: "dashboard.nav.suppliers",
    "Purchase Orders": "dashboard.nav.purchaseOrders",
    Expenses: "dashboard.nav.expenses",
    Prescriptions: "dashboard.nav.prescriptions",
    Doctors: "dashboard.nav.doctors",
    Referrals: "dashboard.nav.referrals",
    Surgery: "dashboard.nav.surgery",
    OTs: "dashboard.nav.ots",
    Antenatal: "dashboard.nav.antenatal",
    Pediatric: "dashboard.nav.pediatric",
    "Blood Bank": "dashboard.nav.bloodBank",
    Ambulance: "dashboard.nav.ambulance",
    Assets: "dashboard.nav.assets",
    Telemedicine: "dashboard.nav.telemedicine",
    Emergency: "dashboard.nav.emergency",
    Users: "dashboard.nav.users",
    "Duty Roster": "dashboard.nav.dutyRoster",
    "Leave Requests": "dashboard.nav.leaveRequests",
    "Leave Calendar": "dashboard.nav.leaveCalendar",
    Holidays: "dashboard.nav.holidays",
    Payroll: "dashboard.nav.payroll",
    Certifications: "dashboard.nav.certifications",
    "Census Report": "dashboard.nav.census",
    Budgets: "dashboard.nav.budgets",
    Broadcasts: "dashboard.nav.broadcasts",
    Schedule: "dashboard.nav.schedule",
    "My Schedule": "dashboard.nav.mySchedule",
    "My Leaves": "dashboard.nav.myLeaves",
    Reports: "dashboard.nav.reports",
    "Scheduled Reports": "dashboard.nav.scheduledReports",
    Analytics: "dashboard.nav.analytics",
    Notifications: "dashboard.nav.notifications",
    "Audit Log": "dashboard.nav.audit",
    Feedback: "dashboard.nav.feedback",
    Complaints: "dashboard.nav.complaints",
    Chat: "dashboard.nav.chat",
    Visitors: "dashboard.nav.visitors",
    Workspace: "dashboard.nav.workspace",
    Workstation: "dashboard.nav.workstation",
    Medication: "dashboard.nav.medication",
    Vitals: "dashboard.nav.vitals",
    "Walk-in": "dashboard.nav.walkIn",
    Bills: "dashboard.nav.bills",
    Home: "dashboard.nav.home",
    Appts: "dashboard.nav.appts",
    Stats: "dashboard.nav.stats",
    Rx: "dashboard.nav.rx",
    Profile: "common.profile",
    Settings: "common.settings",
    Work: "dashboard.nav.workstation",
    Meds: "dashboard.nav.medication",
    "Chart Search": "dashboard.nav.chartSearch",
    "AI Analytics": "dashboard.nav.aiAnalytics",
    "No-Show Predictions": "dashboard.nav.predictions",
    "ER Triage": "dashboard.nav.erTriage",
    "Pharmacy Forecast": "dashboard.nav.pharmacyForecast",
    "AI Letters": "dashboard.nav.letters",
    "Lab Explainer": "dashboard.nav.labExplainer",
    "AI Radiology": "dashboard.nav.aiRadiology",
    Adherence: "dashboard.nav.adherence",
    "Medication Reminders": "dashboard.nav.medReminders",
    "ABDM / ABHA": "dashboard.nav.abdm",
    "FHIR Export": "dashboard.nav.fhirExport",
    "Insurance Claims": "dashboard.nav.insuranceClaims",
  };
  const tNav = (label: string) =>
    NAV_LABEL_TO_KEY[label] ? t(NAV_LABEL_TO_KEY[label], label) : label;

  const nav = navByRole[user.role] || navByRole.PATIENT;
  const bottomNav = bottomNavByRole[user.role] || bottomNavByRole.PATIENT;

  return (
    <DialogProvider>
    <div className="flex h-screen">
      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          "no-print flex w-64 flex-col bg-sidebar text-white transition-transform duration-200",
          "fixed inset-y-0 left-0 z-50 md:static md:translate-x-0",
          drawerOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        )}
        aria-label="Primary navigation"
      >
        <div className="border-b border-white/10 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold">MedCore</h1>
              <p className="mt-1 text-xs text-gray-400">
                {user.name} ({user.role})
              </p>
            </div>
            <button
              onClick={() => setSearchOpen(true)}
              title="Search (Ctrl+K)"
              aria-label="Open search (Ctrl+K)"
              className="rounded-lg p-2 text-gray-300 transition hover:bg-sidebar-hover hover:text-white focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar focus:outline-none"
            >
              <Search size={18} aria-hidden="true" />
            </button>
          </div>
          <button
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            className="mt-3 flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/10 focus:ring-2 focus:ring-primary focus:outline-none"
          >
            <Search size={13} aria-hidden="true" /> Search...
            <kbd className="ml-auto rounded bg-black/30 px-1 py-0.5 text-[10px]">
              Ctrl K
            </kbd>
          </button>
        </div>

        <nav
          className="flex-1 overflow-y-auto p-3"
          aria-label="Main menu"
        >
          {nav.map(({ href, label, icon: Icon }) => {
            const isActive = pathname === href;
            const tip = SIDEBAR_TIPS[href];
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setDrawerOpen(false)}
                aria-current={isActive ? "page" : undefined}
                title={tip}
                className={clsx(
                  "mb-1 flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar",
                  isActive
                    ? "bg-primary font-medium text-white"
                    : "text-gray-300 hover:bg-sidebar-hover hover:text-white"
                )}
              >
                <Icon size={18} aria-hidden="true" />
                {tNav(label)}
              </Link>
            );
          })}
          {user && (
            <button
              type="button"
              onClick={() => {
                resetTour(user.role);
                setTourOpen(true);
              }}
              className="mt-2 flex w-full items-center gap-3 rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-300 hover:bg-sidebar-hover hover:text-white"
            >
              {t("dashboard.nav.takeTour")}
            </button>
          )}
        </nav>

        <div className="flex items-center gap-2 border-t border-white/10 p-3">
          <button
            onClick={toggleTheme}
            aria-label={
              resolvedTheme === "dark"
                ? t("common.lightMode")
                : t("common.darkMode")
            }
            title={
              resolvedTheme === "dark"
                ? t("common.lightMode")
                : t("common.darkMode")
            }
            className="rounded-lg p-2 text-gray-300 transition hover:bg-sidebar-hover hover:text-white focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar focus:outline-none"
          >
            {resolvedTheme === "dark" ? (
              <Sun size={18} aria-hidden="true" />
            ) : (
              <Moon size={18} aria-hidden="true" />
            )}
          </button>
          <button
            onClick={() => setShortcutsOpen(true)}
            aria-label={t("common.shortcuts")}
            title={`${t("common.shortcuts")} (?)`}
            className="rounded-lg p-2 text-gray-300 transition hover:bg-sidebar-hover hover:text-white focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar focus:outline-none"
          >
            <Keyboard size={18} aria-hidden="true" />
          </button>
          <Link
            href="/dashboard/settings"
            aria-label={t("common.settings")}
            title={t("common.settings")}
            className="rounded-lg p-2 text-gray-300 transition hover:bg-sidebar-hover hover:text-white focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar focus:outline-none"
          >
            <SettingsIcon size={18} aria-hidden="true" />
          </Link>
          <button
            onClick={() => {
              logout();
              router.push("/login");
            }}
            aria-label={t("common.signOut")}
            className="ml-auto flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-300 transition hover:bg-sidebar-hover hover:text-white focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar focus:outline-none"
          >
            <LogOut size={16} aria-hidden="true" />
            <span>{t("common.signOut")}</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main
        id="main-content"
        className="flex-1 overflow-y-auto bg-bg dark:bg-gray-900"
      >
        {/* Mobile top bar */}
        <div className="sticky top-0 z-30 flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-800 md:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t("common.openMenu")}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <span className="font-semibold text-gray-900 dark:text-gray-100">
            MedCore
          </span>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label={t("common.openSearch")}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <Search size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="p-4 pb-20 md:p-6 md:pb-6">{children}</div>
      </main>

      {/* Mobile bottom nav */}
      <nav
        aria-label="Bottom navigation"
        className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800 md:hidden"
      >
        {bottomNav.map(({ href, label, icon: Icon }) => {
          const isActive =
            pathname === href ||
            (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={clsx(
                "flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px] font-medium transition",
                isActive
                  ? "text-primary"
                  : "text-gray-500 dark:text-gray-400"
              )}
            >
              <Icon size={20} aria-hidden="true" />
              <span className="truncate">{tNav(label)}</span>
            </Link>
          );
        })}
      </nav>

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <KeyboardShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      <HelpPanel onStartTour={() => setTourOpen(true)} />
      {user && (
        <OnboardingTour
          role={user.role}
          open={tourOpen}
          onClose={() => setTourOpen(false)}
        />
      )}
    </div>
    </DialogProvider>
  );
}
