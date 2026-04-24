// Radiology Report Drafting (PRD §7.2) — HITL flow.
//
// Scope: upload study metadata (image keys come from the existing storage /
// signed-URL layer), kick off AI draft, list pending reviews, approve / amend.
// DICOM parsing is intentionally deferred — see `.prisma-models-radiology.md`.
//
// Audit: every state-mutating call writes an AuditLog entry. Read-only GETs
// also audit because radiology reports are PHI.

import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` auto-injects tenantId on create
// and auto-filters on read. See services/tenant-prisma.ts.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { rateLimit } from "../middleware/rate-limit";
import {
  createStudy,
  createReportDraft,
  approveReport,
  amendReport,
  type RadiologyModality,
  type RadiologyImageRef,
} from "../services/ai/radiology-reports";

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

const MODALITIES: RadiologyModality[] = [
  "XRAY",
  "CT",
  "MRI",
  "ULTRASOUND",
  "MAMMOGRAPHY",
  "PET",
];

export const aiRadiologyRouter = Router();

aiRadiologyRouter.use(authenticate);
// security(2026-04-24-med): F-RAD-* — draft generation is Sarvam-backed
// (one LLM call). Cap to 20/min/IP so one caller can't burn budget.
if (process.env.NODE_ENV !== "test") {
  aiRadiologyRouter.use(rateLimit(20, 60_000));
}

// ── POST /studies ─────────────────────────────────────────────────────────────
// Upload study metadata. Image bytes come from the existing /uploads flow;
// we persist opaque file keys in RadiologyStudy.images.

aiRadiologyRouter.post(
  "/studies",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, modality, bodyPart, imageKeys, studyDate, notes, orderId } =
        req.body as {
          patientId: string;
          modality: RadiologyModality;
          bodyPart: string;
          imageKeys: string[];
          studyDate?: string;
          notes?: string;
          orderId?: string;
        };

      if (!patientId || !modality || !bodyPart || !Array.isArray(imageKeys) || imageKeys.length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "patientId, modality, bodyPart and at least one imageKey are required",
        });
        return;
      }
      if (!MODALITIES.includes(modality)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `modality must be one of ${MODALITIES.join(", ")}`,
        });
        return;
      }

      // Sanity-check the patient exists (and is reachable within the caller's
      // tenant scope — tenantScopedPrisma will have already filtered).
      const patient = await prisma.patient.findUnique({ where: { id: patientId } });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      const images: RadiologyImageRef[] = imageKeys.map((k) => ({
        key: String(k),
        uploadedAt: new Date().toISOString(),
      }));

      const study = await createStudy({
        patientId,
        modality,
        bodyPart,
        images,
        studyDate: studyDate ? new Date(studyDate) : undefined,
        notes,
        orderId,
      });

      safeAudit(req, "RADIOLOGY_STUDY_CREATE", "RadiologyStudy", study.id, {
        modality,
        bodyPart,
        imageCount: images.length,
      });

      res.status(201).json({ success: true, data: study, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /:studyId/draft ──────────────────────────────────────────────────────
// Kick off AI draft generation for a study. Creates a RadiologyReport with
// status = DRAFT. Idempotent — re-calling returns the existing draft.

aiRadiologyRouter.post(
  "/:studyId/draft",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { studyId } = req.params;

      // Verify the study exists & is in the caller's tenant before firing the
      // expensive LLM call.
      const study = await prisma.radiologyStudy.findUnique({
        where: { id: studyId },
      });
      if (!study) {
        res.status(404).json({ success: false, data: null, error: "Study not found" });
        return;
      }

      const report = await createReportDraft(studyId);

      safeAudit(req, "RADIOLOGY_DRAFT_CREATE", "RadiologyReport", report.id, {
        studyId,
      });

      res.status(201).json({ success: true, data: report, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /studies/:studyId ─────────────────────────────────────────────────────
// Return the study + its report (if any). Doctor, admin, and reception can
// view. RADIOLOGIST role does not exist in the enum yet — DOCTOR/ADMIN only.

aiRadiologyRouter.get(
  "/studies/:studyId",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { studyId } = req.params;
      const study = await prisma.radiologyStudy.findUnique({
        where: { id: studyId },
        include: {
          report: true,
          patient: { include: { user: { select: { name: true } } } },
        },
      });
      if (!study) {
        res.status(404).json({ success: false, data: null, error: "Study not found" });
        return;
      }

      safeAudit(req, "RADIOLOGY_STUDY_READ", "RadiologyStudy", studyId);

      res.json({ success: true, data: study, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /pending-review ───────────────────────────────────────────────────────
// Triage queue: DRAFT + RADIOLOGIST_REVIEW reports, tenant-scoped.

aiRadiologyRouter.get(
  "/pending-review",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reports = await prisma.radiologyReport.findMany({
        where: { status: { in: ["DRAFT", "RADIOLOGIST_REVIEW"] } },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          study: {
            include: {
              patient: { include: { user: { select: { name: true } } } },
            },
          },
        },
      });

      res.json({ success: true, data: reports, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /:reportId/approve ───────────────────────────────────────────────────
// HITL approval. Moves DRAFT / RADIOLOGIST_REVIEW → FINAL.

aiRadiologyRouter.post(
  "/:reportId/approve",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reportId } = req.params;
      const { finalReport, finalImpression } = req.body as {
        finalReport: string;
        finalImpression?: string;
      };

      if (!finalReport || finalReport.trim().length < 10) {
        res.status(400).json({
          success: false,
          data: null,
          error: "finalReport is required and must be at least 10 characters",
        });
        return;
      }

      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, data: null, error: "Unauthorized" });
        return;
      }

      try {
        const updated = await approveReport(reportId, finalReport, userId, finalImpression);

        safeAudit(req, "RADIOLOGY_REPORT_APPROVE", "RadiologyReport", reportId, {
          approvedBy: userId,
        });

        res.json({ success: true, data: updated, error: null });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg.includes("not found")) {
          res.status(404).json({ success: false, data: null, error: msg });
          return;
        }
        if (msg.includes("already")) {
          res.status(409).json({ success: false, data: null, error: msg });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /:reportId/amend ─────────────────────────────────────────────────────
// Post-FINAL amendment.

aiRadiologyRouter.post(
  "/:reportId/amend",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reportId } = req.params;
      const { finalReport, finalImpression } = req.body as {
        finalReport: string;
        finalImpression?: string;
      };

      if (!finalReport || finalReport.trim().length < 10) {
        res.status(400).json({
          success: false,
          data: null,
          error: "finalReport is required and must be at least 10 characters",
        });
        return;
      }

      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, data: null, error: "Unauthorized" });
        return;
      }

      try {
        const updated = await amendReport(reportId, finalReport, userId, finalImpression);

        safeAudit(req, "RADIOLOGY_REPORT_AMEND", "RadiologyReport", reportId, {
          amendedBy: userId,
        });

        res.json({ success: true, data: updated, error: null });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg.includes("not found")) {
          res.status(404).json({ success: false, data: null, error: msg });
          return;
        }
        if (msg.includes("must be FINAL")) {
          res.status(409).json({ success: false, data: null, error: msg });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  }
);
