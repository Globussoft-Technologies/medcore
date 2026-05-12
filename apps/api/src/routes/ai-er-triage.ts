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
import { validateUuidParams } from "../middleware/validate-params";
import { assessERPatient } from "../services/ai/er-triage";
import { sanitizeUserInput } from "../services/ai/prompt-safety";

// security(2026-05-04): F-ER-3 — Sarvam model used for AI-assisted triage.
// Stamped onto the AI_ER_TRIAGE_INFERENCE audit row so we can correlate
// model rollouts with quality / billing changes downstream.
const SARVAM_MODEL = process.env.SARVAM_MODEL ?? "sarvam-m";

const router = Router();

// #511 audit (file-level, 2026-05-09): both POST handlers apply
// `authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN)` (or DOCTOR/ADMIN-only
// for the `:caseId` variant) — PATIENT is excluded. Verified-safe.

// security(2026-04-24): F-ER-2 — er-triage is Sarvam-backed (one LLM call per
// assess), same risk profile as chart-search / report-explainer / letters that
// were rate-limited in the first MEDIUM pass. Cap to 30/min/IP so one
// compromised clinician token cannot burn Sarvam budget via assessment spam.
const erTriageRateLimit =
  process.env.NODE_ENV === "test"
    ? (_: any, __: any, n: any) => n()
    : rateLimit(30, 60_000);

