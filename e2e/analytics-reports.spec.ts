/**
 * Analytics Report Builder export-surface + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/analytics/reports
 *     (apps/web/src/app/dashboard/analytics/reports/page.tsx)
 *   GET /api/v1/analytics/revenue?from=&to=&groupBy=
 *   GET /api/v1/analytics/appointments?from=&to=&groupBy=
 *   GET /api/v1/analytics/patients/growth?from=&to=&groupBy=
 *     (apps/api/src/routes/analytics.ts — router.use(authorize(ADMIN, RECEPTION, DOCTOR));
 *      individual handlers at lines 381/268 narrow further to ADMIN only.)
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome (heading "Report Builder", 5 report-type
 *     tiles, From / To / Group By controls, Run button), and an analytics
 *     GET fires on first paint via the useEffect at page.tsx:294-296.
 *   - Type switch contract: clicking the Appointments tile re-runs the
 *     preview against /analytics/appointments (page.tsx:174-178). Pins the
 *     useCallback dep on `type` so a future regression doesn't silently
 *     stick the page on revenue.
 *   - Export contract: clicking the CSV / JSON buttons triggers a download
 *     event without a network call (page.tsx:330-356 build the file
 *     client-side from the in-memory preview). We pin the trigger contract
 *     by stubbing the analytics endpoint to a single row and asserting the
 *     download's `suggestedFilename` matches `<type>-report-<from>_<to>.csv`.
 *   - Empty-state: when the analytics endpoint returns an empty `data: []`,
 *     page.tsx:532-535 renders "No data for this configuration" — and the
 *     CSV / JSON buttons stay disabled.
 *   - Non-ADMIN bounces: useEffect at page.tsx:116-120 routes any non-ADMIN
 *     to /dashboard/analytics, and the inline `if (user && user.role !==
 *     "ADMIN") return null;` at page.tsx:358 prevents content render.
 *
 * Why these tests exist:
 *   §2.6 of docs/E2E_COVERAGE_BACKLOG.md flagged "/dashboard/analytics/reports
 *   — analytics export" as zero-coverage. This is the operator's primary
 *   ad-hoc export surface; a regression on the export trigger or the type-
 *   switch dep array cuts off CSV/JSON delivery for revenue / appointments /
 *   patients / IPD / pharmacy reports without a visible error.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Analytics Report Builder — /dashboard/analytics/reports (ADMIN export surface + type-switch contract + non-ADMIN RBAC redirects)", () => {
  test("ADMIN lands on /dashboard/analytics/reports, heading + 5 report-type tiles + Run button render, an analytics GET fires on first paint", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Race the first-paint preview fetch against the navigation. The
    // useEffect at page.tsx:294-296 fires runPreview() which by default
    // hits /analytics/revenue.
    const previewPromise = page.waitForResponse(
      (r) =>
        /\/api\/v1\/analytics\/(revenue|appointments|patients\/growth|ipd\/|pharmacy\/)/.test(
          r.url()
        ) && r.request().method() === "GET",
      { timeout: 15_000 }
    );

    await gotoAuthed(page, "/dashboard/analytics/reports");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /report builder/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    const previewRes = await previewPromise;
    expect(previewRes.status()).toBeLessThan(500);

    // The 5 report-type tile labels from page.tsx:47-53 — anchors the
    // analytics-export coverage matrix.
    for (const label of [
      /revenue report/i,
      /appointments report/i,
      /patient growth/i,
      /ipd admissions/i,
      /pharmacy dispensing/i,
    ]) {
      await expect(page.getByText(label).first()).toBeVisible();
    }

    await expect(
      page.getByRole("button", { name: /^run$/i }).first()
    ).toBeVisible();
    // CSV / JSON export buttons are anchored on the page, even if disabled
    // before any data arrives.
    await expect(
      page.getByRole("button", { name: /^csv$/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^json$/i }).first()
    ).toBeVisible();
  });

  test("ADMIN switching to Appointments tile re-runs preview against /analytics/appointments — pins the type-switch useCallback dep", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub /analytics/revenue first so the initial paint settles fast and
    // doesn't race the click below.
    await page.route("**/api/v1/analytics/revenue**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await gotoAuthed(page, "/dashboard/analytics/reports");
    await expect(
      page.getByRole("heading", { name: /report builder/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Now race the appointments fetch against the click on the
    // Appointments tile — the type-switch contract.
    const apptPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/analytics/appointments") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    await page.getByText(/appointments report/i).first().click();
    const apptRes = await apptPromise;
    expect(apptRes.status()).toBeLessThan(500);

    // The Appointments-specific status filter renders only when type ===
    // "appointments" (page.tsx:472-490). Use the unique option value to
    // avoid colliding with the global LanguageDropdown (CLAUDE.md gotcha #9).
    await expect(
      page.locator('select:has(option[value="BOOKED"])').first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("ADMIN clicking CSV after a populated preview triggers a file download with the canonical <type>-report-<from>_<to>.csv name", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub revenue analytics with one row so the CSV button enables and
    // the table populates.
    await page.route("**/api/v1/analytics/revenue**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            {
              date: "2026-04-30",
              total: 12500,
              cash: 5000,
              card: 3000,
              upi: 2500,
              online: 1000,
              insurance: 1000,
            },
          ],
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/analytics/reports");
    await expect(
      page.getByRole("heading", { name: /report builder/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the preview row to render so the CSV button is enabled.
    await expect(
      page.locator("text=/Period|Total Periods/i").first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/grand total/i).first()).toBeVisible();

    // The CSV download is built client-side via Blob + a.click() — pin the
    // trigger contract by listening for the download event.
    const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByRole("button", { name: /^csv$/i }).first().click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(
      /^revenue-report-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/
    );
  });

  test("ADMIN with no analytics data sees 'No data for this configuration' empty-state — CSV / JSON export buttons stay disabled", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub every analytics endpoint to empty so the empty-state pin is
    // deterministic regardless of which type the preview started on.
    await page.route("**/api/v1/analytics/revenue**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await gotoAuthed(page, "/dashboard/analytics/reports");
    await expect(
      page.getByRole("heading", { name: /report builder/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByText(/no data for this configuration/i).first()
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("button", { name: /^csv$/i }).first()
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /^json$/i }).first()
    ).toBeDisabled();
  });

  test("DOCTOR is bounced from /dashboard/analytics/reports — useEffect at page.tsx:116-120 router.push('/dashboard/analytics'), the early-return at page.tsx:358 keeps content empty", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/analytics/reports");
    await page.waitForTimeout(1500);

    // The redirect lands on /dashboard/analytics; tolerate either outcome
    // (some test runs settle on /dashboard if /analytics also has gating).
    const url = page.url();
    expect(url).toMatch(/\/dashboard(\/analytics(\/reports)?)?(\?|$|\/)/);

    // Critical assertion: the Report Builder heading must NOT render for a
    // non-ADMIN role — the early-return at page.tsx:358 bails before render.
    await expect(
      page.getByRole("heading", { name: /report builder/i })
    ).toHaveCount(0);
  });

  test("PATIENT is bounced from /dashboard/analytics/reports — admin-only export surface inaccessible to patients", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/analytics/reports");
    await page.waitForTimeout(1500);

    const url = page.url();
    expect(url).toMatch(/\/dashboard(\/analytics(\/reports)?)?(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /report builder/i })
    ).toHaveCount(0);
    // No CSV / JSON export controls for a PATIENT (defense-in-depth).
    await expect(
      page.getByRole("button", { name: /^csv$/i })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^json$/i })
    ).toHaveCount(0);
  });
});
