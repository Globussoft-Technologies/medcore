// Pharmacy Inventory Demand Forecasting Service
// Uses 90-day rolling consumption history to forecast demand and flag reorder needs.

import OpenAI from "openai";
import { prisma } from "@medcore/db";
import { StockMovementType } from "@prisma/client";

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

/** Demand forecast for a single pharmacy inventory item. */
export interface ItemForecast {
  inventoryItemId: string;
  medicineName: string;
  currentStock: number;
  avgDailyConsumption: number;    // units/day over last 90 days
  predictedConsumption7d: number;
  predictedConsumption30d: number;
  daysOfStockLeft: number;        // currentStock / avgDailyConsumption
  reorderRecommended: boolean;    // daysOfStockLeft < 14
  suggestedReorderQty: number;    // 30-day supply minus currentStock, min 0
  urgency: "OK" | "LOW" | "CRITICAL"; // >14d=OK, 7-14d=LOW, <7d=CRITICAL
}

/**
 * Forecast pharmacy inventory demand for all items using the last 90 days of
 * stock outflow movements (DISPENSED, EXPIRED, DAMAGED). Items with no stock
 * and no consumption history are excluded.
 *
 * @param daysAhead Forecast horizon in days used to calculate `predictedConsumption`
 *   fields; defaults to 30.
 */
export async function forecastInventory(daysAhead = 30): Promise<ItemForecast[]> {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  // Fetch all inventory items with their medicine name
  const items = await prisma.inventoryItem.findMany({
    include: {
      medicine: { select: { name: true } },
    },
  });

  const forecasts: ItemForecast[] = [];

  for (const item of items) {
    const currentStock = item.quantity;

    // Fetch outflow movements from last 90 days
    const movements = await prisma.stockMovement.findMany({
      where: {
        inventoryItemId: item.id,
        createdAt: { gte: ninetyDaysAgo },
        OR: [
          { quantity: { lt: 0 } },
          { type: { in: OUTFLOW_TYPES } },
        ],
      },
      select: { quantity: true, type: true },
    });

    // Sum absolute outflow quantities
    const totalOut = movements.reduce((sum, m) => {
      // If quantity is negative it's an outflow; otherwise it's an outflow type with positive qty
      if (m.quantity < 0) return sum + Math.abs(m.quantity);
      if (OUTFLOW_TYPES.includes(m.type as StockMovementType)) return sum + m.quantity;
      return sum;
    }, 0);

    const avgDailyConsumption = totalOut / 90;

    // Skip items with no stock and no consumption
    if (currentStock <= 0 && avgDailyConsumption === 0) continue;

    const predictedConsumption7d = Math.ceil(avgDailyConsumption * 7);
    const predictedConsumption30d = Math.ceil(avgDailyConsumption * daysAhead);

    const daysOfStockLeft =
      avgDailyConsumption > 0
        ? currentStock / avgDailyConsumption
        : Infinity;

    const reorderRecommended = daysOfStockLeft < 14;

    const suggestedReorderQty = Math.max(
      0,
      Math.ceil(avgDailyConsumption * 30) - currentStock
    );

    let urgency: "OK" | "LOW" | "CRITICAL";
    if (daysOfStockLeft < 7) {
      urgency = "CRITICAL";
    } else if (daysOfStockLeft < 14) {
      urgency = "LOW";
    } else {
      urgency = "OK";
    }

    forecasts.push({
      inventoryItemId: item.id,
      medicineName: item.medicine.name,
      currentStock,
      avgDailyConsumption: parseFloat(avgDailyConsumption.toFixed(2)),
      predictedConsumption7d,
      predictedConsumption30d,
      daysOfStockLeft:
        daysOfStockLeft === Infinity ? 9999 : parseFloat(daysOfStockLeft.toFixed(1)),
      reorderRecommended,
      suggestedReorderQty,
      urgency,
    });
  }

  return forecasts;
}

/**
 * Ask Sarvam AI to summarise the top 10 most urgent inventory items from a
 * forecast result set as 3–5 actionable bullet points for the pharmacy manager.
 *
 * @param forecasts Output of {@link forecastInventory}.
 */
export async function getAIInsights(forecasts: ItemForecast[]): Promise<string> {
  // Sort: CRITICAL first, then LOW, then OK; within each group by daysOfStockLeft asc
  const urgencyOrder = { CRITICAL: 0, LOW: 1, OK: 2 };
  const sorted = [...forecasts].sort((a, b) => {
    const uDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    if (uDiff !== 0) return uDiff;
    return a.daysOfStockLeft - b.daysOfStockLeft;
  });

  // Take top 10 most critical
  const top10 = sorted.slice(0, 10);

  const summaryLines = top10.map(
    (f, i) =>
      `${i + 1}. ${f.medicineName}: stock=${f.currentStock} units, ` +
      `avgDailyUse=${f.avgDailyConsumption} units/day, ` +
      `daysLeft=${f.daysOfStockLeft === 9999 ? "∞" : f.daysOfStockLeft}, ` +
      `urgency=${f.urgency}, suggestedReorder=${f.suggestedReorderQty} units`
  );

  const prompt = `You are a pharmacy inventory management assistant. Given these pharmacy inventory forecasts, provide a brief (3-5 bullet points) actionable summary for the pharmacy manager, highlighting critical items and suggested actions.

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
