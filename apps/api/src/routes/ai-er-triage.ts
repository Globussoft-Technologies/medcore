import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validateUuidParams } from "../middleware/validate-params";
import { assessERPatient } from "../services/ai/er-triage";

const router = Router();

// POST /api/v1/ai/er-triage/assess
// Assess a patient based on provided vitals and complaint (no existing case required)
router.post(
  "/assess",
  authenticate,
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        chiefComplaint,
        vitals,
        patientAge,
        patientGender,
        briefHistory,
      } = req.body as {
        chiefComplaint: string;
        vitals?: {
          bp?: string;
          pulse?: number;
          resp?: number;
          spO2?: number;
          temp?: number;
          gcs?: number;
        };
        patientAge?: number;
        patientGender?: string;
        briefHistory?: string;
      };

      if (!chiefComplaint || typeof chiefComplaint !== "string" || !chiefComplaint.trim()) {
        res.status(400).json({
          success: false,
          data: null,
          error: "chiefComplaint is required",
        });
        return;
      }

      const assessment = await assessERPatient({
        chiefComplaint: chiefComplaint.trim(),
        vitals: vitals ?? {},
        patientAge,
        patientGender,
        briefHistory,
      });

      res.json({ success: true, data: assessment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/er-triage/:caseId/assess
// Assess an existing EmergencyCase — fetch vitals from DB, run assessment,
// optionally update the case's mewsScore.
router.post(
  "/:caseId/assess",
  authenticate,
  authorize(Role.DOCTOR, Role.ADMIN),
  // security(2026-04-23-med): F-ER-4 — reject non-UUID :caseId up front.
  validateUuidParams(["caseId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { caseId } = req.params;

      const ec = await prisma.emergencyCase.findUnique({
        where: { id: caseId },
        select: {
          id: true,
          chiefComplaint: true,
          vitalsBP: true,
          vitalsPulse: true,
          vitalsResp: true,
          vitalsSpO2: true,
          vitalsTemp: true,
          glasgowComa: true,
          patient: {
            select: {
              dateOfBirth: true,
              gender: true,
            },
          },
        },
      });

      if (!ec) {
        res.status(404).json({ success: false, data: null, error: "Emergency case not found" });
        return;
      }

      // Derive patient age from DOB if available
      let patientAge: number | undefined;
      if (ec.patient?.dateOfBirth) {
        const dob = new Date(ec.patient.dateOfBirth);
        const now = new Date();
        patientAge = Math.floor(
          (now.getTime() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
        );
      }

      const assessment = await assessERPatient({
        chiefComplaint: ec.chiefComplaint,
        vitals: {
          bp: ec.vitalsBP ?? undefined,
          pulse: ec.vitalsPulse ?? undefined,
          resp: ec.vitalsResp ?? undefined,
          spO2: ec.vitalsSpO2 ?? undefined,
          temp: ec.vitalsTemp ?? undefined,
          gcs: ec.glasgowComa ?? undefined,
        },
        patientAge,
        patientGender: ec.patient?.gender ?? undefined,
      });

      // Optionally persist the calculated MEWS back to the case
      if (assessment.calculatedMEWS !== null) {
        await prisma.emergencyCase.update({
          where: { id: caseId },
          data: { mewsScore: assessment.calculatedMEWS },
        }).catch(() => {
          // Non-fatal — assessment is still returned even if DB write fails
        });
      }

      res.json({ success: true, data: assessment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiERTriageRouter };
