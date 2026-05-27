/**
 * Per-tenant compliance posture dashboard — Pearl ERP Stage 1 §8.6
 * (gap row 225 closure, 2026-05-23).
 *
 * What / which modules / why:
 *   - Super-admin needs a single view that surfaces compliance posture
 *     across all tenants: ABHA-link adoption, DPDP erasure tickets
 *     processed, audit-log activity, ADMIN TOTP coverage, and mandatory-
 *     TOTP enforcement state. Each row in the response represents one
 *     tenant; the UI badges red/amber violations so the operator can
 *     dispatch follow-up (e.g. nudge a tenant whose ADMINs haven't
 *     enrolled TOTP despite `requireAdminTOTP=true`).
 *   - Mounts at /api/v1/super-admin/compliance. Endpoint:
 *       GET /  — { tenants: [...], snapshotAt }.
 *   - RBAC: router-level `authenticate` + `authorize(Role.ADMIN)` +
 *     `requireSuperAdmin` (mirrors `super-admin-metrics.ts` exactly).
 *   - Audit: awaited `auditLog()` (NOT `safeAudit`) so the integration
 *     test can read the row immediately. Action
 *     SUPER_ADMIN_COMPLIANCE_VIEWED.
 *   - Read-only — no writes, no schema changes. If `DPDPErasureRequest`
 *     or other tracked-elsewhere models grow new fields, this route
 *     simply ignores them.
 *   - Scope-cuts from prompt:
 *       * NHCX claims metric omitted — no per-tenant `claim` table is
 *         currently tenant-scoped in a way this route can query without
 *         crossing the apps→packages arrow (would require a schema
 *         tweak; out of scope per allowlist).
 *       * Encryption-at-rest flags omitted — that's an ops-level
 *         posture (filesystem + RDS), not a per-tenant field.
 *       * `lastDpdpAt` derived from `executedAt` (NOT `requestedAt`)
 *         so the timestamp reflects WHEN the purge ran — that's what
 *         a compliance auditor cares about.
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
 * Mirrors `super-admin-metrics.ts:requireSuperAdmin` — re-declared
 * locally so this route stays independently movable.
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
      error: "Only super-admins can view per-tenant compliance posture",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface CompliancePostureRow {
  tenantId: string;
  tenantName: string;
  active: boolean;
  patientCount: number;
  abhaLinkedCount: number;
  abhaLinkedPct: number;
  dpdpRequestsLast30d: number;
  auditRowsLast30d: number;
  adminCount: number;
  totpEnrolledAdminCount: number;
  requireAdminTOTP: boolean;
  lastDpdpAt: string | null;
  lastAuditAt: string | null;
}

// ─── Routes ──────────────────────────────────────────────────────────

router.use(authenticate);
router.use(authorize(Role.ADMIN, Role.SUPER_ADMIN));
router.use(requireSuperAdmin);
router.use(enforceSuperAdminIdleTimeout);

// GET /api/v1/super-admin/compliance — per-tenant compliance posture.
router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = Date.now();
      const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

      const [
        tenants,
        patientByTenant,
        abhaLinkedByTenant,
        dpdpByTenant,
        auditByTenant,
        adminByTenant,
        totpAdminByTenant,
        lastDpdpByTenant,
        lastAuditByTenant,
      ] = await Promise.all([
        prisma.tenant.findMany({
          select: {
            id: true,
            name: true,
            active: true,
            requireAdminTOTP: true,
          },
        }),
        prisma.patient.groupBy({
          by: ["tenantId"],
          _count: { _all: true },
        }),
        prisma.patient.groupBy({
          by: ["tenantId"],
          where: { abhaId: { not: null } },
          _count: { _all: true },
        }),
        prisma.dPDPErasureRequest.groupBy({
          by: ["tenantId"],
          where: { requestedAt: { gte: thirtyDaysAgo } },
          _count: { _all: true },
        }),
        prisma.auditLog.groupBy({
          by: ["tenantId"],
          where: { createdAt: { gte: thirtyDaysAgo } },
          _count: { _all: true },
        }),
        prisma.user.groupBy({
          by: ["tenantId"],
          where: { role: "ADMIN" },
          _count: { _all: true },
        }),
        prisma.user.groupBy({
          by: ["tenantId"],
          where: { role: "ADMIN", twoFactorEnabled: true },
          _count: { _all: true },
        }),
        prisma.dPDPErasureRequest.groupBy({
          by: ["tenantId"],
          where: { executedAt: { not: null } },
          _max: { executedAt: true },
        }),
        prisma.auditLog.groupBy({
          by: ["tenantId"],
          _max: { createdAt: true },
        }),
      ]);

      const toCountMap = (
        rows: Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      ): Map<string, number> => {
        const m = new Map<string, number>();
        for (const r of rows) {
          if (r.tenantId == null) continue;
          m.set(r.tenantId, r._count._all);
        }
        return m;
      };

      const patientMap = toCountMap(
        patientByTenant as Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      );
      const abhaMap = toCountMap(
        abhaLinkedByTenant as Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      );
      const dpdpMap = toCountMap(
        dpdpByTenant as Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      );
      const auditMap = toCountMap(
        auditByTenant as Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      );
      const adminMap = toCountMap(
        adminByTenant as Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      );
      const totpAdminMap = toCountMap(
        totpAdminByTenant as Array<{
          tenantId: string | null;
          _count: { _all: number };
        }>,
      );

      const lastDpdpMap = new Map<string, Date>();
      for (const r of lastDpdpByTenant as Array<{
        tenantId: string | null;
        _max: { executedAt: Date | null };
      }>) {
        if (r.tenantId == null || r._max.executedAt == null) continue;
        lastDpdpMap.set(r.tenantId, r._max.executedAt);
      }

      const lastAuditMap = new Map<string, Date>();
      for (const r of lastAuditByTenant as Array<{
        tenantId: string | null;
        _max: { createdAt: Date | null };
      }>) {
        if (r.tenantId == null || r._max.createdAt == null) continue;
        lastAuditMap.set(r.tenantId, r._max.createdAt);
      }

      const tenantsOut: CompliancePostureRow[] = tenants.map((t) => {
        const patientCount = patientMap.get(t.id) ?? 0;
        const abhaLinkedCount = abhaMap.get(t.id) ?? 0;
        const abhaLinkedPct =
          patientCount > 0 ? abhaLinkedCount / patientCount : 0;
        return {
          tenantId: t.id,
          tenantName: t.name,
          active: t.active,
          patientCount,
          abhaLinkedCount,
          abhaLinkedPct,
          dpdpRequestsLast30d: dpdpMap.get(t.id) ?? 0,
          auditRowsLast30d: auditMap.get(t.id) ?? 0,
          adminCount: adminMap.get(t.id) ?? 0,
          totpEnrolledAdminCount: totpAdminMap.get(t.id) ?? 0,
          requireAdminTOTP: t.requireAdminTOTP,
          lastDpdpAt: lastDpdpMap.get(t.id)?.toISOString() ?? null,
          lastAuditAt: lastAuditMap.get(t.id)?.toISOString() ?? null,
        };
      });

      // Sort: tenants with mandatory-TOTP violations float to the top,
      // then by patientCount desc so the biggest tenants are above-fold.
      tenantsOut.sort((a, b) => {
        const aViolating =
          a.requireAdminTOTP &&
          a.totpEnrolledAdminCount < a.adminCount;
        const bViolating =
          b.requireAdminTOTP &&
          b.totpEnrolledAdminCount < b.adminCount;
        if (aViolating !== bViolating) return aViolating ? -1 : 1;
        return b.patientCount - a.patientCount;
      });

      const snapshotAt = new Date().toISOString();

      await auditLog(
        req,
        "SUPER_ADMIN_COMPLIANCE_VIEWED",
        "system",
        undefined,
        {
          tenantCount: tenantsOut.length,
        },
      );

      res.status(200).json({
        success: true,
        data: {
          tenants: tenantsOut,
          snapshotAt,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export const superAdminComplianceRouter = router;
