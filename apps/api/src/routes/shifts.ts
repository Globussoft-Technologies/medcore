import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createShiftSchema,
  bulkShiftSchema,
  updateShiftSchema,
  updateShiftStatusSchema,
  checkOutShiftSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// Helper: parse "HH:MM" into minutes since midnight
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

// Helper: parse YYYY-MM-DD to Date (UTC midnight)
function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

// ─── POST /shifts — create single shift (ADMIN) ────────────────
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createShiftSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, date, type, startTime, endTime, notes } = req.body;

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        res.status(404).json({ success: false, data: null, error: "User not found" });
        return;
      }

      const shift = await prisma.staffShift.create({
        data: {
          userId,
          date: parseDate(date),
          type,
          startTime,
          endTime,
          notes,
        },
        include: { user: { select: { id: true, name: true, role: true } } },
      });

      auditLog(req, "SHIFT_CREATE", "staffShift", shift.id, { userId, date, type }).catch(
        console.error
      );

      res.status(201).json({ success: true, data: shift, error: null });
    } catch (err: any) {
      if (err?.code === "P2002") {
        res.status(409).json({
          success: false,
          data: null,
          error: "A shift of this type already exists for this user on this date",
        });
        return;
      }
      next(err);
    }
  }
);

// ─── POST /shifts/bulk — create multiple shifts (ADMIN) ────────
router.post(
  "/bulk",
  authorize(Role.ADMIN),
  validate(bulkShiftSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { shifts } = req.body as {
        shifts: Array<{
          userId: string;
          date: string;
          type: string;
          startTime: string;
          endTime: string;
          notes?: string;
        }>;
      };

      const created: any[] = [];
      const skipped: Array<{ userId: string; date: string; type: string; reason: string }> =
        [];

      for (const s of shifts) {
        try {
          const shift = await prisma.staffShift.create({
            data: {
              userId: s.userId,
              date: parseDate(s.date),
              type: s.type as any,
              startTime: s.startTime,
              endTime: s.endTime,
              notes: s.notes,
            },
          });
          created.push(shift);
        } catch (err: any) {
          skipped.push({
            userId: s.userId,
            date: s.date,
            type: s.type,
            reason: err?.code === "P2002" ? "duplicate" : err?.message || "error",
          });
        }
      }

      auditLog(req, "SHIFT_BULK_CREATE", "staffShift", undefined, {
        createdCount: created.length,
        skippedCount: skipped.length,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: { created, skipped },
        error: null,
        meta: { createdCount: created.length, skippedCount: skipped.length },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /shifts — list w/ filters & pagination ────────────────
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, from, to, status, type } = req.query;
    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
    const limit = Math.min(
      200,
      Math.max(1, parseInt((req.query.limit as string) || "50", 10))
    );

    const where: any = {};
    if (userId) where.userId = userId as string;
    if (status) where.status = status as string;
    if (type) where.type = type as string;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = parseDate(from as string);
      if (to) where.date.lte = parseDate(to as string);
    }

    // Non-admins only see their own shifts
    if (req.user!.role !== Role.ADMIN) {
      where.userId = req.user!.userId;
    }

    const [total, shifts] = await Promise.all([
      prisma.staffShift.count({ where }),
      prisma.staffShift.findMany({
        where,
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: [{ date: "asc" }, { startTime: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json({
      success: true,
      data: shifts,
      error: null,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /shifts/my — current user's shifts for next 14 days ───
router.get("/my", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const end = new Date(today);
    end.setUTCDate(end.getUTCDate() + 14);

    const shifts = await prisma.staffShift.findMany({
      where: {
        userId: req.user!.userId,
        date: { gte: today, lte: end },
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
    });

    res.json({ success: true, data: shifts, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── GET /shifts/staff — list all staff users (ADMIN) ──────────
router.get(
  "/staff",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const users = await prisma.user.findMany({
        where: {
          role: { in: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION] },
          isActive: true,
        },
        select: { id: true, name: true, email: true, role: true },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      });
      res.json({ success: true, data: users, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /shifts/roster?date=YYYY-MM-DD — grouped by type ──────
router.get("/roster", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date } = req.query;
    if (!date || typeof date !== "string") {
      res.status(400).json({
        success: false,
        data: null,
        error: "date query parameter is required (YYYY-MM-DD)",
      });
      return;
    }

    const shifts = await prisma.staffShift.findMany({
      where: { date: parseDate(date) },
      include: {
        user: { select: { id: true, name: true, role: true, email: true } },
      },
      orderBy: [{ startTime: "asc" }],
    });

    const grouped: Record<string, typeof shifts> = {
      MORNING: [],
      AFTERNOON: [],
      NIGHT: [],
      ON_CALL: [],
    };
    for (const s of shifts) {
      (grouped[s.type] ||= []).push(s);
    }

    res.json({
      success: true,
      data: { date, shifts, grouped },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /shifts/:id — update (ADMIN) ────────────────────────
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateShiftSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const existing = await prisma.staffShift.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Shift not found" });
        return;
      }

      const body = req.body as any;
      const data: any = {};
      if (body.date !== undefined) data.date = parseDate(body.date);
      if (body.type !== undefined) data.type = body.type;
      if (body.startTime !== undefined) data.startTime = body.startTime;
      if (body.endTime !== undefined) data.endTime = body.endTime;
      if (body.status !== undefined) data.status = body.status;
      if (body.notes !== undefined) data.notes = body.notes;

      const shift = await prisma.staffShift.update({
        where: { id },
        data,
        include: { user: { select: { id: true, name: true, role: true } } },
      });

      auditLog(req, "SHIFT_UPDATE", "staffShift", id, data).catch(console.error);

      res.json({ success: true, data: shift, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /shifts/:id/check-in ────────────────────────────────
router.patch("/:id/check-in", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const shift = await prisma.staffShift.findUnique({ where: { id } });
    if (!shift) {
      res.status(404).json({ success: false, data: null, error: "Shift not found" });
      return;
    }

    // Allow self check-in, or ADMIN
    if (shift.userId !== req.user!.userId && req.user!.role !== Role.ADMIN) {
      res.status(403).json({ success: false, data: null, error: "Forbidden" });
      return;
    }

    // Late detection: current time vs shift startTime + 15 min (local time)
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = toMinutes(shift.startTime);
    const isLate = nowMinutes > startMinutes + 15;

    const updated = await prisma.staffShift.update({
      where: { id },
      data: {
        status: isLate ? "LATE" : "PRESENT",
        notes: isLate
          ? `${shift.notes ? shift.notes + " | " : ""}Late check-in at ${now.toTimeString().slice(0, 5)}`
          : shift.notes,
      },
      include: { user: { select: { id: true, name: true, role: true } } },
    });

    auditLog(req, "SHIFT_CHECK_IN", "staffShift", id, { late: isLate }).catch(console.error);

    res.json({ success: true, data: updated, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /shifts/:id/check-out ───────────────────────────────
router.patch(
  "/:id/check-out",
  validate(checkOutShiftSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const shift = await prisma.staffShift.findUnique({ where: { id } });
      if (!shift) {
        res.status(404).json({ success: false, data: null, error: "Shift not found" });
        return;
      }

      if (shift.userId !== req.user!.userId && req.user!.role !== Role.ADMIN) {
        res.status(403).json({ success: false, data: null, error: "Forbidden" });
        return;
      }

      const { notes } = req.body as { notes?: string };
      const now = new Date();
      const checkoutNote = `Checked out at ${now.toTimeString().slice(0, 5)}${
        notes ? " — " + notes : ""
      }`;

      // Keep current status (PRESENT/LATE) but append checkout note
      const updated = await prisma.staffShift.update({
        where: { id },
        data: {
          notes: shift.notes ? `${shift.notes} | ${checkoutNote}` : checkoutNote,
        },
        include: { user: { select: { id: true, name: true, role: true } } },
      });

      auditLog(req, "SHIFT_CHECK_OUT", "staffShift", id).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /shifts/:id — cancel (ADMIN) ───────────────────────
router.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const existing = await prisma.staffShift.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Shift not found" });
        return;
      }

      await prisma.staffShift.delete({ where: { id } });

      auditLog(req, "SHIFT_DELETE", "staffShift", id).catch(console.error);

      res.json({ success: true, data: { id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as shiftRouter };
