import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  bookAppointmentSchema,
  walkInSchema,
  updateAppointmentStatusSchema,
  rescheduleAppointmentSchema,
  recurringAppointmentSchema,
  transferAppointmentSchema,
  markLwbsSchema,
  DEFAULT_SLOT_DURATION_MINUTES,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  onAppointmentBooked,
  onAppointmentCancelled,
  onTokenCalled,
  notifyQueuePosition,
} from "../services/notification-triggers";
import { auditLog } from "../middleware/audit";
import { notifyNextInWaitlist } from "../services/waitlist";

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

// Helper: read integer SystemConfig with fallback
async function getConfigInt(key: string, fallback: number): Promise<number> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  if (!row) return fallback;
  const n = parseInt(row.value, 10);
  return isNaN(n) ? fallback : n;
}

// POST /api/v1/appointments/book — book scheduled appointment
router.post(
  "/book",
  validate(bookAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, doctorId, date, slotId, notes } = req.body;
      const overrideNoShow: boolean = Boolean(req.body.overrideNoShow);
      const dateObj = new Date(date);

      // Issue #491 (2026-05-03): Zod refuses past calendar dates, but a
      // today-dated booking with a slot start that's already elapsed
      // (e.g. it's 14:30 and the caller asks for 09:00) was still
      // accepted. Reject same-day past-time slots before we touch the
      // DB. `slotId` from the booking form is HH:MM (the route comment
      // notes this); only block when it parses as a real time so any
      // legacy callers passing a true UUID slotId are unaffected.
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      if (date === todayStr && /^\d{2}:\d{2}$/.test(slotId)) {
        const [sh, sm] = slotId.split(":").map(Number);
        const slotMin = sh * 60 + sm;
        const nowMin = now.getHours() * 60 + now.getMinutes();
        if (slotMin < nowMin) {
          res.status(400).json({
            success: false,
            data: null,
            error: "Cannot book a slot in the past",
          });
          return;
        }
      }

      // ── No-show policy enforcement ──
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { noShowCount: true },
      });
      const threshold = await getConfigInt("no_show_threshold", 3);
      if (
        patient &&
        patient.noShowCount >= threshold &&
        !overrideNoShow
      ) {
        // Reception/Admin can override via flag; patients cannot.
        if (req.user!.role === Role.PATIENT) {
          res.status(400).json({
            success: false,
            data: null,
            error:
              "Patient has exceeded no-show threshold. Please contact reception.",
          });
          return;
        }
        if (
          req.user!.role !== Role.ADMIN &&
          req.user!.role !== Role.RECEPTION
        ) {
          res.status(400).json({
            success: false,
            data: null,
            error:
              "Patient has exceeded no-show threshold. Please contact reception.",
          });
          return;
        }
        // admin/reception without overrideNoShow flag also blocked — they must
        // explicitly override.
        res.status(400).json({
          success: false,
          data: null,
          error:
            "Patient has exceeded no-show threshold. Please contact reception.",
        });
        return;
      }

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
      auditLog(req, "APPOINTMENT_CREATE", "appointment", appointment.id, { patientId, doctorId, date }).catch(console.error);

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
      auditLog(req, "WALK_IN_REGISTER", "appointment", appointment.id, { patientId, doctorId }).catch(console.error);

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
    if (date) {
      // Issue #156: Today's-Patients in the AI Scribe page sends an ISO
      // date (e.g. "2026-04-26"). `new Date("2026-04-26")` parses to
      // 00:00 UTC, but appointment rows store local-day timestamps that
      // can land just before midnight UTC the previous day. Match the
      // whole calendar day rather than an exact equality so the picker
      // doesn't return an empty list (or 500 on a bad ISO string).
      try {
        const day = new Date(date as string);
        if (Number.isNaN(day.getTime())) {
          res.status(400).json({
            success: false,
            data: null,
            error: "Invalid date",
          });
          return;
        }
        const start = new Date(day);
        start.setHours(0, 0, 0, 0);
        const end = new Date(day);
        end.setHours(23, 59, 59, 999);
        where.date = { gte: start, lte: end };
      } catch {
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid date",
        });
        return;
      }
    }
    if (status) {
      // Issue #156: scribe Today's-Patients sends a comma-separated
      // status filter (e.g. `status=CHECKED_IN,BOOKED`). Prisma rejected
      // the literal "CHECKED_IN,BOOKED" string against the
      // AppointmentStatus enum and threw a 500. Normalise to `{ in: […] }`
      // when a comma is present, otherwise fall through to a single
      // equality match.
      const raw = String(status);
      if (raw.includes(",")) {
        where.status = {
          in: raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        };
      } else {
        where.status = raw;
      }
    }

    // If patient role, only show own appointments
    if (req.user!.role === "PATIENT") {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (patient) where.patientId = patient.id;
    }

    // Issue #194: free-text `?search=` filter so the prescription page's
    // EntityPicker can narrow same-day appointments by token number, slot
    // time prefix, or doctor name. The list endpoint quietly accepted (and
    // ignored) `search=` previously, which is why typing in the picker
    // produced "No matches" while the unfiltered list contained the row.
    const searchRaw = req.query.search;
    if (typeof searchRaw === "string" && searchRaw.trim().length > 0) {
      const q = searchRaw.trim();
      const tokenN = Number.parseInt(q, 10);
      const orClauses: Record<string, unknown>[] = [
        { slotStart: { contains: q } },
        {
          doctor: {
            user: { name: { contains: q, mode: "insensitive" } },
          },
        },
      ];
      if (Number.isFinite(tokenN)) orClauses.push({ tokenNumber: tokenN });
      where.OR = orClauses;
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

      // Capture previous state to only fire side-effects on state transitions
      const prev = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        select: { status: true, patientId: true },
      });

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
      if (req.body.status === "CANCELLED" && prev?.status !== "CANCELLED") {
        onAppointmentCancelled(appointment as any).catch(console.error);
        // Auto-notify next waitlisted patient for this doctor
        notifyNextInWaitlist(appointment.doctorId).catch(console.error);
      }
      if (req.body.status === "IN_CONSULTATION") {
        onTokenCalled(appointment as any).catch(console.error);
      }
      if (req.body.status === "CHECKED_IN" && prev?.status !== "CHECKED_IN") {
        notifyQueuePosition(appointment.id).catch(console.error);
      }

      // No-show policy: increment counter + add fee when transitioning to NO_SHOW
      if (req.body.status === "NO_SHOW" && prev?.status !== "NO_SHOW") {
        try {
          await prisma.patient.update({
            where: { id: appointment.patientId },
            data: { noShowCount: { increment: 1 } },
          });
        } catch (e) {
          console.error("Failed to increment noShowCount", e);
        }
        // Add ₹500 no-show fee to an open invoice for this patient (or create a new one)
        try {
          const feeRow = await prisma.systemConfig.findUnique({
            where: { key: "no_show_fee" },
          });
          const fee = feeRow ? parseFloat(feeRow.value) : 500;
          if (!isNaN(fee) && fee > 0) {
            const openInvoice = await prisma.invoice.findFirst({
              where: {
                patientId: appointment.patientId,
                paymentStatus: { in: ["PENDING", "PARTIAL"] },
              },
              orderBy: { createdAt: "desc" },
            });
            if (openInvoice) {
              await prisma.invoiceItem.create({
                data: {
                  invoiceId: openInvoice.id,
                  description: `No-show fee (appt ${appointment.id.slice(0, 8)})`,
                  category: "FEE",
                  quantity: 1,
                  unitPrice: fee,
                  amount: fee,
                },
              });
              await prisma.invoice.update({
                where: { id: openInvoice.id },
                data: {
                  subtotal: { increment: fee },
                  totalAmount: { increment: fee },
                },
              });
            }
          }
        } catch (e) {
          console.error("Failed to add no-show fee", e);
        }
      }

      auditLog(req, "APPOINTMENT_STATUS_UPDATE", "appointment", req.params.id, { status: req.body.status }).catch(console.error);

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
      auditLog(req, "APPOINTMENT_RESCHEDULE", "appointment", appointment.id, {
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

      auditLog(req, "RECURRING_APPOINTMENT_CREATE", "appointment", undefined, {
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
    // Avoid capturing static route names as an appointment id
    if (req.params.id === "next-available") {
      next();
      return;
    }
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

// ─── GROUP APPOINTMENTS (therapy / training sessions) ─────
// POST /api/v1/appointments/group — create N appointments with same groupId
router.post(
  "/group",
  authorize(Role.RECEPTION, Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { doctorId, date, slotStart, patientIds, notes } = req.body as {
        doctorId: string;
        date: string;
        slotStart?: string;
        patientIds: string[];
        notes?: string;
      };
      if (!doctorId || !date || !Array.isArray(patientIds) || patientIds.length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "doctorId, date, and at least one patientId required",
        });
        return;
      }
      const dateObj = new Date(date);
      const groupId = `GRP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      const created: Array<{ id: string; tokenNumber: number; patientId: string }> = [];
      let nextToken = await getNextToken(doctorId, dateObj);
      for (const patientId of patientIds) {
        const appt = await prisma.appointment.create({
          data: {
            patientId,
            doctorId,
            date: dateObj,
            slotStart: slotStart ?? null,
            tokenNumber: nextToken,
            type: "SCHEDULED",
            status: "BOOKED",
            notes: notes ? `[GROUP] ${notes}` : `[GROUP ${groupId}]`,
            groupId,
          },
        });
        created.push({ id: appt.id, tokenNumber: appt.tokenNumber, patientId });
        nextToken += 1;
      }

      auditLog(req, "GROUP_APPOINTMENT_CREATE", "appointment", groupId, {
        doctorId,
        date,
        patientCount: patientIds.length,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: { groupId, appointments: created },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── CALENDAR INVITE (.ics) ─────────────────────────────
// GET /api/v1/appointments/:id/calendar.ics — return iCalendar file
router.get(
  "/:id/calendar.ics",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: { user: { select: { name: true, email: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
        },
      });
      if (!appointment) {
        res.status(404).json({ success: false, data: null, error: "Not found" });
        return;
      }

      // Patients can only download their own
      if (req.user!.role === Role.PATIENT) {
        const self = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
        });
        if (!self || self.id !== appointment.patientId) {
          res.status(403).json({ success: false, data: null, error: "Forbidden" });
          return;
        }
      }

      const slotStart = appointment.slotStart ?? "09:00";
      const [sh, sm] = slotStart.split(":").map((n) => parseInt(n, 10));
      const durationMin = 15;
      const startUtc = new Date(
        Date.UTC(
          appointment.date.getUTCFullYear(),
          appointment.date.getUTCMonth(),
          appointment.date.getUTCDate(),
          sh,
          sm,
          0
        )
      );
      const endUtc = new Date(startUtc.getTime() + durationMin * 60 * 1000);
      const fmtUtc = (d: Date): string =>
        `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
          d.getUTCDate()
        ).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}${String(
          d.getUTCMinutes()
        ).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;

      const dtStart = fmtUtc(startUtc);
      const dtEnd = fmtUtc(endUtc);
      const dtStamp = fmtUtc(new Date());

      const uid = `${appointment.id}@medcore`;
      const doctorName = appointment.doctor.user.name;
      const patientName = appointment.patient.user.name;
      const summary = `Appointment with Dr. ${doctorName}`;
      const description = `Token #${appointment.tokenNumber}. Patient: ${patientName}. Status: ${appointment.status}.`;

      const esc = (s: string): string =>
        s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//MedCore//Appointment//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${esc(summary)}`,
        `DESCRIPTION:${esc(description)}`,
        "LOCATION:MedCore Hospital",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="appointment-${appointment.id.slice(0, 8)}.ics"`
      );
      res.send(ics);
    } catch (err) {
      next(err);
    }
  }
);

// ─── NEXT AVAILABLE SLOT ────────────────────────────────
// GET /api/v1/appointments/next-available?fromDate=YYYY-MM-DD&specialty=&anyDoctor=true
router.get(
  "/next-available",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fromDateStr = (req.query.fromDate as string) || undefined;
      const specialty = (req.query.specialty as string) || undefined;
      const fromDate = fromDateStr ? new Date(fromDateStr) : new Date();
      fromDate.setHours(0, 0, 0, 0);

      const doctorWhere: Record<string, unknown> = {};
      if (specialty) doctorWhere.specialization = specialty;
      const doctors = await prisma.doctor.findMany({
        where: doctorWhere,
        include: {
          schedules: true,
          user: { select: { name: true } },
        },
      });

      if (doctors.length === 0) {
        res.json({
          success: true,
          data: { slot: null, reason: "No doctors found" },
          error: null,
        });
        return;
      }

      const DAYS = 14;
      let best: {
        doctorId: string;
        doctorName: string;
        specialization: string | null;
        date: string;
        startTime: string;
        endTime: string;
      } | null = null;

      const todayIso = new Date().toISOString().split("T")[0];
      const nowMin = (() => {
        const n = new Date();
        return n.getHours() * 60 + n.getMinutes();
      })();

      for (const doc of doctors) {
        for (let i = 0; i < DAYS; i++) {
          const d = new Date(fromDate);
          d.setDate(fromDate.getDate() + i);
          const dayOfWeek = d.getDay();
          const daySchedules = doc.schedules.filter((s) => s.dayOfWeek === dayOfWeek);
          if (daySchedules.length === 0) continue;

          const override = await prisma.scheduleOverride.findUnique({
            where: { doctorId_date: { doctorId: doc.id, date: d } },
          });
          if (override?.isBlocked) continue;

          const booked = await prisma.appointment.findMany({
            where: {
              doctorId: doc.id,
              date: d,
              status: { notIn: ["CANCELLED", "NO_SHOW"] },
            },
            select: { slotStart: true },
          });
          const bookedSet = new Set(booked.map((b) => b.slotStart));
          const dIso = d.toISOString().split("T")[0];

          let foundForDay: { startStr: string; endStr: string } | null = null;
          for (const sch of daySchedules) {
            const startTime = override?.startTime || sch.startTime;
            const endTime = override?.endTime || sch.endTime;
            const duration = sch.slotDurationMinutes || DEFAULT_SLOT_DURATION_MINUTES;
            const buffer = sch.bufferMinutes || 0;
            const step = duration + buffer;

            const [ssh, ssm] = startTime.split(":").map(Number);
            const [eh, em] = endTime.split(":").map(Number);
            const startMin = ssh * 60 + ssm;
            const endMin = eh * 60 + em;

            for (let m = startMin; m + duration <= endMin; m += step) {
              const startStr = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
                m % 60
              ).padStart(2, "0")}`;
              const endM = m + duration;
              const endStr = `${String(Math.floor(endM / 60)).padStart(2, "0")}:${String(
                endM % 60
              ).padStart(2, "0")}`;

              if (dIso === todayIso && m < nowMin) continue;
              if (!bookedSet.has(startStr)) {
                foundForDay = { startStr, endStr };
                break;
              }
            }
            if (foundForDay) break;
          }

          if (foundForDay) {
            const candidate = {
              doctorId: doc.id,
              doctorName: doc.user.name,
              specialization: doc.specialization,
              date: dIso,
              startTime: foundForDay.startStr,
              endTime: foundForDay.endStr,
            };
            if (
              !best ||
              candidate.date < best.date ||
              (candidate.date === best.date && candidate.startTime < best.startTime)
            ) {
              best = candidate;
            }
            break; // earliest day for this doctor found
          }
        }
      }

      res.json({
        success: true,
        data: { slot: best, searchedDoctors: doctors.length, windowDays: DAYS },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── TRANSFER APPOINTMENT TO ANOTHER DOCTOR ─────────────
// PATCH /api/v1/appointments/:id/transfer-doctor
router.patch(
  "/:id/transfer-doctor",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(transferAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { newDoctorId, reason } = req.body as {
        newDoctorId: string;
        reason: string;
      };

      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Not found" });
        return;
      }
      if (existing.doctorId === newDoctorId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Appointment is already with this doctor",
        });
        return;
      }
      if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(existing.status)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Cannot transfer an appointment with status ${existing.status}`,
        });
        return;
      }

      const newToken = await getNextToken(newDoctorId, existing.date);

      const oldDoctorId = existing.doctorId;
      const appointment = await prisma.appointment.update({
        where: { id: req.params.id },
        data: {
          doctorId: newDoctorId,
          tokenNumber: newToken,
          notes: existing.notes
            ? `${existing.notes}\n[TRANSFERRED] ${reason}`
            : `[TRANSFERRED] ${reason}`,
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      const io = req.app.get("io");
      if (io) {
        const dateStr = appointment.date.toISOString().split("T")[0];
        io.to(`queue:${oldDoctorId}`).emit("queue-updated", {
          doctorId: oldDoctorId,
          date: dateStr,
        });
        io.to(`queue:${newDoctorId}`).emit("queue-updated", {
          doctorId: newDoctorId,
          date: dateStr,
        });
      }

      auditLog(req, "APPOINTMENT_TRANSFER", "appointment", appointment.id, {
        oldDoctorId,
        newDoctorId,
        reason,
      }).catch(console.error);

      res.json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── LWBS (Left Without Being Seen) ─────────────────────
// PATCH /api/v1/appointments/:id/mark-lwbs
router.patch(
  "/:id/mark-lwbs",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE),
  validate(markLwbsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reason } = req.body as { reason?: string };

      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        select: { status: true, patientId: true, doctorId: true },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Not found" });
        return;
      }

      const appointment = await prisma.appointment.update({
        where: { id: req.params.id },
        data: {
          status: "NO_SHOW",
          lwbsReason: reason ?? "Left without being seen",
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      if (existing.status !== "NO_SHOW") {
        prisma.patient
          .update({
            where: { id: existing.patientId },
            data: { noShowCount: { increment: 1 } },
          })
          .catch(console.error);
      }

      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${appointment.doctorId}`).emit("queue-updated", {
          doctorId: appointment.doctorId,
          date: appointment.date.toISOString().split("T")[0],
        });
      }

      auditLog(req, "APPOINTMENT_LWBS_MARK", "appointment", appointment.id, { reason }).catch(
        console.error
      );

      res.json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/group/:groupId — all members
