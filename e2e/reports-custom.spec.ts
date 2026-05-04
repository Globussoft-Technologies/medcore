/**
 * Custom Reports admin-flow + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/reports (apps/web/src/app/dashboard/reports/page.tsx)
 *   GET  /api/v1/billing/reports/daily        (Daily Collection tab first-paint)
 *   GET  /api/v1/analytics/report-runs        (Report History tab fetch + ?type= filter)
 *   POST /api/v1/analytics/report-runs        (Generate modal — ad-hoc run record)
 *   POST /api/v1/scheduled-reports            (Schedule modal — recurring delivery)
 *   GET  /api/v1/analytics/export/revenue.csv (per-row Export CSV trigger)
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome (heading + Daily/History tab strip),
 *     Daily Collection tab fires GET /billing/reports/daily on first paint.
 *   - History tab: type-filter `<select>` re-fires GET /analytics/report-runs
 *     with `?type=WEEKLY_REVENUE` — pin the query-string contract.
 *   - Generate modal (Issue #301): opens with date range + report-type fields,
 *     submitting POSTs `{ reportType, parameters: { from, to }, snapshot, status }`
 *     to /analytics/report-runs. We page.route-stub the POST so seed data
 *     stays clean across runs.
 *   - Schedule modal (Issue #301): opens with name/type/frequency/time/email,
 *     submitting POSTs `{ name, reportType, frequency, timeOfDay, recipients,
 *     active, dayOfWeek? | dayOfMonth? }` to /scheduled-reports. Stubbed
 *     identically so no real ScheduledReport row gets persisted.
 *   - Per-row Export button: stubbed CSV endpoint returns a tiny payload and
 *     the browser fires a download (page.waitForEvent("download")) — pins the
 *     authed-fetch+blob+anchor-click pattern at page.tsx:269-298.
 *   - Non-ADMIN bounce: useEffect at page.tsx:127-132 router.push("/dashboard")
 *     for ANY role !== "ADMIN" (RECEPTION too — even though the render gate at
 *     line 317 is more permissive). This is the 8:1 cron-learning archetype:
 *     redirect target is /dashboard, NOT /dashboard/not-authorized.
 *
 * Why these tests exist:
 *   /dashboard/reports was previously covered ONLY by e2e/reports.spec.ts —
 *   a regression test for Issues #3/#26 (white-screen client-side crash on
 *   null-access through paymentModeBreakdown / recentPayments). That spec is
 *   intentionally narrow: heading-render + no-error-boundary + clean console.
 *   This spec covers the FORWARD-FLOW added by Issue #301: filter wiring,
 *   on-demand generate, recurring schedule create, and CSV export — closes
 *   §5 P6 of docs/E2E_COVERAGE_BACKLOG.md.
 *
 *   Recurring-schedule lifecycle (actual persisted POST + run-now + delete) is
 *   intentionally skipped — it would pollute the shared seed across runs and
 *   that lifecycle is owned by route-handler unit tests at
 *   apps/api/src/routes/scheduled-reports.ts. We pin the request-shape
 *   contract via page.route fulfill instead.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Custom Reports — /dashboard/reports (ADMIN forward-flow: filter wiring + generate + schedule + export, non-ADMIN redirect-bounce to /dashboard)", () => {
  test("ADMIN lands on /dashboard/reports, Billing-Reports heading + tab strip render, GET /billing/reports/daily first-paints the Daily Collection tab", async ({
    adminPage,
  }) => {
    const page = adminPage;

    const dailyPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/billing/reports/daily") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await gotoAuthed(page, "/dashboard/reports");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^billing reports$/i })
    ).toBeVisible({ timeout: 15_000 });

    // Tab strip — both tabs render at all times (page.tsx:344-363).
    await expect(
      page.getByRole("button", { name: /daily collection/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /report history/i })
    ).toBeVisible();

    // First-paint contract: Daily tab is the default and fires the daily GET.
    const dailyRes = await dailyPromise;
    expect(dailyRes.status()).toBeLessThan(400);

    // Daily tab also exposes the date input (page.tsx:332-339).
    await expect(page.locator('input[type="date"]').first()).toBeVisible();
  });

  test("ADMIN switches to Report History tab → GET /analytics/report-runs fires; selecting type=WEEKLY_REVENUE in the filter re-fires with the ?type= query-string pinned", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/reports");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^billing reports$/i })
    ).toBeVisible({ timeout: 15_000 });

    // Switching tabs should fire the unfiltered GET first.
    const initialRunsPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/analytics/report-runs") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.getByRole("button", { name: /report history/i }).click();
    const initialRunsRes = await initialRunsPromise;
    expect(initialRunsRes.status()).toBeLessThan(400);
    // First fetch is the unfiltered fan-out (no type= param).
    expect(initialRunsRes.url()).not.toMatch(/[?&]type=/);

    // Filter `<select>` re-fires the GET with the type query-string. Anchor
    // by data-testid so we don't snag the LanguageDropdown global `<select>`
    // (CLAUDE.md gotcha #9).
    const typeFilter = page.locator('[data-testid="report-type-filter"]');
    await expect(typeFilter).toBeVisible();

    const filteredRunsPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/analytics/report-runs") &&
        r.url().includes("type=WEEKLY_REVENUE") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await typeFilter.selectOption("WEEKLY_REVENUE");
    const filteredRunsRes = await filteredRunsPromise;
    expect(filteredRunsRes.status()).toBeLessThan(400);
  });

  test("ADMIN opens Generate modal on the History tab, fills date range, submits → POST /analytics/report-runs request body shape is pinned (reportType + parameters.from/to + snapshot + SUCCESS status)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub the POST so we don't persist a real ad-hoc run row across runs.
    let capturedBody: Record<string, unknown> | null = null;
    await page.route(/\/api\/v1\/analytics\/report-runs$/, async (route) => {
      if (route.request().method() === "POST") {
        try {
          capturedBody = route.request().postDataJSON() as Record<
            string,
            unknown
          >;
        } catch {
          capturedBody = null;
        }
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              id: "stubbed-run-id",
              reportType: (capturedBody?.reportType as string) ?? "WEEKLY_REVENUE",
              status: "SUCCESS",
              generatedAt: new Date().toISOString(),
            },
          }),
        });
      }
      // Pass through GETs.
      return route.continue();
    });

    await gotoAuthed(page, "/dashboard/reports");
    await expectNotForbidden(page);
    await page.getByRole("button", { name: /report history/i }).click();

    await page.locator('[data-testid="report-generate-btn"]').click();
    await expect(
      page.locator('[data-testid="report-generate-modal"]')
    ).toBeVisible({ timeout: 5_000 });

    // Fill report type + date range. Type select is anchored by testid so
    // it dodges the LanguageDropdown global `<select>` (CLAUDE.md gotcha #9).
    await page
      .locator('[data-testid="report-generate-type"]')
      .selectOption("WEEKLY_REVENUE");
    await page
      .locator('[data-testid="report-generate-from"]')
      .fill("2026-04-01");
    await page
      .locator('[data-testid="report-generate-to"]')
      .fill("2026-04-30");

    await page.locator('[data-testid="report-generate-submit"]').click();

    // Modal closes after the success toast (page.tsx:217-219).
    await expect(
      page.locator('[data-testid="report-generate-modal"]')
    ).toHaveCount(0, { timeout: 10_000 });

    // Pin the request-body shape — page.tsx:211-216.
    expect(capturedBody).not.toBeNull();
    const body = capturedBody as Record<string, unknown>;
    expect(body.reportType).toBe("WEEKLY_REVENUE");
    expect(body.status).toBe("SUCCESS");
    const params = body.parameters as { from?: string; to?: string };
    expect(params?.from).toBe("2026-04-01");
    expect(params?.to).toBe("2026-04-30");
  });

  test("ADMIN opens Schedule modal, fills name/email/WEEKLY frequency, submits → POST /scheduled-reports body shape pinned (recipients[], active=true, dayOfWeek=1 for WEEKLY)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    let capturedBody: Record<string, unknown> | null = null;
    await page.route(/\/api\/v1\/scheduled-reports(\?|$)/, async (route) => {
      if (route.request().method() === "POST") {
        try {
          capturedBody = route.request().postDataJSON() as Record<
            string,
            unknown
          >;
        } catch {
          capturedBody = null;
        }
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              id: "stubbed-schedule-id",
              name: (capturedBody?.name as string) ?? "Stubbed Schedule",
            },
          }),
        });
      }
      return route.continue();
    });

    await gotoAuthed(page, "/dashboard/reports");
    await expectNotForbidden(page);
    await page.getByRole("button", { name: /report history/i }).click();

    await page.locator('[data-testid="report-schedule-btn"]').click();
    await expect(
      page.locator('[data-testid="report-schedule-modal"]')
    ).toBeVisible({ timeout: 5_000 });

    // Fill all required fields. Use a stable schedule name (no Date.now() —
    // CLAUDE.md gotcha #8 only forbids digits in patient/user-name fields,
    // but a stable label keeps the assertion simple either way).
    await page
      .locator('[data-testid="report-schedule-name"]')
      .fill("E2E Weekly Revenue Stub");
    await page
      .locator('[data-testid="report-schedule-type"]')
      .selectOption("WEEKLY_REVENUE");
    await page
      .locator('[data-testid="report-schedule-frequency"]')
      .selectOption("WEEKLY");
    await page.locator('[data-testid="report-schedule-time"]').fill("09:30");
    await page
      .locator('[data-testid="report-schedule-email"]')
      .fill("ops@example.com");

    await page.locator('[data-testid="report-schedule-submit"]').click();

    await expect(
      page.locator('[data-testid="report-schedule-modal"]')
    ).toHaveCount(0, { timeout: 10_000 });

    // Pin request shape — page.tsx:241-251.
    expect(capturedBody).not.toBeNull();
    const body = capturedBody as Record<string, unknown>;
    expect(body.name).toBe("E2E Weekly Revenue Stub");
    expect(body.reportType).toBe("WEEKLY_REVENUE");
    expect(body.frequency).toBe("WEEKLY");
    expect(body.timeOfDay).toBe("09:30");
    expect(body.active).toBe(true);
    expect(Array.isArray(body.recipients)).toBe(true);
    expect((body.recipients as string[])[0]).toBe("ops@example.com");
    // WEEKLY axis (page.tsx:250) — Monday = 1.
    expect(body.dayOfWeek).toBe(1);
  });

  test("ADMIN clicks per-row CSV Export on a stubbed report run → /analytics/export/revenue.csv is fetched with from/to params and a browser download fires (page.tsx:279-298 authed-fetch+blob+anchor pattern)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub the report-runs GET so we have a deterministic row to click.
    await page.route(
      /\/api\/v1\/analytics\/report-runs(\?|$)/,
      async (route) => {
        if (route.request().method() === "GET") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              data: [
                {
                  id: "stub-run-1",
                  reportType: "WEEKLY_REVENUE",
                  generatedAt: "2026-04-30T10:00:00.000Z",
                  status: "SUCCESS",
                  parameters: { from: "2026-04-01", to: "2026-04-30" },
                  snapshot: { totalCollection: 12345 },
                  scheduledReport: null,
                  sentTo: null,
                  error: null,
                },
              ],
            }),
          });
        }
        return route.continue();
      }
    );

    // Stub the CSV export so it returns a tiny attachment payload.
    let csvUrlSeen = "";
    await page.route(
      /\/api\/v1\/analytics\/export\/revenue\.csv/,
      async (route) => {
        csvUrlSeen = route.request().url();
        return route.fulfill({
          status: 200,
          contentType: "text/csv",
          headers: {
            "Content-Disposition":
              'attachment; filename="revenue.csv"',
          },
          body: "date,total\n2026-04-30,12345\n",
        });
      }
    );

    await gotoAuthed(page, "/dashboard/reports");
    await expectNotForbidden(page);
    await page.getByRole("button", { name: /report history/i }).click();

    // Wait for the stubbed row to land.
    const exportBtn = page.locator(
      '[data-testid="report-export-stub-run-1"]'
    );
    await expect(exportBtn).toBeVisible({ timeout: 10_000 });

    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await exportBtn.click();
    const download = await downloadPromise;

    // The page.tsx:293 line names downloads `report-<type>-<id>.csv`.
    expect(download.suggestedFilename()).toMatch(/^report-weekly_revenue-stub-run-1\.csv$/);

    // The CSV endpoint was hit with the from/to query-string from the run's
    // parameters block (page.tsx:281-284).
    expect(csvUrlSeen).toContain("/analytics/export/revenue.csv");
    expect(csvUrlSeen).toContain("from=2026-04-01");
    expect(csvUrlSeen).toContain("to=2026-04-30");
  });

  test("RECEPTION bounces off /dashboard/reports — page.tsx:127-132 useEffect router.push('/dashboard') fires for ANY role !== ADMIN (the render-gate at line 317 is more permissive but the redirect lands first)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await page.goto("/dashboard/reports", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // 8:1 cron-learning archetype: redirect target is /dashboard, NOT
    // /dashboard/not-authorized. We assert the URL is no longer on /reports
    // and the Billing Reports heading never rendered.
    expect(page.url()).not.toMatch(/\/dashboard\/reports(\?|$|#|\/)/);
    await expect(
      page.getByRole("heading", { name: /^billing reports$/i })
    ).toHaveCount(0);
  });

  test("PATIENT bounces off /dashboard/reports — same useEffect role-gate, financial KPIs are ADMIN-only per Issue #90 (page.tsx:125-132)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/reports", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // 8:1 cron-learning archetype again — /dashboard, not /not-authorized.
    expect(page.url()).not.toMatch(/\/dashboard\/reports(\?|$|#|\/)/);
    await expect(
      page.getByRole("heading", { name: /^billing reports$/i })
    ).toHaveCount(0);
  });
});
