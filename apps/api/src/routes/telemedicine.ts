import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { prisma } from "@medcore/db";
import {
  Role,
  createTelemedicineSchema,
  endTelemedicineSchema,
  rateTelemedicineSchema,
  telemedTechIssuesSchema,
  telemedFollowUpSchema,
  telemedPrescriptionSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

async function nextSessionNumber(): Promise<string> {
  const last = await prisma.telemedicineSession.findFirst({
    orderBy: { sessionNumber: "desc" },
    select: { sessionNumber: true },
  });
  let n = 1;
  if (last?.sessionNumber) {
    const m = last.sessionNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `TEL${String(n).padStart(6, "0")}`;
}

function generateMeetingId(): string {
  return crypto.randomBytes(8).toString("hex");
}

// POST /api/v1/telemedicine — schedule
router.post(
  "/",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  validate(createTelemedicineSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, doctorId, scheduledAt, chiefComplaint, fee } = req.body;

      const patient = await prisma.patient.findUnique({ where: { id: patientId } });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
      if (!doctor) {
        res.status(404).json({ success: false, data: null, error: "Doctor not found" });
        return;
      }

      const sessionNumber = await nextSessionNumber();
      const meetingId = generateMeetingId();
      const meetingUrl = `https://meet.jit.si/medcore-${meetingId}`;

      const session = await prisma.telemedicineSession.create({
        data: {
          sessionNumber,
          patientId,
          doctorId,
          scheduledAt: new Date(scheduledAt),
          chiefComplaint,
          fee: fee ?? 500,
          meetingId,
          meetingUrl,
          status: "SCHEDULED",
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true, email: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "SCHEDULE_TELEMEDICINE", "telemedicineSession", session.id, {
        sessionNumber,
        patientId,
        doctorId,
      }).catch(console.error);

      res.status(201).json({ success: true, data: session, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/telemedicine — list with filters
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      patientId,
      doctorId,
      status,
      date,
      page = "1",
      limit = "20",
    } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (patientId) where.patientId = patientId;
    if (doctorId) where.doctorId = doctorId;
    if (date) {
      const start = new Date(date as string);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      where.scheduledAt = { gte: start, lt: end };
    }

    // PATIENT restricted to own
    if (req.user!.role === Role.PATIENT) {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (patient) where.patientId = patient.id;
      else {
        res.json({
          success: true,
          data: [],
          error: null,
          meta: { page: 1, limit: take, total: 0 },
        });
        return;
      }
    }
    // DOCTOR restricted to own when no explicit filter and they aren't admin/reception
    if (req.user!.role === Role.DOCTOR && !doctorId && !patientId) {
      const doctor = await prisma.doctor.findUnique({
        where: { userId: req.user!.userId },
      });
      if (doctor) where.doctorId = doctor.id;
    }

    const [sessions, total] = await Promise.all([
      prisma.telemedicineSession.findMany({
        where,
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
        skip,
        take,
        orderBy: { scheduledAt: "desc" },
      }),
      prisma.telemedicineSession.count({ where }),
    ]);

    res.json({
      success: true,
      data: sessions,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/telemedicine/:id
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await prisma.telemedicineSession.findUnique({
      where: { id: req.params.id },
      include: {
        patient: {
          include: { user: { select: { name: true, phone: true, email: true } } },
        },
        doctor: { include: { user: { select: { name: true } } } },
      },
    });
    if (!session) {
      res.status(404).json({ success: false, data: null, error: "Session not found" });
      return;
    }
    res.json({ success: true, data: session, error: null });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/telemedicine/:id/start
router.patch(
  "/:id/start",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.telemedicineSession.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (existing.status === "COMPLETED" || existing.status === "CANCELLED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot start ${existing.status} session`,
        });
        return;
      }

      const session = await prisma.telemedicineSession.update({
        where: { id: req.params.id },
        data: {
          status: "IN_PROGRESS",
          startedAt: existing.startedAt ?? new Date(),
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "START_TELEMEDICINE", "telemedicineSession", session.id, {
        sessionNumber: session.sessionNumber,
      }).catch(console.error);

      res.json({ success: true, data: session, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/telemedicine/:id/end
router.patch(
  "/:id/end",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(endTelemedicineSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.telemedicineSession.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }

      const endedAt = new Date();
      const startedAt = existing.startedAt ?? endedAt;
      const durationMin = Math.max(
        0,
        Math.round((endedAt.getTime() - startedAt.getTime()) / 60000)
      );

      const session = await prisma.telemedicineSession.update({
        where: { id: req.params.id },
        data: {
          status: "COMPLETED",
          endedAt,
          startedAt,
          durationMin,
          doctorNotes: req.body.doctorNotes ?? existing.doctorNotes,
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "END_TELEMEDICINE", "telemedicineSession", session.id, {
        sessionNumber: session.sessionNumber,
        durationMin,
      }).catch(console.error);

      res.json({ success: true, data: session, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/telemedicine/:id/cancel
router.patch(
  "/:id/cancel",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.telemedicineSession.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (existing.status === "COMPLETED") {
        res.status(409).json({
          success: false,
          data: null,
          error: "Cannot cancel completed session",
        });
        return;
      }

      // Patients can only cancel their own
      if (req.user!.role === Role.PATIENT) {
        const patient = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
        });
        if (!patient || patient.id !== existing.patientId) {
          res.status(403).json({
            success: false,
            data: null,
            error: "Cannot cancel another patient's session",
          });
          return;
        }
      }

      const session = await prisma.telemedicineSession.update({
        where: { id: req.params.id },
        data: { status: "CANCELLED" },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "CANCEL_TELEMEDICINE", "telemedicineSession", session.id, {
        sessionNumber: session.sessionNumber,
      }).catch(console.error);

      res.json({ success: true, data: session, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/telemedicine/:id/rating — patient rates
router.patch(
  "/:id/rating",
  authorize(Role.PATIENT, Role.ADMIN),
  validate(rateTelemedicineSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.telemedicineSession.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }

      if (req.user!.role === Role.PATIENT) {
        const patient = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
        });
        if (!patient || patient.id !== existing.patientId) {
          res.status(403).json({
            success: false,
            data: null,
            error: "Cannot rate another patient's session",
          });
          return;
        }
      }

      if (existing.status !== "COMPLETED") {
        res.status(409).json({
          success: false,
          data: null,
          error: "Can only rate completed sessions",
        });
        return;
      }

      const session = await prisma.telemedicineSession.update({
        where: { id: req.params.id },
        data: { patientRating: req.body.patientRating },
        include: {
          patient: { include: { user: { select: { name: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "RATE_TELEMEDICINE", "telemedicineSession", session.id, {
        rating: req.body.patientRating,
      }).catch(console.error);

      res.json({ success: true, data: session, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/telemedicine/:id/join — patient joins waiting room
router.patch(
  "/:id/join",
  authorize(Role.PATIENT, Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.telemedicineSession.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }

      const session = await prisma.telemedicineSession.update({
        where: { id: req.params.id },
        data: {
          patientJoinedAt: existing.patientJoinedAt ?? new Date(),
          status: existing.status === "SCHEDULED" ? "WAITING" : existing.status,
        },
      });

      auditLog(req, "TELEMED_JOIN_WAITING", "telemedicineSession", session.id, {
        sessionNumber: session.sessionNumber,
      }).catch(console.error);

      res.json({ success: true, data: session, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/telemedicine/:id/tech-issues
router.patch(
  "/:id/tech-issues",
  authorize(Role.PATIENT, Role.DOCTOR, Role.ADMIN),
  validate(telemedTechIssuesSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await prisma.telemedicineSession.update({
        where: { id: req.params.id },
        data: { technicalIssues: req.body.technicalIssues },
      });
      auditLog(req, "TELEMED_TECH_ISSUE", "telemedicineSession", session.id, {
        issues: req.body.technicalIssues,
      }).catch(console.error);
      res.json({ success: true, data: session, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/telemedicine/:id/followup
router.patch(
  "/:id/followup",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(telemedFollowUpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await prisma.telemedicineSession.update({
        where: { id: req.params.id },
        data: {
          followUpScheduledAt: new Date(req.body.followUpScheduledAt),
        },
      });
      auditLog(req, "TELEMED_FOLLOWUP_SCHEDULED", "telemedicineSession", session.id, {
        followUpScheduledAt: req.body.followUpScheduledAt,
      }).catch(console.error);
      res.json({ success: true, data: session, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/telemedicine/:id/prescription — create prescription from session
router.post(
  "/:id/prescription",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(telemedPrescriptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.telemedicineSession.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Session not found" });
        return;
      }
      if (existing.status !== "COMPLETED" && existing.status !== "IN_PROGRESS") {
        res.status(409).json({
          success: false,
          data: null,
          error: "Prescription requires session to be IN_PROGRESS or COMPLETED",
        });
        return;
      }

      // Serialize items to doctorNotes appendix + cache prescription id
      const items = req.body.items as Array<{
        medicineName: string;
        dosage: string;
        frequency: string;
        duration?: string;
        instructions?: string;
      }>;

      const rxBlock = [
        "\n--- Prescription ---",
        ...items.map(
          (m, i) =>
            `${i + 1}. ${m.medicineName} ${m.dosage} — ${m.frequency}${m.duration ? ` x ${m.duration}` : ""}${m.instructions ? ` (${m.instructions})` : ""}`
        ),
        req.body.advice ? `\nAdvice: ${req.body.advice}` : "",
      ].join("\n");

      const rxId = `TRX-${existing.sessionNumber}-${Date.now()}`;

      const session = await prisma.telemedicineSession.update({
        where: { id: req.params.id },
        data: {
          prescriptionId: rxId,
          doctorNotes: (existing.doctorNotes ?? "") + rxBlock,
        },
      });

      auditLog(req, "TELEMED_PRESCRIPTION_CREATED", "telemedicineSession", session.id, {
        prescriptionId: rxId,
        itemCount: items.length,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: { session, prescriptionId: rxId, items, advice: req.body.advice },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as telemedicineRouter };