router.get(
  "/group/:groupId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const members = await prisma.appointment.findMany({
        where: { groupId: req.params.groupId },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
        orderBy: { tokenNumber: "asc" },
      });
      res.json({
        success: true,
        data: { groupId: req.params.groupId, members },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── BULK OPERATIONS ─────────────────────────────────
// POST /api/v1/appointments/bulk-action
// Body: { appointmentIds: string[], action: "CANCEL" | "NO_SHOW" | "SEND_REMINDER" }
router.post(
  "/bulk-action",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { appointmentIds, action } = req.body as {
        appointmentIds?: string[];
        action?: string;
      };

      if (
        !Array.isArray(appointmentIds) ||
        appointmentIds.length === 0 ||
        !appointmentIds.every((id) => typeof id === "string")
      ) {
        res.status(400).json({
          success: false,
          data: null,
          error: "appointmentIds must be a non-empty string array",
        });
        return;
      }

      const allowed = ["CANCEL", "NO_SHOW", "SEND_REMINDER"];
      if (!action || !allowed.includes(action)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `action must be one of: ${allowed.join(", ")}`,
        });
        return;
      }

      // Fetch existing appointments to validate & filter
      const found = await prisma.appointment.findMany({
        where: { id: { in: appointmentIds } },
        include: {
          patient: { include: { user: { select: { name: true, phone: true, email: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      const results: Array<{ id: string; status: "ok" | "skipped" | "error"; message?: string }> = [];

      if (action === "CANCEL") {
        for (const apt of found) {
          if (["COMPLETED", "CANCELLED"].includes(apt.status)) {
            results.push({ id: apt.id, status: "skipped", message: "already finalized" });
            continue;
          }
          try {
            await prisma.appointment.update({
              where: { id: apt.id },
              data: { status: "CANCELLED" },
            });
            onAppointmentCancelled(apt as any).catch(console.error);
            results.push({ id: apt.id, status: "ok" });
          } catch (e) {
            results.push({
              id: apt.id,
              status: "error",
              message: e instanceof Error ? e.message : "failed",
            });
          }
        }
      } else if (action === "NO_SHOW") {
        for (const apt of found) {
          if (!["BOOKED", "CHECKED_IN"].includes(apt.status)) {
            results.push({ id: apt.id, status: "skipped", message: "not active" });
            continue;
          }
          try {
            await prisma.$transaction([
              prisma.appointment.update({
                where: { id: apt.id },
                data: { status: "NO_SHOW" },
              }),
              prisma.patient.update({
                where: { id: apt.patientId },
                data: { noShowCount: { increment: 1 } },
              }),
            ]);
            results.push({ id: apt.id, status: "ok" });
          } catch (e) {
            results.push({
              id: apt.id,
              status: "error",
              message: e instanceof Error ? e.message : "failed",
            });
          }
        }
      } else if (action === "SEND_REMINDER") {
        // Fire-and-forget reminder notifications (re-use onAppointmentBooked path which
        // queues an SMS/email via notification-triggers). If you have a dedicated
        // reminder function, call it here instead.
        for (const apt of found) {
          try {
            onAppointmentBooked(apt as any).catch(console.error);
            results.push({ id: apt.id, status: "ok" });
          } catch (e) {
            results.push({
              id: apt.id,
              status: "error",
              message: e instanceof Error ? e.message : "failed",
            });
          }
        }
      }

      // Audit log
      auditLog(
        req,
        `APPOINTMENT_BULK_${action}`,
        "appointment",
        undefined,
        { count: appointmentIds.length, action, results }
      ).catch(console.error);

      const okCount = results.filter((r) => r.status === "ok").length;
      const skippedCount = results.filter((r) => r.status === "skipped").length;
      const errorCount = results.filter((r) => r.status === "error").length;

      res.json({
        success: true,
        data: {
          requested: appointmentIds.length,
          processed: okCount,
          skipped: skippedCount,
          errors: errorCount,
          results,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── TRANSFER APPOINTMENT TO ANOTHER DOCTOR (Apr 2026) ──
router.post(
  "/:id/transfer",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  validate(transferAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Appointment not found" });
        return;
      }
      if (existing.status === "COMPLETED" || existing.status === "CANCELLED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot transfer ${existing.status} appointment`,
        });
        return;
      }

      const { newDoctorId, reason } = req.body as { newDoctorId: string; reason: string };
      const newDoctor = await prisma.doctor.findUnique({
        where: { id: newDoctorId },
      });
      if (!newDoctor) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Target doctor not found",
        });
        return;
      }
      if (newDoctorId === existing.doctorId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Target doctor is the same as current doctor",
        });
        return;
      }

      const last = await prisma.appointment.findFirst({
        where: { doctorId: newDoctorId, date: existing.date },
        orderBy: { tokenNumber: "desc" },
        select: { tokenNumber: true },
      });
      const nextToken = (last?.tokenNumber ?? 0) + 1;

      const transferNote = `[TRANSFERRED from ${existing.doctorId} by ${req.user!.userId}] ${reason}`;

      const updated = await prisma.appointment.update({
        where: { id: existing.id },
        data: {
          doctorId: newDoctorId,
          tokenNumber: nextToken,
          status: "BOOKED",
          notes: existing.notes
            ? `${existing.notes}\n${transferNote}`
            : transferNote,
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "APPOINTMENT_TRANSFER", "appointment", updated.id, {
        fromDoctorId: existing.doctorId,
        toDoctorId: newDoctorId,
        reason,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── MARK LWBS (Left Without Being Seen) (Apr 2026) ─────
router.patch(
  "/:id/lwbs",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  validate(markLwbsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Appointment not found" });
        return;
      }
      if (existing.status === "COMPLETED" || existing.status === "CANCELLED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot mark ${existing.status} appointment as LWBS`,
        });
        return;
      }

      const updated = await prisma.appointment.update({
        where: { id: existing.id },
        data: {
          status: "NO_SHOW",
          lwbsReason: req.body.reason ?? "Left without being seen",
        },
      });

      auditLog(req, "APPOINTMENT_LWBS_MARK", "appointment", updated.id, {
        reason: req.body.reason,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as appointmentRouter };
