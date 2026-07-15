"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
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
// Issue #534: scrub RFC1918 / loopback IPs from the error-breakdown
// table so the Admin Console doesn't leak internal-network topology to
// users who may not have full SRE clearance. Public IPs (real bot
// traffic) still render verbatim — we only redact private space.
import { scrubInternalIp } from "@/lib/scrub-ip";
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
import { SkeletonCard } from "@/components/Skeleton";

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

/**
 * Issue #47 (.issue-details.txt 2026-05-09 wave): canonical list of
 * audit-log action names that the codebase actually writes when something
 * goes wrong. Used by the System Health "Errors (1h)" widget so the count
 * isn't pinned to LOGIN_FAILED only — the previous behaviour silently
 * under-counted the other failure paths and made the tile look like a
 * vanity number that always ~matched the "Audit Events (1h)" tile in
 * low-traffic windows. Sourced via codebase grep for `auditLog(...,
 * "*FAILED|REJECTED|...")` against actual handler call sites; admin-only
 * audit actions like CONFIG_FAILED haven't been added because they don't
 * exist yet — they'll appear in the breakdown automatically once a
 * handler starts writing them.
 */
const ERROR_ACTIONS = [
  "LOGIN_FAILED",
  "PRESCRIPTION_REJECTED",
  "PRESCRIPTION_SHARE_FAILED",
  "NOTIFICATION_AUDIENCE_REJECTED",
] as const;

