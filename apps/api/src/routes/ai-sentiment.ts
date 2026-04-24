import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import {
  analyzeFeedback,
  summarizeNpsDrivers,
} from "../services/ai/sentiment-ai";

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

export const aiSentimentRouter = Router();

aiSentimentRouter.use(authenticate);
// Issue #28: the reception dashboard also renders the NPS-drivers widget on
// /dashboard/feedback. Previously this router required ADMIN and the widget
// fetch failed with 403 (surfacing in logs as a broken endpoint for the
// reception role). Mirror the authorize list already used by
// GET /api/v1/feedback/summary which accepts ADMIN + RECEPTION.
aiSentimentRouter.use(authorize(Role.ADMIN, Role.RECEPTION));

// ─── POST /analyze/:feedbackId ────────────────────────────────────────────
// Re-analysis writes to the FeedbackSentiment table and should remain
// admin-only even after the router-level authorize was widened for Issue #28.

aiSentimentRouter.post(
  "/analyze/:feedbackId",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await analyzeFeedback(req.params.feedbackId);
      if (!result) {
        res.status(404).json({ success: false, data: null, error: "Feedback not found" });
        return;
      }
      safeAudit(req, "AI_SENTIMENT_ANALYZE", "PatientFeedback", req.params.feedbackId, {
        sentiment: result.sentiment,
      });
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /nps-drivers?days=30 ─────────────────────────────────────────────

aiSentimentRouter.get(
  "/nps-drivers",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(String(req.query.days ?? "30"), 10) || 30));

      // Prefer the cached daily rollup if present and fresh (same calendar day).
      const rollupDelegate = (prisma as unknown as { npsDailyRollup?: any }).npsDailyRollup;
      if (rollupDelegate?.findFirst) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const cached = await rollupDelegate.findUnique({ where: { date: today } }).catch(() => null);
        if (cached && cached.windowDays === days) {
          res.json({ success: true, data: cached, error: null, meta: { cached: true } });
          return;
        }
      }

      // Otherwise compute on-demand (also persists the rollup).
      const summary = await summarizeNpsDrivers({ windowDays: days });
      safeAudit(req, "AI_SENTIMENT_NPS_DRIVERS", "NpsDailyRollup", undefined, {
        windowDays: days,
        totalFeedback: summary.totalFeedback,
      });
      res.json({ success: true, data: summary, error: null, meta: { cached: false } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /feedback/:feedbackId — read stored sentiment ────────────────────

aiSentimentRouter.get(
  "/feedback/:feedbackId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const delegate = (prisma as unknown as { feedbackSentiment?: any }).feedbackSentiment;
      if (!delegate?.findUnique) {
        res.status(503).json({
          success: false,
          data: null,
          error:
            "FeedbackSentiment model is not yet migrated. See apps/api/src/services/.prisma-models-ops-quality.md",
        });
        return;
      }
      const row = await delegate.findUnique({
        where: { feedbackId: req.params.feedbackId },
      });
      if (!row) {
        res.status(404).json({ success: false, data: null, error: "Sentiment not found" });
        return;
      }
      res.json({ success: true, data: row, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Scheduler entry ──────────────────────────────────────────────────────

export async function runDailyNpsDriverRollup(): Promise<void> {
  try {
    const s = await summarizeNpsDrivers({ windowDays: 30 });
    console.log(
      `[ai-sentiment] daily NPS rollup: ${s.totalFeedback} feedback, ${s.positiveThemes.length}+ ${s.negativeThemes.length}-`
    );
  } catch (err) {
    console.error("[ai-sentiment] daily rollup failed", err);
  }
}
