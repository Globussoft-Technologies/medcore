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
  preOpChecklistSchema,
  intraOpTimingSchema,
  complicationsSchema,
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

// PATCH /api/v1/surgery/:id/preop — update pre-op checklist
router.patch(
  "/:id/preop",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(preOpChecklistSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = {};
      if (typeof req.body.consentSigned === "boolean") {
        data.consentSigned = req.body.consentSigned;
        if (req.body.consentSigned) data.consentSignedAt = new Date();
      }
      if (req.body.npoSince) data.npoSince = new Date(req.body.npoSince);
      if (typeof req.body.allergiesVerified === "boolean")
        data.allergiesVerified = req.body.allergiesVerified;
      if (typeof req.body.antibioticsGiven === "boolean") {
        data.antibioticsGiven = req.body.antibioticsGiven;
        if (req.body.antibioticsGiven && req.body.antibioticsAt)
          data.antibioticsAt = new Date(req.body.antibioticsAt);
        else if (req.body.antibioticsGiven)
          data.antibioticsAt = new Date();
      }
      if (typeof req.body.siteMarked === "boolean") data.siteMarked = req.body.siteMarked;
      if (typeof req.body.bloodReserved === "boolean")
        data.bloodReserved = req.body.bloodReserved;
      data.preOpChecklistBy = req.user!.userId;

      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data,
        include: {
          patient: { include: { user: { select: { name: true } } } },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "UPDATE_PREOP_CHECKLIST", "surgery", surgery.id, data).catch(
        console.error
      );
      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/intraop — intra-op timings
router.patch(
  "/:id/intraop",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(intraOpTimingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = {};
      for (const k of [
        "anesthesiaStartAt",
        "anesthesiaEndAt",
        "incisionAt",
        "closureAt",
      ]) {
        if (req.body[k]) data[k] = new Date(req.body[k]);
      }
      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(req, "UPDATE_INTRAOP_TIMING", "surgery", surgery.id, data).catch(
        console.error
      );
      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/complications
router.patch(
  "/:id/complications",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(complicationsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data: {
          complications: req.body.complications,
          complicationSeverity: req.body.complicationSeverity,
          bloodLossMl: req.body.bloodLossMl,
        },
      });
      auditLog(req, "RECORD_SURGERY_COMPLICATIONS", "surgery", surgery.id, {
        severity: req.body.complicationSeverity,
      }).catch(console.error);
      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/surgery/ots/:id/utilization?from=&to=
// Daily utilization (hours used / available) per day in range
router.get(
  "/ots/:id/utilization",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const from = req.query.from
        ? new Date(req.query.from as string)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const to = req.query.to ? new Date(req.query.to as string) : new Date();

      const ot = await prisma.operatingTheater.findUnique({
        where: { id: req.params.id },
      });
      if (!ot) {
        res.status(404).json({ success: false, data: null, error: "OT not found" });
        return;
      }

      const surgeries = await prisma.surgery.findMany({
        where: {
          otId: req.params.id,
          scheduledAt: { gte: from, lte: to },
          status: { in: ["COMPLETED", "IN_PROGRESS"] as const },
        },
        select: {
          id: true,
          caseNumber: true,
          procedure: true,
          scheduledAt: true,
          durationMin: true,
          actualStartAt: true,
          actualEndAt: true,
        },
      });

      // Group by date (YYYY-MM-DD)
      const byDay = new Map<string, { hoursUsed: number; caseCount: number }>();
      for (const s of surgeries) {
        const day = (s.actualStartAt ?? s.scheduledAt).toISOString().slice(0, 10);
        let hours = 0;
        if (s.actualStartAt && s.actualEndAt) {
          hours =
            (s.actualEndAt.getTime() - s.actualStartAt.getTime()) /
            (60 * 60 * 1000);
        } else if (s.durationMin) {
          hours = s.durationMin / 60;
        }
        const cur = byDay.get(day) ?? { hoursUsed: 0, caseCount: 0 };
        cur.hoursUsed += hours;
        cur.caseCount += 1;
        byDay.set(day, cur);
      }

      const dailyAvailable = 12; // 12 operating hours per day standard
      const utilization = Array.from(byDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({
          date,
          hoursUsed: Math.round(v.hoursUsed * 10) / 10,
          caseCount: v.caseCount,
          utilizationPct: Math.min(
            100,
            Math.round((v.hoursUsed / dailyAvailable) * 100)
          ),
        }));

      res.json({
        success: true,
        data: {
          otId: ot.id,
          otName: ot.name,
          from,
          to,
          dailyAvailableHours: dailyAvailable,
          utilization,
          totalCases: surgeries.length,
          totalHoursUsed:
            Math.round(
              utilization.reduce((acc, d) => acc + d.hoursUsed, 0) * 10
            ) / 10,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as surgeryRouter };
