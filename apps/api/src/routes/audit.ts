import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();
router.use(authenticate);
router.use(authorize(Role.ADMIN));

// GET /api/v1/audit — paginated audit logs with filters
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      userId,
      entity,
      from,
      to,
      page = "1",
      limit = "50",
    } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};

    if (userId) where.userId = userId;
    if (entity) where.entity = entity;

    // Date range — default to last 7 days
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    where.createdAt = {
      gte: from ? new Date(from as string) : defaultFrom,
      ...(to ? { lte: new Date(to as string) } : {}),
    };

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: logs,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

export { router as auditRouter };
