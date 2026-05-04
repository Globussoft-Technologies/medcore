/**
 * Capacity Forecast — admin/nurse dashboard, /dashboard/capacity-forecast.
 *
 * What this exercises:
 *   /dashboard/capacity-forecast (apps/web/src/app/dashboard/capacity-forecast/page.tsx)
 *   GET /api/v1/ai/capacity/{beds,icu,ot}?horizon=24|48|72 (apps/api/src/routes/ai-capacity.ts)
 *
 * Surfaces touched:
 *   - ADMIN: lands on the page, sees heading + horizon toggle (24/48/72) +
 *     three resource tabs (beds/icu/ot) and a refreshable forecast.
 *   - NURSE: also allowed by `authorize(Role.ADMIN, Role.NURSE)` for /beds and
 *     /icu (per ai-capacity.ts:47/109). Page chrome renders fine; OT tab is
 *     ADMIN-only at the API layer.
 *   - PATIENT/RECEPTION: page chrome is NOT client-gated (CLAUDE.md gotcha #7
 *     — many dashboard pages have no `VIEW_ALLOWED` constant). They see the
 *     header + tabs but the forecast fetch errors on the API side; the page
 *     surfaces the error banner rather than redirecting.
 *
 * Why these tests exist:
 *   Closes docs/E2E_COVERAGE_BACKLOG.md §2.7 entry
 *   "/dashboard/capacity-forecast — forecast editing (smoke-visited)" by
 *   pinning the actual page shape (Holt-Winters demand forecast for beds /
 *   ICU / OT with a 24/48/72h horizon toggle and a heatmap of expected
 *   occupancy %), not just smoke-visiting it.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, gotoAuthed } from "./helpers";

function bedsFixture() {
  return {
    success: true,
    data: {
      horizonHours: 72,
      generatedAt: new Date().toISOString(),
      forecasts: [
        {
          resourceId: "ward-gen-1",
          resourceName: "General Ward A",
          resourceType: "ward",
          capacityUnits: 30,
          currentlyInUse: 18,
          plannedReleases: 4,
          predictedInflow: 6,
          predictedInflowUpper: 9,
          expectedOccupancyPct: 67,
          expectedStockout: false,
          confidence: "high",
          method: "holt-winters",
          insufficientData: false,
        },
        {
          resourceId: "ward-icu-1",
          resourceName: "ICU South",
          resourceType: "ward",
          capacityUnits: 12,
          currentlyInUse: 11,
          plannedReleases: 0,
          predictedInflow: 3,
          predictedInflowUpper: 5,
          expectedOccupancyPct: 117,
          expectedStockout: true,
          confidence: "medium",
          method: "holt-winters",
          insufficientData: false,
        },
      ],
      summary: {
        totalCapacity: 42,
        totalCurrentlyInUse: 29,
        totalPredictedInflow: 9,
        totalPredictedInflowUpper: 14,
        aggregateOccupancyPct: 81,
        anyStockoutRisk: true,
        wardsAtRisk: 1,
      },
    },
    error: null,
  };
}

function emptyFixture(resourceType: "ward" | "ot") {
  return {
    success: true,
    data: {
      horizonHours: 24,
      generatedAt: new Date().toISOString(),
      forecasts: [],
      summary: {
        totalCapacity: 0,
        totalCurrentlyInUse: 0,
        totalPredictedInflow: 0,
        totalPredictedInflowUpper: 0,
        aggregateOccupancyPct: 0,
        anyStockoutRisk: false,
        wardsAtRisk: 0,
      },
    },
    error: null,
  };
}

test.describe("Capacity Forecast — /dashboard/capacity-forecast (24/48/72h horizon × beds/ICU/OT tabs)", () => {
  test("ADMIN lands on the page with heading + horizon toggle + three resource tabs visible", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub the default-tab fetch (beds@72h) so the test doesn't rely on real
    // data being seeded.
    await page.route("**/api/v1/ai/capacity/beds**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(bedsFixture()),
      })
    );

    await gotoAuthed(page, "/dashboard/capacity-forecast");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /capacity forecast/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Horizon toggles render as buttons whose label is "24h" / "48h" / "72h".
    await expect(page.getByRole("button", { name: /^24h$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^48h$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^72h$/ })).toBeVisible();

    // Three resource tabs by data-testid (page.tsx:155).
    await expect(page.locator('[data-testid="capacity-tab-beds"]')).toBeVisible();
    await expect(page.locator('[data-testid="capacity-tab-icu"]')).toBeVisible();
    await expect(page.locator('[data-testid="capacity-tab-ot"]')).toBeVisible();
  });

  test("ADMIN switching to ICU + OT tabs triggers the matching capacity endpoint", async ({
    adminPage,
  }) => {
    const page = adminPage;

    let bedsHits = 0;
    let icuHits = 0;
    let otHits = 0;
    await page.route("**/api/v1/ai/capacity/beds**", (route) => {
      bedsHits++;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(bedsFixture()),
      });
    });
    await page.route("**/api/v1/ai/capacity/icu**", (route) => {
      icuHits++;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(bedsFixture()),
      });
    });
    await page.route("**/api/v1/ai/capacity/ot**", (route) => {
      otHits++;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyFixture("ot")),
      });
    });

    await gotoAuthed(page, "/dashboard/capacity-forecast");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /capacity forecast/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Initial tab is "beds" — that fetch fires immediately on mount.
    await expect.poll(() => bedsHits, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    await page.locator('[data-testid="capacity-tab-icu"]').click();
    await expect.poll(() => icuHits, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    await page.locator('[data-testid="capacity-tab-ot"]').click();
    await expect.poll(() => otHits, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  });

  test("ADMIN sees summary cards + heatmap row labels rendered from the forecast payload", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/capacity/beds**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(bedsFixture()),
      })
    );

    await gotoAuthed(page, "/dashboard/capacity-forecast");
    await dismissTourIfPresent(page);

    // Summary card labels (page.tsx:179/185/191/206).
    await expect(page.getByText(/aggregate occupancy/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/currently in use/i).first()).toBeVisible();
    await expect(page.getByText(/predicted inflow/i).first()).toBeVisible();
    await expect(page.getByText(/stockout risk/i).first()).toBeVisible();

    // Heatmap rows from the stubbed forecast.
    await expect(page.getByText(/general ward a/i).first()).toBeVisible();
    await expect(page.getByText(/icu south/i).first()).toBeVisible();
  });

  test("NURSE can also load the page (allowed for /beds + /icu by authorize(Role.ADMIN, Role.NURSE))", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await page.route("**/api/v1/ai/capacity/beds**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(bedsFixture()),
      })
    );

    await gotoAuthed(page, "/dashboard/capacity-forecast");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /capacity forecast/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="capacity-tab-beds"]')).toBeVisible();
    await expect(page.getByText(/general ward a/i).first()).toBeVisible();
  });

  test("PATIENT visiting the page does not crash and surfaces an error banner (no client-side VIEW_ALLOWED gate)", async ({
    patientPage,
  }) => {
    const page = patientPage;

    // Don't stub — let the real API 403 surface in the page's error banner.
    await page.goto("/dashboard/capacity-forecast");

    // Heading still renders (page chrome is not gated client-side per
    // CLAUDE.md gotcha #7).
    await expect(
      page.getByRole("heading", { name: /capacity forecast/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // No app-crash overlay.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("empty forecast response renders the 'no resources to display' empty state", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/capacity/beds**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyFixture("ward")),
      })
    );

    await gotoAuthed(page, "/dashboard/capacity-forecast");
    await dismissTourIfPresent(page);

    await expect(
      page.getByText(/no resources to display/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("error envelope from /capacity/beds renders the red error banner without crashing", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/capacity/beds**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          data: null,
          error: "Forecast service unavailable",
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/capacity-forecast");
    await dismissTourIfPresent(page);

    await expect(
      page.getByText(/forecast service unavailable|error/i).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
