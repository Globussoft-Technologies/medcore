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

// ── Entity-label resolver ──────────────────────────────
//
// Issue #192 (Apr 30 2026): the Audit Log table renders the raw `entityId`
// UUID in the right-most column, which is unreadable for an admin doing
// incident review or compliance triage. We resolve the UUID to a
// human-readable label per entity type *server-side* (single batched
// round-trip per entity bucket) and surface it as `entityLabel` on each
// row. The UI keeps the UUID accessible on hover / in the details drawer.
//
// We deliberately don't crash if a referenced row has been deleted — the
// label simply falls back to `null`, and the FE renders "(deleted)" or the
// bare UUID as a last resort. Casing on the entity column is inconsistent
// across writers (see `buildAuditWhere`'s comment about Issue #79) so we
// normalise to lower-case for the dispatch table.

type EntityResolver = (
  ids: string[]
) => Promise<Record<string, string>>;

const ENTITY_RESOLVERS: Record<string, EntityResolver> = {
  user: async (ids) => {
    const rows = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
    return Object.fromEntries(
      rows.map((r) => [r.id, `User: ${r.name || r.email || r.id}`])
    );
  },
  patient: async (ids) => {
    const rows = await prisma.patient.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        mrNumber: true,
        user: { select: { name: true } },
      },
    });
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        `Patient: ${r.user?.name || r.mrNumber || r.id} (MR: ${r.mrNumber})`,
      ])
    );
  },
  appointment: async (ids) => {
    const rows = await prisma.appointment.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        date: true,
        patient: { select: { user: { select: { name: true } } } },
      },
    });
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        `Appointment: ${r.patient?.user?.name || "Patient"} on ${
          r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date
        }`,
      ])
    );
  },
  invoice: async (ids) => {
    const rows = await prisma.invoice.findMany({
      where: { id: { in: ids } },
      select: { id: true, invoiceNumber: true, totalAmount: true },
    });
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        `Invoice: ${r.invoiceNumber} (${r.totalAmount})`,
      ])
    );
  },
  prescription: async (ids) => {
    const rows = await prisma.prescription.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        diagnosis: true,
        patient: { select: { user: { select: { name: true } } } },
      },
    });
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        `Prescription: ${r.patient?.user?.name || "Patient"} — ${r.diagnosis}`,
      ])
    );
  },
  admission: async (ids) => {
    const rows = await prisma.admission.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        admissionNumber: true,
        patient: { select: { user: { select: { name: true } } } },
      },
    });
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        `Admission: ${r.admissionNumber} — ${r.patient?.user?.name || "Patient"}`,
      ])
    );
  },
  holiday: async (ids) => {
    try {
      const rows = await (prisma as any).holiday.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, date: true },
      });
      return Object.fromEntries(
        rows.map((r: { id: string; name: string; date: Date | string }) => [
          r.id,
          `Holiday: ${r.name} (${
            r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date
          })`,
        ])
      );
    } catch {
      return {};
    }
  },
};

/**
 * Resolve `entityId → entityLabel` for a batch of audit rows. Groups by
 * normalised entity name so each entity table is hit at most once.
 */
async function resolveEntityLabels(
  rows: Array<{ entity: string | null; entityId: string | null }>
): Promise<Map<string, string>> {
  const buckets = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.entity || !r.entityId) continue;
    const key = String(r.entity).toLowerCase().replace(/_/g, "");
    const set = buckets.get(key) ?? new Set<string>();
    set.add(r.entityId);
    buckets.set(key, set);
  }

  const out = new Map<string, string>();
  await Promise.all(
    Array.from(buckets.entries()).map(async ([entityKey, idSet]) => {
      const resolver = ENTITY_RESOLVERS[entityKey];
      if (!resolver) return;
      try {
        const map = await resolver(Array.from(idSet));
        for (const [id, label] of Object.entries(map)) {
          // Disambiguate by entity+id to avoid collisions across tables
          out.set(`${entityKey}:${id}`, label);
        }
      } catch {
        // Resolver failure: leave labels blank for this bucket.
      }
    })
  );
  return out;
}