export default function AdminConsolePage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();
  const { t } = useTranslation();
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
  // Issue #936 (2026-05-24): track in-flight approval IDs so the row's
  // Approve button can be disabled while the PATCH is on the wire. Stops
  // the admin from double-clicking and racing the optimistic-prune
  // against the server's "already APPROVED" 4xx.
  const [approving, setApproving] = useState<Set<string>>(new Set());
  // Issue #744: friendly tenant identity for the header. Replaces the
  // raw `clinicId: <uuid>` fallback the page used to surface when ops
  // wanted to know which hospital they were looking at. We fetch from
  // /api/v1/me/tenant (any-authed) instead of /api/v1/tenants/:id which
  // is super-admin-only and would 403 a regular hospital admin.
  const [tenant, setTenant] = useState<{
    id: string;
    name: string;
    subdomain: string;
    plan: string;
    active: boolean;
    isDefault?: boolean;
  } | null>(null);
  // Issue #746: canonical Visitors-Today KPI shared with /dashboard/visitors
  // and (future) /dashboard/reports — anchored to the hospital's local day
  // (Asia/Kolkata) so all three surfaces always agree.
  const [visitorsToday, setVisitorsToday] = useState<number>(0);
  const [visitorsActive, setVisitorsActive] = useState<number>(0);

  // Issue #703 (May 2026): direct-URL navigation to /dashboard/admin-console
  // while authenticated used to force a re-login. Root cause: this useEffect
  // (and the early-return guard below) fired before the auth store had
  // hydrated from the server's session cookie — `user` was null on first
  // render, the page rendered "restricted to administrators", and any
  // adjacent redirect logic in the layout kicked the user back to /login.
  //
  // Fix: gate every redirect / restriction render on `!isLoading`. While the
  // store is still resolving /auth/me, render the same skeleton the rest of
  // the dashboard uses so we don't show a half-state. Only after isLoading
  // clears do we evaluate the user's role. This mirrors the hydration-aware
  // guard in /dashboard/queue/page.tsx (search "isAuthLoading").
  useEffect(() => {
    if (isLoading) return;
    if (user && user.role !== "ADMIN") {
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
        tenantRes,
        visitorStatsRes,
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
        // Issue #532: previous URL `/pharmacy/inventory?expiring=true&limit=1`
        // hit the generic list endpoint, which does NOT honour `expiring` and
        // returned `meta.total` = total inventory rows (often a large number)
        // instead of the expiring-medicines count. The dedicated
        // /pharmacy/inventory/expiring?days=30 endpoint returns just the
        // expiring rows, giving a stable, single-source-of-truth count that
        // no longer flickers against other widgets that read the same data.
        safe<any>(`/pharmacy/inventory/expiring?days=30`, { data: [] }),
        safe<any>(`/bloodbank/inventory/summary`, { data: null }),
        // Total audit events (used for "Audit Events" card, not errors).
        safe<any>(`/audit?from=${hourAgo}&limit=1`, { meta: { total: 0 } }),
        // Issue #47 (2026-05-09): "real errors" is the union of the canonical
        // ERROR_ACTIONS allowlist, not just LOGIN_FAILED. The audit route now
        // supports `actionIn=A,B,C` (added 2026-05-09) so a single round-trip
        // returns the full count instead of one-per-action. The old
        // `action=LOGIN_FAILED` shape was historically narrow and made
        // "Errors (1h)" look ~equal to "Audit Events (1h)" in low-traffic
        // windows where the only audit writes were login failures.
        safe<any>(
          `/audit?from=${hourAgo}&actionIn=${ERROR_ACTIONS.join(",")}&limit=1`,
          { meta: { total: 0 } }
        ),
        // Issue #47 (2026-04-24, refactored 2026-05-09): also pull a recent
        // page of error rows so we can render a breakdown (action · count ·
        // top-src-ip) beside the raw count. `limit=100` is enough to
        // characterise a noisy hour without paging through thousands of
        // entries. Same `actionIn` allowlist as the count query so the
        // numbers reconcile (sum of breakdown rows = displayed count, modulo
        // the 100-row page cap which we surface in the panel header).
        safe<any>(
          `/audit?from=${hourAgo}&actionIn=${ERROR_ACTIONS.join(",")}&limit=100`,
          { data: [] }
        ),
        safe<any>(`/leaves/pending`, { data: [] }),
        safe<any>(`/expenses?status=PENDING&limit=20`, { data: [] }),
        safe<any>(`/purchase-orders?status=PENDING&limit=20`, { data: [] }),
        safe<any>(`/wards`, { data: [] }),
        safe<any>(`/shifts/roster?date=${dayKey}`, { data: [] }),
        safe<any>(`/surgery?from=${fromISO}&to=${toISO}&limit=100`, { data: [] }),
        safe<any>(`/doctors`, { data: [] }),
        // Issue #744: friendly tenant identity for the header banner.
        safe<any>(`/me/tenant`, { data: null }),
        // Issue #746: canonical visitor KPI for the snapshot tile.
        safe<any>(`/visitors-stats?period=today`, { data: null }),
      ]);

      setApiHealth(health?.status === "ok" ? "ok" : "down");
      setOverview(ov.data);
      const openComps = comp.data || comp.complaints || [];
      setComplaints(Array.isArray(openComps) ? openComps : []);
      setLowStock(pharmLow.meta?.total || 0);
      // Issue #532: response shape is `{ data: InventoryItem[] }` — count the
      // array length directly (no pagination on this endpoint).
      setExpiringMeds(Array.isArray(pharmExp.data) ? pharmExp.data.length : 0);
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
      // Issue #744: stash friendly tenant identity for the header.
      setTenant(tenantRes?.data ?? null);
      // Issue #746: pull the canonical totalToday + currentlyActive numbers
      // and store them so the snapshot tile renders one source of truth.
      const vs = visitorStatsRes?.data;
      setVisitorsToday(typeof vs?.totalToday === "number" ? vs.totalToday : 0);
      setVisitorsActive(typeof vs?.currentlyActive === "number" ? vs.currentlyActive : 0);
      setLoaded(true);
    })();
  }, [user, refreshTick]);

  // Issue #703: while the auth store is still hydrating from /auth/me,
  // render a skeleton instead of the "restricted" placeholder. Showing the
  // restriction text on a brief flicker before the user object lands was
  // confusing (especially on direct URL navigation) and combined with the
  // layout's redirect-effect to bounce the admin back to /login.
  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center p-12 text-sm text-gray-700 dark:text-gray-300"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        Loading…
      </div>
    );
  }

  if (!user || user.role !== "ADMIN") {
    return (
      <div className="p-8 text-center text-gray-700 dark:text-gray-300">
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
  // Issue #314: the canonical schema field is `slaDueAt` (Complaint model in
  // packages/db). The previous keys (`slaBreachAt` / `dueAt`) never exist on
  // the response, so this filter always returned 0 and the Admin Console SLA
  // Overdue tile contradicted the Complaints page (which renders against the
  // same `slaDueAt`). Match the schema field with the legacy aliases retained
  // as a defensive fallback.
  const overdueComplaints = complaints.filter((c: any) => {
    const due = c.slaDueAt || c.slaBreachAt || c.dueAt;
    return due && new Date(due) < new Date();
  }).length;

  async function approve(kind: "leave" | "expense" | "po", id: string) {
    // Issue #936: guard against double-clicks while in flight.
    if (approving.has(id)) return;
    setApproving((s) => {
      const next = new Set(s);
      next.add(id);
      return next;
    });
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
      // Issue #936 (2026-05-24): when the server rejects with "already
      // APPROVED/REJECTED" (the row is stale on the client), prune the
      // dead row optimistically AND bump the refresh tick so the next
      // useEffect cycle refetches authoritative state. Without this the
      // row sat in the list with an enabled Approve button forever, and
      // the counter (`Expenses (N)`) never decremented — repeated
      // clicks reproduced the same toast indefinitely.
      const status = (err as { status?: number })?.status;
      const message = (err as { message?: string })?.message ?? "";
      const isAlready = status === 400 && /already (APPROVED|REJECTED)/i.test(message);
      if (isAlready) {
        if (kind === "leave") {
          setPendingLeaves((xs) => xs.filter((x) => x.id !== id));
        } else if (kind === "expense") {
          setPendingExpenses((xs) => xs.filter((x) => x.id !== id));
        } else if (kind === "po") {
          setPendingPOs((xs) => xs.filter((x) => x.id !== id));
        }
        setRefreshTick((t) => t + 1);
      }
    } finally {
      // Issue #936: always release the in-flight latch.
      setApproving((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t("adminConsole.title")}</h1>
          <p className="text-sm text-gray-700 dark:text-gray-300">{t("adminConsole.subtitle")}</p>
          {/* Issue #744: render tenant identity by FRIENDLY name + short
              slug rather than the raw UUID `clinicId` that this page used
              to surface in toast errors and debug breadcrumbs. The
              tenantId is intentionally NOT rendered here — operators
              identify hospitals by name; the UUID is an internal handle
              with no meaning at this surface. */}
          {tenant && (
            <p
              className="mt-1 text-xs text-gray-600 dark:text-gray-400"
              data-testid="admin-console-tenant-banner"
            >
              <span className="font-medium text-gray-800 dark:text-gray-200">{tenant.name}</span>{" "}
              <span className="font-mono">(#{tenant.subdomain})</span>
              {/* The Main/Default hospital is un-gated → show "Full Access"
                  instead of a plan tier. */}
              <span
                className={`ml-2 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                  tenant.isDefault
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                }`}
              >
                {tenant.isDefault ? t("adminConsole.fullAccess") : tenant.plan}
              </span>
            </p>
          )}
        </div>
        {/* a11y: text-primary (#2563eb) on bg-primary/10 (effective ~#e9eefe
            over white) is ~4.31:1 — under WCAG AA's 4.5:1 for normal text.
            Using --color-primary-dark (#1d4ed8 = blue-700) on the same tint
            lifts the ratio to ~5.4:1 while preserving the badge's visual
            identity. */}
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-blue-800 dark:text-blue-200">
          ADMIN
        </span>
      </div>

      {/* System Health */}
      <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
        <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">{t("adminConsole.systemHealth")}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Health
            Icon={Server}
            label={t("adminConsole.health.api")}
            status={apiHealth === "ok" ? t("adminConsole.status.healthy") : apiHealth === "down" ? t("adminConsole.status.down") : "—"}
            ok={apiHealth === "ok"}
          />
          <Health
            Icon={Database}
            label={t("adminConsole.health.database")}
            status={apiHealth === "ok" ? t("adminConsole.status.connected") : "—"}
            ok={apiHealth === "ok"}
          />
          <Health Icon={Activity} label={t("adminConsole.health.uptime")} status={t("adminConsole.status.live")} ok={true} />
          <Health
            Icon={AlertTriangle}
            label={t("adminConsole.health.errors1h")}
            status={String(errorCount)}
            ok={errorCount < 10}
            // Issue #47 (2026-05-09): the count now spans the canonical
            // ERROR_ACTIONS allowlist, so the drill-in can no longer
            // pre-filter to a single `action=`. The audit-page filter
            // dropdown accepts only one action at a time; per-action
            // drill-down lives in the breakdown table below this tile.
            // The tile itself just lands on the audit log scoped to the
            // last hour so admins land on a meaningful slice immediately.
            href={`/dashboard/audit?from=${hourAgoQs}`}
          />
          <Health
            Icon={UserCheck}
            label={t("adminConsole.health.activeUsers")}
            status={String(activeSessions)}
            ok={true}
          />
        </div>

        {/* Issue #47 (2026-04-24): when errors are non-zero, show an
            actionable breakdown rather than just a raw count so ops can
            tell bot-scraping apart from a real auth-service outage. */}
        {errorCount > 0 && errorBreakdown.length > 0 && (
          <div className="mt-4 border-t pt-3 dark:border-gray-700" data-testid="error-breakdown">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-200">
              Error breakdown (last 1h, top {errorBreakdown.length})
            </h3>
            <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-600 dark:bg-gray-700 dark:text-gray-300">
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
                      <tr key={row.action} className="border-t border-gray-100 dark:border-gray-700 dark:text-gray-200">
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
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                              likely bot traffic
                            </span>
                          )}
                        </td>
                        <td className="p-2">{row.uniqueIps}</td>
                        <td className="p-2 font-mono text-[11px]">
                          {row.topIp ? (
                            <>
                              {/* Issue #534: scrub RFC1918 / loopback IPs
                                  here so we never render an internal
                                  topology breadcrumb. Public IPs flow
                                  through unchanged. */}
                              {scrubInternalIp(row.topIp)}
                              {/* a11y: text-gray-500 on white = 4.59:1 (passes
                                  4.5:1 normal-text). text-gray-400 (#9ca3af)
                                  on white was 2.84:1 — below WCAG AA — so the
                                  empty-state em-dash now uses text-gray-600
                                  (#4b5563) for ~7.5:1 against the white card
                                  background. Per ARCHITECTURE.md this closes
                                  the admin-console color-contrast tech debt. */}
                              <span className="ml-1 text-gray-600 dark:text-gray-400">
                                ({row.topIpCount})
                              </span>
                            </>
                          ) : (
                            <span className="text-gray-600 dark:text-gray-400">—</span>
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
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-900/20">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-red-800 dark:text-red-300">
          <AlertTriangle size={16} /> {t("adminConsole.criticalAlerts")}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Alert
            Icon={AlertTriangle}
            label={t("adminConsole.alert.slaOverdue")}
            value={overdueComplaints}
            href="/dashboard/complaints"
          />
          <Alert
            Icon={Droplet}
            label={t("adminConsole.alert.lowBlood")}
            value={bloodLow.length}
            href="/dashboard/bloodbank"
          />
          <Alert
            Icon={Pill}
            label={t("adminConsole.alert.expiringMeds")}
            value={expiringMeds}
            href="/dashboard/pharmacy"
          />
          <Alert
            Icon={Shield}
            label={t("adminConsole.alert.auditEvents1h")}
            value={auditCount}
            href="/dashboard/audit"
          />
        </div>
      </div>

      {/* Today snapshot */}
      <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
        <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">{t("adminConsole.todaySnapshot")}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Snap Icon={Users} label={t("adminConsole.snap.registered")} value={overview?.newPatients ?? 0} />
          <Snap Icon={BedDouble} label={t("adminConsole.snap.admissions")} value={overview?.admissions ?? 0} />
          <Snap Icon={CheckCircle2} label={t("adminConsole.snap.discharges")} value={overview?.discharges ?? 0} />
          <Snap Icon={Scissors} label={t("adminConsole.snap.surgeries")} value={overview?.surgeries ?? 0} />
          <Snap Icon={Siren} label={t("adminConsole.snap.erCases")} value={overview?.erCases ?? 0} />
          {/* Issue #746: Visitors-Today KPI from the canonical
              /visitors-stats endpoint. The tile shows totalToday with the
              currently-inside count as a sub-line so operators can see
              both numbers at a glance and confirm Inside ⊆ Today. */}
          <Snap
            Icon={UserCheck}
            label={t("adminConsole.snap.visitorsToday")}
            value={`${visitorsToday}${visitorsActive > 0 ? ` (${visitorsActive} in)` : ""}`}
            isString
            data-testid="admin-console-visitors-today"
          />
          <Snap
            Icon={TrendingUp}
            label={t("adminConsole.snap.revenue")}
            value={`Rs. ${(overview?.totalRevenue ?? 0).toLocaleString("en-IN")}`}
            isString
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Pending Approvals */}
        <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
            {t("adminConsole.pendingApprovals")}
          </h2>

          <ApprovalGroup
            Icon={PlaneTakeoff}
            title={`${t("adminConsole.leaveRequests")} (${pendingLeaves.length})`}
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
            approving={approving}
            viewAllHref="/dashboard/leave-management"
          />
          <ApprovalGroup
            Icon={Wallet}
            title={`${t("adminConsole.expenses")} (${pendingExpenses.length})`}
            items={pendingExpenses.slice(0, 5).map((e: any) => ({
              id: e.id,
              primary: e.description || e.vendor || "Expense",
              secondary: `Rs. ${(e.amount || 0).toLocaleString("en-IN")}`,
            }))}
            onApprove={(id) => approve("expense", id)}
            approving={approving}
            viewAllHref="/dashboard/expenses"
          />
          <ApprovalGroup
            Icon={ShoppingCart}
            title={`${t("adminConsole.purchaseOrders")} (${pendingPOs.length})`}
            items={pendingPOs.slice(0, 5).map((p: any) => ({
              id: p.id,
              primary: p.poNumber || p.number || p.id.slice(0, 8),
              secondary: `${p.supplier?.name || "—"} · Rs. ${(p.totalAmount || 0).toLocaleString("en-IN")}`,
            }))}
            onApprove={(id) => approve("po", id)}
            approving={approving}
            viewAllHref="/dashboard/purchase-orders"
          />
        </div>

        {/* Resource Usage */}
        <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">{t("adminConsole.resourceUsage")}</h2>
          <div className="space-y-3">
            <ResourceBar
              label={t("adminConsole.res.bedOccupancy")}
              used={bedStats.occupied}
              total={bedStats.total}
              color="bg-indigo-500"
            />
            <ResourceBar
              label={t("adminConsole.res.doctorsOnDuty")}
              // Issue #108: real "on duty / total doctors" ratio. The previous
              // implementation used `forceFull` and `total = max(used, 1)`, which
              // rendered the math-impossible "0/1 (100%)". With the directory
              // count as the denominator we get an honest 0/12 (0%) etc.
              used={rosterToday.filter((s: any) => s.user?.role === "DOCTOR").length}
              total={totalDoctors}
              color="bg-blue-700"
            />
            <ResourceBar
              label={t("adminConsole.res.otUtilization")}
              used={otUtil.used}
              total={Math.max(otUtil.total, 1)}
              color="bg-rose-500"
            />
            <ResourceBar
              label={t("adminConsole.res.lowStockItems")}
              used={lowStock}
              total={Math.max(lowStock, 10)}
              color="bg-amber-500"
              warnAt={1}
            />
          </div>

          <div className="mt-4 border-t pt-3 dark:border-gray-700">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-200">
              {t("adminConsole.quickLinks")}
            </h3>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <QuickLink href="/dashboard/users" Icon={UserCog} label={t("dashboard.nav.users")} />
              <QuickLink href="/dashboard/analytics" Icon={TrendingUp} label={t("dashboard.nav.analytics")} />
              <QuickLink href="/dashboard/reports" Icon={FlaskConical} label={t("dashboard.nav.reports")} />
              <QuickLink href="/dashboard/audit" Icon={Shield} label={t("dashboard.nav.audit")} />
              <QuickLink href="/dashboard/suppliers" Icon={Package} label={t("dashboard.nav.suppliers")} />
              <QuickLink href="/dashboard/assets" Icon={Wrench} label={t("dashboard.nav.assets")} />
              <QuickLink href="/dashboard/feedback" Icon={Star} label={t("dashboard.nav.feedback")} />
              <QuickLink href="/dashboard/broadcasts" Icon={CreditCard} label={t("dashboard.nav.broadcasts")} />
              <QuickLink href="/dashboard/duty-roster" Icon={Users} label={t("dashboard.nav.dutyRoster")} />
            </div>
          </div>
        </div>
      </div>

      {!loaded && (
        <div
          data-testid="admin-console-loading"
          aria-busy="true"
          className="grid grid-cols-1 gap-3 md:grid-cols-3"
        >
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
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
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
        <Icon size={13} />
        {label}
      </div>
      <p
        className={`mt-1 text-sm font-bold ${
          ok ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300"
        }`}
      >
        {status}
      </p>
    </>
  );
  const cls = `rounded-lg border p-3 ${
    ok
      ? "border-green-200 bg-green-50 dark:border-green-900/50 dark:bg-green-900/20"
      : "border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/20"
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
      className="flex items-center gap-3 rounded-lg bg-white p-3 shadow-sm transition hover:shadow-md dark:bg-gray-800"
    >
      <div className="rounded-lg bg-red-100 p-2 text-red-600 dark:bg-red-900/40 dark:text-red-300">
        <Icon size={16} />
      </div>
      <div>
        <p className="text-[11px] text-gray-700 dark:text-gray-300">{label}</p>
        <p className="text-lg font-bold text-gray-800 dark:text-gray-100">{value}</p>
      </div>
    </Link>
  );
}

function Snap({
  Icon,
  label,
  value,
  isString,
  "data-testid": testId,
}: {
  Icon: React.ElementType;
  label: string;
  value: number | string;
  isString?: boolean;
  "data-testid"?: string;
}) {
  return (
    <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-700" data-testid={testId}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300">
        <Icon size={12} /> {label}
      </div>
      <p className="mt-1 text-lg font-bold text-gray-800 dark:text-gray-100">
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
  approving,
  viewAllHref,
}: {
  Icon: React.ElementType;
  title: string;
  items: Array<{ id: string; primary: string; secondary: string }>;
  onApprove: (id: string) => void;
  // Issue #936 (2026-05-24): set of row ids whose approval PATCH is
  // currently in flight. Used to disable the per-row Approve button so
  // the admin can't double-click and race the optimistic prune against
  // the server's "already APPROVED" 4xx.
  approving?: Set<string>;
  viewAllHref: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-200">
          <Icon size={13} /> {title}
        </p>
        <Link href={viewAllHref} className="text-[11px] text-primary hover:underline">
          {t("adminConsole.viewAll")}
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="px-2 py-1 text-xs text-gray-600 dark:text-gray-400">{t("adminConsole.noPending")}</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => (
            <div
              key={it.id}
              className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-1.5 dark:border-gray-700 dark:bg-gray-700"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">
                  {it.primary}
                </p>
                <p className="truncate text-[11px] text-gray-700 dark:text-gray-300">
                  {it.secondary}
                </p>
              </div>
              {/* a11y: text-white on bg-green-600 (#16a34a) is only 3.34:1 —
                  below WCAG AA (4.5:1) for the 11px button label. Bumping the
                  resting state to bg-green-700 (#15803d) raises it to ~5.5:1
                  while keeping the same hover affordance via bg-green-800. */}
              {/* Issue #936: disable while the approval PATCH is in flight so
                  a double-click cannot race the optimistic prune. */}
              {(() => {
                const busy = approving?.has(it.id) ?? false;
                return (
                  <button
                    onClick={() => onApprove(it.id)}
                    disabled={busy}
                    aria-label={`Approve ${it.primary}`}
                    aria-busy={busy || undefined}
                    className="shrink-0 rounded-md bg-green-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-green-800 disabled:cursor-not-allowed disabled:bg-green-700/60"
                  >
                    {busy ? t("adminConsole.approving") : t("adminConsole.approve")}
                  </button>
                );
              })()}
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
        <span className="text-gray-600 dark:text-gray-300">{label}</span>
        <span className={`font-semibold ${warn ? "text-red-600 dark:text-red-400" : "text-gray-800 dark:text-gray-100"}`}>
          {used}/{total} ({pct}%)
        </span>
      </div>
      {/* Issue #818: pair the bg-gray-100 track with bg-gray-700 in dark mode.
          The track must always render — even when the fill (`warn`) is red and
          the fill width is small (10%), the remaining 90% should show a clearly
          contrasted track instead of the appearance of a "floating dash". */}
      <div className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
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
      className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-gray-700 hover:border-primary hover:text-primary dark:border-gray-700 dark:bg-gray-700 dark:text-gray-200 dark:hover:border-blue-400 dark:hover:bg-gray-600 dark:hover:text-blue-400"
    >
      <Icon size={13} /> {label}
    </Link>
  );
}
