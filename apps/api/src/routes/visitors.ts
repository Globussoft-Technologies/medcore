import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  checkinVisitorSchema,
  visitorBlacklistSchema,
  visitorPhotoSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function nextPassNumber(): Promise<string> {
  const stamp = todayStamp();
  // Find last pass for today
  const last = await prisma.visitor.findFirst({
    where: { passNumber: { contains: stamp } },
    orderBy: { passNumber: "desc" },
    select: { passNumber: true },
  });
  let n = 1;
  if (last?.passNumber) {
    const m = last.passNumber.match(/VIS(\d+)/);
    if (m) n = parseInt(m[1], 10) + 1;
  } else {
    // fallback: global last
    const globalLast = await prisma.visitor.findFirst({
      orderBy: { passNumber: "desc" },
      select: { passNumber: true },
    });
    if (globalLast?.passNumber) {
      const m = globalLast.passNumber.match(/VIS(\d+)/);
      if (m) n = parseInt(m[1], 10) + 1;
    }
  }
  return `VIS${String(n).padStart(6, "0")}-${stamp}`;
}

// POST /api/v1/visitors — check in
router.post(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(checkinVisitorSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        name,
        phone,
        idProofType,
        idProofNumber,
        patientId,
        purpose,
        department,
        notes,
      } = req.body;

      // Blacklist check
      const bl = await prisma.visitorBlacklist.findFirst({
        where: {
          OR: [
            idProofNumber ? { idProofNumber } : undefined,
            phone ? { phone } : undefined,
            name ? { name } : undefined,
          ].filter(Boolean) as any,
        },
      });
      if (bl) {
        res.status(403).json({
          success: false,
          data: null,
          error: `Visitor is blacklisted: ${bl.reason}`,
        });
        return;
      }

      // Visitor limits: max 2 active visitors per patient at a time
      if (patientId) {
        const activeCount = await prisma.visitor.count({
          where: { patientId, checkOutAt: null },
        });
        if (activeCount >= 2) {
          res.status(400).json({
            success: false,
            data: null,
            error: "This patient already has 2 active visitors (limit reached)",
          });
          return;
        }
      }

      const passNumber = await nextPassNumber();

      const visitor = await prisma.visitor.create({
        data: {
          passNumber,
          name,
          phone,
          idProofType,
          idProofNumber,
          patientId,
          purpose,
          department,
          notes,
          checkInAt: new Date(),
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
      });

      auditLog(req, "CHECKIN_VISITOR", "visitor", visitor.id, {
        passNumber,
        name,
      }).catch(console.error);

      res.status(201).json({ success: true, data: visitor, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/visitors
router.get(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        date,
        patientId,
        checkedOut,
        page = "1",
        limit = "50",
      } = req.query;
      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = Math.min(parseInt(limit as string), 200);

      const where: Record<string, unknown> = {};
      if (date) {
        const d = new Date(date as string);
        const start = new Date(d);
        start.setHours(0, 0, 0, 0);
        const end = new Date(d);
        end.setHours(23, 59, 59, 999);
        where.checkInAt = { gte: start, lte: end };
      }
      if (patientId) where.patientId = patientId;
      if (checkedOut === "true") where.checkOutAt = { not: null };
      else if (checkedOut === "false") where.checkOutAt = null;

      const [items, total] = await Promise.all([
        prisma.visitor.findMany({
          where,
          include: {
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
          },
          skip,
          take,
          orderBy: { checkInAt: "desc" },
        }),
        prisma.visitor.count({ where }),
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

// GET /api/v1/visitors/active
router.get(
  "/active",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await prisma.visitor.findMany({
        where: { checkOutAt: null },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
        orderBy: { checkInAt: "asc" },
      });
      res.json({ success: true, data: items, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/visitors/stats/daily
router.get(
  "/stats/daily",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);

      const today = await prisma.visitor.findMany({
        where: { checkInAt: { gte: start, lte: end } },
        select: { purpose: true, checkOutAt: true },
      });
      const active = await prisma.visitor.count({
        where: { checkOutAt: null },
      });

      const byPurpose: Record<string, number> = {
        PATIENT_VISIT: 0,
        DELIVERY: 0,
        APPOINTMENT: 0,
        MEETING: 0,
        OTHER: 0,
      };
      for (const v of today) {
        byPurpose[v.purpose] = (byPurpose[v.purpose] || 0) + 1;
      }

      res.json({
        success: true,
        data: {
          totalToday: today.length,
          currentInside: active,
          byPurpose,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/visitors/:id/checkout
router.patch(
  "/:id/checkout",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.visitor.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Visitor not found" });
        return;
      }
      if (existing.checkOutAt) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Visitor already checked out",
        });
        return;
      }

      const updated = await prisma.visitor.update({
        where: { id: req.params.id },
        data: { checkOutAt: new Date() },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
      });

      auditLog(req, "CHECKOUT_VISITOR", "visitor", updated.id, {}).catch(
        console.error
      );

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/visitors/:id
router.get(
  "/:id",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const v = await prisma.visitor.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true, email: true } } },
          },
        },
      });
      if (!v) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Visitor not found" });
        return;
      }
      res.json({ success: true, data: v, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: BLACKLIST, PHOTO, PEAK ANALYTICS
// ═══════════════════════════════════════════════════════

// GET /api/v1/visitors/blacklist
router.get(
  "/blacklist",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await prisma.visitorBlacklist.findMany({
        orderBy: { createdAt: "desc" },
      });
      res.json({ success: true, data: items, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/visitors/blacklist
router.post(
  "/blacklist",
  authorize(Role.ADMIN),
  validate(visitorBlacklistSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const item = await prisma.visitorBlacklist.create({
        data: {
          idProofType: req.body.idProofType,
          idProofNumber: req.body.idProofNumber,
          name: req.body.name,
          phone: req.body.phone,
          reason: req.body.reason,
          addedBy: req.user!.userId,
        },
      });
      auditLog(req, "VISITOR_BLACKLIST", "visitor_blacklist", item.id, req.body).catch(
        console.error
      );
      res.status(201).json({ success: true, data: item, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/visitors/blacklist/:id
router.delete(
  "/blacklist/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.visitorBlacklist.delete({ where: { id: req.params.id } });
      auditLog(req, "VISITOR_BLACKLIST_REMOVE", "visitor_blacklist", req.params.id).catch(
        console.error
      );
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/visitors/:id/photo — upload base64 photo
router.patch(
  "/:id/photo",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(visitorPhotoSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const v = await prisma.visitor.update({
        where: { id: req.params.id },
        data: { photoUrl: req.body.photoUrl },
      });
      auditLog(req, "VISITOR_PHOTO", "visitor", v.id).catch(console.error);
      res.json({ success: true, data: v, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/visitors/patient/:patientId — all visitors for a patient (ongoing + history)
router.get(
  "/patient/:patientId",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await prisma.visitor.findMany({
        where: { patientId: req.params.patientId },
        orderBy: { checkInAt: "desc" },
      });
      const active = items.filter((v) => !v.checkOutAt).length;
      res.json({
        success: true,
        data: { items, active, total: items.length },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/visitors/stats/peak-hours?from=&to=
router.get(
  "/stats/peak-hours",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const from = req.query.from
        ? new Date(req.query.from as string)
        : new Date(now.getTime() - 30 * 86400000);
      const to = req.query.to ? new Date(req.query.to as string) : now;
      const visitors = await prisma.visitor.findMany({
        where: { checkInAt: { gte: from, lte: to } },
        select: { checkInAt: true },
      });
      const byHour: Record<number, number> = {};
      const byDayOfWeek: Record<number, number> = {};
      for (const v of visitors) {
        const d = new Date(v.checkInAt);
        byHour[d.getHours()] = (byHour[d.getHours()] || 0) + 1;
        byDayOfWeek[d.getDay()] = (byDayOfWeek[d.getDay()] || 0) + 1;
      }
      const peakHour = Object.entries(byHour).sort(
        (a, b) => b[1] - a[1]
      )[0]?.[0];
      res.json({
        success: true,
        data: {
          total: visitors.length,
          peakHour: peakHour != null ? parseInt(peakHour, 10) : null,
          byHour,
          byDayOfWeek,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as visitorsRouter };
