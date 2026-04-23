import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  medicationOrderSchema,
  updateMedicationOrderSchema,
  administerMedicationSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// Map frequency string to doses per day + interval hours
function parseFrequency(freqRaw: string): { dosesPerDay: number; intervalHours: number } {
  const f = freqRaw.toLowerCase().trim();

  // "every N hours"
  const everyM = f.match(/every\s+(\d+)\s*h(?:our)?s?/);
  if (everyM) {
    const h = parseInt(everyM[1], 10);
    if (h > 0 && h <= 24) {
      return { dosesPerDay: Math.max(1, Math.floor(24 / h)), intervalHours: h };
    }
  }

  // Common abbreviations
  if (/\bqid\b|4\s*times|four\s*times/.test(f)) return { dosesPerDay: 4, intervalHours: 6 };
  if (/\btid\b|3\s*times|three\s*times/.test(f)) return { dosesPerDay: 3, intervalHours: 8 };
  if (/\bbid\b|2\s*times|two\s*times|twice/.test(f)) return { dosesPerDay: 2, intervalHours: 12 };
  if (/\bqd\b|\bod\b|once\s*daily|once\s*a\s*day|daily/.test(f)) return { dosesPerDay: 1, intervalHours: 24 };
  if (/\bqhs\b|at\s*bedtime|at\s*night/.test(f)) return { dosesPerDay: 1, intervalHours: 24 };
  if (/sos|prn|as\s*needed/.test(f)) return { dosesPerDay: 0, intervalHours: 24 };

  // "1-0-1" / "1-1-1" pattern
  const pattern = f.match(/(\d)\s*-\s*(\d)\s*-\s*(\d)/);
  if (pattern) {
    const count = [pattern[1], pattern[2], pattern[3]].filter((x) => x !== "0").length;
    if (count > 0) return { dosesPerDay: count, intervalHours: Math.floor(24 / count) };
  }

  // Default: once daily
  return { dosesPerDay: 1, intervalHours: 24 };
}

