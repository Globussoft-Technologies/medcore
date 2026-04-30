"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
// Issue #288 (2026-04-30): the Pending-Approvals card swallowed every
// failure as a generic "Approve failed" toast. We now surface the real
// API message (and field-level zod errors) so admins can tell a 404
// "Leave request not found" apart from a 400 "approved Required". See
// the rewritten `approve()` handler below for the consumer.
import { topLineError } from "@/lib/field-errors";
// Issue #109 / #119: route every user-facing date through the central
// formatDate helper so a `null` / undefined / unparseable value renders as
// "—" instead of "Invalid Date → Invalid Date".
import { formatDate } from "@/lib/format";
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

/**
 * Issue #47 breakdown row — one entry per action type seen in the last hour,
 * surfaced as a mini-table under the System Health "Errors (1h)" tile so a
 * raw count of 125 becomes "3 unique actions · top: LOGIN_FAILED (120) from
 * 2 IPs" rather than an opaque number.
 */
interface ErrorBreakdownRow {
  action: string;
  count: number;
  uniqueIps: number;
  topIp?: string;
  topIpCount?: number;
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
  const [errorCount, setErrorCount] = useState(0);
  const [errorBreakdown, setErrorBreakdown] = useState<ErrorBreakdownRow[]>([]);
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
  // Issue #108 (2026-04-26): the Doctors-On-Duty bar previously fed
  // `total = max(onDutyCount, 1)` and `forceFull` into ResourceBar, which
  // produced "0/1 (100%)" — math impossibility. We now also pull the total
  // employed-doctor count so the bar shows "0/12 (0%)" or "8/12 (66%)".
  const [totalDoctors, setTotalDoctors] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!isLoading && user && user.role !== "ADMIN") {
      router.replace("/dashboard");
    }
  }, [user, isLoading, router]);

  // Issue #48 (2026-04-24): day-bounds must be computed in the viewer's
  // timezone (hospital operates in IST) rather than UTC. `new Date()
  // .toISOString().split("T")[0]` returns the UTC date which, after
  // 18:30 local, is already tomorrow — producing empty snapshots.
  function localTodayBounds(): { fromISO: string; toISO: string; dayKey: string } {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const dayKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    return { fromISO: start.toISOString(), toISO: end.toISOString(), dayKey };
  }

  // Issue #48: refresh the admin-console every 60s so freshly-registered
  // patients show up in "Today Snapshot" without a hard reload. Also
  // mitigates any intermediate caching of /analytics/overview.
  useEffect(() => {
    if (!user || user.role !== "ADMIN") return;
    const id = window.setInterval(() => setRefreshTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [user]);

  useEffect(() => {
    if (!user || user.role !== "ADMIN") return;
    (async () => {
      const { fromISO, toISO, dayKey } = localTodayBounds();
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      const [
        health,
        ov,
        comp,
        pharmLow,
        pharmExp,
        bloodSum,
        audit,
        auditErrors,
        auditErrorRows,
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
        // Issue #48: use ISO timestamps at local-midnight bounds so the
        // server range filter aligns with the hospital's calendar day.
        safe<any>(`/analytics/overview?from=${fromISO}&to=${toISO}`, { data: null }),
        safe<any>(`/complaints?status=OPEN&limit=50`, { data: [] }),
        safe<any>(`/pharmacy/inventory?lowStock=true&limit=1`, { meta: { total: 0 } }),
        safe<any>(`/pharmacy/inventory?expiring=true&limit=1`, { meta: { total: 0 } }),
        safe<any>(`/bloodbank/inventory/summary`, { data: null }),
        // Total audit events (used for "Audit Events" card, not errors).
        safe<any>(`/audit?from=${hourAgo}&limit=1`, { meta: { total: 0 } }),
        // Real errors: login failures and other explicitly-failed actions.
        // The audit route does not support LIKE-matching; use action= filter.
        safe<any>(`/audit?from=${hourAgo}&action=LOGIN_FAILED&limit=1`, {
          meta: { total: 0 },
        }),
        // Issue #47 (2026-04-24): also pull a recent page of error rows so
        // we can render a breakdown (action · count · top-src-ip) beside
        // the raw count. `limit=100` is enough to characterise a noisy
        // hour without paging through thousands of entries.
        safe<any>(`/audit?from=${hourAgo}&action=LOGIN_FAILED&limit=100`, {
          data: [],
        }),
        safe<any>(`/leaves/pending`, { data: [] }),
        safe<any>(`/expenses?status=PENDING&limit=20`, { data: [] }),
        safe<any>(`/purchase-orders?status=PENDING&limit=20`, { data: [] }),
        safe<any>(`/wards`, { data: [] }),
        safe<any>(`/shifts/roster?date=${dayKey}`, { data: [] }),
        safe<any>(`/surgery?from=${fromISO}&to=${toISO}&limit=100`, { data: [] }),
        safe<any>(`/doctors`, { data: [] }),
      ]);

      setApiHealth(health?.status === "ok" ? "ok" : "down");
      setOverview(ov.data);
      const openComps = comp.data || comp.complaints || [];
      setComplaints(Array.isArray(openComps) ? openComps : []);
      setLowStock(pharmLow.meta?.total || 0);
      setExpiringMeds(pharmExp.meta?.total || 0);
      const blood = bloodSum.data;
      // Issue #49: the summary now returns `byBloodGroup` (map keyed by
      // group code, each value is a component→count map). A "low" group
      // is one whose total AVAILABLE units fall below a threshold.
      const bg: Record<string, Record<string, number>> = blood?.byBloodGroup || {};
      const lowGroups = Object.entries(bg)
        .map(([group, counts]) => ({
          group,
          available: Object.values(counts || {}).reduce(
            (a: number, b) => a + (Number(b) || 0),
            0
          ),
        }))
        .filter((g) => g.available < 3);
      setBloodLow(lowGroups);
      setAuditCount(audit.meta?.total || 0);
      setErrorCount(auditErrors.meta?.total || 0);

      // Issue #47: summarise error rows into (action, count, uniqueIps,
      // topIp, topIpCount). Even though the current query scopes to
      // LOGIN_FAILED, the breakdown is implemented generically so future
      // error actions appear automatically.
      const errRows: any[] = Array.isArray(auditErrorRows.data)
        ? auditErrorRows.data
        : [];
      const byAction = new Map<
        string,
        { count: number; ipCounts: Map<string, number> }
      >();
      for (const r of errRows) {
        const action = r.action || "UNKNOWN";
        const ip = (r.ipAddress as string) || "(unknown)";
        if (!byAction.has(action)) {
          byAction.set(action, { count: 0, ipCounts: new Map() });
        }
        const bucket = byAction.get(action)!;
        bucket.count += 1;
        bucket.ipCounts.set(ip, (bucket.ipCounts.get(ip) || 0) + 1);
      }
      const breakdown: ErrorBreakdownRow[] = Array.from(byAction.entries())
        .map(([action, { count, ipCounts }]) => {
          let topIp: string | undefined;
          let topIpCount = 0;
          ipCounts.forEach((c, ip) => {
            if (c > topIpCount) {
              topIp = ip;
              topIpCount = c;
            }
          });
          return {
            action,
            count,
            uniqueIps: ipCounts.size,
            topIp,
            topIpCount,
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      setErrorBreakdown(breakdown);

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
      // Issue #108 — the doctors endpoint returns the directory of all
      // employed doctors; this is the correct denominator for "Doctors On
      // Duty (X / total)". A 0-doctor hospital still renders sanely as 0/0
      // (0%) thanks to the guard in ResourceBar.
      setTotalDoctors(Array.isArray(users.data) ? users.data.length : 0);
      setLoaded(true);
    })();
  }, [user, refreshTick]);

  if (!user || user.role !== "ADMIN") {
    return (
      <div className="p-8 text-center text-gray-700">
        Admin Console restricted to administrators.
      </div>
    );
  }

  const hourAgoQs = new Date(Date.now() - 3600_000).toISOString();

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
        // Issue #288 (2026-04-30): the previous URL was `/leaves/${id}`
        // — there is no such route on the API; the approve endpoint is
        // `PATCH /leaves/:id/approve` and it requires `{ status }` per
        // approveLeaveSchema. Express therefore 404'd every click and
        // the catch-all toast claimed the approval "failed" with no
        // detail. Hit the correct route + send the schema-required
        // payload so the same Anita-Pawar leave that approves from
        // /dashboard/leave-management also approves from this card.
        await api.patch(`/leaves/${id}/approve`, { status: "APPROVED" });
        setPendingLeaves((xs) => xs.filter((x) => x.id !== id));
      } else if (kind === "expense") {
        // Issue #288: the body was `{}`. approveExpenseSchema requires
        // `{ approved: boolean }`, so zod rejected with a 400 +
        // field-level "approved is required" detail that the old
        // catch-block discarded. Send the explicit approval flag.
        await api.patch(`/expenses/${id}/approve`, { approved: true });
        setPendingExpenses((xs) => xs.filter((x) => x.id !== id));
      } else if (kind === "po") {
        await api.patch(`/purchase-orders/${id}/approve`, {});
        setPendingPOs((xs) => xs.filter((x) => x.id !== id));
      }
    } catch (err) {
      // Issue #288: stop swallowing the error. `topLineError` extracts
      // the first zod field-level message if the payload carried
      // `details: [...]`; otherwise it falls back to the API-supplied
      // `error` string and finally to a generic notice. Admins now see
      // "Cannot modify leave in status APPROVED" or "approved Required"
      // instead of the opaque "Approve failed".
      toast.error(topLineError(err, "Approve failed"));
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
            status={String(errorCount)}
            ok={errorCount < 10}
            href={`/dashboard/audit?action=LOGIN_FAILED&from=${hourAgoQs}`}
          />
          <Health
            Icon={UserCheck}
            label="Active Users"
            status={String(activeSessions)}
            ok={true}
          />
        </div>

        {/* Issue #47 (2026-04-24): when errors are non-zero, show an
            actionable breakdown rather than just a raw count so ops can
            tell bot-scraping apart from a real auth-service outage. */}
        {errorCount > 0 && errorBreakdown.length > 0 && (
          <div className="mt-4 border-t pt-3" data-testid="error-breakdown">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-700">
              Error breakdown (last 1h, top {errorBreakdown.length})
            </h3>
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-600">
                  <tr>
                    <th className="p-2">Action</th>
                    <th className="p-2">Count</th>
                    <th className="p-2">Unique IPs</th>
                    <th className="p-2">Most attempts from</th>
                  </tr>
                </thead>
                <tbody>
                  {errorBreakdown.map((row) => {
                    const likelyBot =
                      row.count >= 10 &&
                      row.uniqueIps > 0 &&
                      row.count / row.uniqueIps >= 20;
                    return (
                      <tr key={row.action} className="border-t border-gray-100">
                        <td className="p-2 font-mono text-[11px]">
                          <Link
                            href={`/dashboard/audit?action=${encodeURIComponent(
                              row.action
                            )}&from=${hourAgoQs}`}
                            className="text-primary hover:underline"
                          >
                            {row.action}
                          </Link>
                        </td>
                        <td className="p-2 font-semibold">
                          {row.count.toLocaleString("en-IN")}
                          {likelyBot && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                              likely bot traffic
                            </span>
                          )}
                        </td>
                        <td className="p-2">{row.uniqueIps}</td>
                        <td className="p-2 font-mono text-[11px]">
                          {row.topIp ? (
                            <>
                              {row.topIp}
                              <span className="ml-1 text-gray-500">
                                ({row.topIpCount})
                              </span>
                            </>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
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
              // Issue #109: API returns `fromDate`/`toDate` (not
              // startDate/endDate); the old keys produced "Invalid Date →
              // Invalid Date" on every row. We now read the correct fields
              // and route them through formatDate so any future null/empty
              // value renders as "—" instead of "Invalid Date".
              secondary: `${l.type} · ${formatDate(l.fromDate ?? l.startDate)} → ${formatDate(l.toDate ?? l.endDate)}`,
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
              // Issue #108: real "on duty / total doctors" ratio. The previous
              // implementation used `forceFull` and `total = max(used, 1)`, which
              // rendered the math-impossible "0/1 (100%)". With the directory
              // count as the denominator we get an honest 0/12 (0%) etc.
              used={rosterToday.filter((s: any) => s.user?.role === "DOCTOR").length}
              total={totalDoctors}
              color="bg-blue-700"
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
  href,
}: {
  Icon: React.ElementType;
  label: string;
  status: string;
  ok: boolean;
  href?: string;
}) {
  const body = (
    <>
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
    </>
  );
  const cls = `rounded-lg border p-3 ${
    ok ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"
  }`;
  if (href) {
    return (
      <Link href={href} className={`${cls} block transition hover:shadow-sm`}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
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
  // Issue #108 — a `total` of 0 must yield 0% (not 100%). The previous
  // `Math.max(total, 1)` divisor made every empty roster look fully staffed.
  const pct = forceFull
    ? 100
    : total <= 0
      ? 0
      : Math.min(Math.round((used / total) * 100), 100);
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
