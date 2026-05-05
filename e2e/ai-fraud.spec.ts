/**
 * AI Fraud & Anomaly Alerts — billing/anomaly investigation surface for
 * ADMIN + RECEPTION; reads from the FraudAlert table; ADMIN can trigger a
 * fresh scan + re-open terminal alerts.
 *
 * What this exercises:
 *   /dashboard/ai-fraud (apps/web/src/app/dashboard/ai-fraud/page.tsx, 676 lines)
 *   GET   /api/v1/ai/fraud/alerts           (apps/api/src/routes/ai-fraud.ts)
 *   POST  /api/v1/ai/fraud/scan             (ADMIN-only)
 *   PATCH /api/v1/ai/fraud/alerts/:id/status
 *
 * Surfaces touched:
 *   - ADMIN: chrome (h1 + filters + Run-Scan-Now CTA + Scan-Window input),
 *     table render with status pill + per-row expand, ADMIN-only "Run Scan
 *     Now" button + windowDays input.
 *   - RECEPTION: chrome + filters render (canRead is true) but ADMIN-only
 *     CTA + windowDays input are hidden.
 *   - PATIENT / DOCTOR / NURSE: page.tsx:478 short-circuits to an inline
 *     "Restricted — fraud alerts are only visible to admin and reception
 *     staff." placeholder. The page itself stays mounted (NO /not-authorized
 *     redirect) — same archetype as ai-kpis-admin-gate. The placeholder is
 *     reachable via data-testid="ai-fraud-page" with the Restricted text.
 *
 * Why these tests exist:
 *   Closes docs/E2E_COVERAGE_BACKLOG.md §2.8 entry
 *   "/dashboard/ai-fraud — fraud-case investigation (smoke-visited)" by
 *   pinning the actual page shape (ADMIN/RECEPTION investigator surface +
 *   inline Restricted placeholder for everyone else), the ADMIN-only Run
 *   Scan CTA + windowDays input, the row-level status pill + expand
 *   contract, and the empty-state path.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, gotoAuthed } from "./helpers";

function alertFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "alert-1",
    type: "DUPLICATE_BILLING",
    severity: "HIGH_RISK",
    status: "NEW",
    entityType: "Bill",
    entityId: "bill-99",
    description: "Two identical bills issued within 90s for the same patient.",
    evidence: { llmReason: "Same line items, same patient, no refund record." },
    detectedAt: "2026-05-05T10:00:00.000Z",
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolutionNote: null,
    ...overrides,
  };
}

test.describe("AI Fraud & Anomaly Alerts — /dashboard/ai-fraud (ADMIN/RECEPTION investigator surface + inline Restricted placeholder for everyone else)", () => {
  test("ADMIN lands on the page with title, severity/status filters, scan-window input and the Run Scan Now CTA", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/fraud/alerts**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [alertFixture()],
          error: null,
          meta: { page: 1, limit: 50, total: 1 },
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/ai-fraud");
    await dismissTourIfPresent(page);

    await expect(page.locator('[data-testid="ai-fraud-page"]'))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /Fraud .* Anomaly Alerts/i }))
      .toBeVisible();

    // ADMIN-only chrome — Run Scan Now + scan-window input.
    await expect(page.getByRole("button", { name: /Run Scan Now/i })).toBeVisible();
    await expect(page.locator("#ai-fraud-window-days")).toBeVisible();

    // Filters — by id (not bare locator('select') per CLAUDE.md gotcha #9).
    await expect(page.locator("#ai-fraud-severity")).toBeVisible();
    await expect(page.locator("#ai-fraud-status")).toBeVisible();
  });

  test("ADMIN with one alert in the list sees the row, the per-row status pill, and clicking it expands the comment thread", async ({
    adminPage,
  }) => {
    const page = adminPage;

    const alert = alertFixture({ id: "alert-row-1" });
    await page.route("**/api/v1/ai/fraud/alerts**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [alert],
          error: null,
          meta: { page: 1, limit: 50, total: 1 },
        }),
      })
    );
    // Comment thread fetch on row expand.
    await page.route("**/api/v1/ai/fraud/alerts/alert-row-1/comments**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    await gotoAuthed(page, "/dashboard/ai-fraud");
    await dismissTourIfPresent(page);

    const row = page.locator('[data-testid="ai-fraud-row-alert-row-1"]');
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Status pill renders (NEW state) — buttonised because canWrite is true
    // for ADMIN, so the testid is on the <button> with the alertId suffix.
    await expect(
      page.locator('[data-testid="ai-fraud-status-alert-row-1"]')
    ).toBeVisible();

    // Click the chevron cell (first td) to expand → details/comments
    // row appears. Clicking the row's center can land on the status
    // pill button (page.tsx:233 has e.stopPropagation()) and miss the
    // row-level onClick that toggles expandedId.
    await row.locator("td").first().click();
    await expect(
      page.locator('[data-testid="ai-fraud-details-alert-row-1"]')
    ).toBeVisible({ timeout: 5_000 });
  });

  test("RECEPTION lands on the same investigator chrome but the ADMIN-only Run Scan + windowDays controls are hidden", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    await page.route("**/api/v1/ai/fraud/alerts**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [],
          error: null,
          meta: { page: 1, limit: 50, total: 0 },
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/ai-fraud");
    await dismissTourIfPresent(page);

    await expect(page.locator('[data-testid="ai-fraud-page"]'))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /Fraud .* Anomaly Alerts/i }))
      .toBeVisible();

    // Filters render for RECEPTION (canRead === true).
    await expect(page.locator("#ai-fraud-severity")).toBeVisible();
    await expect(page.locator("#ai-fraud-status")).toBeVisible();

    // ADMIN-only controls are gone.
    await expect(page.getByRole("button", { name: /Run Scan Now/i })).toHaveCount(0);
    await expect(page.locator("#ai-fraud-window-days")).toHaveCount(0);
  });

  test("PATIENT visiting /dashboard/ai-fraud hits the inline Restricted placeholder (page.tsx:478 short-circuit, no /not-authorized redirect)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/ai-fraud");

    // The page renders the Restricted placeholder rather than the alerts table.
    // page.tsx:481 keeps the data-testid="ai-fraud-page" wrapper on this branch
    // too, but the table + filters never mount — only the Restricted copy.
    await expect(page.locator('[data-testid="ai-fraud-page"]'))
      .toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/Restricted .* admin and reception staff/i)
    ).toBeVisible();
    await expect(page.locator("#ai-fraud-severity")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Run Scan Now/i })).toHaveCount(0);
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("DOCTOR is also gated by the same client-side investigator-only check (Role.DOCTOR is outside ADMIN/RECEPTION on page.tsx:382)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/ai-fraud");

    await expect(
      page.getByText(/Restricted .* admin and reception staff/i)
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /Run Scan Now/i })).toHaveCount(0);
  });

  test("ADMIN with zero alerts sees the empty-state shield ('No matching alerts') keyed by data-testid='fraud-empty-state'", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/fraud/alerts**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [],
          error: null,
          meta: { page: 1, limit: 50, total: 0 },
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/ai-fraud");
    await dismissTourIfPresent(page);

    await expect(page.locator('[data-testid="fraud-empty-state"]'))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/No matching alerts/i)).toBeVisible();
  });
});
