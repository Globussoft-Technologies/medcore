/**
 * Cross-tenant super-admin metrics — Pearl ERP Stage 1 §8.4
 * (gap rows 219 + 220 closure, 2026-05-23).
 *
 * What / which modules / why:
 *   - Operator-facing roll-up: cluster-wide totals (tenants, users,
 *     patients, recent appointments/invoices, active campaigns) +
 *     per-tenant rollup (top-20 by userCount). Super-admin only.
 *   - Closes the two open §8.4 partial-rows (219 + 220). Hospital-level
 *     "health" today is Sentry + OTel + `services/metrics.ts`; the Pearl
 *     super-admin needs a single page that aggregates across tenants
 *     without crossing the apps→packages arrow. We deliberately stay
 *     read-only — no rolling-window aggregation table is created (that's
 *     a piece-2 perf optimization if these queries get slow at >50
 *     tenants).
 *   - Mounts at /api/v1/super-admin/metrics. Endpoint:
 *       GET /  — totals + perTenant (top-20-by-userCount).
 *   - RBAC: router-level `authenticate` + `authorize(Role.ADMIN)` +
 *     `requireSuperAdmin` (mirrors `tenants.ts` exactly: tenant-less
 *     ADMIN OR ADMIN on the seeded "default" tenant). PATIENT/DOCTOR etc
 *     bounce at `authorize`; tenant-bound ADMINs bounce at the guard.
 *   - Audit: awaited `auditLog()` (NOT `safeAudit`) so the integration
 *     test can read AuditLog immediately. Action
 *     SUPER_ADMIN_METRICS_VIEWED.
 *   - Scope-cut from prompt: "active" campaigns are defined as status
 *     in (SCHEDULED, RUNNING) per `CampaignStatus` enum. DRAFT and
 *     PAUSED are not counted as "active" — DRAFT has never been
 *     scheduled and PAUSED is operator-initiated halt.
 */

import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { enforceSuperAdminIdleTimeout } from "../middleware/session-idle";

const router = Router();

// ─── Guards ──────────────────────────────────────────────────────────

/**
 * Mirrors `routes/tenants.ts:requireSuperAdmin` + `super-admin-users.ts`.
 * Re-declared locally so this route stays independently movable (Pearl
 * may eventually host /super-admin/ on its own service).
 */
