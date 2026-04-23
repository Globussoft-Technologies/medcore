import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import {
  forecastInventory,
  forecastSingleItem,
  getAIInsights,
  type ItemForecast,
} from "../services/ai/pharmacy-forecast";

export const aiPharmacyRouter = Router();

// All routes require authentication
aiPharmacyRouter.use(authenticate);
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
      next(err);
    }
  }
);

// GET /api/v1/ai/pharmacy/forecast/:inventoryItemId
// Single item forecast with 90-day movement history
aiPharmacyRouter.get(
  "/forecast/:inventoryItemId",
  async (req: Request, res: Response, next: NextFunction) => {
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
      next(err);
    }
  }
);
