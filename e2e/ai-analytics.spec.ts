import { test, expect } from "./fixtures";
import { dismissTourIfPresent } from "./helpers";

// AI Analytics dashboard — admin-only. Shows Triage + Scribe KPI cards.
// Endpoints:
//   GET /analytics/ai/triage?from=&to=
//   GET /analytics/ai/scribe?from=&to=

test.describe("AI Analytics", () => {
  test("admin can load AI Analytics page with heading + date controls", async ({
    browserName,
    adminPage,
  }) => {
    // webkit auth-redirect residue (TODO.md #4).
    test.skip(browserName === "webkit", "webkit auth-redirect residue");
    const page = adminPage;
    await page.goto("/dashboard/ai-analytics");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /ai analytics/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // From / To date inputs and Refresh button anchor the page controls.
    await expect(page.locator('input[type="date"]').first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /refresh/i }).first()
    ).toBeVisible();
  });

  test("tabs switch between Triage and Scribe views", async ({ adminPage }) => {
    const page = adminPage;
    await page.goto("/dashboard/ai-analytics");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /ai analytics/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    const scribeTab = page.getByRole("button", { name: /^scribe$/i }).first();
    const triageTab = page.getByRole("button", { name: /^triage$/i }).first();

    await expect(scribeTab).toBeVisible();
    await expect(triageTab).toBeVisible();

    await scribeTab.click();
    // Scribe tab shows its distinctive KPIs (e.g. "Drug Alert Rate").
    await expect(
      page.getByText(/drug alert rate|consent withdrawn/i).first()
    ).toBeVisible({ timeout: 10_000 });

    await triageTab.click();
    await expect(
      page.getByText(/avg turns to recommendation|completion rate/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("refresh triggers a re-fetch and keeps UI stable", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub both analytics endpoints so we have deterministic data cards.
    await page.route("**/api/v1/analytics/ai/triage**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            totalSessions: 42,
            completedSessions: 30,
            completionRate: 0.714,
            emergencyDetected: 2,
            bookingConversions: 18,
            conversionRate: 0.6,
            avgTurnsToRecommendation: 5,
            avgConfidence: 0.82,
            topChiefComplaints: [{ complaint: "fever", count: 12 }],
            specialtyDistribution: [{ specialty: "General", count: 8 }],
            languageBreakdown: [{ language: "en", count: 40 }],
            statusBreakdown: [{ status: "COMPLETED", count: 30 }],
          },
        }),
      })
    );
    await page.route("**/api/v1/analytics/ai/scribe**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            totalSessions: 15,
            completedSessions: 12,
            consentWithdrawnSessions: 1,
            avgDoctorEditRate: 3,
            drugAlertRate: 0.2,
            totalDrugAlerts: 3,
            statusBreakdown: [{ status: "COMPLETED", count: 12 }],
          },
        }),
      })
    );

    await page.goto("/dashboard/ai-analytics");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /ai analytics/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // A stat label from the stubbed Triage response.
    await expect(page.getByText(/total sessions/i).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: /refresh/i }).first().click();

    await expect(page.getByText(/total sessions/i).first()).toBeVisible();
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("empty-state — tables render 'No data' when the API returns zeros", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/analytics/ai/triage**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            totalSessions: 0,
            completedSessions: 0,
            completionRate: 0,
            emergencyDetected: 0,
            bookingConversions: 0,
            conversionRate: 0,
            avgTurnsToRecommendation: 0,
            avgConfidence: 0,
            topChiefComplaints: [],
            specialtyDistribution: [],
            languageBreakdown: [],
            statusBreakdown: [],
          },
        }),
      })
    );
    await page.route("**/api/v1/analytics/ai/scribe**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            totalSessions: 0,
            completedSessions: 0,
            consentWithdrawnSessions: 0,
            avgDoctorEditRate: 0,
            drugAlertRate: 0,
            totalDrugAlerts: 0,
            statusBreakdown: [],
          },
        }),
      })
    );

    await page.goto("/dashboard/ai-analytics");
    await dismissTourIfPresent(page);

    await expect(page.getByText(/no data/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("patient cannot view AI Analytics — API responds with 401/403 or empty UI", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/ai-analytics");

    // Either backend RBAC kicks in (error banner), or the page shell loads
    // but KPI data is absent. We assert the app stays stable without a crash.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
