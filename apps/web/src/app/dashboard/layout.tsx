"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
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
import { LanguageDropdown } from "@/components/LanguageDropdown";
import { ThemeToggle } from "@/components/ThemeToggle";
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
    { href: "/dashboard/agent-console", label: "Agent Console", icon: HeartPulse },
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
    { href: "/dashboard/ai-kpis", label: "AI KPIs", icon: BarChart3 },
    { href: "/dashboard/predictions", label: "No-Show Predictions", icon: TrendingUp },
    { href: "/dashboard/er-triage", label: "ER Triage", icon: Siren },
    { href: "/dashboard/pharmacy-forecast", label: "Pharmacy Forecast", icon: FlaskRound },
    { href: "/dashboard/ai-letters", label: "AI Letters", icon: FileText },
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
    { href: "/dashboard/ai-letters", label: "AI Letters", icon: FileText },
    { href: "/dashboard/ai-radiology", label: "AI Radiology", icon: ScanLine },
    { href: "/dashboard/abdm", label: "ABDM / ABHA", icon: ShieldCheck },
  ],
  RECEPTION: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/agent-console", label: "Agent Console", icon: HeartPulse },
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
    // Issue #90: Reports/Today's Revenue is ADMIN-only. Removed from
    // RECEPTION nav so they can't reach the financial KPI tile.
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
  // Track multi-key sequences (e.g. "g h" for go home)
  const seqRef = useRef<{ key: string; ts: number } | null>(null);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // TODO.md #4 — WebKit auth-redirect residue (v2).
  //
  // Even with `addInitScript`-based fixture injection (Playwright e2e), under
  // heavy CI parallelism the auth store occasionally settles to `user: null`
  // on first render despite a valid `medcore_token` being present in
  // localStorage. The dashboard layout's redirect-to-login effect below
  // would then fire before the token-bearing session probe was observed,
  // the test sees a `/login` URL, and the run logs out as if there were
  // no session at all.
  //
  // Symptom (release.yml run 25256962182, 8 specs still failing after v1):
  //   "page.goto: Navigation to /dashboard/X is interrupted by another
  //    navigation to /login?redirect=%2Fdashboard". The literal
  //    `%2Fdashboard` (not `%2Fdashboard%2FX`) confirms the redirect
  //    fires from the LAYOUT during a still-resolving /dashboard nav,
  //    not from the target page itself.
  //
  // Iteration history:
  // - v0 (commit 202f310): 150ms setTimeout, fire-and-forget loadSession.
  //   Failed because loadSession is async and the redirect-effect still
  //   re-armed before the in-flight /auth/me resolved.
  // - v1 (commit 8d7fa94): 250ms timeout, AWAIT loadSession before
  //   arming. Cleared ~10 WebKit specs but 8 still raced — either
  //   /auth/me was slower than 250ms on WebKit CI, or the token wasn't
  //   yet observable from page context when the layout first mounted.
  // - v2 (this iteration): combine TWO defenses.
  //
  // Defense 1 — fixture-side wait (e2e/helpers.ts::waitForAuthReady).
  //   After addInitScript runs and the first navigation completes, the
  //   fixtures now block until `localStorage.getItem("medcore_token")`
  //   actually returns the expected token from page context. This
  //   eliminates the "token-not-yet-observable" race entirely for tests
  //   that use the standard adminPage/doctorPage/etc. fixtures.
  //
  // Defense 2 — layout retry LOOP (this hook). Instead of a single
  //   awaited loadSession() with a 250ms grace, retry up to 5 times with
  //   200ms between attempts. If any attempt populates `user`, the outer
  //   `if (isLoading || user) return` on the redirect-effect short-
  //   circuits and no bounce happens. Only after 5 failed probes do we
  //   arm the redirect. This handles the "token IS readable but
  //   /auth/me is slow on WebKit CI" case that defense 1 doesn't cover.
  //
  // v3 (release run 25257377985): bumped from 3×200ms (600ms) to
  //   5×200ms (1000ms). 21 specs were still flaky on WebKit at the
  //   v2 budget — `waitForAuthReady` confirms storage at fixture
  //   creation but every test then does its own page.goto which
  //   re-mounts this layout in a context where loadSession runs again
  //   and races render. The extra 400ms of grace absorbs WebKit's
  //   tail latency on /auth/me under CI parallelism.
  //
  // Production cost: at most ~1000ms added latency on a genuinely-
  // no-session bounce (vs. v2's ~600ms). Healthy sessions are
  // completely unaffected — useEffect 1 above hydrates `user`, both
  // effects short-circuit on the first re-render. Five /auth/me hits
  // in a row only happen if every probe fails, which in production
  // means the token really is dead and the user genuinely needs to
  // log in (and they're being redirected anyway, so the wait is
  // invisible).
  //
  // Validation pending next release.yml run.
  const retryAttemptedRef = useRef(false);
  const [redirectArmed, setRedirectArmed] = useState(false);
  useEffect(() => {
    if (isLoading || user) return;
    if (retryAttemptedRef.current) return;
    retryAttemptedRef.current = true;
    if (typeof window === "undefined") {
      setRedirectArmed(true);
      return;
    }
    if (!localStorage.getItem("medcore_token")) {
      setRedirectArmed(true); // no token, no retry needed; bounce now
      return;
    }
    let cancelled = false;
    (async () => {
      // 5-attempt retry loop (v3): between each attempt, sleep 200ms
      // then call loadSession() again. If any attempt populates
      // `user`, the OUTER `if (isLoading || user) return` guard at
      // the top of this effect short-circuits subsequent re-runs and
      // the redirect effect below never sees `redirectArmed=true`. We
      // arm the redirect only after all 5 attempts have failed so a
      // slow /auth/me on WebKit CI still has a chance to win the
      // race.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (cancelled) return;
        try {
          await loadSession();
        } catch {
          // loadSession swallows errors internally and clears local
          // state, but be defensive against future refactors.
        }
        if (cancelled) return;
        // If loadSession populated `user`, this effect won't run again
        // (retryAttemptedRef is already true), and the redirect-effect
        // will short-circuit on its `user` guard. No need to break the
        // loop early — the next iteration is cheap because /auth/me
        // would short-circuit at the store layer if user is set, but
        // we still avoid the wasted hit by checking the latest store
        // state via the effect's stale-closure-safe approach: just
        // letting React re-run the effect on user change isn't an
        // option (retryAttemptedRef gates it), so we read directly.
        if (useAuthStore.getState().user) return;
      }
      if (cancelled) return;
      setRedirectArmed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoading, user, loadSession]);

  // Issue #70: previously every sidebar <Link> ran `onClick={() => setDrawerOpen(false)}`.
  // On the first click the synchronous setState scheduled a re-render of the
  // <aside> while the browser was still committing the Link's navigation —
  // the result was that the active class flipped (because the parent's
  // pathname watcher saw it as the next pathname) but the navigation was
  // dropped, requiring a second click. We now close the drawer reactively in
  // response to the pathname actually changing, so the click handler doesn't
  // race with the router push at all.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

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
    // Wait for the WebKit-grace retry block above to either arm the
    // redirect (no token / retry attempted) or short-circuit by setting
    // `user` from a successful retry.
    if (!redirectArmed) return;
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
  }, [user, isLoading, router, pathname, t, redirectArmed]);

  // Auto-launch first-time tour after session loads.
  // Issue #122: pass user.id so a previous Skip on any page (which sets a
  // global per-user flag in localStorage) suppresses the auto-launch
  // everywhere — the tour used to reopen each time the user navigated to
  // a sibling dashboard route because the skip was only honoured by the
  // role-keyed "completed" flag.
  useEffect(() => {
    if (!isLoading && user && !hasCompletedTour(user.role, user.id)) {
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
    "Agent Console": "dashboard.nav.agentConsole",
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

      {/* Sidebar — issue #145: previously the `bg-sidebar` token was a
          fixed slate value (#1e293b) and the foreground was hardcoded to
          `text-white`, so toggling the theme to light only flipped the
          main pane while the sidebar stayed dark. The token is now
          theme-aware (white in light mode, slate in dark mode — see
          globals.css) and every text class below has both a light-mode
          (`text-slate-700` etc.) base and a `dark:` override. */}
      <aside
        className={clsx(
          "no-print flex w-64 flex-col bg-sidebar text-slate-900 transition-transform duration-200 dark:text-white",
          "fixed inset-y-0 left-0 z-50 border-r border-gray-200 dark:border-white/10 md:static md:translate-x-0",
          drawerOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        )}
        aria-label="Primary navigation"
      >
        <div className="border-b border-gray-200 p-5 dark:border-white/10">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold">MedCore</h1>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {user.name} ({user.role})
              </p>
            </div>
            <button
              onClick={() => setSearchOpen(true)}
              title="Search (Ctrl+K)"
              aria-label="Open search (Ctrl+K)"
              className="rounded-lg p-2 text-gray-600 transition hover:bg-sidebar-hover hover:text-gray-900 focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar focus:outline-none dark:text-gray-300 dark:hover:text-white"
            >
              <Search size={18} aria-hidden="true" />
            </button>
          </div>
          <button
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            className="mt-3 flex w-full items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 focus:ring-2 focus:ring-primary focus:outline-none dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
          >
            <Search size={13} aria-hidden="true" /> Search...
            <kbd className="ml-auto rounded bg-gray-200 px-1 py-0.5 text-[10px] text-gray-700 dark:bg-black/30 dark:text-gray-300">
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
                // Issue #70: drawer close is now handled by the pathname-effect
                // above so we don't race a setState against the Link's
                // built-in navigation (which used to require a second click).
                aria-current={isActive ? "page" : undefined}
                title={tip}
                className={clsx(
                  "mb-1 flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar",
                  isActive
                    ? "bg-primary font-medium text-white"
                    : "text-slate-700 hover:bg-sidebar-hover hover:text-slate-900 dark:text-gray-300 dark:hover:text-white"
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
                // Issue #122: clear both the role-completion flag and the
                // per-user skip flag so the tour can re-launch.
                resetTour(user.role, user.id);
                setTourOpen(true);
              }}
              className="mt-2 flex w-full items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 text-xs text-slate-600 hover:bg-sidebar-hover hover:text-slate-900 dark:border-white/10 dark:text-gray-300 dark:hover:text-white"
            >
              {t("dashboard.nav.takeTour")}
            </button>
          )}
        </nav>

        {/* Issue #486 — sidebar footer was a single horizontal flex row that
            crammed LanguageDropdown + ThemeToggle + Keyboard + Settings +
            Sign Out into the 256px-wide aside. At 1350×803 the Sign Out
            button's "Sign Out" label wrapped to two lines ("Sign / Out")
            and visually collided with the leftmost Quick Action card on
            the dashboard. Splitting the footer into two stacked rows
            (utility icons row + dedicated full-width Sign Out row) gives
            the label its own line, eliminates the wrap, and keeps every
            existing icon reachable. `whitespace-nowrap` on the Sign Out
            label is a belt-and-braces guard so future translations can't
            re-introduce the wrap on narrower locales. */}
        <div
          className="flex flex-col gap-2 border-t border-gray-200 p-3 dark:border-white/10"
          data-testid="sidebar-footer"
        >
          <div
            className="flex items-center gap-2"
            data-testid="sidebar-footer-actions"
          >
            {/* Issue #137: in-app language switcher. Persists to localStorage
                (handled by the i18n store) AND PATCHes /auth/me so the
                choice follows the user across devices. */}
            <LanguageDropdown
              persistToServer
              instanceId="mc-lang-sidebar"
              className="text-slate-700 dark:text-gray-300"
            />
            {/* Issue #485 + #508: theme toggle extracted into its own
                component. Inlined version was missing both `type="button"`
                (could submit if ever wrapped in a form) and `aria-pressed`
                (screen readers couldn't observe state change). See
                `@/components/ThemeToggle.tsx` for the full rationale. */}
            <ThemeToggle />
            <button
              onClick={() => setShortcutsOpen(true)}
              aria-label={t("common.shortcuts")}
              title={`${t("common.shortcuts")} (?)`}
              className="rounded-lg p-2 text-slate-700 transition hover:bg-sidebar-hover hover:text-slate-900 focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar focus:outline-none dark:text-gray-300 dark:hover:text-white"
            >
              <Keyboard size={18} aria-hidden="true" />
            </button>
            <Link
              href="/dashboard/settings"
              aria-label={t("common.settings")}
              title={t("common.settings")}
              className="ml-auto rounded-lg p-2 text-slate-700 transition hover:bg-sidebar-hover hover:text-slate-900 focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar focus:outline-none dark:text-gray-300 dark:hover:text-white"
            >
              <SettingsIcon size={18} aria-hidden="true" />
            </Link>
          </div>
          <button
            type="button"
            onClick={() => {
              logout();
              router.push("/login");
            }}
            aria-label={t("common.signOut")}
            data-testid="sidebar-sign-out"
            className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap text-slate-700 transition hover:bg-sidebar-hover hover:text-slate-900 focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar focus:outline-none dark:text-gray-300 dark:hover:text-white"
          >
            <LogOut size={16} aria-hidden="true" />
            <span className="whitespace-nowrap">{t("common.signOut")}</span>
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
          <div className="flex items-center gap-1">
            {/* Issue #137: language switcher mirrors the sidebar one for
                small screens where the sidebar is collapsed by default. */}
            <LanguageDropdown
              persistToServer
              instanceId="mc-lang-mobile"
            />
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label={t("common.openSearch")}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <Search size={18} aria-hidden="true" />
            </button>
          </div>
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
          userId={user.id}
          open={tourOpen}
          onClose={() => setTourOpen(false)}
        />
      )}
    </div>
    </DialogProvider>
  );
}
