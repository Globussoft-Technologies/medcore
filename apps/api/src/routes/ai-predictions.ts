import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { validateUuidParams } from "../middleware/validate-params";
import { predictNoShow } from "../services/ai/no-show-predictor";

/**
 * Best-effort audit wrapper: PHI audit writes must never take a GET response
 * down with them. If prisma is unavailable (e.g. transient DB blip), log a
 * warning and allow the request to complete.
 */
function safeAudit(
  req: Request,
  action: string,
  entity: string,
  entityId: string | undefined,
  details?: Record<string, unknown>
): void {
  auditLog(req, action, entity, entityId, details).catch((err) => {
    console.warn(`[audit] ${action} failed (non-fatal):`, (err as Error)?.message ?? err);
  });
}

// ── Zod schemas ────────────────────────────────────────────────────────────

const noShowBatchQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Query param 'date' is required in YYYY-MM-DD format"),
});

const router = Router();

// GET /api/v1/ai/predictions/no-show/batch?date=YYYY-MM-DD
// Must be declared BEFORE /:appointmentId to avoid "batch" being consumed as a param
router.get(
  "/no-show/batch",
  authenticate,
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedBatch = noShowBatchQuerySchema.safeParse(req.query);
      if (!parsedBatch.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsedBatch.error.issues[0]?.message ?? "Query param 'date' is required in YYYY-MM-DD format",
        });
        return;
      }
      const { date } = parsedBatch.data;

      const dateObj = new Date(date);

      // security(2026-04-23): restricted `user` select — previous `user: true`
      // leaked password hashes and all other User fields via `patientName` /
      // `doctorName` response enrichment (see map below). Narrow to id+name.
      const appointments = await prisma.appointment.findMany({
        where: {
          date: dateObj,
          status: "BOOKED",
        },
        include: {
          patient: {
            include: {
              user: { select: { id: true, name: true } },
            },
          },
          doctor: {
            include: {
              user: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { slotStart: "asc" },
      });

      if (appointments.length === 0) {
        safeAudit(req, "AI_NO_SHOW_BATCH", "Appointment", undefined, {
          date,
          resultCount: 0,
        });
        res.json({ success: true, data: [], error: null });
        return;
      }

      // Run predictions in parallel
      const predictions = await Promise.all(
        appointments.map((appt) => predictNoShow(appt.id))
      );

      // Merge prediction data with appointment info
      const apptMap = new Map(appointments.map((a) => [a.id, a]));

      const enriched = predictions
        .sort((a, b) => b.riskScore - a.riskScore)
        .map((pred) => {
          const appt = apptMap.get(pred.appointmentId)!;
          return {
            ...pred,
            appointment: {
              id: appt.id,
              slotStart: appt.slotStart,
              slotEnd: appt.slotEnd,
              date: appt.date,
              patientName: appt.patient.user.name,
              patientId: appt.patientId,
              doctorName: appt.doctor.user.name,
              doctorId: appt.doctorId,
            },
          };
        });

      safeAudit(req, "AI_NO_SHOW_BATCH", "Appointment", undefined, {
        date,
        resultCount: enriched.length,
      });

      res.json({ success: true, data: enriched, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/predictions/no-show/:appointmentId
router.get(
  "/no-show/:appointmentId",
  authenticate,
  authorize(Role.DOCTOR, Role.ADMIN, Role.RECEPTION),
  // security(2026-04-23-med): F-PRED-2 — reject non-UUID :appointmentId up front.
  validateUuidParams(["appointmentId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { appointmentId } = req.params;

      const prediction = await predictNoShow(appointmentId);

      safeAudit(req, "AI_NO_SHOW_READ", "Appointment", appointmentId, {
        riskScore: prediction.riskScore,
      });

      res.json({ success: true, data: prediction, error: null });
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

export { router as aiPredictionsRouter };
