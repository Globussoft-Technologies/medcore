import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  bookAppointmentSchema,
  walkInSchema,
  updateAppointmentStatusSchema,
  rescheduleAppointmentSchema,
  recurringAppointmentSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  onAppointmentBooked,
  onAppointmentCancelled,
  onTokenCalled,
} from "../services/notification-triggers";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// Helper: get next token number for a doctor on a date
async function getNextToken(doctorId: string, date: Date): Promise<number> {
  const last = await prisma.appointment.findFirst({
    where: { doctorId, date },
    orderBy: { tokenNumber: "desc" },
  });
  return (last?.tokenNumber ?? 0) + 1;
}

// POST /api/v1/appointments/book — book scheduled appointment
router.post(
  "/book",
  validate(bookAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, doctorId, date, slotId, notes } = req.body;
      const dateObj = new Date(date);

      // slotId is actually the slot start time passed from frontend
      // Check if slot is already booked
      const existing = await prisma.appointment.findFirst({
        where: {
          doctorId,
          date: dateObj,
          slotStart: slotId,
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        },
      });

      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: "This slot is already booked",
        });
        return;
      }

      const tokenNumber = await getNextToken(doctorId, dateObj);

      const appointment = await prisma.appointment.create({
        data: {
          patientId,
          doctorId,
          date: dateObj,
          slotStart: slotId,
          tokenNumber,
          type: "SCHEDULED",
          status: "BOOKED",
          notes,
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
        },
      });

      // Emit socket event for queue update
      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${doctorId}`).emit("queue-updated", {
          doctorId,
          date,
        });
      }

      // Fire-and-forget notification
      onAppointmentBooked(appointment as any).catch(console.error);
      auditLog(req, "BOOK_APPOINTMENT", "appointment", appointment.id, { patientId, doctorId, date }).catch(console.error);

      res.status(201).json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/appointments/walk-in — register walk-in
router.post(
  "/walk-in",
  authorize(Role.RECEPTION, Role.ADMIN),
  validate(walkInSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, doctorId, priority, notes } = req.body;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const tokenNumber = await getNextToken(doctorId, today);

      const appointment = await prisma.appointment.create({
        data: {
          patientId,
          doctorId,
          date: today,
          tokenNumber,
          type: "WALK_IN",
          status: "BOOKED",
          priority: priority || "NORMAL",
          notes,
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
        },
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${doctorId}`).emit("queue-updated", {
          doctorId,
          date: today.toISOString().split("T")[0],
        });
        io.to("token-display").emit("token-updated", {
          doctorId,
          tokenNumber,
        });
      }

      // Fire-and-forget notification
      onAppointmentBooked(appointment as any).catch(console.error);
      auditLog(req, "WALK_IN", "appointment", appointment.id, { patientId, doctorId }).catch(console.error);

      res.status(201).json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments — list appointments
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { doctorId, patientId, date, status, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};
    if (doctorId) where.doctorId = doctorId;
    if (patientId) where.patientId = patientId;
    if (date) where.date = new Date(date as string);
    if (status) where.status = status;

    // If patient role, only show own appointments
    if (req.user!.role === "PATIENT") {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (patient) where.patientId = patient.id;
    }

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
          vitals: true,
        },
        skip,
        take,
        orderBy: [{ date: "desc" }, { tokenNumber: "asc" }],
      }),
      prisma.appointment.count({ where }),
    ]);

    res.json({
      success: true,
      data: appointments,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/appointments/:id/status — update status
router.patch(
  "/:id/status",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE),
  validate(updateAppointmentStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Auto-stamp timing fields on status transitions
      const extraData: Record<string, unknown> = { status: req.body.status };
      const now = new Date();
      if (req.body.status === "CHECKED_IN") extraData.checkInAt = now;
      if (req.body.status === "IN_CONSULTATION") extraData.consultationStartedAt = now;
      if (req.body.status === "COMPLETED") extraData.consultationEndedAt = now;

      const appointment = await prisma.appointment.update({
        where: { id: req.params.id },
        data: extraData,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
        },
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${appointment.doctorId}`).emit("queue-updated", {
          doctorId: appointment.doctorId,
          date: appointment.date.toISOString().split("T")[0],
        });

        // If a patient is being called, emit token-called
        if (req.body.status === "IN_CONSULTATION") {
          const apt = appointment as any;
          io.to("token-display").emit("token-called", {
            doctorId: appointment.doctorId,
            doctorName: apt.doctor?.user?.name,
            tokenNumber: appointment.tokenNumber,
            patientName: apt.patient?.user?.name,
          });
        }
      }

      // Fire-and-forget notifications based on status
      if (req.body.status === "CANCELLED") {
        onAppointmentCancelled(appointment as any).catch(console.error);
      }
      if (req.body.status === "IN_CONSULTATION") {
        onTokenCalled(appointment as any).catch(console.error);
      }

      auditLog(req, "UPDATE_APPOINTMENT_STATUS", "appointment", req.params.id, { status: req.body.status }).catch(console.error);

      res.json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Local stub trigger for reschedule notifications (fire-and-forget)
async function onAppointmentRescheduled(appointment: {
  id: string;
  tokenNumber: number;
  date: Date;
  slotStart?: string | null;
  patient: { user: { name: string } };
  doctor: { user: { name: string } };
}): Promise<void> {
  const dateStr = new Date(appointment.date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timeStr = appointment.slotStart ? ` at ${appointment.slotStart}` : "";
  console.log(
    `[notification] Appointment rescheduled: ${appointment.patient.user.name} with Dr. ${appointment.doctor.user.name} → ${dateStr}${timeStr} (Token #${appointment.tokenNumber})`
  );
}

// PATCH /api/v1/appointments/:id/reschedule — reschedule appointment
router.patch(
  "/:id/reschedule",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE, Role.PATIENT),
  validate(rescheduleAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date, slotStart } = req.body;
      const dateObj = new Date(date);

      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
      });

      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Appointment not found" });
        return;
      }

      if (!["BOOKED", "CHECKED_IN"].includes(existing.status)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Cannot reschedule an appointment with status ${existing.status}`,
        });
        return;
      }

      // Verify the new slot is available for that doctor
      const conflict = await prisma.appointment.findFirst({
        where: {
          doctorId: existing.doctorId,
          date: dateObj,
          slotStart,
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
          id: { not: existing.id },
        },
      });

      if (conflict) {
        res.status(409).json({
          success: false,
          data: null,
          error: "The requested slot is already booked",
        });
        return;
      }

      const tokenNumber =
        existing.date.toISOString().split("T")[0] === date
          ? existing.tokenNumber
          : await getNextToken(existing.doctorId, dateObj);

      const appointment = await prisma.appointment.update({
        where: { id: req.params.id },
        data: { date: dateObj, slotStart, tokenNumber },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
          vitals: true,
        },
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${appointment.doctorId}`).emit("queue-updated", {
          doctorId: appointment.doctorId,
          date,
        });
      }

      onAppointmentRescheduled(appointment as any).catch(console.error);
      auditLog(req, "RESCHEDULE_APPOINTMENT", "appointment", appointment.id, {
        oldDate: existing.date.toISOString().split("T")[0],
        oldSlotStart: existing.slotStart,
        newDate: date,
        newSlotStart: slotStart,
      }).catch(console.error);

      res.json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/appointments/recurring — create N appointments on a schedule
