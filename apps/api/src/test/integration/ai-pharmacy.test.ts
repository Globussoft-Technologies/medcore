// Integration tests for the AI Pharmacy forecasting router (/api/v1/ai/pharmacy).
// pharmacy-forecast service is mocked — no SARVAM_API_KEY required.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createMedicineFixture, createInventoryFixture } from "../factories";

import type { ItemForecast } from "../../services/ai/pharmacy-forecast";

const MOCK_FORECASTS: ItemForecast[] = [
  {
    inventoryItemId: "item-critical",
    medicineName: "Paracetamol 500mg",
    currentStock: 10,
    avgDailyConsumption: 5,
    predictedConsumption7d: 35,
    predictedConsumption30d: 150,
    predictedConsumption60d: 300,
    predictedConsumption90d: 450,
    predictedConsumption30dUpper: 180,
    daysOfStockLeft: 2,
    reorderRecommended: true,
    suggestedReorderQty: 140,
    urgency: "CRITICAL",
    stockoutRisk: true,
    deadStock: false,
    method: "holt-winters",
  },
  {
    inventoryItemId: "item-low",
    medicineName: "Amoxicillin 250mg",
    currentStock: 50,
    avgDailyConsumption: 5,
    predictedConsumption7d: 35,
    predictedConsumption30d: 150,
    predictedConsumption60d: 300,
    predictedConsumption90d: 450,
    predictedConsumption30dUpper: 180,
    daysOfStockLeft: 10,
    reorderRecommended: true,
    suggestedReorderQty: 100,
    urgency: "LOW",
    stockoutRisk: true,
    deadStock: false,
    method: "holt-winters",
  },
  {
    inventoryItemId: "item-ok",
    medicineName: "Cetirizine 10mg",
    currentStock: 500,
    avgDailyConsumption: 5,
    predictedConsumption7d: 35,
    predictedConsumption30d: 150,
    predictedConsumption60d: 300,
    predictedConsumption90d: 450,
    predictedConsumption30dUpper: 180,
    daysOfStockLeft: 100,
    reorderRecommended: false,
    suggestedReorderQty: 0,
    urgency: "OK",
    stockoutRisk: false,
    deadStock: false,
    method: "holt-winters",
  },
];

vi.mock("../../services/ai/pharmacy-forecast", () => ({
  forecastInventory: vi.fn().mockResolvedValue(MOCK_FORECASTS),
  getAIInsights: vi
    .fn()
    .mockResolvedValue("- Reorder Paracetamol immediately\n- Consider topping up Amoxicillin"),
}));

let app: any;
let adminToken: string;
let pharmacistToken: string;
let doctorToken: string;
let patientToken: string;

describeIfDB("AI Pharmacy API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    pharmacistToken = await getAuthToken("PHARMACIST");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── GET /forecast ────────────────────────────────────────────────────

  it("returns a sorted inventory forecast for ADMIN (CRITICAL first)", async () => {
    const res = await request(app)
      .get("/api/v1/ai/pharmacy/forecast")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.forecast)).toBe(true);
    expect(res.body.data.forecast.length).toBe(3);
    // CRITICAL should come first
    expect(res.body.data.forecast[0].urgency).toBe("CRITICAL");
    expect(res.body.data.forecast[1].urgency).toBe("LOW");
    expect(res.body.data.forecast[2].urgency).toBe("OK");
    expect(res.body.data.generatedAt).toBeTruthy();
    expect(res.body.data.insights).toBeUndefined();
  });

  it("returns a forecast for PHARMACIST role", async () => {
    const res = await request(app)
      .get("/api/v1/ai/pharmacy/forecast")
      .set("Authorization", `Bearer ${pharmacistToken}`);

    expect(res.status).toBe(200);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/ai/pharmacy/forecast");
    expect(res.status).toBe(401);
  });

  it("rejects DOCTOR role (403) — only ADMIN/PHARMACIST allowed", async () => {
    const res = await request(app)
      .get("/api/v1/ai/pharmacy/forecast")
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(403);
  });

  it("rejects PATIENT role (403)", async () => {
    const res = await request(app)
      .get("/api/v1/ai/pharmacy/forecast")
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(403);
  });

  it("filters forecast by urgency=CRITICAL", async () => {
    const res = await request(app)
      .get("/api/v1/ai/pharmacy/forecast?urgency=CRITICAL")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.forecast.length).toBe(1);
    expect(res.body.data.forecast[0].urgency).toBe("CRITICAL");
  });

  it("ignores an invalid urgency filter and returns all items", async () => {
    const res = await request(app)
      .get("/api/v1/ai/pharmacy/forecast?urgency=SUPER_CRITICAL")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.forecast.length).toBe(3);
  });

  it("includes AI insights when insights=true", async () => {
    const { getAIInsights } = await import("../../services/ai/pharmacy-forecast");
    vi.mocked(getAIInsights).mockClear();

    const res = await request(app)
      .get("/api/v1/ai/pharmacy/forecast?insights=true")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.insights).toContain("Reorder");
    expect(vi.mocked(getAIInsights)).toHaveBeenCalledOnce();
  });

  it("passes custom days parameter through to forecastInventory", async () => {
    const { forecastInventory } = await import("../../services/ai/pharmacy-forecast");
    vi.mocked(forecastInventory).mockClear();

    const res = await request(app)
      .get("/api/v1/ai/pharmacy/forecast?days=60")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(vi.mocked(forecastInventory)).toHaveBeenCalledWith(60);
  });

  // ─── GET /forecast/:inventoryItemId ───────────────────────────────────

  it("returns a single-item forecast with movement history", async () => {
    // Create a real inventory item and stock movement to verify the join works
    const prisma = await getPrisma();
    const medicine = await createMedicineFixture();
    const inventory = await createInventoryFixture({ medicineId: medicine.id });
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    await prisma.stockMovement.create({
      data: {
        inventoryItemId: inventory.id,
        type: "DISPENSED",
        quantity: -5,
        reason: "OPD dispensing",
        performedBy: admin!.id,
      },
    });

    // Override mock to return a forecast entry for this real item
    const { forecastInventory } = await import("../../services/ai/pharmacy-forecast");
    vi.mocked(forecastInventory).mockResolvedValueOnce([
      {
        ...MOCK_FORECASTS[0],
        inventoryItemId: inventory.id,
        medicineName: medicine.name,
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/ai/pharmacy/forecast/${inventory.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.forecast.inventoryItemId).toBe(inventory.id);
    expect(Array.isArray(res.body.data.movements)).toBe(true);
    expect(res.body.data.movements.length).toBeGreaterThan(0);
    expect(res.body.data.movements[0].type).toBe("DISPENSED");
  });

  it("returns 404 for an inventory item not in the forecast", async () => {
    const res = await request(app)
      .get("/api/v1/ai/pharmacy/forecast/nonexistent-item-id-xyz")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("rejects PATIENT role on single-item forecast (403)", async () => {
    const res = await request(app)
      .get("/api/v1/ai/pharmacy/forecast/whatever")
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(403);
  });
});
