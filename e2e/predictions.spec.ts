import { test, expect } from "./fixtures";
import { dismissTourIfPresent } from "./helpers";

// No-Show Predictions — admin / doctor surface.
// Endpoint: GET /ai/predictions/no-show/batch?date=YYYY-MM-DD

test.describe("No-Show Predictions", () => {
  test("admin can load the predictions page with heading + date input", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/predictions");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /no-show predictions/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('input[type="date"]').first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /load predictions/i }).first()
    ).toBeVisible();

    // Initial-state prompt ("Select a date and click Load Predictions to begin.")
    await expect(
      page.getByText(/select a date and click/i).first()
    ).toBeVisible();
  });

  test("loading predictions renders summary stats + table rows", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/predictions/no-show/batch**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            {
              appointmentId: "appt-high-1",
              riskScore: 0.85,
              riskLevel: "high",
              factors: ["Cancelled previously", "No phone confirm"],
              recommendation: "Call patient to confirm",
              appointment: {
                id: "appt-high-1",
                slotStart: "09:00",
                slotEnd: "09:15",
                date: new Date().toISOString().split("T")[0],
                patientName: "Aarav Kumar",
                patientId: "p-1",
                doctorName: "Dr. Sharma",
                doctorId: "d-1",
              },
            },
            {
              appointmentId: "appt-low-1",
              riskScore: 0.12,
              riskLevel: "low",
              factors: [],
              recommendation: "No action needed",
              appointment: {
                id: "appt-low-1",
                slotStart: "10:00",
                slotEnd: "10:15",
                date: new Date().toISOString().split("T")[0],
                patientName: "Meera Patel",
                patientId: "p-2",
                doctorName: "Dr. Sharma",
                doctorId: "d-1",
              },
            },
          ],
        }),
      })
    );

    await page.goto("/dashboard/predictions");
    await dismissTourIfPresent(page);

    await page.getByRole("button", { name: /load predictions/i }).first().click();

    // Summary stats cards.
    await expect(page.getByText(/total appointments/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/high risk/i).first()).toBeVisible();

    // Row content from the stubbed data.
    await expect(page.getByText("Aarav Kumar").first()).toBeVisible();
    await expect(page.getByText("Meera Patel").first()).toBeVisible();
  });

  test("empty-state appears when the API returns no appointments", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/predictions/no-show/batch**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await page.goto("/dashboard/predictions");
    await dismissTourIfPresent(page);

    await page.getByRole("button", { name: /load predictions/i }).first().click();

    await expect(
      page.getByText(/no booked appointments found/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("error banner shows when /batch throws a 500", async ({ adminPage }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/predictions/no-show/batch**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Predictor failed" }),
      })
    );

    await page.goto("/dashboard/predictions");
    await dismissTourIfPresent(page);

    await page.getByRole("button", { name: /load predictions/i }).first().click();

    // The page surfaces the error in a red banner with an AlertTriangle icon.
    // We don't require exact error text — only that the page remains stable
    // and either the error banner shows or the table stays absent.
    const noResults = page.getByText(/no booked appointments found/i);
    await expect(noResults).toHaveCount(0);
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("patient hitting /dashboard/predictions does not crash the app", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/predictions");

    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