// POST /api/v1/ai/er-triage/assess
// Assess a patient based on provided vitals and complaint (no existing case required)
router.post(
  "/assess",
  authenticate,
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  erTriageRateLimit,
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

      if (
        !chiefComplaint ||
        typeof chiefComplaint !== "string" ||
        !chiefComplaint.trim()
      ) {
        res.status(400).json({
          success: false,
          data: null,
          error: "chiefComplaint is required",
        });
        return;
      }

      // security(2026-05-04): F-INJ-1 — strip prompt-injection markers from
      // every clinician-supplied free-text field before they hit the Sarvam
      // payload. The er-triage service does NOT sanitize internally (unlike
      // letter-generator / report-explainer / chart-search), so this route
      // is the only choke-point.
      const safeChiefComplaint = sanitizeUserInput(chiefComplaint.trim(), {
        maxLen: 2000,
      });
      const safeBriefHistory =
        typeof briefHistory === "string" && briefHistory.trim()
          ? sanitizeUserInput(briefHistory, { maxLen: 3000 })
          : undefined;
      const safePatientGender =
        typeof patientGender === "string" && patientGender.trim()
          ? sanitizeUserInput(patientGender, { maxLen: 20 })
          : undefined;

      // Approximate prompt size up-front so the audit row has it on both the
      // success and failure path. Cheap to compute; not PHI.
      const promptSize =
        safeChiefComplaint.length +
        (safeBriefHistory?.length ?? 0) +
        (safePatientGender?.length ?? 0);

      // Issue #81: previously a Sarvam outage / missing API key surfaced as
      // an opaque HTTP 500 with the auth middleware's "Unauthorized" body
      // bleeding into the toast (because the front-end retried and mid-flight
      // the token expired) — both bad UX. We now catch errors from
      // assessERPatient explicitly and return a 503 with a human-readable
      // error string the front-end can show in a toast + Retry. The MEWS
      // score is still useful even without AI, so we DO NOT fall back to a
      // mock-AI assessment — that hides outages from clinicians.
      let assessment;
      const inferenceStartedAt = Date.now();
      try {
        assessment = await assessERPatient({
          chiefComplaint: safeChiefComplaint,
          vitals: vitals ?? {},
          patientAge,
          patientGender: safePatientGender,
          briefHistory: safeBriefHistory,
        });
      } catch (aiErr) {
        const msg =
          (aiErr as Error)?.message ??
          "AI triage assistant is currently unavailable";
        console.warn(`[ai-er-triage] assessERPatient failed:`, msg);

        // security(2026-05-04): F-ER-3 — audit failed inference so Sarvam
        // outage spikes are visible in the audit log (and not just stderr).
        auditLog(req, "AI_ER_TRIAGE_INFERENCE", "EmergencyCase", undefined, {
          model: SARVAM_MODEL,
          promptSize,
          responseSize: 0,
          latencyMs: Date.now() - inferenceStartedAt,
          failure: true,
          errorMessage: String(msg).slice(0, 200),
        }).catch((err) =>
          console.warn(
            `[audit] AI_ER_TRIAGE_INFERENCE (failure) failed (non-fatal):`,
            (err as Error)?.message ?? err,
          ),
        );

        res.status(503).json({
          success: false,
          data: null,
          error:
            "AI triage assistant is temporarily unavailable. Please try again, or proceed with manual triage.",
        });
        return;
      }

      // security(2026-04-24): F-ER-3 — audit AI inference so post-incident
      // reconstruction (and Sarvam-bill spike triage) can identify who hit the
      // paid path and how often. No PHI in details — complaint truncated.
      auditLog(req, "AI_ER_TRIAGE_ASSESS", "EmergencyCase", undefined, {
        chiefComplaintPreview: safeChiefComplaint.slice(0, 100),
        patientAge: patientAge ?? null,
        triageLevel: assessment.suggestedTriageLevel ?? null,
        mews: assessment.calculatedMEWS ?? null,
      }).catch((err) =>
        console.warn(
          `[audit] AI_ER_TRIAGE_ASSESS failed (non-fatal):`,
          (err as Error)?.message ?? err,
        ),
      );

      // security(2026-05-04): F-ER-3 — companion AI_<FEATURE>_INFERENCE row
      // tracks model + sizes + latency so we can spot Sarvam-budget spikes
      // and slow-call regressions independently of the case-state audit.
      auditLog(req, "AI_ER_TRIAGE_INFERENCE", "EmergencyCase", undefined, {
        model: SARVAM_MODEL,
        promptSize,
        responseSize: JSON.stringify(assessment).length,
        latencyMs: Date.now() - inferenceStartedAt,
        triageLevel: assessment.suggestedTriageLevel ?? null,
      }).catch((err) =>
        console.warn(
          `[audit] AI_ER_TRIAGE_INFERENCE failed (non-fatal):`,
          (err as Error)?.message ?? err,
        ),
      );

      res.json({ success: true, data: assessment, error: null });
    } catch (err) {
      next(err);
    }
  },
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
  erTriageRateLimit,
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
        res
          .status(404)
          .json({
            success: false,
            data: null,
            error: "Emergency case not found",
          });
        return;
      }

      // Derive patient age from DOB if available
      let patientAge: number | undefined;
      if (ec.patient?.dateOfBirth) {
        const dob = new Date(ec.patient.dateOfBirth);
        const now = new Date();
        patientAge = Math.floor(
          (now.getTime() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000),
        );
      }

      // security(2026-05-04): F-INJ-1 — sanitize free-text fields pulled from
      // the EmergencyCase row before they reach the Sarvam payload. The DB
      // could contain pre-existing notes that already include injection
      // markers (deliberately or copy-pasted), so the route is the right
      // choke-point regardless of where the text originated.
      const safeCaseComplaint = sanitizeUserInput(ec.chiefComplaint, {
        maxLen: 2000,
      });
      const safeCaseGender = ec.patient?.gender
        ? sanitizeUserInput(ec.patient.gender, { maxLen: 20 })
        : undefined;

      const inferenceStartedAt = Date.now();
      const assessment = await assessERPatient({
        chiefComplaint: safeCaseComplaint,
        vitals: {
          bp: ec.vitalsBP ?? undefined,
          pulse: ec.vitalsPulse ?? undefined,
          resp: ec.vitalsResp ?? undefined,
          spO2: ec.vitalsSpO2 ?? undefined,
          temp: ec.vitalsTemp ?? undefined,
          gcs: ec.glasgowComa ?? undefined,
        },
        patientAge,
        patientGender: safeCaseGender,
      });

      // Optionally persist the calculated MEWS back to the case
      if (assessment.calculatedMEWS !== null) {
        await prisma.emergencyCase
          .update({
            where: { id: caseId },
            data: { mewsScore: assessment.calculatedMEWS },
          })
          .catch(() => {
            // Non-fatal — assessment is still returned even if DB write fails
          });
      }

      // security(2026-04-24): F-ER-3 — audit inference on existing cases so
      // the MEWS-overwrite write can be traced to a user + request.
      auditLog(req, "AI_ER_TRIAGE_CASE_ASSESS", "EmergencyCase", caseId, {
        triageLevel: assessment.suggestedTriageLevel ?? null,
        mews: assessment.calculatedMEWS ?? null,
        mewsWrittenBack: assessment.calculatedMEWS !== null,
      }).catch((err) =>
        console.warn(
          `[audit] AI_ER_TRIAGE_CASE_ASSESS failed (non-fatal):`,
          (err as Error)?.message ?? err,
        ),
      );

      // security(2026-05-04): F-ER-3 — companion inference row with model +
      // sizes + latency for budget / latency observability.
      auditLog(req, "AI_ER_TRIAGE_INFERENCE", "EmergencyCase", caseId, {
        model: SARVAM_MODEL,
        promptSize: safeCaseComplaint.length + (safeCaseGender?.length ?? 0),
        responseSize: JSON.stringify(assessment).length,
        latencyMs: Date.now() - inferenceStartedAt,
        triageLevel: assessment.suggestedTriageLevel ?? null,
      }).catch((err) =>
        console.warn(
          `[audit] AI_ER_TRIAGE_INFERENCE failed (non-fatal):`,
          (err as Error)?.message ?? err,
        ),
      );

      res.json({ success: true, data: assessment, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as aiERTriageRouter };
