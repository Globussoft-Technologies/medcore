/**
 * Background-job queue admin API — Pearl ERP Stage 1 §8.4 (gap row 222
 * closure, 2026-05-22).
 *
 * Surfaces the in-process cron scheduler in
 * `apps/api/src/services/scheduled-tasks.ts` so super-admins on
 * `/super-admin/jobs` can:
 *   - GET  /api/v1/scheduled-jobs           — list runs (filters)
 *   - GET  /api/v1/scheduled-jobs/:id       — fetch a single run + error
 *   - POST /api/v1/scheduled-jobs/:id/retry — re-invoke a FAILED task
 *
 * Auth model mirrors `routes/tenants.ts`: ALL endpoints require
 * `Role.ADMIN` AND the caller must be a super-admin (either globally
 * tenant-less OR an admin on the seeded "default" tenant). Tenant-scoped
 * admins cannot see other tenants' job runs.
 *
 * AuditLog actions emitted:
 *   - SCHEDULED_JOB_RETRIED (POST /:id/retry)
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { getRegisteredTask } from "../services/scheduled-tasks";

const router = Router();

// ─── Guards ──────────────────────────────────────────────────────────

/**
 * Super-admin gate. Mirrors `routes/tenants.ts:requireSuperAdmin`:
 * tenant-less ADMINs and ADMINs on the seeded "default" tenant are
 * allowed; non-default-tenant ADMINs are rejected so a hospital operator
 * cannot view another tenant's scheduler.
 */
async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction
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
      error: "Only super-admins can view the background-job queue",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

router.use(authenticate);
router.use(authorize(Role.ADMIN));
router.use(requireSuperAdmin);

// ─── Schemas ─────────────────────────────────────────────────────────

const statusEnum = z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED"]);

const listQuerySchema = z.object({
  status: statusEnum.optional(),
  taskName: z.string().trim().min(1).max(120).optional(),
  from: z
    .string()
    .datetime()
    .optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  to: z
    .string()
    .datetime()
    .optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────

// GET /api/v1/scheduled-jobs — list runs (super-admin only).
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
      const { status, taskName, from, to, limit, cursor } = parsed.data;
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (taskName) where.taskName = taskName;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from);
        if (to) range.lte = new Date(to);
        where.startedAt = range;
      }
      const take = limit ?? 50;
      const rows = await prisma.scheduledTaskRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: take + 1,
        ...(cursor
          ? { skip: 1, cursor: { id: cursor } }
          : {}),
      });
      const hasMore = rows.length > take;
      const slice = hasMore ? rows.slice(0, take) : rows;
      res.status(200).json({
        success: true,
        data: {
          runs: slice,
          nextCursor: hasMore ? slice[slice.length - 1]?.id ?? null : null,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/scheduled-jobs/:id — full row including the error message.
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await prisma.scheduledTaskRun.findUnique({
        where: { id: req.params.id },
      });
      if (!row) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Scheduled-job run not found",
        });
        return;
      }
      res.status(200).json({ success: true, data: row, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/scheduled-jobs/:id/retry — re-invoke a FAILED task.
// 409 if the row isn't FAILED (PENDING/RUNNING/SUCCESS rows have no retry
// semantics). 404 if the original task name is no longer registered (the
// scheduler was edited between the failure and the retry attempt).
const retrySchema = z.object({});
router.post(
  "/:id/retry",
  validate(retrySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await prisma.scheduledTaskRun.findUnique({
        where: { id: req.params.id },
      });
      if (!row) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Scheduled-job run not found",
        });
        return;
      }
      if (row.status !== "FAILED") {
        res.status(409).json({
          success: false,
          data: null,
          error: "Only failed jobs can be retried",
        });
        return;
      }
      const task = getRegisteredTask(row.taskName);
      if (!task) {
        res.status(404).json({
          success: false,
          data: null,
          error: `Task '${row.taskName}' is no longer registered in the scheduler`,
        });
        return;
      }

      // Kick off the retry. We intentionally do NOT await the task body
      // (some tasks take minutes — the operator gets the new run id back
      // immediately and can poll the row for status). We DO await the row
      // creation so we can return the new run id.
      //
      // The RUNNING row is created inside runTaskWithAudit; to return the
      // id immediately we create a placeholder here, mark it RUNNING, and
      // pass `retryOfRunId` so the wrap links back to the original. The
      // wrap updates this row to SUCCESS/FAILED on completion.
      const startedAt = new Date();
      const newRun = await prisma.scheduledTaskRun.create({
        data: {
          taskName: task.name,
          status: "RUNNING",
          startedAt,
          retryOfRunId: row.id,
        },
        select: { id: true, taskName: true, status: true, startedAt: true },
      });

      // Fire-and-forget the task body. On completion update the row we
      // already created (so the id we returned to the client is the one
      // that ends up SUCCESS/FAILED).
      (async () => {
        try {
          await task.run();
          const completedAt = new Date();
          await prisma.scheduledTaskRun.update({
            where: { id: newRun.id },
            data: {
              status: "SUCCESS",
              completedAt,
              durationMs: completedAt.getTime() - startedAt.getTime(),
            },
          });
        } catch (err) {
          const completedAt = new Date();
          const msg =
            err instanceof Error ? (err.stack ?? err.message) : String(err);
          try {
            await prisma.scheduledTaskRun.update({
              where: { id: newRun.id },
              data: {
                status: "FAILED",
                completedAt,
                durationMs: completedAt.getTime() - startedAt.getTime(),
                error: msg.slice(0, 5000),
              },
            });
          } catch (innerErr) {
            console.error(
              `[scheduled-jobs] failed to record retry FAILED for ${task.name}`,
              innerErr
            );
          }
          console.error(`[scheduled-jobs] retry ${task.name} failed`, err);
        }
      })().catch((err) =>
        console.error(`[scheduled-jobs] retry wrap failed for ${task.name}`, err)
      );

      // Awaited audit write so the test (and the operator's view) sees
      // the row immediately. Mirrors the tenants router pattern.
      await auditLog(
        req,
        "SCHEDULED_JOB_RETRIED",
        "scheduled_task_run",
        newRun.id,
        {
          originalRunId: row.id,
          taskName: row.taskName,
          originalFailedAt: row.completedAt,
        }
      );

      res.status(200).json({
        success: true,
        data: { newRun, retryOfRunId: row.id },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export const scheduledJobsRouter = router;
