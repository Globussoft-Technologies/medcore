/**
 * Pearl ERP Stage 1 §8.4 (2026-05-28) — maintenance-window CRUD.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: operator CRUD for `MaintenanceWindow` rows. The public
 *   `/api/v1/status` endpoint merges upcoming + active windows into
 *   its response so visitors see scheduled maintenance instead of
 *   generic "operational" while the platform is being intentionally
 *   taken down.
 * - MODULES: writes `MaintenanceWindow` rows (schema piece §8.4).
 *   No relation to Tenant — windows are platform-wide.
 * - WHY: §8.4 calls for a "public-facing system status page with
 *   uptime + maintenance windows". The status route already exists;
 *   this surface lets operators populate the windows table.
 *
 * RBAC
 * ────
 * Mutating endpoints (POST / PATCH / DELETE) are strict-super-admin.
 * The public listing endpoint is on `/status`, not here, so we don't
 * expose a second un-auth list.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
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
      error: "Only super-admins can manage maintenance windows",
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

// Untyped accessor — see super-admin-health.ts comment for the
// same Prisma-client-regen rationale.
const maintenanceWindow = (prisma as unknown as {
  maintenanceWindow: {
    findMany: (args: unknown) => Promise<unknown[]>;
    findUnique: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<{ id: string }>;
    update: (args: unknown) => Promise<{ id: string }>;
    delete: (args: unknown) => Promise<unknown>;
  };
}).maintenanceWindow;

const createSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(2000).optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    affectsComponents: z
      .array(z.string().trim().min(1).max(40))
      .max(20)
      .default([]),
    status: z
      .enum(["scheduled", "in_progress", "completed", "cancelled"])
      .default("scheduled"),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

const updateSchema = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  affectsComponents: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .optional(),
  status: z
    .enum(["scheduled", "in_progress", "completed", "cancelled"])
    .optional(),
});

router.get(
  "/",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await maintenanceWindow.findMany({
        orderBy: { startsAt: "desc" },
        take: 200,
      });
      res.status(200).json({
        success: true,
        data: { windows: rows },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/",
  validate(createSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof createSchema>;
      const created = await maintenanceWindow.create({
        data: {
          title: body.title,
          description: body.description ?? null,
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
          affectsComponents: body.affectsComponents,
          status: body.status,
          createdByUserId: req.user?.userId ?? null,
        },
      });
      await auditLog(
        req,
        "MAINTENANCE_WINDOW_CREATED",
        "maintenance_window",
        created.id,
        {
          title: body.title,
          startsAt: body.startsAt,
          endsAt: body.endsAt,
          status: body.status,
        },
      );
      res.status(201).json({
        success: true,
        data: { id: created.id },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  "/:id",
  validate(updateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof updateSchema>;
      const data: Record<string, unknown> = {};
      if (body.title !== undefined) data.title = body.title;
      if (body.description !== undefined) data.description = body.description;
      if (body.startsAt !== undefined) data.startsAt = new Date(body.startsAt);
      if (body.endsAt !== undefined) data.endsAt = new Date(body.endsAt);
      if (body.affectsComponents !== undefined)
        data.affectsComponents = body.affectsComponents;
      if (body.status !== undefined) data.status = body.status;

      if (Object.keys(data).length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Nothing to update",
        });
        return;
      }

      const updated = await maintenanceWindow.update({
        where: { id: req.params.id },
        data,
      });
      await auditLog(
        req,
        "MAINTENANCE_WINDOW_UPDATED",
        "maintenance_window",
        updated.id,
        data,
      );
      res.status(200).json({
        success: true,
        data: { id: updated.id },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await maintenanceWindow.delete({ where: { id: req.params.id } });
      await auditLog(
        req,
        "MAINTENANCE_WINDOW_DELETED",
        "maintenance_window",
        req.params.id,
        {},
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

export const maintenanceWindowsRouter = router;
