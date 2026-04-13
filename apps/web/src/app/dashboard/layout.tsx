"use client";

import { useEffect } from "react";
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
} from "lucide-react";
import clsx from "clsx";

const navByRole: Record<
  string,
  Array<{ href: string; label: string; icon: React.ElementType }>
> = {
  ADMIN: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/appointments", label: "Appointments", icon: Calendar },
    { href: "/dashboard/patients", label: "Patients", icon: Users },
    { href: "/dashboard/queue", label: "Queue", icon: Monitor },
    { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
    { href: "/dashboard/prescriptions", label: "Prescriptions", icon: FileText },
    { href: "/dashboard/doctors", label: "Doctors", icon: Stethoscope },
    { href: "/dashboard/users", label: "Users", icon: UserCog },
    { href: "/dashboard/schedule", label: "Schedule", icon: CalendarClock },
    { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/audit", label: "Audit Log", icon: Shield },
  ],
  DOCTOR: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/queue", label: "My Queue", icon: Monitor },
    { href: "/dashboard/appointments", label: "Appointments", icon: Calendar },
    { href: "/dashboard/prescriptions", label: "Prescriptions", icon: FileText },
    { href: "/dashboard/patients", label: "Patients", icon: Users },
    { href: "/dashboard/schedule", label: "Schedule", icon: CalendarClock },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
  ],
  RECEPTION: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/appointments", label: "Appointments", icon: Calendar },
    { href: "/dashboard/walk-in", label: "Walk-in", icon: UserPlus },
    { href: "/dashboard/patients", label: "Patients", icon: Users },
    { href: "/dashboard/queue", label: "Queue", icon: Monitor },
    { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
    { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
  ],
  NURSE: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/queue", label: "Queue", icon: Monitor },
    { href: "/dashboard/vitals", label: "Vitals", icon: Activity },
    { href: "/dashboard/patients", label: "Patients", icon: Users },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
  ],
  PATIENT: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/appointments", label: "My Appointments", icon: Calendar },
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

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (!isLoading && !user) {
      router.push("/login");
    }
  }, [user, isLoading, router]);

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
          <h1 className="text-xl font-bold">MedCore</h1>
          <p className="mt-1 text-xs text-gray-400">
            {user.name} ({user.role})
          </p>
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
    </div>
  );
}
