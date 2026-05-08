import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import {
  auditConsultation,
  runDailyDocQASample,
} from "../services/ai/doc-qa";

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

function docQaDelegate(): { ok: true; delegate: any } | { ok: false } {
  const delegate = (prisma as unknown as { docQAReport?: any }).docQAReport;
  if (!delegate?.findUnique) return { ok: false };
  return { ok: true, delegate };
}

function modelUnavailable(res: Response): void {
  res.status(503).json({
    success: false,
    data: null,
    error:
      "DocQAReport model is not yet migrated. See apps/api/src/services/.prisma-models-ops-quality.md",
  });
}

export const aiDocQaRouter = Router();

aiDocQaRouter.use(authenticate);
// #511 audit (file-level, 2026-05-09): every handler applies
// `authorize(Role.ADMIN)` (or ADMIN/DOCTOR for the report-fetch surface).
// PATIENT is excluded. Verified-safe.

// ─── POST /run-sample ─────────────────────────────────────────────────────

aiDocQaRouter.post(
  "/run-sample",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const samplePct = Math.max(
        1,
        Math.min(100, parseInt(String(req.body?.samplePct ?? 10), 10) || 10)
      );
      const windowDays = Math.max(
        1,
        Math.min(30, parseInt(String(req.body?.windowDays ?? 1), 10) || 1)
      );
      const result = await runDailyDocQASample({ samplePct, windowDays });
      safeAudit(req, "AI_DOC_QA_RUN_SAMPLE", "DocQAReport", undefined, result);
      res.json({
        success: true,
        data: { ...result, samplePct, windowDays, ranAt: new Date().toISOString() },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /audit/:consultationId ──────────────────────────────────────────

aiDocQaRouter.post(
  "/audit/:consultationId",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await auditConsultation(req.params.consultationId);
      if (!report) {
        res.status(404).json({ success: false, data: null, error: "Consultation not found" });
        return;
      }
      safeAudit(req, "AI_DOC_QA_AUDIT", "Consultation", req.params.consultationId, {
        score: report.score,
      });
      res.json({ success: true, data: report, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /reports ─────────────────────────────────────────────────────────

aiDocQaRouter.get(
  "/reports",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = docQaDelegate();
      if (!d.ok) {
        modelUnavailable(res);
        return;
      }
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
      const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const { minScore, maxScore, from, to } = req.query as Record<string, string | undefined>;

      const where: Record<string, unknown> = {};
      if (minScore || maxScore) {
        const rng: Record<string, number> = {};
        if (minScore) rng.gte = parseInt(minScore, 10);
        if (maxScore) rng.lte = parseInt(maxScore, 10);
        where.score = rng;
      }
      if (from || to) {
        const rng: Record<string, Date> = {};
        if (from) rng.gte = new Date(from);
        if (to) rng.lte = new Date(to);
        where.auditedAt = rng;
      }

      const [items, total] = await Promise.all([
        d.delegate.findMany({
          where,
          orderBy: { auditedAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
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

// ─── GET /reports/:consultationId ─────────────────────────────────────────
// ADMIN always allowed. DOCTOR allowed to see reports for their OWN
// consultations only.

aiDocQaRouter.get(
  "/reports/:consultationId",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = docQaDelegate();
      if (!d.ok) {
        modelUnavailable(res);
        return;
      }

      const requester = (req as Request & { user?: { userId?: string; role?: string } }).user;

      const report = await d.delegate.findUnique({
        where: { consultationId: req.params.consultationId },
      });
      if (!report) {
        res.status(404).json({ success: false, data: null, error: "Report not found" });
        return;
      }

      if (requester?.role === "DOCTOR") {
        // Doctor may see their own only — look up the doctor row by userId
        const doctor = await prisma.doctor.findFirst({
          where: { userId: requester.userId },
          select: { id: true },
        });
        const consultation = await prisma.consultation.findUnique({
          where: { id: req.params.consultationId },
          select: { doctorId: true },
        });
        if (!doctor || !consultation || consultation.doctorId !== doctor.id) {
          res.status(403).json({
            success: false,
            data: null,
            error: "Doctors can only view QA reports for their own consultations",
          });
          return;
        }
      }

      safeAudit(req, "AI_DOC_QA_READ", "DocQAReport", req.params.consultationId);
      res.json({ success: true, data: report, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Scheduler entry ──────────────────────────────────────────────────────

export async function runDailyDocQAScheduledTask(): Promise<void> {
  try {
    const result = await runDailyDocQASample({ samplePct: 10, windowDays: 1 });
    console.log(
      `[ai-doc-qa] daily run: ${result.audited}/${result.sampled} consultations audited`
    );
  } catch (err) {
    console.error("[ai-doc-qa] daily run failed", err);
  }
}