/** Look up the resolved label for a single (entity, entityId) pair. */
function labelFor(
  entity: string | null,
  entityId: string | null,
  labels: Map<string, string>
): string | null {
  if (!entity || !entityId) return null;
  const key = String(entity).toLowerCase().replace(/_/g, "");
  return labels.get(`${key}:${entityId}`) ?? null;
}

function buildAuditWhere(req: Request): Record<string, unknown> {
  const { userId, entity, action, ipContains, from, to, q } = req.query;
  const where: Record<string, unknown> = {};

  if (userId) where.userId = userId;
  // Issue #79: entity casing is inconsistent across writers — patient creates
  // log "patient" lowercase, HL7 writes "Patient" titlecase, etc. The
  // dropdown used to send the title-cased value verbatim and got 0 hits
  // against the lowercase rows. We now match case-insensitively so the
  // dropdown's canonical value finds historical data regardless of writer.
  if (entity) {
    where.entity = {
      equals: String(entity),
      mode: "insensitive",
    } as unknown;
  }
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

    // Issue #192: resolve entityId UUIDs to human-readable labels per row.
    const labels = await resolveEntityLabels(logs);

    const data = logs.map((l) => ({
      id: l.id,
      timestamp: l.createdAt.toISOString(),
      userId: l.userId,
      userName: l.userId ? userMap.get(l.userId)?.name ?? "Unknown" : "—",
      userEmail: l.userId ? userMap.get(l.userId)?.email ?? "" : "",
      action: l.action,
      entity: l.entity,
      entityId: l.entityId,
      entityLabel: labelFor(l.entity, l.entityId, labels),
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

        // Issue #192: enrich with entityLabel so the search-result table
        // matches the default list rendering.
        const labels = await resolveEntityLabels(slice);

        const data = slice.map((l) => ({
          id: l.id,
          timestamp: l.createdAt.toISOString(),
          userId: l.userId,
          userName: l.userId ? userMap.get(l.userId)?.name ?? "Unknown" : "—",
          userEmail: l.userId ? userMap.get(l.userId)?.email ?? "" : "",
          action: l.action,
          entity: l.entity,
          entityId: l.entityId,
          entityLabel: labelFor(l.entity, l.entityId, labels),
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

      // No term — same as default list. Issue #79: previously returned raw
      // `logs` without joining the User table, which is what made the User
      // column blank for clients that hit the /search endpoint with empty
      // query (e.g. accidentally clearing the search after typing).
      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where: where as any,
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        prisma.auditLog.count({ where: where as any }),
      ]);

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

      // Issue #192: enrich the no-term branch too.
      const labels = await resolveEntityLabels(logs);

      const data = logs.map((l) => ({
        id: l.id,
        timestamp: l.createdAt.toISOString(),
        userId: l.userId,
        userName: l.userId ? userMap.get(l.userId)?.name ?? "Unknown" : "—",
        userEmail: l.userId ? userMap.get(l.userId)?.email ?? "" : "",
        action: l.action,
        entity: l.entity,
        entityId: l.entityId,
        entityLabel: labelFor(l.entity, l.entityId, labels),
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

      // Issue #192: include the resolved entity label in the CSV export
      // so a downloaded compliance report is just as skim-readable as the
      // table view.
      const labels = await resolveEntityLabels(logs);

      const rows = logs.map((l) => ({
        timestamp: l.createdAt.toISOString(),
        userId: l.userId ?? "",
        userName: l.userId ? userMap.get(l.userId)?.name ?? "" : "",
        userEmail: l.userId ? userMap.get(l.userId)?.email ?? "" : "",
        action: l.action,
        entity: l.entity,
        entityId: l.entityId ?? "",
        entityLabel: labelFor(l.entity, l.entityId, labels) ?? "",
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
        "entityLabel",
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
