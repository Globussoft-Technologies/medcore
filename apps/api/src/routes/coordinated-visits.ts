import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role, coordinatedVisitSchema, DEFAULT_SLOT_DURATION_MINUTES } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { auditLog } from "../middleware/audit";
import { onAppointmentBooked, onAppointmentCancelled } from "../services/notification-triggers";

const router = Router();
router.use(authenticate);

interface SlotInfo {
  startTime: string;
  endTime: string;
}

// Helper: compute available slots for a doctor on a date (honours schedule + overrides + buffer)
async function computeAvailableSlots(doctorId: string, date: Date): Promise<SlotInfo[]> {
  const dayOfWeek = date.getDay();
  const override = await prisma.scheduleOverride.findUnique({
    where: { doctorId_date: { doctorId, date } },
  });
  if (override?.isBlocked) return [];

  const schedules = await prisma.doctorSchedule.findMany({
    where: { doctorId, dayOfWeek },
  });
  if (schedules.length === 0) return [];

  const existing = await prisma.appointment.findMany({
    where: {
      doctorId,
      date,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
    },
    select: { slotStart: true },
  });
  const booked = new Set(existing.map((a) => a.slotStart));

  const slots: SlotInfo[] = [];
  for (const s of schedules) {
    const startTime = override?.startTime || s.startTime;
    const endTime = override?.endTime || s.endTime;
    const duration = s.slotDurationMinutes || DEFAULT_SLOT_DURATION_MINUTES;
    const buffer = s.bufferMinutes || 0;
    const step = duration + buffer;

    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;

    for (let m = startMin; m + duration <= endMin; m += step) {
      const startStr = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
        m % 60
      ).padStart(2, "0")}`;
      const endM = m + duration;
      const endStr = `${String(Math.floor(endM / 60)).padStart(2, "0")}:${String(
        endM % 60
      ).padStart(2, "0")}`;
      if (!booked.has(startStr)) {
        slots.push({ startTime: startStr, endTime: endStr });
      }
    }
  }
  // Sort ascending by startTime
  slots.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return slots;
}

// POST /api/v1/coordinated-visits — create a visit + back-to-back appointments
// #511 audit: STAFF-ONLY — authorize() excludes Role.PATIENT, so a patient
// cannot self-create a coordinated visit on someone else's behalf.
router.post(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  validate(coordinatedVisitSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, name, visitDate, doctorIds } = req.body as {
        patientId: string;
        name: string;
        visitDate: string;
        doctorIds: string[];
        notes?: string;
      };

      const dateObj = new Date(visitDate);
      dateObj.setHours(0, 0, 0, 0);

      // For each doctor, compute earliest available slot that is AFTER the
      // previous doctor's slot (so they're back-to-back).
      const plan: Array<{ doctorId: string; startTime: string; endTime: string }> = [];
      let minStartTime = "00:00";
      for (const doctorId of doctorIds) {
        const slots = await computeAvailableSlots(doctorId, dateObj);
        const pick = slots.find((s) => s.startTime >= minStartTime);
        if (!pick) {
          res.status(409).json({
            success: false,
            data: null,
            error: `No available slot for doctor ${doctorId} on ${visitDate} after ${minStartTime}`,
          });
          return;
        }
        plan.push({ doctorId, ...pick });
        minStartTime = pick.endTime;
      }

      // Create the visit + appointments in one transaction
      const result = await prisma.$transaction(async (tx) => {
        const visit = await tx.coordinatedVisit.create({
          data: {
            patientId,
            name,
            visitDate: dateObj,
            createdBy: req.user!.userId,
          },
        });

        const appts = [];
        for (const p of plan) {
          const last = await tx.appointment.findFirst({
            where: { doctorId: p.doctorId, date: dateObj },
            orderBy: { tokenNumber: "desc" },
          });
          const tokenNumber = (last?.tokenNumber ?? 0) + 1;

          const appt = await tx.appointment.create({
            data: {
              patientId,
              doctorId: p.doctorId,
              date: dateObj,
              slotStart: p.startTime,
              slotEnd: p.endTime,
              tokenNumber,
              type: "SCHEDULED",
              status: "BOOKED",
              coordinatedVisitId: visit.id,
              notes: `[COORDINATED] ${name}`,
            },
            include: {
              patient: { include: { user: { select: { name: true, phone: true } } } },
              doctor: { include: { user: { select: { name: true } } } },
            },
          });
          appts.push(appt);
        }

        return { visit, appointments: appts };
      });

      // Fire-and-forget notifications for each appointment
      for (const a of result.appointments) {
        onAppointmentBooked(a as unknown as Parameters<typeof onAppointmentBooked>[0]).catch(
          console.error
        );
      }

      auditLog(req, "COORDINATED_VISIT_CREATE", "coordinatedVisit", result.visit.id, {
        patientId,
        visitDate,
        doctorCount: doctorIds.length,
      }).catch(console.error);

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/coordinated-visits — list (filter by patientId)
// #511 audit: VERIFIED-SAFE — for PATIENT callers the where-clause is
// force-overridden to their own patient.id, so any ?patientId=<other>
// query param they pass is ignored. Staff roles see filtered or all rows
// per the query.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { patientId } = req.query;
    const where: Record<string, unknown> = {};
    if (patientId) where.patientId = patientId;

    // Patients only see their own
    if (req.user!.role === Role.PATIENT) {
      const self = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (self) where.patientId = self.id;
    }

    const visits = await prisma.coordinatedVisit.findMany({
      where,
      include: {
        patient: { include: { user: { select: { name: true, phone: true } } } },
        appointments: {
          include: { doctor: { include: { user: { select: { name: true } } } } },
          orderBy: { slotStart: "asc" },
        },
      },
      orderBy: { visitDate: "desc" },
      take: 200,
    });

    res.json({ success: true, data: visits, error: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/coordinated-visits/:id
// #511 BOLA fix: previously any authenticated PATIENT could fetch any
// coordinated-visit row by UUID. CoordinatedVisit has a single `patientId`
// (one patient seeing multiple doctors back-to-back — not a multi-patient
// group), so strict patient-self ownership is the correct contract.
// Staff roles are unaffected (assertPatientOwnsResource is a no-op for
// non-PATIENT callers).
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const visit = await prisma.coordinatedVisit.findUnique({
      where: { id: req.params.id },
      include: {
        patient: { include: { user: { select: { name: true, phone: true } } } },
        appointments: {
          include: { doctor: { include: { user: { select: { name: true } } } } },
          orderBy: { slotStart: "asc" },
        },
      },
    });
    if (!visit) {
      res
        .status(404)
        .json({ success: false, data: null, error: "Coordinated visit not found" });
      return;
    }
    if (!(await assertPatientOwnsResource(req, res, visit.patientId))) return;
    res.json({ success: true, data: visit, error: null });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/coordinated-visits/:id/cancel — cancel all member appointments
router.patch(
  "/:id/cancel",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const visit = await prisma.coordinatedVisit.findUnique({
        where: { id: req.params.id },
        include: {
          appointments: {
            include: {
              patient: { include: { user: { select: { name: true, phone: true, id: true } } } },
              doctor: { include: { user: { select: { name: true, id: true } } } },
            },
          },
        },
      });
      if (!visit) {
        res.status(404).json({ success: false, data: null, error: "Not found" });
        return;
      }

      // #511 audit: VERIFIED-SAFE — refactored hand-rolled inline check to
      // assertPatientOwnsResource for drift prevention. CoordinatedVisit has
      // a single owning patientId, so strict patient-self semantics apply
      // (cancelling a coordinated visit cancels all member appointments —
      // only the owning patient or staff may do so).
      if (!(await assertPatientOwnsResource(req, res, visit.patientId))) return;

      const toCancel = visit.appointments.filter(
        (a) => !["CANCELLED", "COMPLETED", "NO_SHOW"].includes(a.status)
      );

      await prisma.appointment.updateMany({
        where: { id: { in: toCancel.map((a) => a.id) } },
        data: { status: "CANCELLED" },
      });

      for (const a of toCancel) {
        onAppointmentCancelled(a as unknown as Parameters<typeof onAppointmentCancelled>[0]).catch(
          console.error
        );
      }

      auditLog(req, "COORDINATED_VISIT_CANCEL", "coordinatedVisit", visit.id, {
        cancelledAppointments: toCancel.length,
      }).catch(console.error);

      res.json({
        success: true,
        data: { id: visit.id, cancelled: toCancel.length },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as coordinatedVisitRouter };
