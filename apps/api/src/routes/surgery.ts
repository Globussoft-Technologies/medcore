import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createOTSchema,
  updateOTSchema,
  scheduleSurgerySchema,
  updateSurgerySchema,
  completeSurgerySchema,
  cancelSurgerySchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// Generate next case number like SRG000001
async function nextCaseNumber(): Promise<string> {
  const last = await prisma.surgery.findFirst({
    orderBy: { caseNumber: "desc" },
    select: { caseNumber: true },
  });
  let n = 1;
  if (last?.caseNumber) {
    const m = last.caseNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `SRG${String(n).padStart(6, "0")}`;
}

// ─── OPERATING THEATERS ─────────────────────────────────

// GET /api/v1/surgery/ots — list OTs
router.get(
  "/ots",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { includeInactive } = req.query;
      const where: Record<string, unknown> = {};
      if (includeInactive !== "true") where.isActive = true;

      const ots = await prisma.operatingTheater.findMany({
        where,
        orderBy: { name: "asc" },
      });

      res.json({ success: true, data: ots, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/surgery/ots — create OT
router.post(
  "/ots",
  authorize(Role.ADMIN),
  validate(createOTSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ot = await prisma.operatingTheater.create({
        data: req.body,
      });
      auditLog(req, "CREATE_OT", "operatingTheater", ot.id, {
        name: ot.name,
      }).catch(console.error);
      res.status(201).json({ success: true, data: ot, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/ots/:id — update OT
router.patch(
  "/ots/:id",
  authorize(Role.ADMIN),
  validate(updateOTSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ot = await prisma.operatingTheater.update({
        where: { id: req.params.id },
        data: req.body,
      });
      auditLog(req, "UPDATE_OT", "operatingTheater", ot.id, req.body).catch(
        console.error
      );
      res.json({ success: true, data: ot, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/surgery/ots/:id/schedule?date=YYYY-MM-DD
router.get(
  "/ots/:id/schedule",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().split("T")[0];
      const start = new Date(`${date}T00:00:00.000Z`);
      const end = new Date(`${date}T23:59:59.999Z`);

      const surgeries = await prisma.surgery.findMany({
        where: {
          otId: req.params.id,
          scheduledAt: { gte: start, lte: end },
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
        orderBy: { scheduledAt: "asc" },
      });

      res.json({ success: true, data: surgeries, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── SURGERIES ──────────────────────────────────────────

// POST /api/v1/surgery — schedule a surgery
router.post(
  "/",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(scheduleSurgerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        surgeonId,
        otId,
        procedure,
        scheduledAt,
        durationMin,
        anaesthesiologist,
        assistants,
        preOpNotes,
        diagnosis,
        cost,
      } = req.body;

      const ot = await prisma.operatingTheater.findUnique({ where: { id: otId } });
      if (!ot) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Operating theater not found",
        });
        return;
      }
      if (!ot.isActive) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Operating theater is inactive",
        });
        return;
      }

      const caseNumber = await nextCaseNumber();

      const surgery = await prisma.surgery.create({
        data: {
          caseNumber,
          patientId,
          surgeonId,
          otId,
          procedure,
          scheduledAt: new Date(scheduledAt),
          durationMin,
          anaesthesiologist,
          assistants,
          preOpNotes,
          diagnosis,
          cost,
          status: "SCHEDULED",
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "SCHEDULE_SURGERY", "surgery", surgery.id, {
        caseNumber,
        patientId,
        surgeonId,
        otId,
      }).catch(console.error);

      res.status(201).json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/surgery — list surgeries
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      patientId,
      surgeonId,
      otId,
      status,
      from,
      to,
      page = "1",
      limit = "20",
    } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};
    if (patientId) where.patientId = patientId;
    if (surgeonId) where.surgeonId = surgeonId;
    if (otId) where.otId = otId;
    if (status) where.status = status;

    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.gte = new Date(from as string);
      if (to) range.lte = new Date(to as string);
      where.scheduledAt = range;
    }

    // PATIENT role: scope to own patient record
    if (req.user!.role === Role.PATIENT) {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (!patient) {
        res.json({
          success: true,
          data: [],
          error: null,
          meta: { page: 1, limit: take, total: 0 },
        });
        return;
      }
      where.patientId = patient.id;
    }

    const [surgeries, total] = await Promise.all([
      prisma.surgery.findMany({
        where,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
        skip,
        take,
        orderBy: { scheduledAt: "desc" },
      }),
      prisma.surgery.count({ where }),
    ]);

    res.json({
      success: true,
      data: surgeries,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/surgery/:id
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const surgery = await prisma.surgery.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: {
              user: { select: { name: true, phone: true, email: true } },
            },
          },
          surgeon: {
            include: { user: { select: { name: true, email: true } } },
          },
          ot: true,
        },
      });

      if (!surgery) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Surgery not found",
        });
        return;
      }

      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id — update
router.patch(
  "/:id",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  validate(updateSurgerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (req.body.scheduledAt) data.scheduledAt = new Date(req.body.scheduledAt);
      if (req.body.actualStartAt) data.actualStartAt = new Date(req.body.actualStartAt);
      if (req.body.actualEndAt) data.actualEndAt = new Date(req.body.actualEndAt);

      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "UPDATE_SURGERY", "surgery", surgery.id, req.body).catch(
        console.error
      );

      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/start
router.patch(
  "/:id/start",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data: {
          status: "IN_PROGRESS",
          actualStartAt: new Date(),
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "START_SURGERY", "surgery", surgery.id, {
        caseNumber: surgery.caseNumber,
      }).catch(console.error);

      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/complete
router.patch(
  "/:id/complete",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(completeSurgerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = {
        status: "COMPLETED",
        actualEndAt: new Date(),
      };
      if (req.body.postOpNotes !== undefined) data.postOpNotes = req.body.postOpNotes;
      if (req.body.diagnosis !== undefined) data.diagnosis = req.body.diagnosis;

      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "COMPLETE_SURGERY", "surgery", surgery.id, {
        caseNumber: surgery.caseNumber,
      }).catch(console.error);

      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/cancel
router.patch(
  "/:id/cancel",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(cancelSurgerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.surgery.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Surgery not found",
        });
        return;
      }

      const existingNotes = existing.postOpNotes ?? "";
      const cancelNote = `[CANCELLED] ${req.body.reason}`;
      const postOpNotes = existingNotes
        ? `${existingNotes}\n${cancelNote}`
        : cancelNote;

      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data: {
          status: "CANCELLED",
          postOpNotes,
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "CANCEL_SURGERY", "surgery", surgery.id, {
        caseNumber: surgery.caseNumber,
        reason: req.body.reason,
      }).catch(console.error);

      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as surgeryRouter };
