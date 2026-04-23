// Pharmacy Inventory Demand Forecasting Service.
//
// The forecasting engine pulls the last 180 days of outflow stock movements
// per medicine, aggregates them into a daily consumption series, and fits a
// Holt-Winters triple exponential smoothing model with weekly seasonality.
// The resulting 30/60/90-day forecast drives reorder, stockout and dead-stock
// flags.  The Sarvam LLM layer (`getAIInsights`) is preserved for qualitative
// summaries of the top items.

import OpenAI from "openai";
import { prisma } from "@medcore/db";
import { StockMovementType } from "@prisma/client";
import { holtWinters, sumForecast, type HoltWintersResult } from "./ml/holt-winters";

// Sarvam AI — India-region servers, DPDP-compliant
const sarvam = new OpenAI({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  baseURL: "https://api.sarvam.ai/v1",
});

// Outflow movement types (consumption/dispensing)
const OUTFLOW_TYPES: StockMovementType[] = [
  StockMovementType.DISPENSED,
  StockMovementType.EXPIRED,
  StockMovementType.DAMAGED,
];

/** Window of history used to fit the model. */
const HISTORY_DAYS = 180;
/** Safety buffer applied on top of the point forecast when flagging stockouts. */
const SAFETY_BUFFER_DAYS = 7;

/** Demand forecast for a single pharmacy inventory item. */
export interface ItemForecast {
  inventoryItemId: string;
  medicineName: string;
  currentStock: number;
  avgDailyConsumption: number; // units/day over the history window
  /** Point forecast of total consumption over the next 7 days. */
  predictedConsumption7d: number;
  /** Point forecast of total consumption over the next 30 days. */
  predictedConsumption30d: number;
  /** Point forecast of total consumption over the next 60 days. */
  predictedConsumption60d: number;
  /** Point forecast of total consumption over the next 90 days. */
  predictedConsumption90d: number;
  /** 95% upper bound on 30-day consumption (used for stockout flagging). */
  predictedConsumption30dUpper: number;
  daysOfStockLeft: number;
  reorderRecommended: boolean;
  suggestedReorderQty: number;
  urgency: "OK" | "LOW" | "CRITICAL";
  /** True when the current stock is likely to run out within 30 days. */
  stockoutRisk: boolean;
  /** True when forecasted demand is ~0 but inventory is high (dead stock). */
  deadStock: boolean;
  /** Which method produced the forecast — "holt-winters" or "fallback-mean". */
  method: "holt-winters" | "fallback-mean";
}

/**
 * Build a daily consumption series from a list of movements.  Each movement
 * contributes its absolute outflow quantity to the day it occurred.  Days
 * with no movements are zero-filled so the series has exactly `days` entries
 * ending on `now`.
 */
export function buildDailySeries(
  movements: Array<{ createdAt: Date | string; quantity: number; type: StockMovementType }>,
  days: number,
  now: Date = new Date()
): number[] {
  const series = new Array<number>(days).fill(0);
  const msPerDay = 1000 * 60 * 60 * 24;
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  for (const m of movements) {
    const createdAt = m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt);
    if (createdAt < start || createdAt > end) continue;
    const isOutflow =
      m.quantity < 0 || OUTFLOW_TYPES.includes(m.type);
    if (!isOutflow) continue;
    const qty = Math.abs(m.quantity);
    const dayIdx = Math.floor((createdAt.getTime() - start.getTime()) / msPerDay);
    if (dayIdx >= 0 && dayIdx < days) {
      series[dayIdx] += qty;
    }
  }
  return series;
}

/**
 * Fit a Holt-Winters model on the series and return a horizon-length forecast.
 * Falls back to a flat mean forecast if the series is too short or the fit
 * produces non-finite results (e.g., all-zero series).
 */
