import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { validateUuidParams } from "../middleware/validate-params";
import { generatePrevisitChecklist } from "../services/ai/previsit";

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

const router = Router();
router.use(authenticate);
// #511 audit (file-level, 2026-05-09): the only handler is GET /:appointmentId
// with `authorize(Role.PATIENT, Role.ADMIN, Role.DOCTOR)`. Per-row ownership
// is enforced by the bespoke `authorizeAppointmentAccess` helper below
// (PATIENT must match `appointment.patient.userId`; DOCTOR must be the
// attending doctor — STRICTER than the generic `assertPatientOwnsResource`
// for the doctor branch). Verified-safe.

/**
 * Resolve whether the caller is allowed to view / generate the checklist for
 * an appointment: the owning patient, any ADMIN, or the attending doctor.
 *
 * #511 audit: VERIFIED-SAFE — this in-handler authorizer enforces per-row
 * ownership (PATIENT must match `appointment.patient.userId`) AND is
 * STRICTER than the canonical `assertPatientOwnsResource` helper for the
 * DOCTOR role, which it scopes to the attending doctor only. We keep the
 * bespoke helper for that reason rather than refactoring to the canonical
 * helper, which would weaken the doctor-side check. Future drift on this
 * function is fenced by `cross-patient-ai-bill-followup-previsit.test.ts`.
 */
async function authorizeAppointmentAccess(
  req: Request,
  appointmentId: string
): Promise<
  | { ok: true; appointment: NonNullable<Awaited<ReturnType<typeof prisma.appointment.findUnique>>> }
  | { ok: false; status: number; message: string }
> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      patient: { select: { userId: true } },
      doctor: { select: { userId: true } },
    },
  });
  if (!appointment) {
    return { ok: false, status: 404, message: "Appointment not found" };
  }

  const user = req.user!;
  if (user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN) {
    return { ok: true, appointment: appointment as any };
  }
  if (user.role === Role.DOCTOR) {
    if ((appointment as any).doctor?.userId === user.userId) {
      return { ok: true, appointment: appointment as any };
    }
    return { ok: false, status: 403, message: "Forbidden: not the attending doctor" };
  }
  if (user.role === Role.PATIENT) {
    if ((appointment as any).patient?.userId === user.userId) {
      return { ok: true, appointment: appointment as any };
    }
    return { ok: false, status: 403, message: "Forbidden: not your appointment" };
  }
  return { ok: false, status: 403, message: "Forbidden" };
}

// ── GET /api/v1/ai/previsit/:appointmentId ────────────────────────────────────
// Returns (and generates on first access / when ?regenerate=1) the checklist.

router.get(
  "/:appointmentId",
  validateUuidParams(["appointmentId"]),
  authorize(Role.PATIENT, Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { appointmentId } = req.params;
      const regen = req.query.regenerate === "1" || req.query.regenerate === "true";

      const auth = await authorizeAppointmentAccess(req, appointmentId);
      if (!auth.ok) {
        res.status(auth.status).json({ success: false, data: null, error: auth.message });
        return;
      }
      const appointment = auth.appointment;

      // Try to read the cached checklist first.
      const existing = regen
        ? null
        : await prisma.previsitChecklist.findUnique({
            where: { appointmentId },
          });

      if (existing) {
        safeAudit(req, "AI_PREVISIT_READ", "PrevisitChecklist", existing.id, {
          appointmentId,
          cached: true,
        });
        res.json({
          success: true,
          data: existing,
          error: null,
        });
        return;
      }

      const result = await generatePrevisitChecklist(appointmentId);
      if (!result) {
        res.status(404).json({ success: false, data: null, error: "Appointment not found" });
        return;
      }

      const record = await prisma.previsitChecklist.upsert({
        where: { appointmentId },
        create: {
          appointmentId,
          patientId: (appointment as any).patientId,
          items: result.items as any,
        },
        update: {
          items: result.items as any,
          generatedAt: new Date(),
        },
      });

      await auditLog(
        req,
        "AI_PREVISIT_GENERATE",
        "PrevisitChecklist",
        record.id,
        {
          appointmentId,
          itemCount: result.items.length,
          regen,
        }
      );

      res.json({
        success: true,
        data: record,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiPrevisitRouter };
