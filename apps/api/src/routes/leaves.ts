import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createLeaveRequestSchema,
  approveLeaveSchema,
  rejectLeaveSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24)) + 1;
}

// Fire-and-forget: mark any overlapping shifts as LEAVE
async function markOverlappingShiftsAsLeave(
  userId: string,
  fromDate: Date,
  toDate: Date
): Promise<void> {
  try {
    await prisma.staffShift.updateMany({
      where: {
        userId,
        date: { gte: fromDate, lte: toDate },
        status: { in: ["SCHEDULED", "PRESENT", "LATE"] },
      },
      data: { status: "LEAVE" },
    });
  } catch (err) {
    console.error("Failed to mark overlapping shifts as LEAVE:", err);
  }
}

// ─── POST /leaves — user creates leave request ─────────────────
router.post(
  "/",
  validate(createLeaveRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, fromDate, toDate, reason } = req.body;

      const from = parseDate(fromDate);
      const to = parseDate(toDate);
      const totalDays = daysBetween(from, to);

      const leave = await prisma.leaveRequest.create({
        data: {
          userId: req.user!.userId,
          type,
          fromDate: from,
          toDate: to,
          totalDays,
          reason,
          status: "PENDING",
        },
        include: { user: { select: { id: true, name: true, role: true } } },
      });

      auditLog(req, "LEAVE_REQUEST", "leaveRequest", leave.id, {
        type,
        fromDate,
        toDate,
      }).catch(console.error);

      res.status(201).json({ success: true, data: leave, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /leaves — list ─────────────────────────────────────────
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, userId } = req.query;
    const isAdmin = req.user!.role === Role.ADMIN;

    const where: any = {};
    if (status) where.status = status as string;

    if (isAdmin) {
      if (userId) where.userId = userId as string;
    } else {
      where.userId = req.user!.userId;
    }

    const leaves = await prisma.leaveRequest.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, role: true, email: true } },
        approver: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: leaves, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── GET /leaves/pending — ADMIN only ──────────────────────────
router.get(
  "/pending",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const leaves = await prisma.leaveRequest.findMany({
        where: { status: "PENDING" },
        include: {
          user: { select: { id: true, name: true, role: true, email: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      res.json({ success: true, data: leaves, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /leaves/my — current user's leaves + summary ──────────
router.get("/my", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const yearStart = new Date(`${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`);
    const yearEnd = new Date(`${new Date().getUTCFullYear()}-12-31T23:59:59.999Z`);

    const [leaves, yearLeaves] = await Promise.all([
      prisma.leaveRequest.findMany({
        where: { userId },
        include: { approver: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.leaveRequest.findMany({
        where: {
          userId,
          fromDate: { gte: yearStart, lte: yearEnd },
        },
      }),
    ]);

    const summary = {
      pending: 0,
      approved: 0,
      used: { CASUAL: 0, SICK: 0, EARNED: 0, MATERNITY: 0, PATERNITY: 0, UNPAID: 0 } as Record<
        string,
        number
      >,
    };

    for (const l of yearLeaves) {
      if (l.status === "PENDING") summary.pending++;
      if (l.status === "APPROVED") {
        summary.approved++;
        summary.used[l.type] = (summary.used[l.type] || 0) + l.totalDays;
      }
    }

    res.json({ success: true, data: { leaves, summary }, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /leaves/:id/approve — ADMIN ─────────────────────────
router.patch(
  "/:id/approve",
  authorize(Role.ADMIN),
  validate(approveLeaveSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { status, rejectionReason } = req.body as {
        status: "APPROVED" | "REJECTED";
        rejectionReason?: string;
      };

      const existing = await prisma.leaveRequest.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Leave request not found" });
        return;
      }
      if (existing.status !== "PENDING") {
        res.status(400).json({
          success: false,
          data: null,
          error: `Cannot modify leave in status ${existing.status}`,
        });
        return;
      }

      const updated = await prisma.leaveRequest.update({
        where: { id },
        data: {
          status,
          approvedBy: req.user!.userId,
          approvedAt: new Date(),
          rejectionReason: status === "REJECTED" ? rejectionReason : null,
        },
        include: {
          user: { select: { id: true, name: true, role: true, email: true } },
          approver: { select: { id: true, name: true } },
        },
      });

      // Fire-and-forget: update overlapping shifts to LEAVE
      if (status === "APPROVED") {
        markOverlappingShiftsAsLeave(
          updated.userId,
          updated.fromDate,
          updated.toDate
        );
      }

      auditLog(req, `LEAVE_${status}`, "leaveRequest", id, { status }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /leaves/:id/reject — ADMIN ──────────────────────────
router.patch(
  "/:id/reject",
  authorize(Role.ADMIN),
  validate(rejectLeaveSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { rejectionReason } = req.body as { rejectionReason: string };

      const existing = await prisma.leaveRequest.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Leave request not found" });
        return;
      }
      if (existing.status !== "PENDING") {
        res.status(400).json({
          success: false,
          data: null,
          error: `Cannot modify leave in status ${existing.status}`,
        });
        return;
      }

      const updated = await prisma.leaveRequest.update({
        where: { id },
        data: {
          status: "REJECTED",
          approvedBy: req.user!.userId,
          approvedAt: new Date(),
          rejectionReason,
        },
        include: {
          user: { select: { id: true, name: true, role: true } },
          approver: { select: { id: true, name: true } },
        },
      });

      auditLog(req, "LEAVE_REJECT", "leaveRequest", id, { rejectionReason }).catch(
        console.error
      );

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /leaves/:id/cancel — owner cancels own PENDING ──────
router.patch("/:id/cancel", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const existing = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, data: null, error: "Leave request not found" });
      return;
    }
    if (existing.userId !== req.user!.userId && req.user!.role !== Role.ADMIN) {
      res.status(403).json({ success: false, data: null, error: "Forbidden" });
      return;
    }
    if (existing.status !== "PENDING") {
      res.status(400).json({
        success: false,
        data: null,
        error: "Only PENDING requests can be cancelled",
      });
      return;
    }

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    auditLog(req, "LEAVE_CANCEL", "leaveRequest", id).catch(console.error);

    res.json({ success: true, data: updated, error: null });
  } catch (err) {
    next(err);
  }
});

export { router as leaveRouter };
