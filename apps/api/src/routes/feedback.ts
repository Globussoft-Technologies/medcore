import { Router, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
// The public POST /feedback endpoint at the top of this file runs before
// `feedbackRouter.use(authenticate)`; for those unauthenticated requests no
// tenant is in AsyncLocalStorage, so the extension behaves as a pass-through.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createFeedbackSchema,
  createComplaintSchema,
  updateComplaintSchema,
  escalateComplaintSchema,
  feedbackRequestSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { analyzeSentiment, computeSlaDueAt } from "../services/ops-helpers";
import { triggerFeedbackAnalysis } from "../services/ai/sentiment-ai";

const feedbackRouter = Router();

// POST /api/v1/feedback — public endpoint for patient feedback forms (SMS/WhatsApp link).
// If authenticated as PATIENT, restrict to own patient record.
feedbackRouter.post(
  "/",
  validate(createFeedbackSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, category, rating, nps, comment } = req.body;

      // Verify patient exists (prevents spam with random UUIDs)
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
      });
      if (!patient) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // If authenticated as PATIENT, must match
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        try {
          const payload = jwt.verify(
            authHeader.split(" ")[1],
            process.env.JWT_SECRET || "dev-secret"
          ) as { userId: string; role: string };
          if (payload.role === "PATIENT" && patient.userId !== payload.userId) {
            res.status(403).json({
              success: false,
              data: null,
              error: "Patients can only submit feedback for themselves",
            });
            return;
          }
        } catch {
          // Invalid token — treat as anonymous public submission
        }
      }

      const sent = analyzeSentiment(comment);
      const fb = await prisma.patientFeedback.create({
        data: {
          patientId,
          category,
          rating,
          nps,
          comment,
          sentiment: sent?.label as any,
          sentimentScore: sent?.score,
        },
      });

      // Fire-and-forget AI sentiment analysis (non-blocking).
      triggerFeedbackAnalysis(fb.id);

      res.status(201).json({ success: true, data: fb, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Authenticated routes below
feedbackRouter.use(authenticate);

// GET /api/v1/feedback — list
feedbackRouter.get(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        category,
        from,
        to,
        page = "1",
        limit = "20",
      } = req.query;
      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = Math.min(parseInt(limit as string), 100);

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (category) where.category = category;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from as string);
        if (to) range.lte = new Date(to as string);
        where.submittedAt = range;
      }

      const [items, total] = await Promise.all([
        prisma.patientFeedback.findMany({
          where,
          include: {
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
          },
          skip,
          take,
          orderBy: { submittedAt: "desc" },
        }),
        prisma.patientFeedback.count({ where }),
      ]);

      res.json({
        success: true,
        data: items,
        error: null,
        meta: { page: parseInt(page as string), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/feedback/summary
feedbackRouter.get(
  "/summary",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = req.query;
      const where: Record<string, unknown> = {};
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from as string);
        if (to) range.lte = new Date(to as string);
        where.submittedAt = range;
      }

      const all = await prisma.patientFeedback.findMany({
        where,
        select: {
          category: true,
          rating: true,
          nps: true,
          submittedAt: true,
        },
      });

      // avgRating per category
      const cats: Record<string, { sum: number; count: number }> = {};
      for (const f of all) {
        if (!cats[f.category]) cats[f.category] = { sum: 0, count: 0 };
        cats[f.category].sum += f.rating;
        cats[f.category].count++;
      }
      const avgRatingByCategory: Record<string, number> = {};
      for (const [c, v] of Object.entries(cats)) {
        avgRatingByCategory[c] = v.count > 0 ? +(v.sum / v.count).toFixed(2) : 0;
      }

      // NPS: need entries with nps set
      const withNps = all.filter((f) => f.nps !== null && f.nps !== undefined);
      let promoters = 0;
      let detractors = 0;
      for (const f of withNps) {
        if ((f.nps as number) >= 9) promoters++;
        else if ((f.nps as number) <= 6) detractors++;
      }
      const npsScore =
        withNps.length > 0
          ? Math.round(((promoters - detractors) / withNps.length) * 100)
          : 0;

      // Overall avg
      const overallAvg =
        all.length > 0
          ? +(all.reduce((a, f) => a + f.rating, 0) / all.length).toFixed(2)
          : 0;

      // Trend: last 12 months monthly avg
      const now = new Date();
      const trend: Array<{ month: string; avgRating: number; count: number }> = [];
      for (let i = 11; i >= 0; i--) {
        const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
        const monthItems = await prisma.patientFeedback.findMany({
          where: { submittedAt: { gte: start, lt: end } },
          select: { rating: true },
        });
        const count = monthItems.length;
        const avg =
          count > 0
            ? +(monthItems.reduce((a, m) => a + m.rating, 0) / count).toFixed(2)
            : 0;
        trend.push({
          month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
          avgRating: avg,
          count,
        });
      }

      res.json({
        success: true,
        data: {
          totalCount: all.length,
          overallAvg,
          avgRatingByCategory,
          npsScore,
          npsSampleSize: withNps.length,
          promoters,
          detractors,
          passives: withNps.length - promoters - detractors,
          trend,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { feedbackRouter };

// ═══════════════════════════════════════════════════════
// COMPLAINTS
// ═══════════════════════════════════════════════════════

const complaintsRouter = Router();
complaintsRouter.use(authenticate);

// Issue #275 (Apr 2026): the ticket prefix was inconsistent in the wild
// — old code emitted `CMP000024` (legacy) while the seed for the demo
// data emitted `COMP-2026-00014`. Reception saw a mix in the Open tab
// and couldn't tell which ones were "real". Standardise on the
// year-scoped form `CMP-YYYY-NNNNN` for any *new* ticket. The
// next-number probe still reads the trailing digit run, so it cleanly
// resumes whether the most recent ticket was legacy `CMPnnnnnn`,
// seed-style `COMP-YYYY-nnnnn`, or the new canonical form.
async function nextTicketNumber(): Promise<string> {
  const last = await prisma.complaint.findFirst({
    orderBy: { ticketNumber: "desc" },
    select: { ticketNumber: true },
  });
  let n = 1;
  if (last?.ticketNumber) {
    const m = last.ticketNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  const year = new Date().getFullYear();
  return `CMP-${year}-${String(n).padStart(5, "0")}`;
}

// POST /api/v1/complaints
complaintsRouter.post(
  "/",
  validate(createComplaintSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        name,
        phone,
        category,
        description,
        priority,
      } = req.body;

      const ticketNumber = await nextTicketNumber();

      const slaDueAt = computeSlaDueAt(priority || "MEDIUM");
      const complaint = await prisma.complaint.create({
        data: {
          ticketNumber,
          patientId,
          name,
          phone,
          category,
          description,
          priority: priority || "MEDIUM",
          status: "OPEN",
          slaDueAt,
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
      });

      auditLog(req, "COMPLAINT_CREATE", "complaint", complaint.id, {
        ticketNumber,
        priority,
      }).catch(console.error);

      res.status(201).json({ success: true, data: complaint, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/complaints
complaintsRouter.get(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        status,
        priority,
        assignedTo,
        page = "1",
        limit = "20",
      } = req.query;
      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = Math.min(parseInt(limit as string), 100);

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (priority) where.priority = priority;
      if (assignedTo) where.assignedTo = assignedTo;

      const [items, total] = await Promise.all([
        prisma.complaint.findMany({
          where,
          include: {
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
          },
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        prisma.complaint.count({ where }),
      ]);

      res.json({
        success: true,
        data: items,
        error: null,
        meta: { page: parseInt(page as string), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/complaints/stats
//
// Issue #92 (2026-04-26): "Critical Open" must be ⊆ "Total Open" so the
// dashboard cannot show 7 critical-open while total-open=5. We define a
// single base set OPEN = { complaints whose status ∈ (OPEN, UNDER_REVIEW,
// ESCALATED) }. Both `byStatus.OPEN_TOTAL` (the headline tile) and
// `criticalOpen` are derived from this same set, plus we expose the
// individual byStatus.OPEN bucket for any consumer that wants the raw
// status='OPEN' count. Critical-open uses the same OPEN set filtered by
// priority so it can never exceed it by construction.
complaintsRouter.get(
  "/stats",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const all = await prisma.complaint.findMany({
        select: {
          status: true,
          priority: true,
          createdAt: true,
          resolvedAt: true,
          assignedTo: true,
        },
      });

      const byStatus: Record<string, number> = {
        OPEN: 0,
        UNDER_REVIEW: 0,
        RESOLVED: 0,
        ESCALATED: 0,
        CLOSED: 0,
      };
      const byPriority: Record<string, number> = {
        LOW: 0,
        MEDIUM: 0,
        HIGH: 0,
        CRITICAL: 0,
      };

      let totalResolutionMs = 0;
      let resolvedCount = 0;
      let overdueCount = 0;
      let overdueUnassignedCount = 0;
      const now = Date.now();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const overdue200hMs = 200 * 60 * 60 * 1000;

      // Single base set used for both Total Open and Critical Open.
      const OPEN_STATUSES: ReadonlyArray<string> = [
        "OPEN",
        "UNDER_REVIEW",
        "ESCALATED",
      ];
      const openSet = all.filter((c) => OPEN_STATUSES.includes(c.status));

      for (const c of all) {
        byStatus[c.status] = (byStatus[c.status] || 0) + 1;
        byPriority[c.priority] = (byPriority[c.priority] || 0) + 1;

        if (c.resolvedAt) {
          totalResolutionMs +=
            new Date(c.resolvedAt).getTime() - new Date(c.createdAt).getTime();
          resolvedCount++;
        }
        if (
          c.status === "OPEN" &&
          now - new Date(c.createdAt).getTime() > sevenDaysMs
        ) {
          overdueCount++;
        }
        if (
          OPEN_STATUSES.includes(c.status) &&
          !c.assignedTo &&
          now - new Date(c.createdAt).getTime() > overdue200hMs
        ) {
          overdueUnassignedCount++;
        }
      }

      const avgResolutionHours =
        resolvedCount > 0
          ? +(totalResolutionMs / resolvedCount / (60 * 60 * 1000)).toFixed(1)
          : 0;

      // Total Open and Critical Open share the same base set so the
      // invariant Critical ⊆ Total is impossible to violate.
      const totalOpen = openSet.length;
      const criticalOpen = openSet.filter((c) => c.priority === "CRITICAL").length;

      res.json({
        success: true,
        data: {
          total: all.length,
          byStatus,
          byPriority,
          avgResolutionHours,
          overdueCount,
          // New tile: complaints overdue >200h AND unassigned (drives the
          // red banner on the dashboard). Frontend shows a banner whenever
          // this count > 0.
          overdueUnassignedCount,
          // totalOpen is the union of OPEN+UNDER_REVIEW+ESCALATED (the
          // "actionable" backlog). Use this for the Open tile.
          totalOpen,
          criticalOpen,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/complaints/:id
complaintsRouter.get(
  "/:id",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = await prisma.complaint.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true, email: true } } },
          },
        },
      });
      if (!c) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Complaint not found" });
        return;
      }
      res.json({ success: true, data: c, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/complaints/:id
complaintsRouter.patch(
  "/:id",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(updateComplaintSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (req.body.status === "RESOLVED") {
        data.resolvedAt = new Date();
      }

      const updated = await prisma.complaint.update({
        where: { id: req.params.id },
        data,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
      });

      auditLog(req, "COMPLAINT_UPDATE", "complaint", updated.id, req.body).catch(
        console.error
      );

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: ESCALATION, AUTO-ESCALATE, DASHBOARD
// ═══════════════════════════════════════════════════════

// POST /api/v1/complaints/:id/escalate — manual escalation
complaintsRouter.post(
  "/:id/escalate",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(escalateComplaintSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.complaint.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Complaint not found" });
        return;
      }
      if (existing.status === "RESOLVED" || existing.status === "CLOSED") {
        res.status(400).json({
          success: false,
          data: null,
          error: `Cannot escalate a ${existing.status} complaint`,
        });
        return;
      }
      const updated = await prisma.complaint.update({
        where: { id: existing.id },
        data: {
          status: "ESCALATED",
          escalatedAt: new Date(),
          escalationReason: req.body.reason,
        },
      });
      auditLog(req, "COMPLAINT_ESCALATE", "complaint", existing.id, {
        reason: req.body.reason,
      }).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/complaints/auto-escalate — cron-safe: escalate overdue OPEN/UNDER_REVIEW
complaintsRouter.post(
  "/auto-escalate",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const overdue = await prisma.complaint.findMany({
        where: {
          status: { in: ["OPEN", "UNDER_REVIEW"] },
          slaDueAt: { lt: now },
          escalatedAt: null,
        },
      });
      let escalated = 0;
      for (const c of overdue) {
        await prisma.complaint.update({
          where: { id: c.id },
          data: {
            status: "ESCALATED",
            escalatedAt: now,
            escalationReason: "Auto-escalated: SLA breach",
          },
        });
        escalated++;
      }
      res.json({ success: true, data: { escalated }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/complaints/dashboard — management dashboard
complaintsRouter.get(
  "/reports/dashboard",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const now = Date.now();
      const all = await prisma.complaint.findMany();
      const stats = {
        total: all.length,
        open: all.filter((c) => c.status === "OPEN").length,
        underReview: all.filter((c) => c.status === "UNDER_REVIEW").length,
        resolved: all.filter((c) => c.status === "RESOLVED").length,
        escalated: all.filter((c) => c.status === "ESCALATED").length,
        closed: all.filter((c) => c.status === "CLOSED").length,
        overdue: all.filter(
          (c) =>
            c.slaDueAt &&
            c.slaDueAt.getTime() < now &&
            c.status !== "RESOLVED" &&
            c.status !== "CLOSED"
        ).length,
      };
      const resolved = all.filter((c) => c.resolvedAt);
      const avgResponseHours =
        resolved.length > 0
          ? +(
              resolved.reduce(
                (s, c) => s + (c.resolvedAt!.getTime() - c.createdAt.getTime()),
                0
              ) /
              resolved.length /
              3600000
            ).toFixed(1)
          : 0;
      res.json({
        success: true,
        data: { stats, avgResponseHours },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/feedback/request — send a feedback-request notification
feedbackRouter.post(
  "/request",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(feedbackRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, channel } = req.body;
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        include: { user: true },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      await prisma.notification.create({
        data: {
          userId: patient.userId,
          type: "SCHEDULE_SUMMARY",
          channel: channel === "WHATSAPP" ? "WHATSAPP" : channel === "EMAIL" ? "EMAIL" : "SMS",
          title: "How was your visit?",
          message: `Hi ${patient.user.name}, thank you for visiting us. We'd love your feedback — it helps us serve you better.`,
          data: { patientId, feedbackRequested: true },
          deliveryStatus: "QUEUED",
        },
      });
      auditLog(req, "FEEDBACK_REQUEST", "patient", patientId, { channel }).catch(
        console.error
      );
      res.status(201).json({ success: true, data: { patientId, channel }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { complaintsRouter };