export function forecastSeries(
  series: number[],
  horizon: number,
  weeklySeasonality: boolean = true,
  monthlySeasonality: boolean = false
): { result: HoltWintersResult | null; method: "holt-winters" | "fallback-mean" } {
  // Need at least 2 full periods of history to seed seasonality reliably.
  const period = monthlySeasonality ? 30 : weeklySeasonality ? 7 : 0;
  const minLen = period > 0 ? period * 2 : 3;

  const sum = series.reduce((s, v) => s + v, 0);
  const allZero = sum === 0;

  if (series.length < minLen || allZero) {
    const mean = series.length > 0 ? sum / series.length : 0;
    const fb: HoltWintersResult = {
      forecast: Array.from({ length: horizon }, () => ({
        yhat: mean,
        lower: mean,
        upper: mean,
      })),
      level: mean,
      trend: 0,
      seasonal: [],
      sigma: 0,
      fitted: new Array(series.length).fill(mean),
    };
    return { result: fb, method: "fallback-mean" };
  }

  try {
    const res = holtWinters(series, horizon, {
      period,
      alpha: 0.3,
      beta: 0.05,
      gamma: 0.1,
    });
    // Guard against NaN/Inf from pathological series
    for (const p of res.forecast) {
      if (!isFinite(p.yhat)) {
        throw new Error("non-finite forecast");
      }
    }
    return { result: res, method: "holt-winters" };
  } catch {
    const mean = sum / series.length;
    const fb: HoltWintersResult = {
      forecast: Array.from({ length: horizon }, () => ({
        yhat: mean,
        lower: mean,
        upper: mean,
      })),
      level: mean,
      trend: 0,
      seasonal: [],
      sigma: 0,
      fitted: new Array(series.length).fill(mean),
    };
    return { result: fb, method: "fallback-mean" };
  }
}

