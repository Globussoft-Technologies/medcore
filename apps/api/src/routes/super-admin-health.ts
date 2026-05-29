/**
 * Pearl ERP Stage 1 §8.4 (2026-05-28) — per-tenant API health surface.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: a read-only API the operator UI uses to render the
 *   per-tenant health panel — error rates, p95 latency, slow-endpoint
 *   leaderboard, and the rolling count of failed background jobs.
 *   Aggregates over `RequestMetric` (logged by middleware/metrics.ts
 *   for slow + 5xx requests) and `ScheduledTaskRun` (cron tracking
 *   table from §8.4 piece 3).
 * - MODULES:
 *   - `RequestMetric` (read) — fed by `apiMetricsMiddleware`.
 *   - `ScheduledTaskRun` (read) — fed by `runTaskWithAudit` in
 *     services/scheduled-tasks.ts.
 *   - `Tenant` (read) — to join human names onto the per-tenant rows.
 * - WHY: §8.4 calls for "per-tenant health — error rates, slow
 *   endpoints (p95 > 1s), failed background jobs". The aggregates are
 *   cheap to compute on the indexed columns (statusCode, createdAt,
 *   tenantId) and the result set is small (one row per tenant) so we
 *   stream the full payload rather than paginating.
 *
 * RBAC mirror
 * ───────────
 * Identical guard chain to `routes/super-admin-metrics.ts` — `authenticate`
 * + `authorize(ADMIN, SUPER_ADMIN)` + the local `requireSuperAdmin`
 * shape (tenant-less ADMIN OR Role.SUPER_ADMIN OR ADMIN on the seeded
 * "default" tenant). The narrower guards belt-and-suspenders the API
 * gate even though the dashboard sidebar already hides the page from
 * non-super-admin tenants.
 *
 * Why not just push to Prometheus / OTel?
 * ───────────────────────────────────────
 * Pearl Stage 1 needs an operator-readable surface in-product BEFORE
 * any prod telemetry pipeline lands. Once OTel exports start, this
 * endpoint stays as the operator-readable view + the database is the
 * historical archive (RequestMetric rows survive even if the
 * telemetry pipe goes down).
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { enforceSuperAdminIdleTimeout } from "../middleware/session-idle";

const router = Router();

async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (req.user?.role === Role.SUPER_ADMIN) return next();
    const callerTenantId = req.user?.tenantId ?? null;
    if (callerTenantId == null) return next();
    const callerTenant = await prisma.tenant.findUnique({
      where: { id: callerTenantId },
      select: { subdomain: true },
    });
    if (callerTenant?.subdomain === "default") return next();
    res.status(403).json({
      success: false,
      data: null,
      error: "Only super-admins can read cross-tenant health metrics",
    });
    return;
  } catch (err) {
    next(err);
  }
}

router.use(authenticate);
router.use(authorize(Role.ADMIN, Role.SUPER_ADMIN));
router.use(requireSuperAdmin);
router.use(enforceSuperAdminIdleTimeout);

// Untyped accessors for the two tables introduced in the §8.4 schema
// migration; the Prisma client may not have been regenerated on the
// dev box that holds the engine DLL lock. Runtime works because
// `db push` already created the columns.
type LooseDelegate = {
  findMany: (args: unknown) => Promise<unknown[]>;
  groupBy: (args: unknown) => Promise<unknown[]>;
  count: (args?: unknown) => Promise<number>;
};
const requestMetric = (prisma as unknown as {
  requestMetric: LooseDelegate;
}).requestMetric;
const scheduledTaskRun = (prisma as unknown as {
  scheduledTaskRun: LooseDelegate;
}).scheduledTaskRun;

const healthQuerySchema = z.object({
  // Default lookback window is 24h — short enough for the aggregator
  // to remain fast on a busy DB, long enough for diurnal patterns.
  hours: z.coerce.number().int().min(1).max(168).default(24),
});

interface PerTenantHealthRow {
  tenantId: string | null;
  tenantName: string | null;
  totalSlowOrErrorRequests: number;
  slowCount: number; // 2xx/4xx + duration >= 1s
  errorCount: number; // statusCode >= 500
  p95DurationMs: number;
  failedJobsLast24h: number;
}

interface SlowEndpointRow {
  pathTemplate: string;
  method: string;
  count: number;
  p95DurationMs: number;
}

/**
 * Percentile helper — sorted ascending, picks the index closest to the
 * requested percentile. Mirrors the simple Nginx-style p95 calculation.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)];
}

router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = healthQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid query",
        });
        return;
      }
      const { hours } = parsed.data;
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);

      // Pull all interesting requests in the window in one query.
      // The DB-level cap keeps it bounded — the slow/error filter in
      // the middleware already throttles writes, and we cap at 50k for
      // safety on a misbehaving boot wave.
      const rawMetrics = (await requestMetric.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 50_000,
      })) as Array<{
        tenantId: string | null;
        statusCode: number;
        durationMs: number;
        pathTemplate: string;
        method: string;
      }>;

      // Group by tenant for the per-tenant table.
      const byTenant = new Map<
        string | null,
        { durations: number[]; errors: number; slow: number; total: number }
      >();
      for (const m of rawMetrics) {
        const key = m.tenantId ?? null;
        let bucket = byTenant.get(key);
        if (!bucket) {
          bucket = { durations: [], errors: 0, slow: 0, total: 0 };
          byTenant.set(key, bucket);
        }
        bucket.total += 1;
        bucket.durations.push(m.durationMs);
        if (m.statusCode >= 500) bucket.errors += 1;
        else bucket.slow += 1; // by definition, if not error it's slow
      }

      // Join tenant names in one batched read.
      const tenantIds = Array.from(byTenant.keys()).filter(
        (id): id is string => id !== null,
      );
      const tenants =
        tenantIds.length > 0
          ? await prisma.tenant.findMany({
              where: { id: { in: tenantIds } },
              select: { id: true, name: true },
            })
          : [];
      const tenantNameById = new Map(tenants.map((t) => [t.id, t.name]));

      // Pull failed-job counts per tenantId in one groupBy.
      const failedRuns = (await scheduledTaskRun.groupBy({
        by: ["tenantId"],
        where: {
          status: "FAILED",
          startedAt: { gte: since },
        },
        _count: { _all: true },
      })) as Array<{ tenantId: string | null; _count: { _all: number } }>;
      const failedByTenant = new Map<string | null, number>();
      for (const r of failedRuns) {
        failedByTenant.set(r.tenantId ?? null, r._count._all);
      }

      const perTenant: PerTenantHealthRow[] = [];
      for (const [tenantId, bucket] of byTenant) {
        bucket.durations.sort((a, b) => a - b);
        perTenant.push({
          tenantId,
          tenantName:
            tenantId === null
              ? "(platform / cross-tenant)"
              : (tenantNameById.get(tenantId) ?? "(unknown)"),
          totalSlowOrErrorRequests: bucket.total,
          slowCount: bucket.slow,
          errorCount: bucket.errors,
          p95DurationMs: percentile(bucket.durations, 95),
          failedJobsLast24h: failedByTenant.get(tenantId) ?? 0,
        });
      }
      perTenant.sort(
        (a, b) =>
          b.errorCount - a.errorCount ||
          b.totalSlowOrErrorRequests - a.totalSlowOrErrorRequests,
      );

      // Top-20 slow endpoints across all tenants — the leaderboard.
      const byEndpoint = new Map<
        string,
        { durations: number[]; count: number; method: string; path: string }
      >();
      for (const m of rawMetrics) {
        const key = `${m.method} ${m.pathTemplate}`;
        let bucket = byEndpoint.get(key);
        if (!bucket) {
          bucket = {
            durations: [],
            count: 0,
            method: m.method,
            path: m.pathTemplate,
          };
          byEndpoint.set(key, bucket);
        }
        bucket.count += 1;
        bucket.durations.push(m.durationMs);
      }
      const slowEndpoints: SlowEndpointRow[] = Array.from(byEndpoint.values())
        .map((b) => {
          b.durations.sort((a, b) => a - b);
          return {
            pathTemplate: b.path,
            method: b.method,
            count: b.count,
            p95DurationMs: percentile(b.durations, 95),
          };
        })
        .sort((a, b) => b.p95DurationMs - a.p95DurationMs)
        .slice(0, 20);

      // Platform totals.
      const totals = {
        windowHours: hours,
        totalInterestingRequests: rawMetrics.length,
        totalErrors: rawMetrics.filter((m) => m.statusCode >= 500).length,
        totalSlow: rawMetrics.filter((m) => m.statusCode < 500).length,
        totalFailedJobs: Array.from(failedByTenant.values()).reduce(
          (s, n) => s + n,
          0,
        ),
        tenantsAffected: perTenant.length,
      };

      res.status(200).json({
        success: true,
        data: { totals, perTenant, slowEndpoints },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export const superAdminHealthRouter = router;
