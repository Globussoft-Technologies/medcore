import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { rateLimit } from "../middleware/rate-limit";
import { analyzeDifferential } from "../services/ai/differential";

const router = Router();
router.use(authenticate);

// #511 audit (file-level, 2026-05-09): every handler applies
// `authorize(Role.DOCTOR, Role.ADMIN)`. PATIENT excluded from differential
// diagnosis surfaces. Verified-safe.

// security(2026-04-23-med): F-DDX-1 — LLM-backed; cap to 20/min/IP so a single
// clinician token cannot burn Sarvam budget.
if (process.env.NODE_ENV !== "test") {
  router.use(rateLimit(20, 60_000));
}

// POST /api/v1/ai/differential — ephemeral differential-diagnosis support
router.post(
  "/",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, chiefComplaint, vitals, relevantHistory } = req.body as {
        patientId: string;
        chiefComplaint: string;
        vitals?: Record<string, unknown>;
        relevantHistory?: string;
      };

      if (!patientId || typeof patientId !== "string") {
        res.status(400).json({ success: false, data: null, error: "patientId is required" });
        return;
      }
      if (!chiefComplaint || typeof chiefComplaint !== "string" || !chiefComplaint.trim()) {
        res.status(400).json({ success: false, data: null, error: "chiefComplaint is required" });
        return;
      }

      // Pull patient context (allergies, chronic conditions, current meds, age/gender)
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        include: {
          allergies: { select: { allergen: true } },
          chronicConditions: { select: { condition: true } },
          prescriptions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { items: { select: { medicineName: true } } },
          },
        },
      });

      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      const result = await analyzeDifferential({
        chiefComplaint,
        vitals,
        relevantHistory,
        allergies: patient.allergies.map((a: any) => a.allergen),
        chronicConditions: patient.chronicConditions.map((c: any) => c.condition),
        currentMedications:
          patient.prescriptions[0]?.items.map((i: any) => i.medicineName) ?? [],
        age: patient.age ?? undefined,
        gender: patient.gender ?? undefined,
      });

      // Best-effort audit log (non-fatal)
      auditLog(req, "AI_DIFFERENTIAL_ANALYZE", "Patient", patientId, {
        differentialCount: result.differentials.length,
      }).catch((err) => {
        console.warn(`[audit] AI_DIFFERENTIAL_ANALYZE failed (non-fatal):`, (err as Error)?.message ?? err);
      });

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiDifferentialRouter };
