import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createHolidaySchema,
  payrollCalcSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

// ─── HOLIDAY CALENDAR ──────────────────────────────────

// GET /api/v1/hr-ops/holidays?year=
router.get("/holidays", async (req: Request, res: Response, next: NextFunction) => {
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
      const h = await prisma.holiday.create({
        data: {
          date: parseDate(req.body.date),
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
      const worked = shifts.filter((s) => s.status === "PRESENT" || s.status === "LATE").length;
      const scheduled = shifts.length;
      const absentPenalty =
        scheduled > 0 ? (shifts.filter((s) => s.status === "ABSENT").length / scheduled) * basicSalary : 0;

      // Overtime: count NIGHT + ON_CALL shifts worked (simplified heuristic)
      const overtimeShifts = shifts.filter(
        (s) => (s.type === "NIGHT" || s.type === "ON_CALL") && (s.status === "PRESENT" || s.status === "LATE")
      ).length;
      const overtimePay = overtimeShifts * (overtimeRate || 0) * 8; // 8-hour default

      const gross = basicSalary + (allowances || 0) + overtimePay;
      const net = +(gross - (deductions || 0) - absentPenalty).toFixed(2);

      res.json({
        success: true,
        data: {
          userId,
          year,
          month,
          basicSalary,
          allowances: allowances || 0,
          deductions: deductions || 0,
          absentPenalty: +absentPenalty.toFixed(2),
          overtimeShifts,
          overtimePay: +overtimePay.toFixed(2),
          workedDays: worked,
          scheduledDays: scheduled,
          gross: +gross.toFixed(2),
          net,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as hrOpsRouter };
