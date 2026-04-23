import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();

// security(2026-04-23-low): audit-log responses contain PHI references and
// user identifiers; prevent caching by intermediate proxies/browsers and
// disable MIME-sniffing on JSON/CSV exports.
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

router.use(authenticate);
router.use(authorize(Role.ADMIN));

// ── Helpers ────────────────────────────────────────────

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(csvEscape).join(",");
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(","));
  return [header, ...lines].join("\r\n");
}

function buildAuditWhere(req: Request): Record<string, unknown> {
  const { userId, entity, action, ipContains, from, to, q } = req.query;
  const where: Record<string, unknown> = {};

  if (userId) where.userId = userId;
  if (entity) where.entity = entity;
  if (action) where.action = action;
  if (ipContains) {
    where.ipAddress = { contains: String(ipContains) } as unknown;
  }

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  where.createdAt = {
    gte: from ? new Date(from as string) : defaultFrom,
    ...(to ? { lte: new Date(to as string) } : {}),
  };

  if (q && typeof q === "string" && q.trim().length > 0) {
    const term = q.trim();
    where.OR = [
      { entity: { contains: term, mode: "insensitive" } },
      { action: { contains: term, mode: "insensitive" } },
      { entityId: { contains: term } },
    ];
  }

  return where;
}

// ── GET /audit — paginated logs with filters ──────────

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = "1", limit = "50" } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const take = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * take;

    const where = buildAuditWhere(req);

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: where as any,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.auditLog.count({ where: where as any }),
    ]);

    // Enrich with user info
    const userIds = Array.from(
      new Set(logs.map((l) => l.userId).filter((v): v is string => !!v))
    );
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const data = logs.map((l) => ({
      id: l.id,
      timestamp: l.createdAt.toISOString(),
      userId: l.userId,
      userName: l.userId ? userMap.get(l.userId)?.name ?? "Unknown" : "—",
      userEmail: l.userId ? userMap.get(l.userId)?.email ?? "" : "",
      action: l.action,
      entity: l.entity,
      entityId: l.entityId,
      ipAddress: l.ipAddress,
      details: l.details,
    }));

    res.json({
      success: true,
      data,
      error: null,
      meta: {
        page: pageNum,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /audit/search — fuzzy search ─────────────────

router.get(
  "/search",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page = "1", limit = "50", q } = req.query;
      const pageNum = Math.max(1, parseInt(page as string, 10));
      const take = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
      const skip = (pageNum - 1) * take;

      const where = buildAuditWhere(req);

      // If full-text query present, also scan details JSON by fetching a wider
      // candidate set and filtering in-memory.
      const term =
        typeof q === "string" && q.trim().length > 0 ? q.trim() : null;

      if (term) {
        const candidates = await prisma.auditLog.findMany({
          where: where as any,
          orderBy: { createdAt: "desc" },
          take: 1000,
        });

        const filtered = candidates.filter((c) => {
          const hay = [
            c.action,
            c.entity,
            c.entityId ?? "",
            c.ipAddress ?? "",
            JSON.stringify(c.details ?? {}),
          ]
            .join(" ")
            .toLowerCase();
          return hay.includes(term.toLowerCase());
        });

        const total = filtered.length;
        const slice = filtered.slice(skip, skip + take);

        const userIds = Array.from(
          new Set(slice.map((l) => l.userId).filter((v): v is string => !!v))
        );
        const users = userIds.length
          ? await prisma.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, name: true, email: true },
            })
          : [];
        const userMap = new Map(users.map((u) => [u.id, u]));

        const data = slice.map((l) => ({
          id: l.id,
          timestamp: l.createdAt.toISOString(),
          userId: l.userId,
          userName: l.userId ? userMap.get(l.userId)?.name ?? "Unknown" : "—",
          userEmail: l.userId ? userMap.get(l.userId)?.email ?? "" : "",
          action: l.action,
          entity: l.entity,
          entityId: l.entityId,
          ipAddress: l.ipAddress,
          details: l.details,
        }));

        res.json({
          success: true,
          data,
          error: null,
          meta: {
            page: pageNum,
            limit: take,
            total,
            totalPages: Math.ceil(total / take),
          },
        });
        return;
      }

      // No term — same as default list
      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where: where as any,
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        prisma.auditLog.count({ where: where as any }),
      ]);

      res.json({
        success: true,
        data: logs,
        error: null,
        meta: {
          page: pageNum,
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /audit/export.csv ────────────────────────────

router.get(
  "/export.csv",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const where = buildAuditWhere(req);
      const maxRows = 50_000;

      const logs = await prisma.auditLog.findMany({
        where: where as any,
        orderBy: { createdAt: "desc" },
        take: maxRows,
      });

      const userIds = Array.from(
        new Set(logs.map((l) => l.userId).filter((v): v is string => !!v))
      );
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
      const userMap = new Map(users.map((u) => [u.id, u]));

      const rows = logs.map((l) => ({
        timestamp: l.createdAt.toISOString(),
        userId: l.userId ?? "",
        userName: l.userId ? userMap.get(l.userId)?.name ?? "" : "",
        userEmail: l.userId ? userMap.get(l.userId)?.email ?? "" : "",
        action: l.action,
        entity: l.entity,
        entityId: l.entityId ?? "",
        ipAddress: l.ipAddress ?? "",
        details: l.details ? JSON.stringify(l.details) : "",
      }));

      const csv = toCsv(rows, [
        "timestamp",
        "userId",
        "userName",
        "userEmail",
        "action",
        "entity",
        "entityId",
        "ipAddress",
        "details",
      ]);

      const now = new Date().toISOString().split("T")[0];
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="audit-${now}.csv"`
      );
      res.send(csv);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /audit/retention-stats ──────────────────────

router.get(
  "/retention-stats",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const logs = await prisma.auditLog.findMany({
        select: { createdAt: true },
      });

      const byYear: Record<string, number> = {};
      logs.forEach((l) => {
        const y = new Date(l.createdAt).getFullYear().toString();
        byYear[y] = (byYear[y] || 0) + 1;
      });

      // Retention config
      const cfg = await prisma.systemConfig.findUnique({
        where: { key: "audit_retention_days" },
      });
      const retentionDays = cfg ? parseInt(cfg.value, 10) || 1095 : 1095;

      const oldest = logs.reduce<Date | null>((acc, l) => {
        if (!acc) return l.createdAt;
        return l.createdAt < acc ? l.createdAt : acc;
      }, null);

      res.json({
        success: true,
        data: {
          totalEntries: logs.length,
          byYear: Object.keys(byYear)
            .sort()
            .map((year) => ({ year, count: byYear[year] })),
          retentionDays,
          oldestEntry: oldest?.toISOString() ?? null,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /audit/filters — list distinct actions/users for dropdowns ──

router.get(
  "/filters",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [actionsRaw, users] = await Promise.all([
        prisma.auditLog.findMany({
          select: { action: true },
          distinct: ["action"],
          take: 500,
        }),
        prisma.auditLog.findMany({
          where: { userId: { not: null } },
          select: { userId: true },
          distinct: ["userId"],
          take: 500,
        }),
      ]);

      const actions = actionsRaw.map((a) => a.action).sort();
      const userIds = users.map((u) => u.userId!).filter(Boolean);
      const userList = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
            orderBy: { name: "asc" },
          })
        : [];

      res.json({
        success: true,
        data: { actions, users: userList },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as auditRouter };
