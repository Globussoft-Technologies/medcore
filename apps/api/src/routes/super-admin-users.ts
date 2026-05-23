/**
 * Cross-tenant super-admin user roster — Pearl ERP Stage 1 §8.2
 * (gap row 208 closure, 2026-05-23).
 *
 * What / which modules / why:
 *   - Operator-facing list of users in the "super-admin" set: rows where
 *     `tenantId == null AND role == ADMIN`. This is the load-bearing
 *     pattern enforced by `routes/tenants.ts:requireSuperAdmin`, NOT a
 *     new permission model — no `SuperAdmin` Prisma table is introduced.
 *   - Mounts at /api/v1/super-admin/users. Endpoints:
 *       GET   /                  — list with `active` + `q` (name/email
 *                                 free-text) filters.
 *       PATCH /:id               — toggle `isActive` on a super-admin
 *                                 user. Refuses to deactivate the LAST
 *                                 ACTIVE super-admin (count guard) so an
 *                                 operator can't lock the org out of the
 *                                 Pearl console.
 *   - RBAC: router-level `authenticate` + `authorize(Role.ADMIN)` +
 *     `requireSuperAdmin` (mirrors `tenants.ts` exactly: tenant-less
 *     ADMIN OR ADMIN on the seeded "default" tenant). PATIENT/DOCTOR/etc
 *     bounce at `authorize`; tenant-bound ADMINs bounce at
 *     `requireSuperAdmin` with 403.
 *   - Audit: awaited `auditLog()` (NOT `safeAudit`) so integration tests
 *     can read AuditLog immediately. Action SUPER_ADMIN_USER_UPDATED on
 *     PATCH success.
 *   - Scope-cut from prompt: `lastSignInAt` is NOT exposed because the
 *     User model does not currently track it. Adding the column was
 *     forbidden by the prompt's "no schema files" allowlist; the page
 *     just omits the column. `createdAt` is shown as the closest proxy.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();

// ─── Guards ──────────────────────────────────────────────────────────

/**
 * Mirrors `routes/tenants.ts:requireSuperAdmin`. We re-declare it locally
 * rather than importing because that helper is module-private and the
 * intent is to keep these endpoints independently movable (Pearl wants
 * /super-admin/ on its own host eventually — CLAUDE.md §5.5).
 */
async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
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
      error: "Only super-admins can manage the super-admin roster",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

// ─── Schemas ─────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  // Default to ALL so the operator sees deactivated rows too (otherwise
  // the "last-active" guard error is mysterious — "but I see one active
  // super-admin in the list" is what the operator needs to verify).
  active: z
    .enum(["true", "false", "all"])
    .optional()
    .transform((v) => (v == null ? "all" : v)),
  q: z.string().trim().max(200).optional(),
});

const patchUserSchema = z.object({
  active: z.boolean(),
});

// ─── Routes ──────────────────────────────────────────────────────────

router.use(authenticate);
router.use(authorize(Role.ADMIN));
router.use(requireSuperAdmin);

// GET /api/v1/super-admin/users — list the super-admin set.
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
      const { active, q } = parsed.data;
      const where: Record<string, unknown> = {
        tenantId: null,
        role: Role.ADMIN,
      };
      if (active === "true") where.isActive = true;
      else if (active === "false") where.isActive = false;
      if (q && q.length > 0) {
        where.OR = [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ];
      }
      const rows = await prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
        take: 500,
      });
      res.status(200).json({
        success: true,
        data: { users: rows },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/v1/super-admin/users/:id — toggle isActive on a super-admin.
// Refuses to deactivate the last active super-admin (count guard) so the
// operator population cannot drop to zero.
router.patch(
  "/:id",
  validate(patchUserSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const target = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          tenantId: true,
        },
      });
      if (!target) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Super-admin user not found",
        });
        return;
      }
      // Defence-in-depth: the route guard already enforces super-admin
      // shape, but PATCH /:id MUST refuse to mutate a non-super-admin
      // user (otherwise the endpoint is a tenant-user mass-mutation
      // surface masquerading as a super-admin tool).
      if (target.tenantId !== null || target.role !== Role.ADMIN) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Super-admin user not found",
        });
        return;
      }

      const body = req.body as z.infer<typeof patchUserSchema>;
      const nextActive = body.active;

      // No-op short-circuit — return current state without audit churn.
      if (nextActive === target.isActive) {
        res.status(200).json({
          success: true,
          data: {
            id: target.id,
            name: target.name,
            email: target.email,
            role: target.role,
            isActive: target.isActive,
          },
          error: null,
        });
        return;
      }

      // Count-guard: deactivating must leave at least one active super-admin.
      if (nextActive === false) {
        const otherActive = await prisma.user.count({
          where: {
            tenantId: null,
            role: Role.ADMIN,
            isActive: true,
            id: { not: target.id },
          },
        });
        if (otherActive === 0) {
          res.status(409).json({
            success: false,
            data: null,
            error:
              "Cannot deactivate the last active super-admin — promote another user first",
          });
          return;
        }
      }

      const updated = await prisma.user.update({
        where: { id: target.id },
        data: { isActive: nextActive },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      });

      await auditLog(
        req,
        "SUPER_ADMIN_USER_UPDATED",
        "user",
        updated.id,
        {
          previousIsActive: target.isActive,
          newIsActive: updated.isActive,
        },
      );

      res.status(200).json({
        success: true,
        data: updated,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export const superAdminUsersRouter = router;
