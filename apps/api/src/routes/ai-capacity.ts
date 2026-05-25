// AI capacity forecasting routes (PRD §7.3 — bed / OT / ICU demand).
//
// Multi-tenant wiring: `tenantScopedPrisma` auto-injects tenantId on create
// and auto-filters on read for tenant-scoped models (Ward, Bed, Admission,
// Surgery).  The forecasting service uses the alias internally.
//
// All endpoints require authentication. Role matrix:
//   GET /beds  — ADMIN, NURSE
//   GET /ot    — ADMIN
//   GET /icu   — ADMIN, NURSE
import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { requireFeature } from "../middleware/feature-flag";
import {
  forecastBedOccupancy,
  forecastICUDemand,
  forecastOTUtilization,
  type CapacityHorizonHours,
} from "../services/ai/capacity-forecast";

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

function parseHorizon(raw: unknown): CapacityHorizonHours | null {
  const n = parseInt(String(raw ?? "72"), 10);
  if (n === 24 || n === 48 || n === 72) return n;
  return null;
}

export const aiCapacityRouter = Router();

aiCapacityRouter.use(authenticate);
// Pearl §6 + §18 (gap item #9 — audit fix-up #3, 2026-05-25): AI capacity
// forecasting (bed/OT/ICU) is a Stage-2 paid feature. Pearl-branded tenants
// set `aiCapacity=false` and every capacity route 404s before authorize.
aiCapacityRouter.use(requireFeature("aiCapacity"));
// #511 audit (file-level, 2026-05-09): every handler applies
// `authorize(Role.ADMIN, Role.NURSE)` (or ADMIN-only for OT). PATIENT
// excluded from capacity-forecast surfaces. Verified-safe.

// GET /api/v1/ai/capacity/beds?horizon=24|48|72
aiCapacityRouter.get(
  "/beds",
  authorize(Role.ADMIN, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const horizon = parseHorizon(req.query.horizon);
      if (horizon === null) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Query param 'horizon' must be one of 24, 48, 72",
        });
        return;
      }

      const result = await forecastBedOccupancy({ horizonHours: horizon });

      safeAudit(req, "AI_CAPACITY_BEDS_READ", "Ward", undefined, {
        horizon,
        wardCount: result.forecasts.length,
        anyStockoutRisk: result.summary.anyStockoutRisk,
      });

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/capacity/ot?horizon=24|48|72
aiCapacityRouter.get(
  "/ot",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const horizon = parseHorizon(req.query.horizon);
      if (horizon === null) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Query param 'horizon' must be one of 24, 48, 72",
        });
        return;
      }

      const result = await forecastOTUtilization({ horizonHours: horizon });

      safeAudit(req, "AI_CAPACITY_OT_READ", "OperatingTheater", undefined, {
        horizon,
        otCount: result.forecasts.length,
        anyStockoutRisk: result.summary.anyStockoutRisk,
      });

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/capacity/icu?horizon=24|48|72
aiCapacityRouter.get(
  "/icu",
  authorize(Role.ADMIN, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const horizon = parseHorizon(req.query.horizon);
      if (horizon === null) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Query param 'horizon' must be one of 24, 48, 72",
        });
        return;
      }

      const result = await forecastICUDemand({ horizonHours: horizon });

      safeAudit(req, "AI_CAPACITY_ICU_READ", "Ward", undefined, {
        horizon,
        wardCount: result.forecasts.length,
        anyStockoutRisk: result.summary.anyStockoutRisk,
      });

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);
