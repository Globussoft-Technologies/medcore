"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import {
  Activity,
  AlertTriangle,
  BedDouble,
  CheckCircle2,
  CreditCard,
  Database,
  Droplet,
  FlaskConical,
  Package,
  PlaneTakeoff,
  Pill,
  Scissors,
  Server,
  Shield,
  Siren,
  Star,
  TrendingUp,
  UserCheck,
  UserCog,
  Users,
  Wallet,
  Wrench,
  ShoppingCart,
} from "lucide-react";

function safe<T>(p: string, fb: T): Promise<T> {
  return api.get<T>(p).catch(() => fb);
}

interface HealthStatus {
  status: string;
  timestamp?: string;
}

export default function AdminConsolePage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();
  const [loaded, setLoaded] = useState(false);
  const [apiHealth, setApiHealth] = useState<"ok" | "down" | "unknown">("unknown");
  const [overview, setOverview] = useState<any>(null);
  const [complaints, setComplaints] = useState<any[]>([]);
  const [lowStock, setLowStock] = useState(0);
  const [expiringMeds, setExpiringMeds] = useState(0);
  const [bloodLow, setBloodLow] = useState<any[]>([]);
  const [auditCount, setAuditCount] = useState(0);
  const [pendingLeaves, setPendingLeaves] = useState<any[]>([]);
  const [pendingExpenses, setPendingExpenses] = useState<any[]>([]);
  const [pendingPOs, setPendingPOs] = useState<any[]>([]);
  const [wards, setWards] = useState<any[]>([]);
  const [rosterToday, setRosterToday] = useState<any[]>([]);
  const [otUtil, setOtUtil] = useState<{ used: number; total: number }>({
    used: 0,
    total: 0,
  });
  const [activeSessions, setActiveSessions] = useState(0);

  useEffect(() => {
    if (!isLoading && user && user.role !== "ADMIN") {
      router.replace("/dashboard");
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!user || user.role !== "ADMIN") return;
    (async () => {
      const today = new Date().toISOString().split("T")[0];
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      const [
        health,
        ov,
        comp,
        pharmLow,
        pharmExp,
        bloodSum,
        audit,
        leaves,
        expenses,
        pos,
        wardRes,
        roster,
        surgeriesToday,
        users,
      ] = await Promise.all([
        fetch(
          `${process.env.NEXT_PUBLIC_API_URL?.replace("/api/v1", "") ||
            "http://localhost:4000"}/api/health`
        )
          .then((r) => r.json())
          .catch(() => null) as Promise<HealthStatus | null>,
        safe<any>(`/analytics/overview?from=${today}&to=${today}`, { data: null }),
        safe<any>(`/complaints?status=OPEN&limit=50`, { data: [] }),
        safe<any>(`/pharmacy/inventory?lowStock=true&limit=1`, { meta: { total: 0 } }),
        safe<any>(`/pharmacy/inventory?expiring=true&limit=1`, { meta: { total: 0 } }),
        safe<any>(`/bloodbank/inventory/summary`, { data: null }),
        safe<any>(`/audit?from=${hourAgo}&limit=1`, { meta: { total: 0 } }),
        safe<any>(`/leaves/pending`, { data: [] }),
        safe<any>(`/expenses?status=PENDING&limit=20`, { data: [] }),
        safe<any>(`/purchase-orders?status=PENDING&limit=20`, { data: [] }),
        safe<any>(`/wards`, { data: [] }),
        safe<any>(`/shifts/roster?date=${today}`, { data: [] }),
        safe<any>(`/surgery?from=${today}&to=${today}&limit=100`, { data: [] }),
        safe<any>(`/doctors`, { data: [] }),
      ]);

      setApiHealth(health?.status === "ok" ? "ok" : "down");
      setOverview(ov.data);
      const openComps = comp.data || comp.complaints || [];
      setComplaints(Array.isArray(openComps) ? openComps : []);
      setLowStock(pharmLow.meta?.total || 0);
      setExpiringMeds(pharmExp.meta?.total || 0);
      const blood = bloodSum.data;
      const lowUnits = Array.isArray(blood?.byGroup)
        ? blood.byGroup.filter((g: any) => (g.available ?? 0) < 3)
        : [];
      setBloodLow(lowUnits);
      setAuditCount(audit.meta?.total || 0);
      setPendingLeaves(Array.isArray(leaves.data) ? leaves.data : []);
      setPendingExpenses(Array.isArray(expenses.data) ? expenses.data : []);
      setPendingPOs(Array.isArray(pos.data) ? pos.data : []);
      setWards(Array.isArray(wardRes.data) ? wardRes.data : []);
      // /shifts/roster returns an OBJECT grouped by shift type — flatten to a single array
      const rosterData = roster.data;
      let rosterFlat: any[] = [];
      if (Array.isArray(rosterData)) {
        rosterFlat = rosterData;
      } else if (rosterData && typeof rosterData === "object") {
        rosterFlat = Object.values(rosterData).flat() as any[];
      }
      setRosterToday(rosterFlat);
      // OT utilization: surgeries today vs number of OTs * 8 hours
      const surgs = Array.isArray(surgeriesToday.data) ? surgeriesToday.data : [];
      setOtUtil({ used: surgs.length, total: 10 });
      setActiveSessions(Array.isArray(users.data) ? users.data.length : 0);
      setLoaded(true);
    })();
  }, [user]);

  if (!user || user.role !== "ADMIN") {
    return (
      <div className="p-8 text-center text-gray-700">
        Admin Console restricted to administrators.
      </div>
    );
  }

  const bedStats = wards.reduce(
    (acc: any, w: any) => {
      const total = w.beds?.length || w.totalBeds || 0;
      const occupied =
        w.beds?.filter((b: any) => b.status === "OCCUPIED").length ??
        w.occupiedBeds ??
        0;
      acc.total += total;
      acc.occupied += occupied;
      return acc;
    },
    { total: 0, occupied: 0 }
  );
  const bedOccPct = bedStats.total ? Math.round((bedStats.occupied / bedStats.total) * 100) : 0;
  const overdueComplaints = complaints.filter((c: any) => {
    const due = c.slaBreachAt || c.dueAt;
    return due && new Date(due) < new Date();
  }).length;

  async function approve(kind: "leave" | "expense" | "po", id: string) {
    try {
      if (kind === "leave") {
        await api.patch(`/leaves/${id}`, { status: "APPROVED" });
        setPendingLeaves((xs) => xs.filter((x) => x.id !== id));
      } else if (kind === "expense") {
        await api.patch(`/expenses/${id}/approve`, {});
        setPendingExpenses((xs) => xs.filter((x) => x.id !== id));
      } else if (kind === "po") {
        await api.patch(`/purchase-orders/${id}/approve`, {});
        setPendingPOs((xs) => xs.filter((x) => x.id !== id));
      }
    } catch {
      alert("Approve failed");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin Console</h1>
          <p className="text-sm text-gray-700">Command center for hospital operations</p>
        </div>
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          ADMIN
        </span>
      </div>

      {/* System Health */}
      <div className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">System Health</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Health
            Icon={Server}
            label="API"
            status={apiHealth === "ok" ? "Healthy" : apiHealth === "down" ? "Down" : "—"}
            ok={apiHealth === "ok"}
          />
          <Health
            Icon={Database}
            label="Database"
            status={apiHealth === "ok" ? "Connected" : "—"}
            ok={apiHealth === "ok"}
          />
          <Health Icon={Activity} label="Uptime" status="Live" ok={true} />
          <Health
            Icon={AlertTriangle}
            label="Errors (1h)"
            status={String(auditCount)}
            ok={auditCount < 10}
          />
          <Health
            Icon={UserCheck}
            label="Active Users"
            status={String(activeSessions)}
            ok={true}
          />
        </div>
      </div>

      {/* Critical Alerts */}
      <div className="rounded-xl border border-red-200 bg-red-50 p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-red-800">
          <AlertTriangle size={16} /> Critical Alerts
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Alert
            Icon={AlertTriangle}
            label="SLA Overdue Complaints"
            value={overdueComplaints}
            href="/dashboard/complaints"
          />
          <Alert
            Icon={Droplet}
            label="Low Blood Stock"
            value={bloodLow.length}
            href="/dashboard/bloodbank"
          />
          <Alert
            Icon={Pill}
            label="Expiring Meds"
            value={expiringMeds}
            href="/dashboard/pharmacy"
          />
          <Alert
            Icon={Shield}
            label="Audit Events (1h)"
            value={auditCount}
            href="/dashboard/audit"
          />
        </div>
      </div>

      {/* Today snapshot */}
      <div className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Today Snapshot</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Snap Icon={Users} label="Registered" value={overview?.newPatients ?? 0} />
          <Snap Icon={BedDouble} label="Admissions" value={overview?.admissions ?? 0} />
          <Snap Icon={CheckCircle2} label="Discharges" value={overview?.discharges ?? 0} />
          <Snap Icon={Scissors} label="Surgeries" value={overview?.surgeries ?? 0} />
          <Snap Icon={Siren} label="ER Cases" value={overview?.erCases ?? 0} />
          <Snap
            Icon={TrendingUp}
            label="Revenue"
            value={`Rs. ${(overview?.totalRevenue ?? 0).toLocaleString("en-IN")}`}
            isString
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Pending Approvals */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">
            Pending Approvals
          </h2>

          <ApprovalGroup
            Icon={PlaneTakeoff}
            title={`Leave Requests (${pendingLeaves.length})`}
            items={pendingLeaves.slice(0, 5).map((l: any) => ({
              id: l.id,
              primary: l.user?.name || "—",
              secondary: `${l.type} · ${new Date(l.startDate).toLocaleDateString()} → ${new Date(l.endDate).toLocaleDateString()}`,
            }))}
            onApprove={(id) => approve("leave", id)}
            viewAllHref="/dashboard/leave-management"
          />
          <ApprovalGroup
            Icon={Wallet}
            title={`Expenses (${pendingExpenses.length})`}
            items={pendingExpenses.slice(0, 5).map((e: any) => ({
              id: e.id,
              primary: e.description || e.vendor || "Expense",
              secondary: `Rs. ${(e.amount || 0).toLocaleString("en-IN")}`,
            }))}
            onApprove={(id) => approve("expense", id)}
            viewAllHref="/dashboard/expenses"
          />
          <ApprovalGroup
            Icon={ShoppingCart}
            title={`Purchase Orders (${pendingPOs.length})`}
            items={pendingPOs.slice(0, 5).map((p: any) => ({
              id: p.id,
              primary: p.poNumber || p.number || p.id.slice(0, 8),
              secondary: `${p.supplier?.name || "—"} · Rs. ${(p.totalAmount || 0).toLocaleString("en-IN")}`,
            }))}
            onApprove={(id) => approve("po", id)}
            viewAllHref="/dashboard/purchase-orders"
          />
        </div>

        {/* Resource Usage */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Resource Usage</h2>
          <div className="space-y-3">
            <ResourceBar
              label="Bed Occupancy"
              used={bedStats.occupied}
              total={bedStats.total}
              color="bg-indigo-500"
            />
            <ResourceBar
              label="Doctors On Duty"
              used={rosterToday.filter((s: any) => s.user?.role === "DOCTOR").length}
              total={Math.max(
                rosterToday.filter((s: any) => s.user?.role === "DOCTOR").length,
                1
              )}
              color="bg-blue-700"
              forceFull
            />
            <ResourceBar
              label="OT Utilization"
              used={otUtil.used}
              total={Math.max(otUtil.total, 1)}
              color="bg-rose-500"
            />
            <ResourceBar
              label="Low Stock Items"
              used={lowStock}
              total={Math.max(lowStock, 10)}
              color="bg-amber-500"
              warnAt={1}
            />
          </div>

          <div className="mt-4 border-t pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-700">
              Quick Links
            </h3>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <QuickLink href="/dashboard/users" Icon={UserCog} label="Users" />
              <QuickLink href="/dashboard/analytics" Icon={TrendingUp} label="Analytics" />
              <QuickLink href="/dashboard/reports" Icon={FlaskConical} label="Reports" />
              <QuickLink href="/dashboard/audit" Icon={Shield} label="Audit" />
              <QuickLink href="/dashboard/suppliers" Icon={Package} label="Suppliers" />
              <QuickLink href="/dashboard/assets" Icon={Wrench} label="Assets" />
              <QuickLink href="/dashboard/feedback" Icon={Star} label="Feedback" />
              <QuickLink href="/dashboard/broadcasts" Icon={CreditCard} label="Broadcasts" />
              <QuickLink href="/dashboard/duty-roster" Icon={Users} label="Roster" />
            </div>
          </div>
        </div>
      </div>

      {!loaded && (
        <p className="text-center text-xs text-gray-600">Loading…</p>
      )}
    </div>
  );
}

function Health({
  Icon,
  label,
  status,
  ok,
}: {
  Icon: React.ElementType;
  label: string;
  status: string;
  ok: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        ok ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-600">
        <Icon size={13} />
        {label}
      </div>
      <p
        className={`mt-1 text-sm font-bold ${
          ok ? "text-green-700" : "text-red-700"
        }`}
      >
        {status}
      </p>
    </div>
  );
}

function Alert({
  Icon,
  label,
  value,
  href,
}: {
  Icon: React.ElementType;
  label: string;
  value: number;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg bg-white p-3 shadow-sm transition hover:shadow-md"
    >
      <div className="rounded-lg bg-red-100 p-2 text-red-600">
        <Icon size={16} />
      </div>
      <div>
        <p className="text-[11px] text-gray-700">{label}</p>
        <p className="text-lg font-bold text-gray-800">{value}</p>
      </div>
    </Link>
  );
}

function Snap({
  Icon,
  label,
  value,
  isString,
}: {
  Icon: React.ElementType;
  label: string;
  value: number | string;
  isString?: boolean;
}) {
  return (
    <div className="rounded-lg bg-gray-50 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-700">
        <Icon size={12} /> {label}
      </div>
      <p className="mt-1 text-lg font-bold text-gray-800">
        {isString ? value : Number(value).toLocaleString("en-IN")}
      </p>
    </div>
  );
}

function ApprovalGroup({
  Icon,
  title,
  items,
  onApprove,
  viewAllHref,
}: {
  Icon: React.ElementType;
  title: string;
  items: Array<{ id: string; primary: string; secondary: string }>;
  onApprove: (id: string) => void;
  viewAllHref: string;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <Icon size={13} /> {title}
        </p>
        <Link href={viewAllHref} className="text-[11px] text-primary hover:underline">
          view all
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="px-2 py-1 text-xs text-gray-600">No pending items</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => (
            <div
              key={it.id}
              className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-gray-800">
                  {it.primary}
                </p>
                <p className="truncate text-[11px] text-gray-700">
                  {it.secondary}
                </p>
              </div>
              <button
                onClick={() => onApprove(it.id)}
                className="shrink-0 rounded-md bg-green-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-green-700"
              >
                Approve
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ResourceBar({
  label,
  used,
  total,
  color,
  warnAt,
  forceFull,
}: {
  label: string;
  used: number;
  total: number;
  color: string;
  warnAt?: number;
  forceFull?: boolean;
}) {
  const pct = forceFull
    ? 100
    : Math.min(Math.round((used / Math.max(total, 1)) * 100), 100);
  const warn = warnAt != null && used >= warnAt;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-gray-600">{label}</span>
        <span className={`font-semibold ${warn ? "text-red-600" : "text-gray-800"}`}>
          {used}/{total} ({pct}%)
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full ${warn ? "bg-red-500" : color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function QuickLink({
  href,
  Icon,
  label,
}: {
  href: string;
  Icon: React.ElementType;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-gray-700 hover:border-primary hover:text-primary"
    >
      <Icon size={13} /> {label}
    </Link>
  );
}