/** Clamp a forecasted count to a non-negative integer (consumption cannot be negative). */
function clampNonNeg(n: number): number {
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/**
 * Forecast pharmacy inventory demand for every inventory item using
 * Holt-Winters triple exponential smoothing with weekly seasonality.
 * Items with no stock and no consumption history are excluded.  The function
 * signature is unchanged from the previous rule-based version so existing
 * routes need no modification.
 *
 * @param daysAhead Forecast horizon in days used to populate the headline
 *                  `predictedConsumption30d` field.  Defaults to 30.
 */
export async function forecastInventory(daysAhead = 30): Promise<ItemForecast[]> {
  const now = new Date();
  const historyStart = new Date(now);
  historyStart.setDate(historyStart.getDate() - HISTORY_DAYS);

  const items = await prisma.inventoryItem.findMany({
    include: {
      medicine: { select: { name: true } },
    },
  });

  const forecasts: ItemForecast[] = [];

  for (const item of items) {
    const movements = await prisma.stockMovement.findMany({
      where: {
        inventoryItemId: item.id,
        createdAt: { gte: historyStart },
        OR: [
          { quantity: { lt: 0 } },
          { type: { in: OUTFLOW_TYPES } },
        ],
      },
      select: { createdAt: true, quantity: true, type: true },
    });

    const forecast = buildItemForecast(item, movements, daysAhead, now);
    if (forecast) forecasts.push(forecast);
  }

  return forecasts;
}

/**
 * Build an {@link ItemForecast} for a single inventory item.  Extracted so
 * both the batch {@link forecastInventory} loop and the single-item route
 * (`GET /pharmacy/forecast/:inventoryItemId`) can share the Holt-Winters
 * pipeline without scanning the whole catalog.
 */
function buildItemForecast(
  item: { id: string; quantity: number; medicine: { name: string } },
  movements: Array<{ createdAt: Date | string; quantity: number; type: StockMovementType }>,
  daysAhead: number,
  now: Date
): ItemForecast | null {
  const currentStock = item.quantity;

  const series = buildDailySeries(movements, HISTORY_DAYS, now);
  const totalOut = series.reduce((s, v) => s + v, 0);
  const avgDailyConsumption = totalOut / HISTORY_DAYS;

  // Skip items with no stock and no consumption
  if (currentStock <= 0 && totalOut === 0) return null;

  const horizon = Math.max(90, daysAhead);
  const { result: fit, method } = forecastSeries(series, horizon, true, false);
  const fc = fit!.forecast;

  const sum7 = clampNonNeg(sumForecast({ ...fit!, forecast: fc.slice(0, 7) }).yhat);
  const sum30 = clampNonNeg(sumForecast({ ...fit!, forecast: fc.slice(0, 30) }).yhat);
  const sum60 = clampNonNeg(sumForecast({ ...fit!, forecast: fc.slice(0, 60) }).yhat);
  const sum90 = clampNonNeg(sumForecast({ ...fit!, forecast: fc.slice(0, 90) }).yhat);
  const upper30Raw = sumForecast({ ...fit!, forecast: fc.slice(0, 30) }).upper;
  const sum30Upper = clampNonNeg(upper30Raw);

  const avgForecastDaily = horizon > 0 ? sum90 / 90 : avgDailyConsumption;
  const daysOfStockLeft =
    avgForecastDaily > 0 ? currentStock / avgForecastDaily : Infinity;

  const reorderRecommended = daysOfStockLeft < 14;
  const suggestedReorderQty = Math.max(0, sum30 - currentStock);

  let urgency: "OK" | "LOW" | "CRITICAL";
  if (daysOfStockLeft < 7) urgency = "CRITICAL";
  else if (daysOfStockLeft < 14) urgency = "LOW";
  else urgency = "OK";

  const safetyBufferQty = clampNonNeg(avgForecastDaily * SAFETY_BUFFER_DAYS);
  const stockoutRisk = sum30 + safetyBufferQty > currentStock;

  const deadStock =
    sum90 <= Math.max(1, Math.round(avgDailyConsumption)) && currentStock >= 50;

  return {
    inventoryItemId: item.id,
    medicineName: item.medicine.name,
    currentStock,
    avgDailyConsumption: parseFloat(avgDailyConsumption.toFixed(2)),
    predictedConsumption7d: sum7,
    predictedConsumption30d: sum30,
    predictedConsumption60d: sum60,
    predictedConsumption90d: sum90,
    predictedConsumption30dUpper: sum30Upper,
    daysOfStockLeft:
      daysOfStockLeft === Infinity ? 9999 : parseFloat(daysOfStockLeft.toFixed(1)),
    reorderRecommended,
    suggestedReorderQty,
    urgency,
    stockoutRisk,
    deadStock,
    method,
  };
}

/**
 * Forecast demand for a single inventory item without running the full
 * catalog scan.  Returns `null` when the item does not exist or has neither
 * stock nor consumption history (same skip rule as {@link forecastInventory}).
 *
 * @param inventoryItemId The id of the inventory item to forecast.
 * @param daysAhead Forecast horizon (same semantics as {@link forecastInventory}).
 */
export async function forecastSingleItem(
  inventoryItemId: string,
  daysAhead = 30
): Promise<ItemForecast | null> {
  const now = new Date();
  const historyStart = new Date(now);
  historyStart.setDate(historyStart.getDate() - HISTORY_DAYS);

  const item = await prisma.inventoryItem.findUnique({
    where: { id: inventoryItemId },
    include: {
      medicine: { select: { name: true } },
    },
  });

  if (!item) return null;

  const movements = await prisma.stockMovement.findMany({
    where: {
      inventoryItemId: item.id,
      createdAt: { gte: historyStart },
      OR: [
        { quantity: { lt: 0 } },
        { type: { in: OUTFLOW_TYPES } },
      ],
    },
    select: { createdAt: true, quantity: true, type: true },
  });

  return buildItemForecast(item, movements, daysAhead, now);
}

/**
 * Ask Sarvam AI to summarise the top 10 most urgent inventory items from a
 * forecast result set as 3-5 actionable bullet points for the pharmacy
 * manager.  Unchanged from the rule-based version.
 *
 * @param forecasts Output of {@link forecastInventory}.
 */
export async function getAIInsights(forecasts: ItemForecast[]): Promise<string> {
  const urgencyOrder = { CRITICAL: 0, LOW: 1, OK: 2 } as const;
  const sorted = [...forecasts].sort((a, b) => {
    const uDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    if (uDiff !== 0) return uDiff;
    return a.daysOfStockLeft - b.daysOfStockLeft;
  });

  const top10 = sorted.slice(0, 10);

  const summaryLines = top10.map(
    (f, i) =>
      `${i + 1}. ${f.medicineName}: stock=${f.currentStock} units, ` +
      `avgDailyUse=${f.avgDailyConsumption} units/day, ` +
      `daysLeft=${f.daysOfStockLeft === 9999 ? "inf" : f.daysOfStockLeft}, ` +
      `urgency=${f.urgency}, suggestedReorder=${f.suggestedReorderQty} units` +
      (f.stockoutRisk ? ", stockoutRisk=yes" : "") +
      (f.deadStock ? ", deadStock=yes" : "")
  );

  const prompt = `You are a pharmacy inventory management assistant. Given these Holt-Winters demand forecasts, provide a brief (3-5 bullet points) actionable summary for the pharmacy manager, highlighting critical items and suggested actions.

Inventory data (top ${top10.length} items by urgency):
${summaryLines.join("\n")}

Provide concise, actionable bullet points.`;

  const response = await sarvam.chat.completions.create({
    model: "sarvam-105b",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 500,
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content ?? "Unable to generate insights.";
}
