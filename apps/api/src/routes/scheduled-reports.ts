import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  scheduledReportCreateSchema,
  scheduledReportUpdateSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { sendEmail } from "../services/notification";

const router = Router();
router.use(authenticate);
router.use(authorize(Role.ADMIN));
// #511 audit (2026-05-05, cron-tick): all handlers verified safe via
// router-level authorize(Role.ADMIN). PATIENT cannot reach any handler in
// this file. Scheduled reports are admin-config only; report DEFINITIONS
// (incl. those whose rendered output may include PHI) are never user-scoped.
// No per-row ownership check is required at the handler level.

// ── Helpers ────────────────────────────────────────────

function computeNextRun(
  frequency: string,
  timeOfDay: string,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null,
  from: Date = new Date()
): Date {
  const [hh, mm] = timeOfDay.split(":").map((n) => parseInt(n, 10));
  const next = new Date(from);
  next.setSeconds(0, 0);

  if (frequency === "DAILY") {
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= from.getTime()) {
      next.setDate(next.getDate() + 1);
    }
  } else if (frequency === "WEEKLY") {
    const target = typeof dayOfWeek === "number" ? dayOfWeek : 1;
    next.setHours(hh, mm, 0, 0);
    const delta = (target - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + delta);
    if (next.getTime() <= from.getTime()) {
      next.setDate(next.getDate() + 7);
    }
  } else {
    // MONTHLY
    const dom = typeof dayOfMonth === "number" ? dayOfMonth : 1;
    next.setDate(dom);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= from.getTime()) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(dom);
    }
  }
  return next;
}

async function generateReportSnapshot(
  reportType: string,
  _config: Record<string, unknown> | null | undefined
): Promise<Record<string, unknown>> {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (reportType === "DAILY_CENSUS") {
    const [admissions, discharges, occupied, totalBeds] = await Promise.all([
      prisma.admission.count({
        where: { admittedAt: { gte: today, lte: now } },
      }),
      prisma.admission.count({
        where: { dischargedAt: { gte: today, lte: now } },
      }),
      prisma.bed.count({ where: { status: "OCCUPIED" } }),
      prisma.bed.count(),
    ]);
    return {
      reportType,
      date: today.toISOString().split("T")[0],
      admissions,
      discharges,
      bedsOccupied: occupied,
      totalBeds,
      occupancyPct: totalBeds > 0 ? +((occupied / totalBeds) * 100).toFixed(1) : 0,
    };
  }

  if (reportType === "WEEKLY_REVENUE") {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 7);
    const payments = await prisma.payment.findMany({
      where: { paidAt: { gte: weekStart, lte: now } },
      select: { amount: true, mode: true },
    });
    const revenueByMode: Record<string, number> = {};
    let total = 0;
    payments.forEach((p) => {
      total += p.amount;
      revenueByMode[p.mode] = (revenueByMode[p.mode] || 0) + p.amount;
    });
    return {
      reportType,
      from: weekStart.toISOString().split("T")[0],
      to: now.toISOString().split("T")[0],
      totalRevenue: total,
      transactionCount: payments.length,
      revenueByMode,
    };
  }

  if (reportType === "MONTHLY_SUMMARY") {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const [patients, appointments, payments, admissions] = await Promise.all([
      prisma.patient.count({
        where: { user: { createdAt: { gte: monthStart, lte: now } } },
      }),
      prisma.appointment.count({
        where: { date: { gte: monthStart, lte: now } },
      }),
      prisma.payment.aggregate({
        where: { paidAt: { gte: monthStart, lte: now } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.admission.count({
        where: { admittedAt: { gte: monthStart, lte: now } },
      }),
    ]);
    return {
      reportType,
      month: monthStart.toISOString().split("T")[0].slice(0, 7),
      newPatients: patients,
      appointments,
      totalRevenue: payments._sum.amount ?? 0,
      paymentCount: payments._count._all,
      admissions,
    };
  }

  // CUSTOM
  return { reportType, note: "Custom report — configure via config field" };
}

function renderReportEmail(
  reportName: string,
  snapshot: Record<string, unknown>
): { subject: string; body: string } {
  const lines = Object.entries(snapshot)
    .filter(([k]) => k !== "reportType")
    .map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  return {
    subject: `[MedCore] ${reportName}`,
    body: `Report: ${reportName}\n\n${lines.join("\n")}`,
  };
}

// ── Routes ─────────────────────────────────────────────

// POST /scheduled-reports
router.post(
  "/",
  validate(scheduledReportCreateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const nextRunAt = computeNextRun(
        body.frequency,
        body.timeOfDay,
        body.dayOfWeek,
        body.dayOfMonth
      );

      const created = await prisma.scheduledReport.create({
        data: {
          name: body.name,
          reportType: body.reportType,
          frequency: body.frequency,
          dayOfWeek: body.dayOfWeek ?? null,
          dayOfMonth: body.dayOfMonth ?? null,
          timeOfDay: body.timeOfDay,
          recipients: body.recipients as any,
          config: (body.config as any) ?? undefined,
          active: body.active ?? true,
          nextRunAt,
          createdBy: req.user!.userId,
        },
      });

      auditLog(req, "SCHEDULED_REPORT_CREATE", "scheduled_report", created.id, {
        name: created.name,
        reportType: created.reportType,
      }).catch(console.error);

      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /scheduled-reports
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { active } = req.query;
    const where: Record<string, unknown> = {};
    if (active === "true") where.active = true;
    if (active === "false") where.active = false;

    const rows = await prisma.scheduledReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: rows, error: null });
  } catch (err) {
    next(err);
  }
});

