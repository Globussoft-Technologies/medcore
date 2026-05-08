import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role, nurseRoundSchema } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// POST /api/v1/nurse-rounds — record a round
router.post(
  "/",
  authorize(Role.ADMIN, Role.NURSE, Role.DOCTOR),
  validate(nurseRoundSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { admissionId, notes } = req.body;

      const admission = await prisma.admission.findUnique({ where: { id: admissionId } });
      if (!admission) {
        res.status(404).json({ success: false, data: null, error: "Admission not found" });
        return;
      }

      const round = await prisma.nurseRound.create({
        data: {
          admissionId,
          nurseId: req.user!.userId,
          notes,
        },
        include: {
          nurse: { select: { id: true, name: true } },
        },
      });

      auditLog(req, "NURSE_ROUND", "nurseRound", round.id, { admissionId }).catch(console.error);

      res.status(201).json({ success: true, data: round, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/nurse-rounds?admissionId=
//
// security(2026-05-09, issue #511): no per-handler `authorize(...)` and no
// per-row ownership check — any authenticated user (including PATIENT)
// could enumerate another patient's nurse rounds (clinical assessment
// notes per shift) by guessing the admissionId. Nurse rounds are
// operational/clinical data: the POST handler already restricts to
// ADMIN/NURSE/DOCTOR, so the GET should match. Block PATIENT.
router.get(
  "/",
  authorize(Role.ADMIN, Role.NURSE, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { admissionId } = req.query;
      if (!admissionId) {
        res.status(400).json({ success: false, data: null, error: "admissionId is required" });
        return;
      }

      const rounds = await prisma.nurseRound.findMany({
        where: { admissionId: admissionId as string },
        include: {
          nurse: { select: { id: true, name: true } },
        },
        orderBy: { performedAt: "desc" },
      });

      res.json({ success: true, data: rounds, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as nurseRoundRouter };
