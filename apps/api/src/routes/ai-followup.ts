import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role, NotificationType } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { suggestFollowUp } from "../services/ai/follow-up";
import { sendNotification } from "../services/notification";

const router = Router();
router.use(authenticate);
// #511 audit (file-level, 2026-05-09): /suggest/:consultationId is staff-only
// (`authorize(Role.DOCTOR, Role.ADMIN)`). /:consultationId/book includes
// Role.PATIENT but loads the consultation's `appointment.patientId` and
// invokes `assertPatientOwnsResource` so a PATIENT cannot self-book a
// follow-up against another patient's consultation. Verified-safe.

// POST /api/v1/ai/followup/suggest/:consultationId — compute a suggestion
router.post(
  "/suggest/:consultationId",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { consultationId } = req.params;

      const consultation = await prisma.consultation.findUnique({
        where: { id: consultationId },
      });
      if (!consultation) {
        res.status(404).json({ success: false, data: null, error: "Consultation not found" });
        return;
      }

      const suggestion = await suggestFollowUp(consultationId);
      if (!suggestion) {
        res.json({
          success: true,
          data: { suggestion: null, reason: "No follow-up timeline documented" },
          error: null,
        });
        return;
      }

      auditLog(req, "AI_FOLLOWUP_SUGGEST", "Consultation", consultationId, {
        suggestedDate: suggestion.suggestedDate,
        doctorId: suggestion.doctorId,
        fallbackUsed: suggestion.fallbackUsed,
      }).catch((err) => {
        console.warn(`[audit] AI_FOLLOWUP_SUGGEST failed (non-fatal):`, (err as Error)?.message ?? err);
      });

      res.json({ success: true, data: { suggestion }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/followup/:consultationId/book — book the suggested slot
router.post(
  "/:consultationId/book",
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { consultationId } = req.params;

      const consultation = await prisma.consultation.findUnique({
        where: { id: consultationId },
        include: { appointment: { select: { patientId: true } } },
      });
      if (!consultation) {
        res.status(404).json({ success: false, data: null, error: "Consultation not found" });
        return;
      }

      // #511 (BOLA): authorize() includes Role.PATIENT for self-service
      // follow-up booking, but without this check any PATIENT could book a
      // follow-up against another patient's consultation. Verify ownership
      // against the consultation's appointment.patientId before proceeding.
      if (!(await assertPatientOwnsResource(req, res, consultation.appointment.patientId))) return;

      // Allow caller to override the auto-computed suggestion by posting date/slot/doctor.
      const body = req.body as {
        suggestedDate?: string;
        slotStart?: string;
        doctorId?: string;
      };

      let suggestedDate = body.suggestedDate;
      let slotStart = body.slotStart;
      let doctorId = body.doctorId;

      if (!suggestedDate || !slotStart || !doctorId) {
        const autoSuggestion = await suggestFollowUp(consultationId);
        if (!autoSuggestion) {
          res.status(400).json({ success: false, data: null, error: "No follow-up timeline documented" });
          return;
        }
        if (!autoSuggestion.slotStart) {
          res.status(409).json({ success: false, data: null, error: "No available slot for the target date" });
          return;
        }
        suggestedDate = suggestedDate ?? autoSuggestion.suggestedDate;
        slotStart = slotStart ?? autoSuggestion.slotStart;
        doctorId = doctorId ?? autoSuggestion.doctorId;
      }

      const patientId = consultation.appointment.patientId;
      const dateObj = new Date(suggestedDate as string);

      // Conflict check
      const conflict = await prisma.appointment.findFirst({
        where: {
          doctorId,
          date: dateObj,
          slotStart,
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        },
      });
      if (conflict) {
        res.status(409).json({ success: false, data: null, error: "Slot no longer available" });
        return;
      }

      const last = await prisma.appointment.findFirst({
        where: { doctorId, date: dateObj },
        orderBy: { tokenNumber: "desc" },
      });
      const tokenNumber = (last?.tokenNumber ?? 0) + 1;

      const appointment = await prisma.appointment.create({
        data: {
          patientId,
          doctorId: doctorId as string,
          date: dateObj,
          slotStart,
          tokenNumber,
          type: "SCHEDULED",
          status: "BOOKED",
          notes: `[AI Follow-up] auto-booked from consultation ${consultationId}`,
        },
      });

      // Notify patient — non-fatal
      try {
        const patientRecord = await prisma.patient.findUnique({
          where: { id: patientId },
          select: { userId: true },
        });
        if (patientRecord?.userId) {
          await sendNotification({
            userId: patientRecord.userId,
            type: NotificationType.APPOINTMENT_BOOKED,
            title: "Follow-up Appointment Booked",
            message: `Your follow-up is booked for ${suggestedDate} at ${slotStart}.`,
            data: { appointmentId: appointment.id, consultationId },
          });
        }
      } catch (notifyErr) {
        console.error("[AI Follow-up] notification failed (non-fatal):", notifyErr);
      }

      auditLog(req, "AI_FOLLOWUP_BOOK", "Appointment", appointment.id, {
        consultationId,
      }).catch((err) => {
        console.warn(`[audit] AI_FOLLOWUP_BOOK failed (non-fatal):`, (err as Error)?.message ?? err);
      });

      res.status(201).json({ success: true, data: { appointment }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiFollowupRouter };
