import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { validate } from "../middleware/validate";
import { validateUuidParams } from "../middleware/validate-params";
import { auditLog } from "../middleware/audit";
import { rateLimit } from "../middleware/rate-limit";
import { explainLabReport } from "../services/ai/report-explainer";
import { sanitizeUserInput } from "../services/ai/prompt-safety";
import { sendNotification } from "../services/notification";
import { NotificationType } from "@medcore/shared";

// security(2026-05-04): F-REX-3 — Sarvam model used for lab-report explanation.
// Stamped onto the AI_REPORT_EXPLAINER_INFERENCE audit row so model rollouts
// are observable.
const SARVAM_MODEL = "sarvam-105b";

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

const explainBodySchema = z.object({
  labOrderId: z.string().uuid(),
  language: z.enum(["en", "hi"]).default("en"),
});

const router = Router();

// security(2026-04-23-med): F-REX-2 — /explain triggers Sarvam-backed LLM work
// on every request. Cap to 20/min/IP so one clinician token can't burn budget.
const explainRateLimit =
  process.env.NODE_ENV === "test"
    ? (_: any, __: any, n: any) => n()
    : rateLimit(20, 60_000);

// POST /api/v1/ai/reports/explain
// security(2026-04-23): added role guard — endpoint triggers LLM work + reveals
// other patients' lab data by labOrderId without an ownership check, so keep
// it clinician-only (DOCTOR/ADMIN approve & send; patient views via GET).
router.post(
  "/explain",
  authenticate,
  authorize(Role.DOCTOR, Role.ADMIN),
  explainRateLimit,
  validate(explainBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { labOrderId, language } = req.body as z.infer<typeof explainBodySchema>;

      // 1. Fetch LabOrder with items.results and patient info
      const labOrder = await prisma.labOrder.findUnique({
        where: { id: labOrderId },
        include: {
          items: {
            include: {
              results: true,
            },
          },
          patient: {
            select: {
              id: true,
              userId: true,
              age: true,
              gender: true,
            },
          },
        },
      });

      if (!labOrder) {
        res.status(404).json({ success: false, data: null, error: "Lab order not found" });
        return;
      }

      // 2. Flatten results from all order items
      // security(2026-05-04): F-INJ-1 — defense-in-depth: report-explainer.ts
      // already sanitizes each lab field internally, but the lab values come
      // from external LIS systems so we pre-sanitize at the route boundary
      // too. Catches injection markers before they cross the service line.
      const labResults = labOrder.items.flatMap((item) =>
        item.results.map((r) => ({
          parameter: sanitizeUserInput(r.parameter, { maxLen: 200 }),
          value: sanitizeUserInput(r.value, { maxLen: 200 }),
          unit: r.unit ? sanitizeUserInput(r.unit, { maxLen: 50 }) : undefined,
          normalRange: r.normalRange
            ? sanitizeUserInput(r.normalRange, { maxLen: 100 })
            : undefined,
          flag: sanitizeUserInput(r.flag as string, { maxLen: 40 }),
        }))
      );

      if (labResults.length === 0) {
        res.status(400).json({ success: false, data: null, error: "No lab results found for this order" });
        return;
      }

      // Approximate prompt size for the audit row — sum of every sanitized
      // field plus a small per-row overhead. Cheap; not PHI on its own.
      const promptSize = labResults.reduce(
        (n, r) =>
          n +
          r.parameter.length +
          r.value.length +
          (r.unit?.length ?? 0) +
          (r.normalRange?.length ?? 0) +
          r.flag.length,
        0
      );

      // 3. Call AI explainer
      const inferenceStartedAt = Date.now();
      const { explanation, flaggedValues } = await explainLabReport({
        labResults,
        patientAge: labOrder.patient.age ?? undefined,
        patientGender: labOrder.patient.gender as string | undefined,
        language,
      });

      // security(2026-05-04): F-REX-3 — audit Sarvam inference with model,
      // prompt/response sizes and latency. No PHI in the audit row.
      safeAudit(
        req,
        "AI_REPORT_EXPLAINER_INFERENCE",
        "LabOrder",
        labOrderId,
        {
          model: SARVAM_MODEL,
          promptSize,
          responseSize:
            (explanation?.length ?? 0) +
            JSON.stringify(flaggedValues ?? []).length,
          latencyMs: Date.now() - inferenceStartedAt,
          language,
          resultCount: labResults.length,
          flaggedCount: (flaggedValues ?? []).length,
        }
      );

      // 4. Upsert LabReportExplanation keyed on labOrderId
      const record = await prisma.labReportExplanation.upsert({
        where: { labOrderId },
        create: {
          labOrderId,
          patientId: labOrder.patient.id,
          explanation,
          flaggedValues: flaggedValues as any,
          language,
          status: "PENDING_REVIEW",
        },
        update: {
          explanation,
          flaggedValues: flaggedValues as any,
          language,
          status: "PENDING_REVIEW",
          approvedBy: null,
          approvedAt: null,
          sentAt: null,
        },
      });

      // 5. Return the explanation + status
      res.status(201).json({
        success: true,
        data: {
          id: record.id,
          labOrderId: record.labOrderId,
          explanation: record.explanation,
          flaggedValues: record.flaggedValues,
          language: record.language,
          status: record.status,
          createdAt: record.createdAt,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/ai/reports/:explanationId/approve
router.patch(
  "/:explanationId/approve",
  authenticate,
  authorize(Role.DOCTOR, Role.ADMIN),
  validateUuidParams(["explanationId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { explanationId } = req.params;

      // 1. Update to APPROVED
      const approved = await prisma.labReportExplanation.update({
        where: { id: explanationId },
        data: {
          status: "APPROVED",
          approvedBy: req.user!.userId,
          approvedAt: new Date(),
        },
      });

      // 2. Fetch patient userId for notification
      const patient = await prisma.patient.findUnique({
        where: { id: approved.patientId },
        select: { userId: true },
      });

      if (patient?.userId) {
        // 3. Send notification to patient
        await sendNotification({
          userId: patient.userId,
          type: NotificationType.APPOINTMENT_REMINDER, // closest available type as fallback
          title: "Your Lab Report Explanation is Ready",
          message:
            approved.explanation.slice(0, 200) +
            (approved.explanation.length > 200 ? "..." : ""),
          data: { labOrderId: approved.labOrderId },
        });
      }

      // 4. Update to SENT
      const sent = await prisma.labReportExplanation.update({
        where: { id: explanationId },
        data: {
          status: "SENT",
          sentAt: new Date(),
        },
      });

      res.json({
        success: true,
        data: sent,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/reports/pending
router.get(
  "/pending",
  authenticate,
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pending = await prisma.labReportExplanation.findMany({
        where: { status: "PENDING_REVIEW" },
        orderBy: { createdAt: "desc" },
      });

      safeAudit(req, "AI_LAB_EXPLANATION_READ", "LabReportExplanation", undefined, {
        filter: "PENDING_REVIEW",
        resultCount: pending.length,
      });

      res.json({
        success: true,
        data: pending,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/reports/:labOrderId
router.get(
  "/:labOrderId",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { labOrderId } = req.params;

      const explanation = await prisma.labReportExplanation.findUnique({
        where: { labOrderId },
      });

      if (!explanation) {
        res.status(404).json({ success: false, data: null, error: "Explanation not found for this lab order" });
        return;
      }

      // security(2026-05-04, issue #511): per-row ownership check — patient
      // may only view their own explanation. Replaced the inline lookup with
      // the shared `assertPatientOwnsResource` helper so the BOLA contract
      // matches the rest of the codebase (admissions, surgery, lab, telemed,
      // prescriptions). Staff roles (DOCTOR/ADMIN) pass through unchanged.
      if (!(await assertPatientOwnsResource(req, res, explanation.patientId))) return;

      safeAudit(req, "AI_LAB_EXPLANATION_READ", "LabReportExplanation", explanation.id, {
        labOrderId,
        status: explanation.status,
      });

      res.json({
        success: true,
        data: explanation,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiReportExplainerRouter };
