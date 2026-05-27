import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createLeaveRequestSchema,
  approveLeaveSchema,
  rejectLeaveSchema,
  leaveBalanceSchema,
  DEFAULT_LEAVE_ENTITLEMENT,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { requireFeature } from "../middleware/feature-flag";
import { generateLeaveLetterHTML } from "../services/pdf";

const router = Router();
router.use(authenticate);
// Pearl §6 + §18 (gap item #9 — audit fix-up #3, 2026-05-25): leave
// management is part of the HRMS/payroll Stage-2 bundle. Pearl-branded
// tenants set `hrmsPayroll=false` and every leave route 404s before authorize.
router.use(requireFeature("hrmsPayroll"));

// #511 audit (2026-05-05, cron-tick): leaves is staff-self-service.
// LeaveRequest.userId is a User id (not Patient id), so assertPatientOwnsResource
// is not the right helper here — ownership is User-vs-User, mirroring the
// `PATCH /:id/cancel` pattern. Approve/reject/calendar/pending are
// `authorize(Role.ADMIN)` (or the calendar's staff allowlist). Reads and
// the cancel write self-scope to `req.user!.userId` for non-ADMIN. The
// only gap surfaced was `GET /:id/letter` — no role gate AND no ownership
// check, leaking another staff member's leave letter (name, role, dates,
// rejection reason) to any authed caller incl. PATIENT. Patched below
// with the same User-id ownership check used by `/cancel`.

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

      auditLog(req, "LEAVE_REQUEST_CREATE", "leaveRequest", leave.id, {
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
    const isAdmin =
      req.user!.role === Role.ADMIN || req.user!.role === Role.SUPER_ADMIN;

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
        // Increment leave balance used
        const year = updated.fromDate.getFullYear();
        prisma.leaveBalance
          .upsert({
            where: {
              userId_type_year: {
                userId: updated.userId,
                type: updated.type,
                year,
              },
            },
            update: { used: { increment: updated.totalDays } },
            create: {
              userId: updated.userId,
              type: updated.type,
              year,
              entitled:
                (DEFAULT_LEAVE_ENTITLEMENT as Record<string, number>)[updated.type] ?? 0,
              used: updated.totalDays,
            },
          })
          .catch(console.error);
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
    if (
      existing.userId !== req.user!.userId &&
      req.user!.role !== Role.ADMIN &&
      req.user!.role !== Role.SUPER_ADMIN
    ) {
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

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: LEAVE BALANCES + CALENDAR
// ═══════════════════════════════════════════════════════

// GET /api/v1/leaves/balance?userId=&year=
router.get(
  "/balance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isAdmin =
      req.user!.role === Role.ADMIN || req.user!.role === Role.SUPER_ADMIN;
      const userId = isAdmin ? (req.query.userId as string) || req.user!.userId : req.user!.userId;
      const year = parseInt((req.query.year as string) || String(new Date().getFullYear()), 10);

      const balances = await prisma.leaveBalance.findMany({
        where: { userId, year },
      });
      // Fill missing types with defaults
      const out: Array<{ type: string; entitled: number; used: number; carried: number; remaining: number }> = [];
      for (const [type, entitled] of Object.entries(DEFAULT_LEAVE_ENTITLEMENT)) {
        const existing = balances.find((b) => b.type === type);
        const e = existing?.entitled ?? entitled;
        const u = existing?.used ?? 0;
        const c = existing?.carried ?? 0;
        out.push({
          type,
          entitled: e,
          used: u,
          carried: c,
          remaining: +(e + c - u).toFixed(1),
        });
      }
      res.json({ success: true, data: { userId, year, balances: out }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/leaves/balance — admin upsert balance
router.post(
  "/balance",
  authorize(Role.ADMIN),
  validate(leaveBalanceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, type, year, entitled, carried } = req.body;
      const b = await prisma.leaveBalance.upsert({
        where: { userId_type_year: { userId, type, year } },
        update: { entitled, carried: carried || 0 },
        create: { userId, type, year, entitled, carried: carried || 0 },
      });
      auditLog(req, "LEAVE_BALANCE_UPSERT", "leave_balance", b.id, req.body).catch(
        console.error
      );
      res.status(201).json({ success: true, data: b, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/leaves/calendar?from=&to= — who is on leave (APPROVED) in window
// Issue #579 (May 2026): mirror the audit-log inverted-range guard (#690 /
// commit abae2f0). The leave-request POST already refuses fromDate > toDate
// at the schema layer, but the calendar GET silently applied an inverted
// `from`/`to` window and returned an empty list with no signal that the
// pickers were transposed. Validate the pair up front and surface a 400 so
// the schedule UI can render an inline error.
router.get(
  "/calendar",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const defaultFrom = new Date(now);
      defaultFrom.setDate(defaultFrom.getDate() - 7);
      const defaultTo = new Date(now);
      defaultTo.setDate(defaultTo.getDate() + 30);

      const from = req.query.from ? new Date(req.query.from as string) : defaultFrom;
      const to = req.query.to ? new Date(req.query.to as string) : defaultTo;

      // Issue #579: inverted-range guard. When the caller supplies BOTH
      // params and they parse to valid dates, from must be on or before to.
      if (
        req.query.from &&
        req.query.to &&
        !isNaN(from.getTime()) &&
        !isNaN(to.getTime()) &&
        from.getTime() > to.getTime()
      ) {
        res.status(400).json({
          success: false,
          data: null,
          error: "from must be on or before to",
          details: [{ field: "to", message: "from must be on or before to" }],
        });
        return;
      }

      const leaves = await prisma.leaveRequest.findMany({
        where: {
          status: "APPROVED",
          fromDate: { lte: to },
          toDate: { gte: from },
        },
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { fromDate: "asc" },
      });

      res.json({
        success: true,
        data: { from, to, leaves },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/leaves/:id/letter
// #511 audit (2026-05-05, cron-tick): added ownership check. Previously any
// authed user (incl. PATIENT) could fetch any staff member's leave letter
// HTML by id, leaking name, role, dates, reason, rejectionReason. The
// canonical pattern in this file is "owner OR admin" (see PATCH /:id/cancel).
router.get(
  "/:id/letter",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.leaveRequest.findUnique({
        where: { id: req.params.id },
        select: { userId: true },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Leave request not found" });
        return;
      }
      if (
        existing.userId !== req.user!.userId &&
        req.user!.role !== Role.ADMIN &&
        req.user!.role !== Role.SUPER_ADMIN
      ) {
        res.status(403).json({ success: false, data: null, error: "Forbidden" });
        return;
      }
      const html = await generateLeaveLetterHTML(req.params.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "Leave request not found") {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

export { router as leaveRouter };
