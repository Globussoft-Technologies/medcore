// AI-driven insurance claim endpoints.
//
// Mounts at `/api/v1/ai/claims`.
//
// Routes:
//   POST /draft/:consultationId    — generate a draft claim from a consultation
//   GET  /pending-drafts           — list AI-drafted claims waiting for review
//   GET  /:claimId/denial-risk     — run the denial-risk predictor
//   POST /:claimId/auto-fix        — apply machine-replayable predictor fixes

import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: tenantScopedPrisma auto-injects tenantId on create and
// auto-filters reads for tenant-scoped models. Kept aliased as `prisma` so
// existing conventions apply.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validateUuidParams } from "../middleware/validate-params";
import { auditLog } from "../middleware/audit";
import {
  draftClaimFromConsultation,
  listPendingDrafts,
} from "../services/insurance-claims/ai-coder";
import {
  predictDenialRisk,
  applyAutoFixes,
} from "../services/insurance-claims/denial-predictor";

const router = Router();
router.use(authenticate);

// #511 audit (file-level, 2026-05-09): every handler applies
// `authorize(Role.ADMIN, Role.RECEPTION)` (or ADMIN-only). PATIENT is
// excluded from insurance-claims drafting and denial prediction surfaces.
// Verified-safe.

// ── POST /draft/:consultationId ──────────────────────────────────────────────
// Draft a claim from the consultation's SOAP + ICD + invoice. Idempotency is
// intentionally NOT enforced here: reception may legitimately want to re-draft
// (e.g. after fixing the patient's insurance record).

router.post(
  "/draft/:consultationId",
  authorize(Role.ADMIN, Role.RECEPTION),
  validateUuidParams(["consultationId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { consultationId } = req.params;
      const result = await draftClaimFromConsultation(consultationId, {
        createdBy: req.user?.userId,
      });
      auditLog(req, "AI_CLAIM_DRAFT", "insurance_claim", result.claim.id, {
        consultationId,
        warningCount: result.warnings.length,
      }).catch(console.error);
      res.status(201).json({
        success: true,
        data: {
          claim: result.claim,
          warnings: result.warnings,
        },
        error: null,
      });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (
        msg.includes("Consultation not found") ||
        msg.includes("appointment linkage")
      ) {
        res.status(404).json({ success: false, data: null, error: msg });
        return;
      }
      if (msg.includes("no invoice")) {
        res.status(422).json({ success: false, data: null, error: msg });
        return;
      }
      next(err);
    }
  }
);

// ── GET /pending-drafts ──────────────────────────────────────────────────────

router.get(
  "/pending-drafts",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await listPendingDrafts();
      auditLog(
        req,
        "AI_CLAIM_PENDING_DRAFTS_LIST",
        "insurance_claim",
        undefined,
        { resultCount: rows.length }
      ).catch(() => undefined);
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /:claimId/denial-risk ────────────────────────────────────────────────

router.get(
  "/:claimId/denial-risk",
  authorize(Role.ADMIN, Role.RECEPTION),
  validateUuidParams(["claimId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await predictDenialRisk(req.params.claimId);
      auditLog(
        req,
        "AI_CLAIM_DENIAL_RISK",
        "insurance_claim",
        req.params.claimId,
        {
          risk: report.risk,
          reasonCount: report.reasons.length,
        }
      ).catch(() => undefined);
      res.json({ success: true, data: report, error: null });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("Claim not found")) {
        res.status(404).json({ success: false, data: null, error: msg });
        return;
      }
      next(err);
    }
  }
);

// ── POST /:claimId/auto-fix ──────────────────────────────────────────────────

router.post(
  "/:claimId/auto-fix",
  authorize(Role.ADMIN),
  validateUuidParams(["claimId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await applyAutoFixes(req.params.claimId);
      auditLog(
        req,
        "AI_CLAIM_AUTO_FIX",
        "insurance_claim",
        req.params.claimId,
        {
          appliedCount: result.applied.length,
          remainingCount: result.remaining.length,
        }
      ).catch(console.error);
      // 200 regardless of whether ops were applied — "nothing to fix" is a
      // valid outcome and the caller wants the report either way.
      res.json({
        success: true,
        data: {
          claim: result.claim,
          appliedOps: result.applied,
          manualFollowUps: result.remaining,
        },
        error: null,
      });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("Claim not found")) {
        res.status(404).json({ success: false, data: null, error: msg });
        return;
      }
      next(err);
    }
  }
);

export { router as aiClaimsRouter };
