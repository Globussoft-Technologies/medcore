import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { detectBillingAnomalies } from "../services/ai/fraud-detection";

function safeAudit(
  req: Request,
  action: string,
  entity: string,
  entityId: string | undefined,
  details?: Record<string, unknown>
): void {
  auditLog(req, action, entity, entityId, details).catch((err) => {
    console.warn(`[audit] ${action} failed (non-fatal):`, (err as Error)?.message ?? err);
  });
}

export const aiFraudRouter = Router();

aiFraudRouter.use(authenticate);
// Note: previously this router was ADMIN-only at the router level. Sprint 2
// added a billing-investigator workflow (status transitions + comment thread)
// for RECEPTION users, so role gating is now applied per-endpoint. Existing
// scan / acknowledge endpoints remain ADMIN-only — only the new status &
// comment endpoints accept RECEPTION as well.
const adminOnly = authorize(Role.ADMIN);
const investigators = authorize(Role.ADMIN, Role.RECEPTION);

/**
 * Returns the FraudAlert delegate when the model has been migrated. Until
 * then the routes return 503 so callers can register the router eagerly.
 */
function fraudAlertDelegate(): { ok: true; delegate: any } | { ok: false } {
  const delegate = (prisma as unknown as { fraudAlert?: any }).fraudAlert;
  if (!delegate?.findMany) return { ok: false };
  return { ok: true, delegate };
}

function modelUnavailable(res: Response): void {
  res.status(503).json({
    success: false,
    data: null,
    error:
      "FraudAlert model is not yet migrated. See apps/api/src/services/.prisma-models-ops-quality.md",
  });
}

// ─── POST /scan ───────────────────────────────────────────────────────────

aiFraudRouter.post(
  "/scan",
  adminOnly,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const windowDays = Math.max(
        1,
        Math.min(365, parseInt(String(req.body?.windowDays ?? 30), 10) || 30)
      );
      const llmReview = Boolean(req.body?.llmReview);

      const result = await detectBillingAnomalies({ windowDays, llmReview, persist: true });

      safeAudit(req, "AI_FRAUD_SCAN", "FraudAlert", undefined, {
        windowDays,
        llmReview,
        hits: result.hits.length,
        persisted: result.persisted,
      });

      res.json({
        success: true,
        data: {
          alertCount: result.persisted,
          hitCount: result.hits.length,
          windowDays: result.windowDays,
          scannedAt: result.scannedAt,
          llmReview,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /alerts ──────────────────────────────────────────────────────────

aiFraudRouter.get(
  "/alerts",
  investigators,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = fraudAlertDelegate();
      if (!d.ok) {
        modelUnavailable(res);
        return;
      }

      const { severity, status, type, from, to } = req.query as Record<string, string | undefined>;
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
      const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? "50"), 10) || 50));

      const where: Record<string, unknown> = {};
      if (severity) where.severity = severity;
      if (status) where.status = status;
      if (type) where.type = type;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from);
        if (to) range.lte = new Date(to);
        where.detectedAt = range;
      }

      const [items, total] = await Promise.all([
        d.delegate.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { detectedAt: "desc" },
        }),
        d.delegate.count({ where }),
      ]);

      res.json({
        success: true,
        data: items,
        error: null,
        meta: { page, limit, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /alerts/:id ──────────────────────────────────────────────────────

aiFraudRouter.get(
  "/alerts/:id",
  investigators,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = fraudAlertDelegate();
      if (!d.ok) {
        modelUnavailable(res);
        return;
      }
      const alert = await d.delegate.findUnique({ where: { id: req.params.id } });
      if (!alert) {
        res.status(404).json({ success: false, data: null, error: "Alert not found" });
        return;
      }
      res.json({ success: true, data: alert, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /alerts/:id/acknowledge ─────────────────────────────────────────

aiFraudRouter.post(
  "/alerts/:id/acknowledge",
  adminOnly,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = fraudAlertDelegate();
      if (!d.ok) {
        modelUnavailable(res);
        return;
      }
      const newStatus = String(req.body?.status ?? "ACKNOWLEDGED");
      if (!["ACKNOWLEDGED", "DISMISSED", "ESCALATED"].includes(newStatus)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "status must be one of ACKNOWLEDGED, DISMISSED, ESCALATED",
        });
        return;
      }
      const existing = await d.delegate.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Alert not found" });
        return;
      }
      const userId = (req as Request & { user?: { userId?: string } }).user?.userId;
      const updated = await d.delegate.update({
        where: { id: req.params.id },
        data: {
          status: newStatus,
          acknowledgedBy: userId ?? "SYSTEM",
          acknowledgedAt: new Date(),
          resolutionNote: req.body?.resolutionNote ?? undefined,
        },
      });
      safeAudit(req, "AI_FRAUD_ALERT_UPDATE", "FraudAlert", req.params.id, {
        newStatus,
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /alerts/:id/status (Sprint 2 resolution workflow) ─────────────
//
// Accepts the new status vocabulary (NEW | INVESTIGATING | RESOLVED |
// DISMISSED) used by the billing-investigator UI. Persists the new value
// directly into the existing `status` column (since the FraudAlert model
// stores it as a free-form enum-ish string and the new values coexist with
// the legacy OPEN/ACKNOWLEDGED/ESCALATED set on a per-alert basis).
//
// RESOLVED and DISMISSED transitions require a 1-line `reason` (max 200
// chars) which is stored in `resolutionNote`. Every transition writes an
// audit-log entry capturing previous + new status.
//
const NEW_STATUSES = ["NEW", "INVESTIGATING", "RESOLVED", "DISMISSED"] as const;
type NewStatus = (typeof NEW_STATUSES)[number];

function sanitizeReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Strip control chars + collapse whitespace; cap at 200.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 200);
}

aiFraudRouter.patch(
  "/alerts/:id/status",
  investigators,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = fraudAlertDelegate();
      if (!d.ok) {
        modelUnavailable(res);
        return;
      }
      const newStatus = String(req.body?.status ?? "") as NewStatus;
      if (!NEW_STATUSES.includes(newStatus)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `status must be one of ${NEW_STATUSES.join(", ")}`,
        });
        return;
      }
      const reason = sanitizeReason(req.body?.reason);
      if ((newStatus === "RESOLVED" || newStatus === "DISMISSED") && !reason) {
        res.status(400).json({
          success: false,
          data: null,
          error: "reason is required when transitioning to RESOLVED or DISMISSED",
        });
        return;
      }

      const existing = await d.delegate.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Alert not found" });
        return;
      }

      // Reopening a terminal status (RESOLVED / DISMISSED) is ADMIN-only.
      const prev = String(existing.status ?? "");
      const isTerminal = prev === "RESOLVED" || prev === "DISMISSED";
      const userRole = (req as Request & { user?: { role?: string } }).user?.role;
      if (isTerminal && newStatus !== prev && userRole !== "ADMIN") {
        res.status(403).json({
          success: false,
          data: null,
          error: "Only ADMIN can reopen a resolved or dismissed alert",
        });
        return;
      }

      const userId = (req as Request & { user?: { userId?: string } }).user?.userId;
      const updated = await d.delegate.update({
        where: { id: req.params.id },
        data: {
          status: newStatus,
          acknowledgedBy: userId ?? existing.acknowledgedBy ?? "SYSTEM",
          acknowledgedAt: new Date(),
          resolutionNote: reason ?? existing.resolutionNote ?? null,
        },
      });

      safeAudit(req, "AI_FRAUD_ALERT_STATUS", "FraudAlert", req.params.id, {
        previousStatus: prev || null,
        newStatus,
        reason,
      });

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET / POST /alerts/:id/comments (Sprint 2 comment thread) ───────────
//
// Comments are stored under `evidence.comments` on the FraudAlert row to
// avoid a schema migration. Each comment has { id, authorId, authorName,
// body, createdAt }. POST sanitizes body (strip control chars, max 2000).
//
interface FraudComment {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

function readComments(alert: { evidence?: unknown }): FraudComment[] {
  const ev = (alert?.evidence ?? {}) as Record<string, unknown>;
  const list = ev.comments;
  return Array.isArray(list) ? (list as FraudComment[]) : [];
}

function sanitizeCommentBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Strip control chars but preserve \n / \t in comment bodies.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 2000);
}

aiFraudRouter.get(
  "/alerts/:id/comments",
  investigators,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = fraudAlertDelegate();
      if (!d.ok) {
        modelUnavailable(res);
        return;
      }
      const alert = await d.delegate.findUnique({ where: { id: req.params.id } });
      if (!alert) {
        res.status(404).json({ success: false, data: null, error: "Alert not found" });
        return;
      }
      res.json({ success: true, data: readComments(alert), error: null });
    } catch (err) {
      next(err);
    }
  }
);

