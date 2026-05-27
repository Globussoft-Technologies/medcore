import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
// Issue #456: audit-log reads must be tenant-scoped so a tenant's ADMIN
// only ever sees their own forensic trail. The wrapper auto-injects
// `where: { tenantId }` from the AsyncLocalStorage context populated by
// `withTenantContext`. Resolver lookups (User / Patient / etc.) keep
// using the un-scoped `prisma` because their delegates are themselves
// already in TENANT_SCOPED_MODELS, so the same scoping is applied
// transparently when a tenant context is bound, and skipped in the cron /
// bootstrap path so this file behaves identically out-of-context.
import { tenantScopedPrisma } from "../services/tenant-prisma";

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

/** Look up the resolved label for a single (entity, entityId) pair.
 *
 * Issue #318 (May 2026): when the referenced entity has been deleted (or
 * we have no resolver for the entity type) we fall back to a 12-char
 * abbreviation prefixed with the entity name so the audit table still
 * surfaces something a human can scan, rather than the raw 36-char
 * UUID. The full UUID stays available on the row's `entityId` field
 * for forensic deep-dives. Format: `Patient: a1b2c3d4-e5f6` (entity
 * name + 12 leading chars of the UUID's hex). */
function labelFor(
  entity: string | null,
  entityId: string | null,
  labels: Map<string, string>
): string | null {
  if (!entity || !entityId) return null;
  const key = String(entity).toLowerCase().replace(/_/g, "");
  const resolved = labels.get(`${key}:${entityId}`);
  if (resolved) return resolved;
  // Best-effort fallback: title-case entity + first 12 chars of UUID.
  const titled =
    String(entity).charAt(0).toUpperCase() +
    String(entity).slice(1).toLowerCase();
  // Abbreviation is the first 12 hex chars (8-4 grouping of a UUID).
  const abbrev =
    entityId.length > 13
      ? `${entityId.slice(0, 8)}-${entityId.slice(9, 13)}`
      : entityId;
  return `${titled}: ${abbrev}`;
}

/**
 * Issue #690 (May 2026): the Audit Log filter UI accepted From > To and the
 * server quietly applied the inverted range, returning zero rows with no
 * indication anything was wrong. Validate the pair up-front and surface a
 * 400 so the form can render an inline error rather than swallowing the
 * inversion. Returns null when the range is valid, or the parsed `from`/`to`
 * Date pair so the caller doesn't reparse.
 */
class InvertedDateRangeError extends Error {
  constructor() {
    super("from must be on or before to");
  }
}

/**
 * Issue #336 (May 2026): the audit log was rendering duplicate rows for
 * the same (action, entity, entityId, userId) tuple within a few seconds
 * of each other — most commonly when a route called both an awaited
 * `auditLog(...)` and a fire-and-forget `safeAudit(...)` for the same
 * event, or when a retry loop wrote the same row N times before the
 * upstream call settled. The write-side fix (CLAUDE.md gotcha #1) covers
 * new traffic, but historical rows are immutable and would keep
 * cluttering compliance reviews. We dedupe at QUERY time: rows in the
 * same 5-second bucket with the same (action, entity, entityId, userId)
 * collapse to the earliest by createdAt. Returns the kept rows in the
 * caller's existing sort order.
 */
const DEDUP_WINDOW_MS = 5_000;

function dedupAuditRows<
  T extends {
    id: string;
    action: string;
    entity: string | null;
    entityId: string | null;
    userId: string | null;
    createdAt: Date;
  }
>(rows: T[]): T[] {
  // Group by (action, entity, entityId, userId), then within each group
  // keep the earliest row in any 5-second window. Anything outside that
  // window starts a new bucket so genuinely-recurring activity (e.g. a
  // user paging through patients 30s apart) is preserved.
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${r.action}|${r.entity ?? ""}|${r.entityId ?? ""}|${r.userId ?? ""}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const keep = new Set<string>();
  for (const arr of groups.values()) {
    if (arr.length <= 1) {
      keep.add(arr[0].id);
      continue;
    }
    // Sort ascending by createdAt; walk and start a new window each time
    // the gap exceeds DEDUP_WINDOW_MS.
    const asc = [...arr].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );
    let windowStart = asc[0];
    keep.add(windowStart.id);
    for (let i = 1; i < asc.length; i++) {
      const gap = asc[i].createdAt.getTime() - windowStart.createdAt.getTime();
      if (gap > DEDUP_WINDOW_MS) {
        windowStart = asc[i];
        keep.add(windowStart.id);
      }
      // else: within the same 5-second window, drop.
    }
  }
  // Preserve caller's order while filtering to the kept set.
  return rows.filter((r) => keep.has(r.id));
}

