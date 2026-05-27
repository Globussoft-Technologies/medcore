/**
 * Pearl ERP Stage 1 §8.2 — super-admin audit trail.
 *
 * Cross-tenant audit log filtered to actions performed BY super-admins
 * (ADMIN role with tenantId = null). Each row carries:
 *   - actor (user id + email + name, joined from `User`)
 *   - timestamp (`createdAt`)
 *   - action (e.g. TENANT_SUSPENDED, TENANT_FEATURE_FLAGS_UPDATED)
 *   - entity + entityId
 *   - ipAddress
 *   - device (parsed from the `User-Agent` if persisted in `details`)
 *
 * Backed by the existing `AuditLog` table — no new column added.
 * Filters: action substring, actor id, date range (from / to), tenantId
 * (for actions scoped to one tenant's resources).
 *
 * RBAC: router-level `authenticate` + `authorize(Role.ADMIN)` +
 * `requireSuperAdmin` — same guard chain as the rest of /super-admin/*.
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
    // Pearl §8.2 — Role.SUPER_ADMIN is a wildcard "root" role: full
    // access on every super-admin surface regardless of tenant binding.
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
      error: "Only super-admins may view the cross-tenant audit trail",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

router.use(authenticate);
router.use(authorize(Role.ADMIN, Role.SUPER_ADMIN));
router.use(requireSuperAdmin);
router.use(enforceSuperAdminIdleTimeout);

const listQuerySchema = z.object({
  action: z.string().trim().max(200).optional(),
  actorId: z.string().trim().max(60).optional(),
  tenantId: z.string().trim().max(60).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.min(Math.max(parseInt(v, 10) || 100, 1), 500) : 100)),
});

// GET /api/v1/super-admin/audit — list audit rows filtered to
// super-admin actors. Joins the actor's name/email so the UI can render
// the trail without N+1 lookups.
router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid query",
        });
        return;
      }
      const { action, actorId, tenantId, from, to, limit } = parsed.data;

      // Step 1: build the set of super-admin user IDs (ADMIN +
      // tenantId=null). Filter by `actorId` if provided.
      const superAdmins = await prisma.user.findMany({
        where: {
          role: Role.ADMIN,
          tenantId: null,
          ...(actorId ? { id: actorId } : {}),
        },
        select: { id: true, name: true, email: true },
      });
      const superAdminIds = superAdmins.map((u) => u.id);
      if (superAdminIds.length === 0) {
        res.status(200).json({
          success: true,
          data: { entries: [] },
          error: null,
        });
        return;
      }

      // Step 2: AuditLog where userId ∈ {super-admins}.
      const where: Record<string, unknown> = {
        userId: { in: superAdminIds },
      };
      if (action) {
        where.action = { contains: action, mode: "insensitive" };
      }
      if (tenantId) {
        where.tenantId = tenantId;
      }
      const createdAtClause: Record<string, Date> = {};
      if (from) {
        const f = new Date(from);
        if (!isNaN(f.getTime())) createdAtClause.gte = f;
      }
      if (to) {
        const t = new Date(to);
        if (!isNaN(t.getTime())) createdAtClause.lte = t;
      }
      if (Object.keys(createdAtClause).length > 0) {
        where.createdAt = createdAtClause;
      }

      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          userId: true,
          action: true,
          entity: true,
          entityId: true,
          details: true,
          ipAddress: true,
          tenantId: true,
          createdAt: true,
        },
      });

      const actorById = new Map(superAdmins.map((u) => [u.id, u]));
      const entries = rows.map((r) => {
        const actor = r.userId ? actorById.get(r.userId) ?? null : null;
        // Device user-agent is stashed in audit `details.userAgent`
        // by some routes (login, sensitive mutations). Surface it when
        // present so the timeline can show device context.
        let device: string | null = null;
        if (r.details && typeof r.details === "object") {
          const d = r.details as Record<string, unknown>;
          if (typeof d.userAgent === "string") device = d.userAgent;
          else if (typeof d.device === "string") device = d.device;
        }
        return {
          id: r.id,
          action: r.action,
          entity: r.entity,
          entityId: r.entityId,
          tenantId: r.tenantId,
          ipAddress: r.ipAddress,
          device,
          details: r.details,
          createdAt: r.createdAt.toISOString(),
          actor: actor
            ? {
                id: actor.id,
                name: actor.name,
                email: actor.email,
              }
            : null,
        };
      });

      res.status(200).json({
        success: true,
        data: { entries },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export const superAdminAuditRouter = router;
