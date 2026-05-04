/**
 * AI KPIs Dashboard — admin-only KPI bundle for AI features 1 (Booking) + 2 (Scribe).
 *
 * What this exercises:
 *   /dashboard/ai-kpis (apps/web/src/app/dashboard/ai-kpis/page.tsx)
 *   GET /api/v1/ai/kpis/feature1?from=&to= (apps/api/src/routes/ai-kpis.ts)
 *   GET /api/v1/ai/kpis/feature2?from=&to= (apps/api/src/routes/ai-kpis.ts)
 *   GET /api/v1/ai/kpis/export?from=&to=  (CSV)
 *
 * Surfaces touched:
 *   - ADMIN: lands on the page, sees title + from/to date inputs + tab strip
 *     (booking / scribe / export). Each feature renders 7 KpiCards keyed by
 *     data-testid, with on-target / off-target / unavailable visual states.
 *   - PATIENT, DOCTOR, NURSE, RECEPTION: page.tsx:296 short-circuits to the
 *     `ai-kpis-admin-gate` placeholder ("admin only") when user.role !== ADMIN.
 *     The page itself stays mounted (no /not-authorized redirect).
 *
 * Why these tests exist:
 *   Closes docs/E2E_COVERAGE_BACKLOG.md §2.8 entry
 *   "/dashboard/ai-kpis — KPI dashboard configuration" by pinning the actual
 *   page shape: KPI bundles for AI Feature 1 (smart booking) + Feature 2
 *   (clinical scribe), the date-range refresh control, the booking/scribe/
 *   export tab strip, and the admin-gate placeholder for non-ADMIN roles.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, gotoAuthed } from "./helpers";

function kpiResult(
  current: number,
  target: number,
  direction: "up" | "down",
  extras: Partial<{
    baseline: number;
    sampleSize: number;
    unit: "pct" | "count" | "seconds" | "minutes" | "rating";
    unavailable: true;
    reason: string;
  }> = {}
) {
  return {
    current,
    target,
    target_direction: direction,
    ...extras,
  };
}

function feature1Bundle() {
  return {
    misroutedOpdAppointments: kpiResult(0.04, 0.05, "down", {
      unit: "pct",
      sampleSize: 250,
      baseline: 0.09,
    }),
    bookingCompletionRate: kpiResult(0.82, 0.75, "up", {
      unit: "pct",
      sampleSize: 1024,
    }),
    patientCsatAiFlow: kpiResult(4.31, 4.0, "up", {
      unit: "rating",
      sampleSize: 412,
    }),
    top1AcceptanceRate: kpiResult(0.71, 0.6, "up", {
      unit: "pct",
      sampleSize: 1024,
    }),
    timeToConfirmedAppointment: kpiResult(180, 300, "down", {
      unit: "seconds",
      sampleSize: 980,
    }),
    redFlagFalseNegativeRate: kpiResult(0.001, 0.005, "down", {
      unit: "pct",
      sampleSize: 1024,
    }),
    frontDeskCallVolume: kpiResult(120, 200, "down", {
      unit: "count",
      sampleSize: 30,
    }),
  };
}

function feature2Bundle() {
  return {
    doctorDocTimeReduction: kpiResult(0.32, 0.25, "up", {
      unit: "pct",
      sampleSize: 88,
    }),
    doctorAdoption: kpiResult(0.68, 0.6, "up", {
      unit: "pct",
      sampleSize: 50,
    }),
    soapAcceptanceRate: kpiResult(0.91, 0.85, "up", {
      unit: "pct",
      sampleSize: 220,
    }),
    drugAlertInducedChanges: kpiResult(12, 5, "up", {
      unit: "count",
      sampleSize: 88,
    }),
    medicationErrorRateComparison: kpiResult(0.02, 0.05, "down", {
      unit: "pct",
      sampleSize: 220,
    }),
    doctorNpsForScribe: kpiResult(0, 30, "up", {
      unavailable: true,
      reason: "Survey window has not opened yet.",
      sampleSize: 0,
    }),
    timeToSignOff: kpiResult(45, 60, "down", {
      unit: "seconds",
      sampleSize: 220,
    }),
  };
}

test.describe("AI KPIs Dashboard — /dashboard/ai-kpis (ADMIN-only KPI bundles for booking + scribe + CSV export)", () => {
  test("ADMIN lands on the page with title, date inputs and the booking/scribe/export tab strip", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/kpis/feature1**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { from: "", to: "", bundle: feature1Bundle() },
          error: null,
        }),
      })
    );
    await page.route("**/api/v1/ai/kpis/feature2**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { from: "", to: "", bundle: feature2Bundle() },
          error: null,
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/ai-kpis");
    await dismissTourIfPresent(page);

    await expect(page.locator('[data-testid="ai-kpis-title"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="ai-kpis-from"]')).toBeVisible();
    await expect(page.locator('[data-testid="ai-kpis-to"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="ai-kpis-refresh"]')
    ).toBeVisible();

    // Tab strip — three tabs by data-testid.
    await expect(
      page.locator('[data-testid="ai-kpis-tab-booking"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="ai-kpis-tab-scribe"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="ai-kpis-tab-export"]')
    ).toBeVisible();
  });

  test("ADMIN sees Feature 1 KpiCards on the booking tab with on-target / off-target chips and rendered current values", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/kpis/feature1**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { from: "", to: "", bundle: feature1Bundle() },
          error: null,
        }),
      })
    );
    await page.route("**/api/v1/ai/kpis/feature2**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { from: "", to: "", bundle: feature2Bundle() },
          error: null,
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/ai-kpis");
    await dismissTourIfPresent(page);

    // Booking is the default active tab; the panel should render directly.
    await expect(
      page.locator('[data-testid="ai-kpis-feature1-panel"]')
    ).toBeVisible({ timeout: 15_000 });

    // 7 cards in Feature 1 — pin the data-testids on the page.
    const feature1Cards = [
      "kpi-misrouted",
      "kpi-booking-completion",
      "kpi-csat",
      "kpi-top1-acceptance",
      "kpi-time-to-confirm",
      "kpi-red-flag-fn",
      "kpi-front-desk",
    ];
    for (const tid of feature1Cards) {
      await expect(page.locator(`[data-testid="${tid}"]`)).toBeVisible();
    }

    // Booking-completion is on-target (current 0.82 >= target 0.75).
    await expect(
      page.locator('[data-testid="kpi-booking-completion"]')
    ).toHaveAttribute("data-state", "on-target");

    // The "current" value renders in the formatted form (% for unit=pct).
    await expect(
      page.locator('[data-testid="kpi-booking-completion-current"]')
    ).toContainText(/82\.0%/);
  });

  test("ADMIN switching to the Scribe tab swaps the panel and renders Feature 2 KpiCards including the unavailable Doctor-NPS card", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/kpis/feature1**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { from: "", to: "", bundle: feature1Bundle() },
          error: null,
        }),
      })
    );
    await page.route("**/api/v1/ai/kpis/feature2**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { from: "", to: "", bundle: feature2Bundle() },
          error: null,
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/ai-kpis");
    await dismissTourIfPresent(page);

    await expect(
      page.locator('[data-testid="ai-kpis-feature1-panel"]')
    ).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="ai-kpis-tab-scribe"]').click();

    await expect(
      page.locator('[data-testid="ai-kpis-feature2-panel"]')
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-testid="ai-kpis-feature1-panel"]')
    ).toHaveCount(0);

    // 7 cards in Feature 2.
    const feature2Cards = [
      "kpi-doc-time",
      "kpi-doctor-adoption",
      "kpi-soap-acceptance",
      "kpi-rx-changes",
      "kpi-med-err",
      "kpi-doctor-nps",
      "kpi-time-to-signoff",
    ];
    for (const tid of feature2Cards) {
      await expect(page.locator(`[data-testid="${tid}"]`)).toBeVisible();
    }

    // Doctor-NPS is unavailable per the fixture.
    await expect(page.locator('[data-testid="kpi-doctor-nps"]')).toHaveAttribute(
      "data-state",
      "unavailable"
    );
  });

  test("ADMIN export tab reveals the CSV download button (clicking it issues a /export request)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/kpis/feature1**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { from: "", to: "", bundle: feature1Bundle() },
          error: null,
        }),
      })
    );
    await page.route("**/api/v1/ai/kpis/feature2**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { from: "", to: "", bundle: feature2Bundle() },
          error: null,
        }),
      })
    );

    let exportHits = 0;
    await page.route("**/api/v1/ai/kpis/export**", (route) => {
      exportHits++;
      route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: {
          "Content-Disposition": 'attachment; filename="ai-kpis.csv"',
        },
        body: "metric,value\nbookingCompletionRate,0.82\n",
      });
    });

    await gotoAuthed(page, "/dashboard/ai-kpis");
    await dismissTourIfPresent(page);

    await page.locator('[data-testid="ai-kpis-tab-export"]').click();
    await expect(
      page.locator('[data-testid="ai-kpis-export-panel"]')
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-testid="ai-kpis-export-btn"]')
    ).toBeVisible();

    await page.locator('[data-testid="ai-kpis-export-btn"]').click();
    await expect.poll(() => exportHits, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  });

  test("PATIENT visiting /dashboard/ai-kpis hits the admin-only gate placeholder (page.tsx:296 short-circuit, no /not-authorized redirect)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/ai-kpis");

    // The page renders the admin-gate placeholder rather than the KPI grid.
    await expect(
      page.locator('[data-testid="ai-kpis-admin-gate"]')
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-testid="ai-kpis-feature1-panel"]')
    ).toHaveCount(0);
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("DOCTOR is also gated by the same client-side admin-only check (Role.DOCTOR is outside the ADMIN allow-set on page.tsx:296)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/ai-kpis");

    await expect(
      page.locator('[data-testid="ai-kpis-admin-gate"]')
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-testid="ai-kpis-feature2-panel"]')
    ).toHaveCount(0);
  });

  test("error envelope from /feature1 surfaces the error banner without crashing the page", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/kpis/feature1**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          data: null,
          error: "KPI compute failed",
        }),
      })
    );
    await page.route("**/api/v1/ai/kpis/feature2**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          data: null,
          error: "KPI compute failed",
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/ai-kpis");
    await dismissTourIfPresent(page);

    await expect(page.locator('[data-testid="ai-kpis-error"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator('[data-testid="ai-kpis-feature1-panel"]')
    ).toHaveCount(0);
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