function buildAuditWhere(req: Request): Record<string, unknown> {
  const { userId, entity, action, actionIn, ipContains, from, to, q } =
    req.query;
  const where: Record<string, unknown> = {};

  // Issue #690: inverted-range guard. If both `from` and `to` are present
  // and parse to valid dates, fromDate must be on or before toDate.
  if (from && to) {
    const fromDate = new Date(from as string);
    const toDate = new Date(to as string);
    if (
      !isNaN(fromDate.getTime()) &&
      !isNaN(toDate.getTime()) &&
      fromDate.getTime() > toDate.getTime()
    ) {
      throw new InvertedDateRangeError();
    }
  }

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
  // Issue #47 (.issue-details.txt 2026-05-09): support `actionIn=A,B,C` for
  // multi-action filters. The Admin Console's "Errors (1h)" widget used to
  // hard-code `action=LOGIN_FAILED`, which under-counted the other
  // error-shaped audit actions that actually exist in the codebase
  // (`PRESCRIPTION_REJECTED`, `PRESCRIPTION_SHARE_FAILED`,
  // `NOTIFICATION_AUDIENCE_REJECTED`). With this param, the widget can
  // pass the full canonical list and the row-aggregation query stays a
  // single round-trip. `action=` (singular) still wins if both are sent —
  // gives existing callers (the audit page filter dropdown, the regression
  // test #8) deterministic precedence.
  if (action) {
    where.action = action;
  } else if (actionIn) {
    const list = String(actionIn)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && /^[A-Z0-9_]{1,64}$/.test(s));
    if (list.length > 0) {
      where.action = { in: list } as unknown;
    }
  }
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

    let where: Record<string, unknown>;
    try {
      where = buildAuditWhere(req);
    } catch (err) {
      if (err instanceof InvertedDateRangeError) {
        res.status(400).json({
          success: false,
          data: null,
          error: err.message,
          details: [{ field: "to", message: err.message }],
        });
        return;
      }
      throw err;
    }

    const [logs, total] = await Promise.all([
      tenantScopedPrisma.auditLog.findMany({
        where: where as any,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      tenantScopedPrisma.auditLog.count({ where: where as any }),
    ]);

    // Issue #336: collapse near-duplicate rows (same action+entity+
    // entityId+userId within 5s) to the earliest. Done in-memory on
    // the page slice so paging math stays consistent — the alternative
    // (DISTINCT ON in SQL) would also need a window function and
    // cross-DB compatibility (sqlite for tests).
    const dedupedLogs = dedupAuditRows(logs);

    // Enrich with user info
    const userIds = Array.from(
      new Set(dedupedLogs.map((l) => l.userId).filter((v): v is string => !!v))
    );
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    // Pearl §8.2 — resolve tenantId → tenant name/subdomain so the
    // super-admin viewer can see "which tenant the action targeted"
    // alongside actor/timestamp. Single batched query; falls back to
    // null when AuditLog.tenantId is null (system / bootstrap rows).
    const tenantIds = Array.from(
      new Set(
        dedupedLogs
          .map((l) => l.tenantId)
          .filter((v): v is string => !!v),
      ),
    );
    const tenants = tenantIds.length
      ? await prisma.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, name: true, subdomain: true },
        })
      : [];
    const tenantMap = new Map(tenants.map((t) => [t.id, t]));

    // Issue #192: resolve entityId UUIDs to human-readable labels per row.
    const labels = await resolveEntityLabels(dedupedLogs);

    const data = dedupedLogs.map((l) => {
      const tenant = l.tenantId ? tenantMap.get(l.tenantId) ?? null : null;
      return {
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
        tenantId: l.tenantId,
        tenantName: tenant?.name ?? null,
        tenantSubdomain: tenant?.subdomain ?? null,
        details: l.details,
      };
    });

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

      let where: Record<string, unknown>;
      try {
        where = buildAuditWhere(req);
      } catch (err) {
        if (err instanceof InvertedDateRangeError) {
          res.status(400).json({
            success: false,
            data: null,
            error: err.message,
            details: [{ field: "to", message: err.message }],
          });
          return;
        }
        throw err;
      }

      // If full-text query present, also scan details JSON by fetching a wider
      // candidate set and filtering in-memory.
      const term =
        typeof q === "string" && q.trim().length > 0 ? q.trim() : null;

      if (term) {
        const candidates = await tenantScopedPrisma.auditLog.findMany({
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

        // Issue #336: dedup near-duplicate rows before paging the
        // full-text result set so the count meta also reflects the
        // collapsed view.
        const deduped = dedupAuditRows(filtered);
        const total = deduped.length;
        const slice = deduped.slice(skip, skip + take);

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
        tenantScopedPrisma.auditLog.findMany({
          where: where as any,
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        tenantScopedPrisma.auditLog.count({ where: where as any }),
      ]);

      // Issue #336: dedup near-duplicate rows (same action+entity+
      // entityId+userId within 5s) to keep parity with GET /audit.
      const dedupedLogs = dedupAuditRows(logs);

      const userIds = Array.from(
        new Set(dedupedLogs.map((l) => l.userId).filter((v): v is string => !!v))
      );
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
      const userMap = new Map(users.map((u) => [u.id, u]));

      // Issue #192: enrich the no-term branch too.
      const labels = await resolveEntityLabels(dedupedLogs);

      const data = dedupedLogs.map((l) => ({
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
      let where: Record<string, unknown>;
      try {
        where = buildAuditWhere(req);
      } catch (err) {
        if (err instanceof InvertedDateRangeError) {
          res.status(400).json({
            success: false,
            data: null,
            error: err.message,
            details: [{ field: "to", message: err.message }],
          });
          return;
        }
        throw err;
      }
      const maxRows = 50_000;

      const logs = await tenantScopedPrisma.auditLog.findMany({
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
      const logs = await tenantScopedPrisma.auditLog.findMany({
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
        tenantScopedPrisma.auditLog.findMany({
          select: { action: true },
          distinct: ["action"],
          take: 500,
        }),
        tenantScopedPrisma.auditLog.findMany({
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
