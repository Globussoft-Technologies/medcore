import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a duration string like "7 days", "2 weeks", "1 month" into days.
 * Falls back to 7 if unparseable.
 */
function parseDurationDays(duration: string): number {
  const lower = duration.toLowerCase();
  const num = parseInt(lower, 10);
  if (isNaN(num)) return 7;
  if (lower.includes("month")) return num * 30;
  if (lower.includes("week")) return num * 7;
  return num; // days
}

/**
 * Derive default reminder times from a frequency string.
 */
function derivedFromFrequency(frequency: string): string[] {
  const lower = frequency.toLowerCase();
  if (lower.includes("four times")) return ["07:00", "12:00", "17:00", "21:00"];
  if (lower.includes("three times")) return ["08:00", "14:00", "20:00"];
  if (lower.includes("twice")) return ["08:00", "20:00"];
  if (lower.includes("once")) return ["08:00"];
  return ["08:00"];
}

// ── POST /api/v1/ai/adherence/enroll ────────────────────────────────────────

router.post(
  "/enroll",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { prescriptionId, reminderTimes } = req.body as {
        prescriptionId: string;
        reminderTimes?: string[];
      };

      if (!prescriptionId) {
        res.status(400).json({ success: false, data: null, error: "prescriptionId is required" });
        return;
      }

      // Fetch prescription with items and patient
      const prescription = await prisma.prescription.findUnique({
        where: { id: prescriptionId },
        include: {
          items: true,
          patient: { include: { user: { select: { id: true } } } },
        },
      });

      if (!prescription) {
        res.status(404).json({ success: false, data: null, error: "Prescription not found" });
        return;
      }

      // Build medications array
      const medications = prescription.items.map((item) => ({
        name: item.medicineName,
        dosage: item.dosage,
        frequency: item.frequency,
        duration: item.duration,
        reminderTimes: reminderTimes ?? derivedFromFrequency(item.frequency),
      }));

      // Calculate endDate from max duration among items
      const maxDays = Math.max(
        ...prescription.items.map((item) => parseDurationDays(item.duration)),
        7
      );
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + maxDays);

      // Upsert AdherenceSchedule keyed on prescriptionId
      const schedule = await prisma.adherenceSchedule.upsert({
        where: { prescriptionId },
        create: {
          patientId: prescription.patientId,
          prescriptionId,
          medications: medications as any,
          startDate: today,
          endDate,
          active: true,
          remindersSent: 0,
        },
        update: {
          medications: medications as any,
          startDate: today,
          endDate,
          active: true,
        },
      });

      res.status(200).json({ success: true, data: schedule, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/ai/adherence/:patientId ─────────────────────────────────────

router.get(
  "/:patientId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId } = req.params;

      const schedules = await prisma.adherenceSchedule.findMany({
        where: { patientId, active: true },
        orderBy: { createdAt: "desc" },
      });

      res.json({ success: true, data: schedules, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/v1/ai/adherence/:scheduleId ─────────────────────────────────

router.delete(
  "/:scheduleId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scheduleId } = req.params;

      const schedule = await prisma.adherenceSchedule.findUnique({
        where: { id: scheduleId },
      });

      if (!schedule) {
        res.status(404).json({ success: false, data: null, error: "Schedule not found" });
        return;
      }

      // Resolve patient to check ownership
      const patient = await prisma.patient.findUnique({
        where: { id: schedule.patientId },
        select: { userId: true },
      });

      const user = req.user!;
      const isOwner = patient?.userId === user.userId;
      const isPrivileged =
        user.role === Role.ADMIN || user.role === Role.DOCTOR;

      if (!isOwner && !isPrivileged) {
        res.status(403).json({
          success: false,
          data: null,
          error: "Forbidden: you can only unenroll your own schedule",
        });
        return;
      }

      const updated = await prisma.adherenceSchedule.update({
        where: { id: scheduleId },
        data: { active: false },
      });

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export const aiAdherenceRouter = router;
