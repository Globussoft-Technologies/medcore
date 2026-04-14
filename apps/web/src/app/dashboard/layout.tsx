"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAuthStore } from "@/lib/store";
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
} from "lucide-react";
import clsx from "clsx";
import { SearchPalette } from "./_components/search-palette";

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
    { href: "/dashboard/immunization-schedule", label: "Immunizations", icon: Syringe },
    { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
    { href: "/dashboard/refunds", label: "Refunds", icon: Undo2 },
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
    { href: "/dashboard/budgets", label: "Budgets", icon: PiggyBank },
    { href: "/dashboard/broadcasts", label: "Broadcasts", icon: Megaphone },
    { href: "/dashboard/schedule", label: "Schedule", icon: CalendarClock },
    { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
    { href: "/dashboard/analytics", label: "Analytics", icon: TrendingUp },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/audit", label: "Audit Log", icon: Shield },
    { href: "/dashboard/feedback", label: "Feedback", icon: Star },
    { href: "/dashboard/complaints", label: "Complaints", icon: AlertTriangle },
    { href: "/dashboard/chat", label: "Chat", icon: MessageCircle },
    { href: "/dashboard/visitors", label: "Visitors", icon: UserCheck },
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
    { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
    { href: "/dashboard/refunds", label: "Refunds", icon: Undo2 },
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
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (!isLoading && !user) {
      router.push("/login");
    }
  }, [user, isLoading, router]);

  // Ctrl+K / Cmd+K shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (isLoading || !user) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  const nav = navByRole[user.role] || navByRole.PATIENT;

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="flex w-64 flex-col bg-sidebar text-white">
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
              className="rounded-lg p-2 text-gray-300 transition hover:bg-sidebar-hover hover:text-white"
            >
              <Search size={18} />
            </button>
          </div>
          <button
            onClick={() => setSearchOpen(true)}
            className="mt-3 flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/10"
          >
            <Search size={13} /> Search...
            <kbd className="ml-auto rounded bg-black/30 px-1 py-0.5 text-[10px]">
              Ctrl K
            </kbd>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={clsx(
                "mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition",
                pathname === href
                  ? "bg-primary font-medium text-white"
                  : "text-gray-300 hover:bg-sidebar-hover hover:text-white"
              )}
            >
              <Icon size={18} />
              {label}
            </Link>
          ))}
        </nav>

        <div className="border-t border-white/10 p-3">
          <button
            onClick={() => {
              logout();
              router.push("/login");
            }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-gray-300 transition hover:bg-sidebar-hover hover:text-white"
          >
            <LogOut size={18} />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-bg">
        <div className="p-6">{children}</div>
      </main>

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