router.post(
  "/recurring",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(recurringAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, doctorId, startDate, slotStart, frequency, occurrences, notes } =
        req.body as {
          patientId: string;
          doctorId: string;
          startDate: string;
          slotStart: string;
          frequency: "DAILY" | "WEEKLY" | "MONTHLY";
          occurrences: number;
          notes?: string;
        };

      // Build the target dates
      const dates: Date[] = [];
      const base = new Date(startDate);
      base.setHours(0, 0, 0, 0);
      for (let i = 0; i < occurrences; i++) {
        const d = new Date(base);
        if (frequency === "DAILY") {
          d.setDate(base.getDate() + i);
        } else if (frequency === "WEEKLY") {
          d.setDate(base.getDate() + i * 7);
        } else {
          d.setMonth(base.getMonth() + i);
        }
        dates.push(d);
      }

      // Check that none of the slots conflict
      const conflicts = await prisma.appointment.findMany({
        where: {
          doctorId,
          slotStart,
          date: { in: dates },
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        },
        select: { date: true },
      });

      if (conflicts.length > 0) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Slot conflicts on: ${conflicts
            .map((c) => c.date.toISOString().split("T")[0])
            .join(", ")}`,
        });
        return;
      }

      // Single transaction — compute token numbers sequentially
      const created = await prisma.$transaction(async (tx) => {
        const results = [];
        for (const d of dates) {
          const last = await tx.appointment.findFirst({
            where: { doctorId, date: d },
            orderBy: { tokenNumber: "desc" },
          });
          const tokenNumber = (last?.tokenNumber ?? 0) + 1;

          const apt = await tx.appointment.create({
            data: {
              patientId,
              doctorId,
              date: d,
              slotStart,
              tokenNumber,
              type: "SCHEDULED",
              status: "BOOKED",
              notes,
            },
            include: {
              patient: {
                include: { user: { select: { name: true, phone: true } } },
              },
              doctor: {
                include: { user: { select: { name: true } } },
              },
            },
          });
          results.push(apt);
        }
        return results;
      });

      // Fire-and-forget notifications for each
      for (const apt of created) {
        onAppointmentBooked(apt as any).catch(console.error);
      }

      auditLog(req, "CREATE_RECURRING_APPOINTMENTS", "appointment", undefined, {
        patientId,
        doctorId,
        startDate,
        slotStart,
        frequency,
        occurrences,
        count: created.length,
      }).catch(console.error);

      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/calendar — calendar-optimized list
router.get(
  "/calendar",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { doctorId, from, to } = req.query;

      const where: Record<string, unknown> = {};
      if (doctorId) where.doctorId = doctorId;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from as string);
        if (to) range.lte = new Date(to as string);
        where.date = range;
      }

      // Patients only see their own
      if (req.user!.role === "PATIENT") {
        const patient = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
        });
        if (patient) where.patientId = patient.id;
      }

      const appointments = await prisma.appointment.findMany({
        where,
        include: {
          patient: { include: { user: { select: { name: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
        orderBy: [{ date: "asc" }, { slotStart: "asc" }],
      });

      const data = appointments.map((a) => {
        const dateStr = a.date.toISOString().split("T")[0];
        const start = a.slotStart ?? "00:00";
        const [sh, sm] = start.split(":").map((n) => parseInt(n, 10));
        const startDt = new Date(`${dateStr}T${start}:00.000Z`);
        const endDt = new Date(startDt.getTime() + 15 * 60 * 1000);
        const endH = String(endDt.getUTCHours()).padStart(2, "0");
        const endM = String(endDt.getUTCMinutes()).padStart(2, "0");
        void sh;
        void sm;
        return {
          id: a.id,
          patientName: a.patient.user.name,
          doctorId: a.doctorId,
          doctorName: a.doctor.user.name,
          startDateTime: `${dateStr}T${start}:00.000Z`,
          endDateTime: `${dateStr}T${endH}:${endM}:00.000Z`,
          status: a.status,
          tokenNumber: a.tokenNumber,
          type: a.type,
          priority: a.priority,
        };
      });

      res.json({ success: true, data, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/no-shows — list missed appointments
router.get(
  "/no-shows",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to, doctorId } = req.query;
      const where: Record<string, unknown> = { status: "NO_SHOW" };
      if (doctorId) where.doctorId = doctorId;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from as string);
        if (to) range.lte = new Date(to as string);
        where.date = range;
      } else {
        // default: last 30 days
        const thirtyAgo = new Date();
        thirtyAgo.setDate(thirtyAgo.getDate() - 30);
        where.date = { gte: thirtyAgo };
      }

      const noShows = await prisma.appointment.findMany({
        where,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: { include: { user: { select: { name: true } } } },
        },
        orderBy: { date: "desc" },
        take: 500,
      });

      res.json({ success: true, data: noShows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/check-conflict?patientId=&date=&slotStart=
// Detects double-booking of same patient at same time across doctors
router.get(
  "/check-conflict",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, date, slotStart, excludeId } = req.query;
      if (!patientId || !date || !slotStart) {
        res.status(400).json({
          success: false,
          data: null,
          error: "patientId, date, slotStart are required",
        });
        return;
      }
      const conflicts = await prisma.appointment.findMany({
        where: {
          patientId: patientId as string,
          date: new Date(date as string),
          slotStart: slotStart as string,
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
          ...(excludeId ? { id: { not: excludeId as string } } : {}),
        },
        include: {
          doctor: { include: { user: { select: { name: true } } } },
        },
      });
      res.json({
        success: true,
        data: { hasConflict: conflicts.length > 0, conflicts },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/stats — aggregate statistics
router.get(
  "/stats",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to, doctorId } = req.query;

      const where: Record<string, unknown> = {};
      if (doctorId) where.doctorId = doctorId;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from as string);
        if (to) range.lte = new Date(to as string);
        where.date = range;
      }

      const appointments = await prisma.appointment.findMany({
        where,
        select: {
          id: true,
          status: true,
          slotStart: true,
          date: true,
          doctorId: true,
          checkInAt: true,
          consultationStartedAt: true,
          consultationEndedAt: true,
        },
      });

      const totalCount = appointments.length;
      const byStatus: Record<string, number> = {
        BOOKED: 0,
        CHECKED_IN: 0,
        IN_CONSULTATION: 0,
        COMPLETED: 0,
        CANCELLED: 0,
        NO_SHOW: 0,
      };
      const hourBuckets: Record<number, number> = {};
      let waitSumMin = 0;
      let waitCount = 0;
      let consSumMin = 0;
      let consCount = 0;

      for (const a of appointments) {
        byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
        if (a.slotStart) {
          const h = parseInt(a.slotStart.split(":")[0], 10);
          if (!isNaN(h)) hourBuckets[h] = (hourBuckets[h] ?? 0) + 1;
        }
        if (a.checkInAt && a.consultationStartedAt) {
          const diff =
            (a.consultationStartedAt.getTime() - a.checkInAt.getTime()) / 60000;
          if (diff >= 0 && diff < 480) {
            waitSumMin += diff;
            waitCount += 1;
          }
        }
        if (a.consultationStartedAt && a.consultationEndedAt) {
          const diff =
            (a.consultationEndedAt.getTime() - a.consultationStartedAt.getTime()) /
            60000;
          if (diff >= 0 && diff < 240) {
            consSumMin += diff;
            consCount += 1;
          }
        }
      }

      let peakHour: number | null = null;
      let peakCount = -1;
      for (const [h, c] of Object.entries(hourBuckets)) {
        if (c > peakCount) {
          peakCount = c;
          peakHour = parseInt(h, 10);
        }
      }

      res.json({
        success: true,
        data: {
          totalCount,
          byStatus,
          completedCount: byStatus.COMPLETED,
          cancelledCount: byStatus.CANCELLED,
          noShowCount: byStatus.NO_SHOW,
          avgWaitTimeMin:
            waitCount > 0 ? Math.round((waitSumMin / waitCount) * 10) / 10 : null,
          avgConsultationTimeMin:
            consCount > 0 ? Math.round((consSumMin / consCount) * 10) / 10 : 15,
          peakHour,
          peakHourCount: peakCount >= 0 ? peakCount : 0,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/:id
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true, email: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
          vitals: true,
          consultation: true,
          prescription: { include: { items: true } },
          invoice: { include: { items: true, payments: true } },
        },
      });

      if (!appointment) {
        res.status(404).json({ success: false, data: null, error: "Appointment not found" });
        return;
      }

      res.json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as appointmentRouter };