async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // Pearl §8.2 — Role.SUPER_ADMIN is a wildcard "root" role: full
    // access on every super-admin surface regardless of tenant binding.
    if (req.user?.role === Role.SUPER_ADMIN) {
      return next();
    }
    const callerTenantId = req.user?.tenantId ?? null;
    if (callerTenantId == null) {
      return next();
    }
    const callerTenant = await prisma.tenant.findUnique({
      where: { id: callerTenantId },
      select: { subdomain: true },
    });
    if (callerTenant?.subdomain === "default") {
      return next();
    }
    res.status(403).json({
      success: false,
      data: null,
      error: "Only super-admins can view cross-tenant metrics",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface PerTenantRow {
  tenantId: string;
  tenantName: string;
  plan: string;
  active: boolean;
  userCount: number;
  patientCount: number;
  appointmentsLast7d: number;
  invoicesLast30d: number;
  createdAt: string;
}

interface MetricsTotals {
  tenants: number;
  activeTenants: number;
  users: number;
  patients: number;
  appointmentsLast7d: number;
  invoicesLast30d: number;
  campaignsActive: number;
}

const PER_TENANT_CAP = 20;

// ─── Routes ──────────────────────────────────────────────────────────

router.use(authenticate);
router.use(authorize(Role.ADMIN, Role.SUPER_ADMIN));
router.use(requireSuperAdmin);
router.use(enforceSuperAdminIdleTimeout);

// GET /api/v1/super-admin/metrics — cluster totals + per-tenant rollup.
router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = Date.now();
      const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

      // Cluster totals + per-tenant groupings fan out in parallel. Each
      // groupBy returns ONE row per tenantId, which we then map into a
      // single per-tenant array below.
      const [
        tenants,
        tenantsCount,
        activeTenantsCount,
        usersCount,
        patientsCount,
        appointmentsLast7dCount,
        invoicesLast30dCount,
        campaignsActiveCount,
        userByTenant,
        patientByTenant,
        apptByTenant,
        invoiceByTenant,
      ] = await Promise.all([
        prisma.tenant.findMany({
          select: {
            id: true,
            name: true,
            plan: true,
            active: true,
            createdAt: true,
          },
        }),
        prisma.tenant.count(),
        prisma.tenant.count({ where: { active: true } }),
        prisma.user.count(),
        prisma.patient.count(),
        prisma.appointment.count({
          where: { createdAt: { gte: sevenDaysAgo } },
        }),
        prisma.invoice.count({
          where: { createdAt: { gte: thirtyDaysAgo } },
        }),
        prisma.campaign.count({
          where: { status: { in: ["SCHEDULED", "RUNNING"] } },
        }),
        prisma.user.groupBy({
          by: ["tenantId"],
          _count: { _all: true },
        }),
        prisma.patient.groupBy({
          by: ["tenantId"],
          _count: { _all: true },
        }),
        prisma.appointment.groupBy({
          by: ["tenantId"],
          where: { createdAt: { gte: sevenDaysAgo } },
          _count: { _all: true },
        }),
        prisma.invoice.groupBy({
          by: ["tenantId"],
          where: { createdAt: { gte: thirtyDaysAgo } },
          _count: { _all: true },
        }),
      ]);

      const toMap = (
        rows: Array<{ tenantId: string | null; _count: { _all: number } }>,
      ): Map<string, number> => {
        const m = new Map<string, number>();
        for (const r of rows) {
          if (r.tenantId == null) continue;
          m.set(r.tenantId, r._count._all);
        }
        return m;
      };

      const userMap = toMap(
        userByTenant as Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      );
      const patientMap = toMap(
        patientByTenant as Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      );
      const apptMap = toMap(
        apptByTenant as Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      );
      const invoiceMap = toMap(
        invoiceByTenant as Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      );

      const perTenant: PerTenantRow[] = tenants.map((t) => ({
        tenantId: t.id,
        tenantName: t.name,
        plan: t.plan as unknown as string,
        active: t.active,
        userCount: userMap.get(t.id) ?? 0,
        patientCount: patientMap.get(t.id) ?? 0,
        appointmentsLast7d: apptMap.get(t.id) ?? 0,
        invoicesLast30d: invoiceMap.get(t.id) ?? 0,
        createdAt: t.createdAt.toISOString(),
      }));

      // Cap perTenant at top-20-by-userCount so the payload stays
      // bounded as the tenant fleet grows. Tie-break by createdAt desc
      // so newer tenants surface first at equal headcount.
      perTenant.sort((a, b) => {
        if (b.userCount !== a.userCount) return b.userCount - a.userCount;
        return a.createdAt < b.createdAt ? 1 : -1;
      });
      const trimmedPerTenant = perTenant.slice(0, PER_TENANT_CAP);

      const totals: MetricsTotals = {
        tenants: tenantsCount,
        activeTenants: activeTenantsCount,
        users: usersCount,
        patients: patientsCount,
        appointmentsLast7d: appointmentsLast7dCount,
        invoicesLast30d: invoicesLast30dCount,
        campaignsActive: campaignsActiveCount,
      };

      await auditLog(
        req,
        "SUPER_ADMIN_METRICS_VIEWED",
        "system",
        undefined,
        {
          totals,
          perTenantCount: trimmedPerTenant.length,
        },
      );

      res.status(200).json({
        success: true,
        data: {
          totals,
          perTenant: trimmedPerTenant,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export const superAdminMetricsRouter = router;
