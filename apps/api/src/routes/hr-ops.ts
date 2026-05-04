import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createHolidaySchema,
  payrollCalcSchema,
  certificationSchema,
  updateCertificationSchema,
  overtimeRecordSchema,
  autoOvertimeSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { generatePaySlipHTML } from "../services/pdf";
import { computePayroll } from "../services/payroll";

const router = Router();
router.use(authenticate);

function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

// ─── HOLIDAY CALENDAR ──────────────────────────────────

// GET /api/v1/hr-ops/holidays?year=
// Issue #459 (A5 RBAC drift, May 2026): tighten server to match the UI gate.
// The dashboard route `/dashboard/holidays` redirects every non-ADMIN user
// in `useEffect`, so any read by a non-admin is the result of a direct API
// call, not a legitimate UI flow. Writes (POST/PATCH/DELETE below) are
// already ADMIN-only — make read symmetric so the audit trail is clean.
router.get("/holidays", authorize(Role.ADMIN), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = parseInt((req.query.year as string) || String(new Date().getFullYear()), 10);
    const start = new Date(`${year}-01-01T00:00:00.000Z`);
    const end = new Date(`${year}-12-31T23:59:59.999Z`);
    const holidays = await prisma.holiday.findMany({
      where: { date: { gte: start, lte: end } },
      orderBy: { date: "asc" },
    });
    res.json({ success: true, data: holidays, error: null });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/holidays",
  authorize(Role.ADMIN),
  validate(createHolidaySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Issue #73 — application-level dedup on (date, tenant). The schema
      // has @@unique([date, name]) which still allows two different names
      // on the same calendar day (e.g. "Diwali" + "Lakshmi Puja"). Per
      // policy a single date should hold at most one holiday per tenant,
      // so we check before insert and return 409 with a clear message.
      const date = parseDate(req.body.date);
      const existing = await prisma.holiday.findFirst({
        where: { date },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: `A holiday already exists on ${req.body.date}: "${existing.name}". Delete it first to replace.`,
        });
        return;
      }

      const h = await prisma.holiday.create({
        data: {
          date,
          name: req.body.name,
          type: req.body.type || "PUBLIC",
          description: req.body.description,
        },
      });
      auditLog(req, "HOLIDAY_CREATE", "holiday", h.id, req.body).catch(console.error);
      res.status(201).json({ success: true, data: h, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/holidays/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.holiday.delete({ where: { id: req.params.id } });
      auditLog(req, "HOLIDAY_DELETE", "holiday", req.params.id).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── ATTENDANCE SUMMARY ────────────────────────────────
// GET /api/v1/hr-ops/attendance?userId=&year=&month=
router.get(
  "/attendance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isAdmin = req.user!.role === Role.ADMIN;
      const userId =
        isAdmin ? ((req.query.userId as string) || req.user!.userId) : req.user!.userId;
      const now = new Date();
      const year = parseInt((req.query.year as string) || String(now.getFullYear()), 10);
      const month = parseInt(
        (req.query.month as string) || String(now.getMonth() + 1),
        10
      );
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

      const shifts = await prisma.staffShift.findMany({
        where: { userId, date: { gte: start, lte: end } },
      });
      const by = { PRESENT: 0, LATE: 0, ABSENT: 0, LEAVE: 0, SCHEDULED: 0 };
      for (const s of shifts) {
        by[s.status as keyof typeof by] =
          (by[s.status as keyof typeof by] || 0) + 1;
      }
      const totalDays = shifts.length;
      const workedDays = by.PRESENT + by.LATE;
      res.json({
        success: true,
        data: {
          userId,
          year,
          month,
          totalScheduled: totalDays,
          workedDays,
          leaveDays: by.LEAVE,
          absentDays: by.ABSENT,
          byStatus: by,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PAYROLL CALCULATION ───────────────────────────────
// POST /api/v1/hr-ops/payroll
router.post(
  "/payroll",
  authorize(Role.ADMIN),
  validate(payrollCalcSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, year, month, basicSalary, allowances, deductions, overtimeRate } =
        req.body;
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
      const shifts = await prisma.staffShift.findMany({
        where: { userId, date: { gte: start, lte: end } },
      });
      const approvedOvertime = await prisma.overtimeRecord.findMany({
        where: { userId, approved: true, date: { gte: start, lte: end } },
      });

      // Single source of truth — same math the salary slip uses.
      const calc = computePayroll({
        basicSalary,
        allowances,
        deductions,
        overtimeRate,
        shifts,
        approvedOvertime,
      });

      res.json({
        success: true,
        data: {
          userId,
          year,
          month,
          ...calc,
          // Back-compat aliases used by the dashboard table:
          deductions: calc.otherDeductions,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// STAFF CERTIFICATIONS
// ═══════════════════════════════════════════════════════

function autoStatusFromExpiry(expiryDate: Date | null | undefined): string {
  if (!expiryDate) return "ACTIVE";
  const now = new Date();
  return expiryDate < now ? "EXPIRED" : "ACTIVE";
}

// GET /api/v1/hr-ops/certifications?userId=&expiring=30
router.get(
  "/certifications",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, expiring } = req.query as Record<string, string>;
      const isOwn = userId && req.user!.userId === userId;
      if (!isOwn && req.user!.role !== Role.ADMIN && userId) {
        res.status(403).json({ success: false, data: null, error: "Forbidden" });
        return;
      }
      const where: Record<string, unknown> = {};
      if (userId) where.userId = userId;
      else if (req.user!.role !== Role.ADMIN) where.userId = req.user!.userId;

      if (expiring) {
        const days = parseInt(expiring, 10) || 30;
        const until = new Date();
        until.setDate(until.getDate() + days);
        where.expiryDate = { not: null, lte: until };
      }

      const rows = await prisma.staffCertification.findMany({
        where,
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: [{ expiryDate: "asc" }, { createdAt: "desc" }],
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/hr-ops/certifications/expiring?days=60
router.get(
  "/certifications/expiring",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = parseInt((req.query.days as string) || "60", 10);
      const now = new Date();
      const until = new Date();
      until.setDate(until.getDate() + days);
      const expiring = await prisma.staffCertification.findMany({
        where: {
          expiryDate: { not: null, gte: now, lte: until },
          status: "ACTIVE",
        },
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { expiryDate: "asc" },
      });
      const expired = await prisma.staffCertification.findMany({
        where: {
          expiryDate: { not: null, lt: now },
          status: { in: ["ACTIVE", "EXPIRED"] },
        },
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { expiryDate: "desc" },
      });
      res.json({ success: true, data: { expiring, expired }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/hr-ops/certifications
router.post(
  "/certifications",
  authorize(Role.ADMIN),
  validate(certificationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const expiry = body.expiryDate ? new Date(body.expiryDate) : null;
      const created = await prisma.staffCertification.create({
        data: {
          userId: body.userId,
          type: body.type,
          title: body.title,
          issuingBody: body.issuingBody ?? null,
          certNumber: body.certNumber ?? null,
          issuedDate: body.issuedDate ? new Date(body.issuedDate) : null,
          expiryDate: expiry,
          documentPath: body.documentPath ?? null,
          status: body.status ?? autoStatusFromExpiry(expiry),
          notes: body.notes ?? null,
        },
      });
      auditLog(req, "CERTIFICATION_CREATE", "staff_certification", created.id, {
        userId: body.userId,
        title: body.title,
      }).catch(console.error);
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/hr-ops/certifications/:id
router.patch(
  "/certifications/:id",
  authorize(Role.ADMIN),
  validate(updateCertificationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (data.issuedDate) data.issuedDate = new Date(data.issuedDate as string);
      if (data.expiryDate) data.expiryDate = new Date(data.expiryDate as string);
      const updated = await prisma.staffCertification.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(
        req,
        "CERTIFICATION_UPDATE",
        "staff_certification",
        updated.id,
        req.body
      ).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/hr-ops/certifications/:id
router.delete(
  "/certifications/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.staffCertification.delete({ where: { id: req.params.id } });
      auditLog(req, "CERTIFICATION_DELETE", "staff_certification", req.params.id).catch(
        console.error
      );
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OVERTIME RECORDS
// ═══════════════════════════════════════════════════════

function computeAmount(hours: number, rate: number, multiplier: number): number {
  return +(hours * rate * multiplier).toFixed(2);
}

// GET /api/v1/hr-ops/overtime?userId=&month=YYYY-MM
router.get(
  "/overtime",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, month } = req.query as Record<string, string>;
      const isOwn = userId && req.user!.userId === userId;
      if (!isOwn && req.user!.role !== Role.ADMIN && userId) {
        res.status(403).json({ success: false, data: null, error: "Forbidden" });
        return;
      }
      const where: Record<string, unknown> = {};
      if (userId) where.userId = userId;
      else if (req.user!.role !== Role.ADMIN) where.userId = req.user!.userId;

      if (month) {
        const [y, m] = month.split("-").map((x) => parseInt(x, 10));
        if (!Number.isNaN(y) && !Number.isNaN(m)) {
          const start = new Date(Date.UTC(y, m - 1, 1));
          const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
          where.date = { gte: start, lte: end };
        }
      }
      const rows = await prisma.overtimeRecord.findMany({
        where,
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { date: "desc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/hr-ops/overtime
router.post(
  "/overtime",
  authorize(Role.ADMIN),
  validate(overtimeRecordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const amount = computeAmount(body.overtimeHours, body.hourlyRate, body.overtimeRate);
      const created = await prisma.overtimeRecord.create({
        data: {
          userId: body.userId,
          date: new Date(body.date),
          regularHours: body.regularHours,
          overtimeHours: body.overtimeHours,
          hourlyRate: body.hourlyRate,
          overtimeRate: body.overtimeRate,
          amount,
          notes: body.notes ?? null,
        },
      });
      auditLog(req, "OVERTIME_CREATE", "overtime_record", created.id, body).catch(
        console.error
      );
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/hr-ops/overtime/auto-calculate
router.post(
  "/overtime/auto-calculate",
  authorize(Role.ADMIN),
  validate(autoOvertimeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { year, month, userId, defaultHourlyRate, regularHoursPerDay, overtimeRate } =
        req.body;
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

      const shiftsWhere: Record<string, unknown> = {
        date: { gte: start, lte: end },
        status: { in: ["PRESENT", "LATE"] },
      };
      if (userId) shiftsWhere.userId = userId;

      const shifts = await prisma.staffShift.findMany({
        where: shiftsWhere,
        orderBy: { date: "asc" },
      });

      // Compute hours worked per shift
      const byUserDate: Record<string, { userId: string; date: Date; hours: number }> = {};
      for (const s of shifts) {
        const [sh, sm] = s.startTime.split(":").map((x) => parseInt(x, 10));
        const [eh, em] = s.endTime.split(":").map((x) => parseInt(x, 10));
        let mins = eh * 60 + em - (sh * 60 + sm);
        if (mins < 0) mins += 24 * 60; // overnight
        const hours = mins / 60;
        const k = `${s.userId}|${s.date.toISOString().slice(0, 10)}`;
        if (!byUserDate[k]) byUserDate[k] = { userId: s.userId, date: s.date, hours: 0 };
        byUserDate[k].hours += hours;
      }

      const created: any[] = [];
      for (const v of Object.values(byUserDate)) {
        const otHours = Math.max(0, v.hours - regularHoursPerDay);
        if (otHours <= 0) continue;
        // Skip if we already have an OT record for this user+date
        const existing = await prisma.overtimeRecord.findFirst({
          where: { userId: v.userId, date: v.date },
        });
        if (existing) continue;
        const amount = computeAmount(otHours, defaultHourlyRate, overtimeRate);
        const rec = await prisma.overtimeRecord.create({
          data: {
            userId: v.userId,
            date: v.date,
            regularHours: Math.min(regularHoursPerDay, v.hours),
            overtimeHours: otHours,
            hourlyRate: defaultHourlyRate,
            overtimeRate,
            amount,
          },
        });
        created.push(rec);
      }

      auditLog(req, "OVERTIME_AUTO_CALC", "overtime_record", undefined, {
        year,
        month,
        created: created.length,
      }).catch(console.error);

      res.json({ success: true, data: { created: created.length, records: created }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/hr-ops/overtime/:id/approve
router.patch(
  "/overtime/:id/approve",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await prisma.overtimeRecord.update({
        where: { id: req.params.id },
        data: { approved: true, approvedBy: req.user!.userId },
      });
      auditLog(req, "OVERTIME_APPROVE", "overtime_record", updated.id).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/hr-ops/overtime/:id
router.patch(
  "/overtime/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (data.date) data.date = new Date(data.date as string);
      // recompute amount if hours/rates changed
      if (data.overtimeHours !== undefined || data.hourlyRate !== undefined || data.overtimeRate !== undefined) {
        const existing = await prisma.overtimeRecord.findUnique({ where: { id: req.params.id } });
        if (existing) {
          const oh = (data.overtimeHours as number) ?? existing.overtimeHours;
          const hr = (data.hourlyRate as number) ?? existing.hourlyRate;
          const or = (data.overtimeRate as number) ?? existing.overtimeRate;
          data.amount = computeAmount(oh, hr, or);
        }
      }
      const updated = await prisma.overtimeRecord.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(req, "OVERTIME_UPDATE", "overtime_record", updated.id, req.body).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/hr-ops/payroll/:userId/slip?month=YYYY-MM
router.get(
  "/payroll/:userId/slip",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isAdmin = req.user!.role === Role.ADMIN;
      if (!isAdmin && req.user!.userId !== req.params.userId) {
        res.status(403).json({ success: false, data: null, error: "Forbidden" });
        return;
      }
      const month =
        (req.query.month as string) ||
        new Date().toISOString().slice(0, 7); // default current month
      if (!/^\d{4}-\d{2}$/.test(month)) {
        res
          .status(400)
          .json({ success: false, data: null, error: "month must be YYYY-MM" });
        return;
      }
      // Optional overrides — keep slip math in sync with the payroll
      // dashboard, which posts the same inputs to /hr-ops/payroll.
      const num = (v: unknown): number | undefined => {
        if (v === undefined || v === null || v === "") return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const overrides = {
        basicSalary: num(req.query.basicSalary),
        allowances: num(req.query.allowances),
        deductions: num(req.query.deductions),
        overtimeRate: num(req.query.overtimeRate),
      };
      const html = await generatePaySlipHTML(req.params.userId, month, overrides);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "User not found") {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

export { router as hrOpsRouter };
