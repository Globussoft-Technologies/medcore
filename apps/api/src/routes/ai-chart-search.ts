import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { validateUuidParams } from "../middleware/validate-params";
import { auditLog } from "../middleware/audit";
import { rateLimit } from "../middleware/rate-limit";
import { searchPatientChart, searchCohort } from "../services/ai/chart-search";

// ── Zod schemas ────────────────────────────────────────────────────────────

const patientChartSearchSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  documentTypes: z.array(z.string()).optional(),
  synthesize: z.boolean().optional(),
  rerank: z.boolean().optional(),
});

const cohortSearchSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  documentTypes: z.array(z.string()).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  synthesize: z.boolean().optional(),
  rerank: z.boolean().optional(),
});

const router = Router();
router.use(authenticate);
// security(2026-04-23-med): F-CS-2 — chart-search hits FTS + rerank + Sarvam
// synthesize on every call. Cap to 30/min/IP so a compromised clinician
// token cannot burn Sarvam budget (global limit is 600/min, way too loose).
if (process.env.NODE_ENV !== "test") {
  router.use(rateLimit(30, 60_000));
}

// ── POST /api/v1/ai/chart-search/patient/:patientId ───────────────────────────
// Doctor (or admin) natural-language search over a single patient's chart.
router.post(
  "/patient/:patientId",
  authorize(Role.DOCTOR, Role.ADMIN),
  validateUuidParams(["patientId"]),
  validate(patientChartSearchSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId } = req.params;
      const { query, limit, documentTypes, synthesize, rerank } = req.body as z.infer<typeof patientChartSearchSchema>;

      const result = await searchPatientChart(
        query.trim(),
        patientId,
        { userId: req.user!.userId, role: req.user!.role },
        { limit, documentTypes, synthesize, rerank }
      );

      await auditLog(req, "AI_CHART_SEARCH_PATIENT", "Patient", patientId, {
        query: query.slice(0, 200),
        hits: result.totalHits,
      });

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      if ((err as any)?.statusCode === 403) {
        res.status(403).json({ success: false, data: null, error: (err as Error).message });
        return;
      }
      next(err);
    }
  }
);

// ── POST /api/v1/ai/chart-search/cohort ───────────────────────────────────────
// Cross-patient cohort search, scoped to the doctor's own panel.
router.post(
  "/cohort",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(cohortSearchSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { query, limit, documentTypes, dateFrom, dateTo, synthesize, rerank } =
        req.body as z.infer<typeof cohortSearchSchema>;

      const result = await searchCohort(
        query.trim(),
        { userId: req.user!.userId, role: req.user!.role },
        {
          limit,
          documentTypes,
          dateFrom: dateFrom ? new Date(dateFrom) : undefined,
          dateTo: dateTo ? new Date(dateTo) : undefined,
          synthesize,
          rerank,
        }
      );

      await auditLog(req, "AI_CHART_SEARCH_COHORT", "Cohort", undefined, {
        query: query.slice(0, 200),
        hits: result.totalHits,
        patientCount: result.patientIds.length,
      });

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiChartSearchRouter };
