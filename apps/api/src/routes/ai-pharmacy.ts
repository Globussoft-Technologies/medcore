import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { validateUuidParams } from "../middleware/validate-params";
import {
  forecastInventory,
  forecastSingleItem,
  getAIInsights,
  type ItemForecast,
} from "../services/ai/pharmacy-forecast";

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

export const aiPharmacyRouter = Router();

// All routes require authentication
aiPharmacyRouter.use(authenticate);
// #511 audit (file-level, 2026-05-09): router-level
// `authorize(Role.ADMIN, Role.PHARMACIST)` excludes PATIENT from every
// handler in this file. Verified-safe.
aiPharmacyRouter.use(authorize(Role.ADMIN, Role.PHARMACIST));

const URGENCY_ORDER: Record<string, number> = { CRITICAL: 0, LOW: 1, OK: 2 };

function sortForecasts(forecasts: ItemForecast[]): ItemForecast[] {
  return [...forecasts].sort((a, b) => {
    const uDiff = (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3);
    if (uDiff !== 0) return uDiff;
    return a.daysOfStockLeft - b.daysOfStockLeft;
  });
}

// GET /api/v1/ai/pharmacy/forecast
// Query params: days=30, urgency=CRITICAL|LOW|OK, insights=true
aiPharmacyRouter.get(
  "/forecast",
  async (req: Request, res: Response, next: NextFunction) => {
    // security(2026-05-04-med): F-PH-* — stamp an AI-inference audit row on
    // every forecast call so a Sarvam-bill spike can be traced to the caller
    // who triggered the (optional) `getAIInsights` LLM summary. We always
    // stamp regardless of `withInsights` because the Holt-Winters forecast
    // itself counts as an AI feature for security-team accounting purposes.
    const startedAt = Date.now();
    try {
      const days = parseInt((req.query.days as string) || "30", 10) || 30;
      const urgencyFilter = req.query.urgency as string | undefined;
      const withInsights = req.query.insights === "true";

      let forecasts = await forecastInventory(days);

      // Filter by urgency if provided
      if (urgencyFilter && ["CRITICAL", "LOW", "OK"].includes(urgencyFilter)) {
        forecasts = forecasts.filter(
          (f) => f.urgency === urgencyFilter
        );
      }

      // Sort: CRITICAL first, then LOW, then OK; within each group by daysOfStockLeft asc
      forecasts = sortForecasts(forecasts);

      let insights: string | undefined;
      if (withInsights) {
        insights = await getAIInsights(forecasts);
      }

      safeAudit(req, "AI_PHARMACY_FORECAST_READ", "InventoryItem", undefined, {
        days,
        urgencyFilter: urgencyFilter ?? null,
        withInsights,
        resultCount: forecasts.length,
      });

      safeAudit(req, "AI_PHARMACY_INFERENCE", "InventoryItem", undefined, {
        days,
        urgencyFilter: urgencyFilter ?? null,
        withInsights,
        resultCount: forecasts.length,
        responseBytes: insights ? insights.length : 0,
        latencyMs: Date.now() - startedAt,
        model: "sarvam-105b",
        success: true,
      });

      res.json({
        success: true,
        data: {
          forecast: forecasts,
          ...(insights !== undefined ? { insights } : {}),
          generatedAt: new Date().toISOString(),
        },
        error: null,
      });
    } catch (err) {
      safeAudit(req, "AI_PHARMACY_INFERENCE", "InventoryItem", undefined, {
        latencyMs: Date.now() - startedAt,
        model: "sarvam-105b",
        success: false,
        failure: true,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      next(err);
    }
  }
);

// GET /api/v1/ai/pharmacy/forecast/:inventoryItemId
// Single item forecast with 90-day movement history
aiPharmacyRouter.get(
  "/forecast/:inventoryItemId",
  // security(2026-04-23-med): F-PH-2 — reject non-UUID :inventoryItemId up
  // front so prisma.findUnique doesn't have to handle malformed ids.
  validateUuidParams(["inventoryItemId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    // security(2026-05-04-med): F-PH-* — single-item forecast uses the same
    // Holt-Winters engine as the bulk endpoint; stamp an AI-inference audit
    // row so per-item investigations are traceable.
    const startedAt = Date.now();
    try {
      const { inventoryItemId } = req.params;

      const item = await forecastSingleItem(inventoryItemId, 30);

      if (!item) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Inventory item not found or has no stock/consumption data",
        });
        return;
      }

      // Fetch 90-day movement history for the item
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const { prisma } = await import("@medcore/db");
      const movements = await prisma.stockMovement.findMany({
        where: {
          inventoryItemId,
          createdAt: { gte: ninetyDaysAgo },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          quantity: true,
          reason: true,
          createdAt: true,
        },
      });

      safeAudit(req, "AI_PHARMACY_FORECAST_READ", "InventoryItem", inventoryItemId, {
        movementCount: movements.length,
      });

      safeAudit(req, "AI_PHARMACY_INFERENCE", "InventoryItem", inventoryItemId, {
        movementCount: movements.length,
        latencyMs: Date.now() - startedAt,
        model: "sarvam-105b",
        success: true,
      });

      res.json({
        success: true,
        data: {
          forecast: item,
          movements,
          generatedAt: new Date().toISOString(),
        },
        error: null,
      });
    } catch (err) {
      safeAudit(req, "AI_PHARMACY_INFERENCE", "InventoryItem", undefined, {
        latencyMs: Date.now() - startedAt,
        model: "sarvam-105b",
        success: false,
        failure: true,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      next(err);
    }
  }
);