// GET /scheduled-reports/runs — history (must come before :id)
router.get("/runs", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt((req.query.limit as string) || "50", 10))
    );
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (req.query.scheduledReportId) {
      where.scheduledReportId = req.query.scheduledReportId;
    }
    if (req.query.reportType) where.reportType = req.query.reportType;
    if (req.query.status) where.status = req.query.status;

    const [rows, total] = await Promise.all([
      prisma.reportRun.findMany({
        where,
        skip,
        take: limit,
        orderBy: { generatedAt: "desc" },
        include: {
          scheduledReport: { select: { id: true, name: true } },
        },
      }),
      prisma.reportRun.count({ where }),
    ]);

    res.json({
      success: true,
      data: rows,
      error: null,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /scheduled-reports/:id
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.scheduledReport.findUnique({
      where: { id: req.params.id },
      include: { runs: { orderBy: { generatedAt: "desc" }, take: 20 } },
    });
    if (!row) {
      res.status(404).json({
        success: false,
        data: null,
        error: "Scheduled report not found",
      });
      return;
    }
    res.json({ success: true, data: row, error: null });
  } catch (err) {
    next(err);
  }
});

// PATCH /scheduled-reports/:id — update
router.patch(
  "/:id",
  validate(scheduledReportUpdateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.scheduledReport.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Scheduled report not found",
        });
        return;
      }

      const data: Record<string, unknown> = { ...req.body };
      if (req.body.recipients) data.recipients = req.body.recipients as any;
      if (req.body.config) data.config = req.body.config as any;

      // Recompute nextRunAt if schedule fields changed
      if (
        req.body.frequency ||
        req.body.timeOfDay ||
        req.body.dayOfWeek !== undefined ||
        req.body.dayOfMonth !== undefined
      ) {
        data.nextRunAt = computeNextRun(
          req.body.frequency ?? existing.frequency,
          req.body.timeOfDay ?? existing.timeOfDay,
          req.body.dayOfWeek ?? existing.dayOfWeek,
          req.body.dayOfMonth ?? existing.dayOfMonth
        );
      }

      const updated = await prisma.scheduledReport.update({
        where: { id: req.params.id },
        data: data as any,
      });

      auditLog(
        req,
        "SCHEDULED_REPORT_UPDATE",
        "scheduled_report",
        updated.id,
        req.body as Record<string, unknown>
      ).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /scheduled-reports/:id
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.scheduledReport.delete({ where: { id: req.params.id } });
    auditLog(req, "SCHEDULED_REPORT_DELETE", "scheduled_report", req.params.id).catch(
      console.error
    );
    res.json({ success: true, data: null, error: null });
  } catch (err) {
    next(err);
  }
});

// POST /scheduled-reports/:id/run-now
router.post(
  "/:id/run-now",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sched = await prisma.scheduledReport.findUnique({
        where: { id: req.params.id },
      });
      if (!sched) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Scheduled report not found",
        });
        return;
      }

      let run;
      try {
        const snapshot = await generateReportSnapshot(
          sched.reportType,
          sched.config as Record<string, unknown> | null | undefined
        );
        const recipients = (sched.recipients as unknown as string[]) || [];
        const { subject, body } = renderReportEmail(sched.name, snapshot);

        // Fire-and-forget sending to each recipient (stubbed)
        recipients.forEach((to) => {
          sendEmail(to, subject, body).catch((e) =>
            console.error("sendEmail failed", e)
          );
        });

        run = await prisma.reportRun.create({
          data: {
            scheduledReportId: sched.id,
            reportType: sched.reportType,
            parameters: (sched.config as any) ?? undefined,
            generatedBy: req.user!.userId,
            status: "SUCCESS",
            sentTo: recipients as any,
            snapshot: snapshot as any,
          },
        });

        // Log to NotificationLog/Notification for each recipient — stub as fire-and-forget
        for (const to of recipients) {
          prisma.notification
            .create({
              data: {
                userId: req.user!.userId, // fallback — real impl would lookup user by email
                type: "SCHEDULE_SUMMARY" as any,
                channel: "EMAIL" as any,
                title: subject,
                message: `Sent to ${to}: ${body.slice(0, 200)}`,
                sentAt: new Date(),
              },
            })
            .catch(() => undefined);
        }

        // Update schedule
        const nextRunAt = computeNextRun(
          sched.frequency,
          sched.timeOfDay,
          sched.dayOfWeek,
          sched.dayOfMonth
        );
        await prisma.scheduledReport.update({
          where: { id: sched.id },
          data: { lastRunAt: new Date(), nextRunAt },
        });
      } catch (e) {
        run = await prisma.reportRun.create({
          data: {
            scheduledReportId: sched.id,
            reportType: sched.reportType,
            generatedBy: req.user!.userId,
            status: "FAILED",
            error: (e as Error).message,
          },
        });
      }

      auditLog(req, "SCHEDULED_REPORT_RUN", "scheduled_report", sched.id, {
        runId: run.id,
        status: run.status,
      }).catch(console.error);

      res.json({ success: true, data: run, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as scheduledReportsRouter };
