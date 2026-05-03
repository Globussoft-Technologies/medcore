import { test, expect } from "./fixtures";
import { dismissTourIfPresent, gotoAuthed } from "./helpers";

// Pharmacy Inventory Forecast — admin surface.
// Endpoint: GET /ai/pharmacy/forecast?days=30[&insights=true]

test.describe("Pharmacy Forecast", () => {
  test("admin can load the page with heading + controls", async ({
    adminPage,
  }) => {
    const page = adminPage;
    // gotoAuthed: WebKit auth-race v4 guard — retries if the layout bounces
    // to /login before /auth/me completes on this second navigation.
    await gotoAuthed(page, "/dashboard/pharmacy-forecast");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /inventory forecast/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Days-ahead selector and Load Forecast button anchor the UI.
    await expect(page.locator("#days-select")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /load forecast/i }).first()
    ).toBeVisible();

    // Initial prompt renders before any load.
    await expect(page.getByText(/click .*load forecast/i).first()).toBeVisible();
  });

  test("loading a forecast renders summary pills + a table", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/pharmacy/forecast**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            forecast: [
              {
                inventoryItemId: "it-1",
                medicineName: "Paracetamol 500mg",
                currentStock: 40,
                avgDailyConsumption: 12,
                predictedConsumption7d: 84,
                predictedConsumption30d: 360,
                daysOfStockLeft: 3.3,
                reorderRecommended: true,
                suggestedReorderQty: 400,
                urgency: "CRITICAL",
              },
              {
                inventoryItemId: "it-2",
                medicineName: "Amoxicillin 250mg",
                currentStock: 800,
                avgDailyConsumption: 5,
                predictedConsumption7d: 35,
                predictedConsumption30d: 150,
                daysOfStockLeft: 160,
                reorderRecommended: false,
                suggestedReorderQty: 0,
                urgency: "OK",
              },
            ],
            generatedAt: new Date().toISOString(),
          },
          error: null,
        }),
      })
    );

    await page.goto("/dashboard/pharmacy-forecast");
    await dismissTourIfPresent(page);

    await page.getByRole("button", { name: /load forecast/i }).first().click();

    // Summary pills.
    await expect(page.getByText(/critical/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/low stock/i).first()).toBeVisible();
    // Table row from the stubbed data.
    await expect(page.getByText(/paracetamol 500mg/i).first()).toBeVisible();
    await expect(page.getByText(/amoxicillin 250mg/i).first()).toBeVisible();
  });

  test("empty-state message when forecast returns zero rows", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/pharmacy/forecast**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { forecast: [], generatedAt: new Date().toISOString() },
          error: null,
        }),
      })
    );

    await page.goto("/dashboard/pharmacy-forecast");
    await dismissTourIfPresent(page);

    await page.getByRole("button", { name: /load forecast/i }).first().click();

    await expect(
      page.getByText(/no inventory items found for forecasting/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("error banner shows when /forecast returns a failure envelope", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/pharmacy/forecast**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          data: { forecast: [], generatedAt: new Date().toISOString() },
          error: "Forecast service unavailable",
        }),
      })
    );

    await page.goto("/dashboard/pharmacy-forecast");
    await dismissTourIfPresent(page);

    await page.getByRole("button", { name: /load forecast/i }).first().click();

    await expect(
      page.getByText(/forecast service unavailable|error/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("patient hitting /dashboard/pharmacy-forecast stays stable (no crash)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/pharmacy-forecast");

    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
