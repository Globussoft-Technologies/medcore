import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { searchPatientChart, searchCohort } from "../services/ai/chart-search";

const router = Router();
router.use(authenticate);

// ── POST /api/v1/ai/chart-search/patient/:patientId ───────────────────────────
// Doctor (or admin) natural-language search over a single patient's chart.
router.post(
  "/patient/:patientId",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId } = req.params;
      const {
        query,
        limit,
        documentTypes,
        synthesize,
      } = (req.body ?? {}) as {
        query?: string;
        limit?: number;
        documentTypes?: string[];
        synthesize?: boolean;
      };

      if (!query || typeof query !== "string" || !query.trim()) {
        res.status(400).json({ success: false, data: null, error: "query is required" });
        return;
      }

      const result = await searchPatientChart(
        query.trim(),
        patientId,
        { userId: req.user!.userId, role: req.user!.role },
        { limit, documentTypes, synthesize }
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        query,
        limit,
        documentTypes,
        dateFrom,
        dateTo,
        synthesize,
      } = (req.body ?? {}) as {
        query?: string;
        limit?: number;
        documentTypes?: string[];
        dateFrom?: string;
        dateTo?: string;
        synthesize?: boolean;
      };

      if (!query || typeof query !== "string" || !query.trim()) {
        res.status(400).json({ success: false, data: null, error: "query is required" });
        return;
      }

      const result = await searchCohort(
        query.trim(),
        { userId: req.user!.userId, role: req.user!.role },
        {
          limit,
          documentTypes,
          dateFrom: dateFrom ? new Date(dateFrom) : undefined,
          dateTo: dateTo ? new Date(dateTo) : undefined,
          synthesize,
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
