"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { Calendar, Users, CreditCard, Activity } from "lucide-react";

interface DashboardStats {
  todayAppointments: number;
  totalPatients: number;
  pendingBills: number;
  inQueueCount: number;
}

function StatCard({
  title,
  value,
  icon: Icon,
  color,
}: {
  title: string;
  value: number | string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="rounded-xl bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">{title}</p>
          <p className="mt-1 text-3xl font-bold">{value}</p>
        </div>
        <div className={`rounded-xl p-3 ${color}`}>
          <Icon size={24} className="text-white" />
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuthStore();
  const [stats, setStats] = useState<DashboardStats>({
    todayAppointments: 0,
    totalPatients: 0,
    pendingBills: 0,
    inQueueCount: 0,
  });

  useEffect(() => {
    async function load() {
      try {
        const today = new Date().toISOString().split("T")[0];

        const [appointments, patients, pendingInvoices, partialInvoices, queueData] = await Promise.all([
          api
            .get<{ meta: { total: number } }>(
              `/appointments?date=${today}&limit=1`
            )
            .catch(() => ({ meta: { total: 0 } })),
          api
            .get<{ meta: { total: number } }>("/patients?limit=1")
            .catch(() => ({ meta: { total: 0 } })),
          api
            .get<{ meta: { total: number } }>(
              "/billing/invoices?status=PENDING&limit=1"
            )
            .catch(() => ({ meta: { total: 0 } })),
          api
            .get<{ meta: { total: number } }>(
              "/billing/invoices?status=PARTIAL&limit=1"
            )
            .catch(() => ({ meta: { total: 0 } })),
          api
            .get<{ data: Array<{ waitingCount: number }> }>("/queue")
            .catch(() => ({ data: [] })),
        ]);

        const totalInQueue = (queueData.data ?? []).reduce(
          (sum: number, doc: { waitingCount: number }) => sum + doc.waitingCount,
          0
        );

        setStats({
          todayAppointments: appointments.meta?.total ?? 0,
          totalPatients: patients.meta?.total ?? 0,
          pendingBills: (pendingInvoices.meta?.total ?? 0) + (partialInvoices.meta?.total ?? 0),
          inQueueCount: totalInQueue,
        });
      } catch {
        // Stats will show 0
      }
    }

    load();
  }, []);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome, {user?.name}
        </h1>
        <p className="text-gray-500">
          {new Date().toLocaleDateString("en-IN", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Today's Appointments"
          value={stats.todayAppointments}
          icon={Calendar}
          color="bg-primary"
        />
        <StatCard
          title="Total Patients"
          value={stats.totalPatients}
          icon={Users}
          color="bg-secondary"
        />
        <StatCard
          title="Pending Bills"
          value={stats.pendingBills}
          icon={CreditCard}
          color="bg-accent"
        />
        <StatCard
          title="In Queue"
          value={stats.inQueueCount}
          icon={Activity}
          color="bg-purple-600"
        />
      </div>

      {/* Role-specific quick actions */}
      <div className="mt-8">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          Quick Actions
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(user?.role === "RECEPTION" || user?.role === "ADMIN") && (
            <>
              <a
                href="/dashboard/walk-in"
                className="rounded-xl border-2 border-dashed border-gray-200 p-6 text-center transition hover:border-primary hover:bg-blue-50"
              >
                <Users className="mx-auto mb-2 text-primary" size={32} />
                <p className="font-medium">Register Walk-in</p>
              </a>
              <a
                href="/dashboard/appointments"
                className="rounded-xl border-2 border-dashed border-gray-200 p-6 text-center transition hover:border-primary hover:bg-blue-50"
              >
                <Calendar className="mx-auto mb-2 text-primary" size={32} />
                <p className="font-medium">Book Appointment</p>
              </a>
              <a
                href="/dashboard/billing"
                className="rounded-xl border-2 border-dashed border-gray-200 p-6 text-center transition hover:border-primary hover:bg-blue-50"
              >
                <CreditCard className="mx-auto mb-2 text-primary" size={32} />
                <p className="font-medium">Create Bill</p>
              </a>
            </>
          )}
          {user?.role === "DOCTOR" && (
            <>
              <a
                href="/dashboard/queue"
                className="rounded-xl border-2 border-dashed border-gray-200 p-6 text-center transition hover:border-primary hover:bg-blue-50"
              >
                <Activity className="mx-auto mb-2 text-primary" size={32} />
                <p className="font-medium">View My Queue</p>
              </a>
              <a
                href="/dashboard/prescriptions"
                className="rounded-xl border-2 border-dashed border-gray-200 p-6 text-center transition hover:border-primary hover:bg-blue-50"
              >
                <Calendar className="mx-auto mb-2 text-primary" size={32} />
                <p className="font-medium">Write Prescription</p>
              </a>
            </>
          )}
          {user?.role === "NURSE" && (
            <a
              href="/dashboard/vitals"
              className="rounded-xl border-2 border-dashed border-gray-200 p-6 text-center transition hover:border-primary hover:bg-blue-50"
            >
              <Activity className="mx-auto mb-2 text-primary" size={32} />
              <p className="font-medium">Record Vitals</p>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