// Generate scheduled MedicationAdministration rows for up to 7 days
function generateSchedule(
  startAt: Date,
  endAt: Date | null,
  intervalHours: number,
  dosesPerDay: number
): Date[] {
  if (dosesPerDay <= 0) return []; // PRN — no schedule
  const schedule: Date[] = [];
  const maxEnd = new Date(startAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const stop = endAt && endAt < maxEnd ? endAt : maxEnd;

  let t = new Date(startAt);
  while (t <= stop && schedule.length < 7 * dosesPerDay) {
    schedule.push(new Date(t));
    t = new Date(t.getTime() + intervalHours * 60 * 60 * 1000);
  }
  return schedule;
}

// POST /api/v1/medication/orders — create medication order
router.post(
  "/orders",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(medicationOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        admissionId,
        medicineId,
        medicineName,
        dosage,
        frequency,
        route,
        startDate,
        endDate,
        instructions,
      } = req.body;

      const admission = await prisma.admission.findUnique({ where: { id: admissionId } });
      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }
      if (admission.status !== "ADMITTED") {
        res.status(409).json({
          success: false,
          data: null,
          error: "Medication orders can only be added to active admissions",
        });
        return;
      }

      // doctorId — use the authenticated doctor if role is DOCTOR; else fall back to admission.doctorId
      let doctorId = admission.doctorId;
      if (req.user!.role === Role.DOCTOR) {
        const doc = await prisma.doctor.findUnique({ where: { userId: req.user!.userId } });
        if (doc) doctorId = doc.id;
      }

      const startAt = startDate ? new Date(startDate) : new Date();
      const endAt = endDate ? new Date(endDate) : null;
      const { dosesPerDay, intervalHours } = parseFrequency(frequency);
      const scheduleTimes = generateSchedule(startAt, endAt, intervalHours, dosesPerDay);

      const order = await prisma.$transaction(async (tx) => {
        const created = await tx.medicationOrder.create({
          data: {
            admissionId,
            doctorId,
            medicineId: medicineId ?? null,
            medicineName,
            dosage,
            frequency,
            route,
            startDate: startAt,
            endDate: endAt,
            instructions,
            isActive: true,
          },
        });
        if (scheduleTimes.length > 0) {
          await tx.medicationAdministration.createMany({
            data: scheduleTimes.map((t) => ({
              medicationOrderId: created.id,
              scheduledAt: t,
              status: "SCHEDULED" as const,
            })),
          });
        }
        return created;
      });

      const withAdmins = await prisma.medicationOrder.findUnique({
        where: { id: order.id },
        include: { administrations: { orderBy: { scheduledAt: "asc" } } },
      });

      auditLog(req, "MEDICATION_ORDER_CREATE", "medicationOrder", order.id, {
        admissionId,
        medicineName,
        dosage,
        frequency,
        scheduledDoses: scheduleTimes.length,
      }).catch(console.error);

      res.status(201).json({ success: true, data: withAdmins, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/medication/orders?admissionId=
router.get(
  "/orders",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { admissionId } = req.query;
      if (!admissionId) {
        res.status(400).json({ success: false, data: null, error: "admissionId is required" });
        return;
      }

      const orders = await prisma.medicationOrder.findMany({
        where: { admissionId: admissionId as string },
        include: {
          doctor: { include: { user: { select: { name: true } } } },
          administrations: { orderBy: { scheduledAt: "asc" } },
        },
        orderBy: { createdAt: "desc" },
      });

      res.json({ success: true, data: orders, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/medication/orders/:id — pause/resume / update
router.patch(
  "/orders/:id",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(updateMedicationOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = {};
      if (typeof req.body.isActive === "boolean") data.isActive = req.body.isActive;
      if (req.body.instructions !== undefined) data.instructions = req.body.instructions;
      if (req.body.endDate) data.endDate = new Date(req.body.endDate);

      const order = await prisma.medicationOrder.update({
        where: { id: req.params.id },
        data,
      });

      auditLog(req, "MEDICATION_ORDER_UPDATE", "medicationOrder", order.id, data).catch(console.error);
      res.json({ success: true, data: order, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/medication/administrations?admissionId=&date=
router.get(
  "/administrations",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { admissionId, date } = req.query;
      if (!admissionId) {
        res.status(400).json({ success: false, data: null, error: "admissionId is required" });
        return;
      }

      const where: Record<string, unknown> = {
        medicationOrder: { admissionId: admissionId as string },
      };

      if (date) {
        const start = new Date(date as string);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        where.scheduledAt = { gte: start, lt: end };
      }

      const admins = await prisma.medicationAdministration.findMany({
        where,
        include: {
          medicationOrder: {
            select: {
              id: true,
              medicineName: true,
              dosage: true,
              route: true,
              frequency: true,
            },
          },
          nurse: { select: { id: true, name: true } },
        },
        orderBy: { scheduledAt: "asc" },
      });

      res.json({ success: true, data: admins, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/medication/administrations/due — due in next 30 minutes
router.get(
  "/administrations/due",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { wardId } = req.query;
      const now = new Date();
      const in30 = new Date(now.getTime() + 30 * 60 * 1000);

      const where: Record<string, unknown> = {
        status: "SCHEDULED",
        scheduledAt: { gte: new Date(now.getTime() - 15 * 60 * 1000), lte: in30 },
      };

      if (wardId) {
        (where as any).medicationOrder = {
          admission: { bed: { wardId: wardId as string }, status: "ADMITTED" },
        };
      } else {
        (where as any).medicationOrder = { admission: { status: "ADMITTED" } };
      }

      const due = await prisma.medicationAdministration.findMany({
        where,
        include: {
          medicationOrder: {
            include: {
              admission: {
                include: {
                  patient: { include: { user: { select: { name: true } } } },
                  bed: { include: { ward: true } },
                },
              },
            },
          },
        },
        orderBy: { scheduledAt: "asc" },
      });

      res.json({ success: true, data: due, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/medication/administrations/:id — record administration
router.patch(
  "/administrations/:id",
  authorize(Role.ADMIN, Role.NURSE, Role.DOCTOR),
  validate(administerMedicationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await prisma.medicationAdministration.update({
        where: { id: req.params.id },
        data: {
          status: req.body.status,
          notes: req.body.notes,
          administeredAt: new Date(),
          administeredBy: req.user!.userId,
        },
        include: {
          medicationOrder: {
            select: { id: true, medicineName: true, dosage: true, admissionId: true },
          },
          nurse: { select: { id: true, name: true } },
        },
      });

      auditLog(req, "RECORD_MEDICATION_ADMIN", "medicationAdministration", updated.id, {
        status: req.body.status,
      }).catch(console.error);

      // Realtime: medication dashboard
      const io = req.app.get("io");
      if (io) {
        io.emit("medication:administered", {
          admissionId: updated.medicationOrder?.admissionId ?? null,
          orderId: updated.medicationOrder?.id ?? null,
          status: updated.status,
          administrationId: updated.id,
        });
      }

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as medicationRouter };