aiFraudRouter.post(
  "/alerts/:id/comments",
  investigators,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = fraudAlertDelegate();
      if (!d.ok) {
        modelUnavailable(res);
        return;
      }
      const body = sanitizeCommentBody(req.body?.body);
      if (!body) {
        res.status(400).json({
          success: false,
          data: null,
          error: "body is required (1-2000 chars)",
        });
        return;
      }
      const alert = await d.delegate.findUnique({ where: { id: req.params.id } });
      if (!alert) {
        res.status(404).json({ success: false, data: null, error: "Alert not found" });
        return;
      }
      const userMeta = (req as Request & {
        user?: { userId?: string; name?: string; role?: string };
      }).user;
      const comment: FraudComment = {
        id:
          typeof globalThis.crypto?.randomUUID === "function"
            ? globalThis.crypto.randomUUID()
            : `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        authorId: userMeta?.userId ?? "SYSTEM",
        authorName: userMeta?.name ?? userMeta?.role ?? "User",
        body,
        createdAt: new Date().toISOString(),
      };
      const existingComments = readComments(alert);
      const nextEvidence = {
        ...((alert.evidence as Record<string, unknown>) ?? {}),
        comments: [...existingComments, comment],
      };
      await d.delegate.update({
        where: { id: req.params.id },
        data: { evidence: nextEvidence },
      });

      safeAudit(req, "AI_FRAUD_ALERT_COMMENT", "FraudAlert", req.params.id, {
        commentId: comment.id,
      });

      res.json({ success: true, data: comment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Scheduler-invoked entry (exported so scheduled-tasks can call it) ────

export async function runDailyFraudScan(): Promise<void> {
  try {
    const result = await detectBillingAnomalies({ windowDays: 1, llmReview: false, persist: true });
    console.log(
      `[ai-fraud] daily scan: ${result.persisted} alerts persisted from ${result.hits.length} hits`
    );
  } catch (err) {
    console.error("[ai-fraud] daily scan failed", err);
  }
}
