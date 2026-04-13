import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  bookAppointmentSchema,
  walkInSchema,
  updateAppointmentStatusSchema,
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
      const appointment = await prisma.appointment.update({
        where: { id: req.params.id },
        data: { status: req.body.status },
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
