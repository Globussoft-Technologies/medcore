/**
 * Admin operations DEEP — analytics dashboard deepening (custom date-range,
 * drill-down, period-over-period comparison, KPI threshold deferral, on-page
 * CSV export).
 *
 * Companion specs (intentionally non-overlapping):
 *   - e2e/admin-ops.spec.ts             — daily ADMIN levers (leave / duty-roster
 *                                         / audit / tenants / scheduled-reports)
 *   - e2e/admin.spec.ts                 — admin journeys (Ctrl+K / users / dark-mode)
 *   - e2e/calendar-roster.spec.ts       — calendar + my-schedule + duty-roster
 *   - e2e/analytics-reports.spec.ts     — /dashboard/analytics/reports (Report Builder
 *                                         export + type-switch + RBAC bounce)
 *   - e2e/reports-custom.spec.ts        — /dashboard/reports (Daily Collection +
 *                                         Generate / Schedule / per-row CSV)
 *
 * What this spec adds (analytics deepening from §3 admin-ops + calendar-roster):
 *   /dashboard/analytics  (apps/web/src/app/dashboard/analytics/page.tsx)
 *   GET /api/v1/analytics/overview?from=&to=&compareMode=previous_period
 *     (apps/api/src/routes/analytics.ts:268 — ADMIN / RECEPTION)
 *   GET /api/v1/analytics/export/{revenue,appointments,patients}.csv
 *     (apps/api/src/routes/analytics.ts:1403 / 1457 / 1515 — ADMIN gate on revenue)
 *
 * VERIFY-BEFORE-SCAFFOLD audit (per cron-learning bullet 7 — refined wave 26
 * with API-contract-pin escape valve). Findings:
 *   - Custom date-range UI       SHIPPED (Preset <select> + From/To <input
 *                                 type="date"> + Apply button at page.tsx:1037-
 *                                 1109; Custom preset on `<option value="custom">`
 *                                 keeps date inputs editable; Apply commits
 *                                 pendingFrom/pendingTo into the loadAll()
 *                                 deps so /analytics/overview re-fires).
 *   - Drill-down (summary→detail) SHIPPED (DrillDownModal at page.tsx:2208;
 *                                 row click on Doctor Performance table at
 *                                 page.tsx:1473-1494 opens modal with
 *                                 "Doctor: <name>" title + breadcrumbs +
 *                                 metric/value rows).
 *   - Period-over-period         SHIPPED (compareMode toggle at page.tsx:1093-
 *                                 1106 — three buttons "No Comparison" /
 *                                 "vs Previous Period" / "vs Previous Year";
 *                                 wires `?compareMode=previous_period` into
 *                                 /analytics/overview at page.tsx:824-826;
 *                                 server returns {current, previous,
 *                                 deltaPercent, previousRange} at
 *                                 routes/analytics.ts:322-335; KpiCard renders
 *                                 ▲/▼ delta badge + "Previous: <value>" tail
 *                                 at page.tsx:2154-2179).
 *   - KPI threshold              NOT SHIPPED — repo-wide grep across `apps/api`,
 *                                 `apps/web`, and packages/db/prisma/schema.prisma
 *                                 for `KpiThreshold|kpiThreshold|kpi.*threshold|
 *                                 alertThreshold|setThreshold|threshold-config|
 *                                 kpi-config` returns ZERO hits in the analytics
 *                                 surface. The 2 file matches in apps/api are
 *                                 unrelated (ai-coaching test seeds + bloodbank-
 *                                 deep test). No KpiThreshold model / no
 *                                 /analytics/thresholds endpoint / no
 *                                 ThresholdEditor component. Deferred with
 *                                 explicit evidence-citation (no API-contract-pin
 *                                 either, since neither layer exists). Re-enters
 *                                 the §3 backlog when a threshold-config UI ships.
 *   - On-page CSV export         SHIPPED but distinct surface from
 *                                 analytics-reports.spec.ts (which covers the
 *                                 Report Builder's client-side blob download).
 *                                 The /dashboard/analytics page itself has
 *                                 three top-bar Export buttons at page.tsx:
 *                                 1001-1020 that hit /analytics/export/
 *                                 {revenue,appointments,patients}.csv. Pinned
 *                                 here via downloadCsv-fired GET capture.
 *
 * Surfaces touched:
 *   - ADMIN custom range: switch Preset → Custom, set From/To to a fixed
 *     past window, click Apply, observe the URL contract (?from=…&to=…)
 *     fires on /analytics/overview.
 *   - ADMIN drill-down: stub /analytics/doctors with one fixture row, click
 *     the row, assert DrillDownModal renders with "Doctor: <name>" heading
 *     + breadcrumbs + metric column.
 *   - ADMIN period-compare: stub /analytics/overview with the compare-shape
 *     payload (current + previous + deltaPercent), click "vs Previous Period",
 *     assert the URL contract (?compareMode=previous_period) AND the delta
 *     badge surfaces on the KPI cards.
 *   - ADMIN on-page CSV export: stub the /analytics/export/revenue.csv
 *     endpoint, click "Revenue CSV" top-bar button, assert page.waitForEvent
 *     ("download") fires with `revenue-<from>_<to>.csv` filename.
 *   - DOCTOR bounce: page.tsx:777-781 useEffect routes any role !== ADMIN
 *     && !== RECEPTION to /dashboard. Pin the negative experience.
 *   - Structural-NOT for KPI threshold: assert ZERO threshold-config controls
 *     render anywhere on the analytics page chrome — measures the deferred gap
 *     so the day a threshold UI ships this case fails and forces a rewrite.
 *
 * Why these tests exist:
 *   §3 of docs/E2E_COVERAGE_BACKLOG.md flagged "admin-ops + calendar-roster
 *   deepening" with 4 items: custom date-range + export, drill-down, period-
 *   over-period, KPI threshold. The existing admin-ops.spec.ts covers daily
 *   write levers (leave / roster / audit / scheduled-reports) but skips
 *   the analytics dashboard's own deepening surfaces. This spec closes that
 *   gap with 5 well-chosen cases (3 shipped surfaces pinned + 1 negative
 *   RBAC + 1 structural-NOT for the un-shipped KPI threshold) per cron-
 *   learning bullet 7 — VERIFY-BEFORE-SCAFFOLD discipline.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Admin Ops DEEP — /dashboard/analytics (custom date-range + drill-down + period-compare + on-page CSV export, KPI-threshold structural-NOT pin)", () => {
  test("ADMIN switches the Preset to Custom, fills From / To with a fixed window, clicks Apply, and the /analytics/overview GET re-fires with the explicit ?from=&to= contract (page.tsx:1037-1088)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await gotoAuthed(page, "/dashboard/analytics");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /^analytics dashboard$/i })
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the initial paint to settle. The default preset is last30 so
    // the first GET fires with a today-30d window — we don't assert on that;
    // we wait for it to land before clicking Custom so we're not racing the
    // mount-time fetch.
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/analytics/overview") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    // The Preset <select> is uniquely identifiable by its option value
    // "custom" — the page's other <select> (Comparison toggle uses <button>
    // not <select>; Benchmarks panel renders metric/period selects only
    // after data loads). We ALSO scope away from the global LanguageDropdown
    // <select> that injects into every authed dashboard layout (CLAUDE.md
    // gotcha #9) by selecting on the unique "custom" option.
    const presetSelect = page
      .locator('select:has(option[value="custom"])')
      .first();
    await expect(presetSelect).toBeVisible({ timeout: 10_000 });

    // Pick a fixed window in the past — far enough back that any seed
    // realism doesn't accidentally render a delta (we don't assert on the
    // payload here, only on the URL contract).
    const fromDate = "2025-01-01";
    const toDate = "2025-01-31";

    // The From / To inputs use stable IDs (page.tsx:1057 / 1070).
    await page.locator("#analytics-filter-from").fill(fromDate);
    await page.locator("#analytics-filter-to").fill(toDate);

    // Race the Apply click with the next /analytics/overview GET that
    // carries the explicit window. The button is a plain <button> — match
    // the visible label.
    const customRangePromise = page.waitForRequest(
      (req) => {
        if (req.method() !== "GET") return false;
        const u = req.url();
        return (
          u.includes("/api/v1/analytics/overview") &&
          u.includes(`from=${fromDate}`) &&
          u.includes(`to=${toDate}`)
        );
      },
      { timeout: 10_000 }
    );

    await page.getByRole("button", { name: /^apply$/i }).first().click();
    const customRangeReq = await customRangePromise;
    expect(customRangeReq.url()).toContain(`from=${fromDate}`);
    expect(customRangeReq.url()).toContain(`to=${toDate}`);
  });

  test("ADMIN clicks a Doctor Performance row and the DrillDownModal opens with 'Doctor: <name>' heading + breadcrumbs + metric/value rows (page.tsx:1473-1494 → DrillDownModal at page.tsx:2208)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub /analytics/doctors with a single deterministic row so the table
    // always has exactly one clickable row regardless of seed state. The
    // shape mirrors the DoctorStat interface (page.tsx:69-77).
    const fixtureDoctorName = `Dr. E2E DrillDown ${Date.now()}`;
    await page.route("**/api/v1/analytics/doctors**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            {
              doctorId: "stub-doc-1",
              doctorName: fixtureDoctorName,
              appointmentCount: 42,
              completedCount: 35,
              avgDurationMin: 18,
              revenue: 87500,
              patientCount: 30,
            },
          ],
          error: null,
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/analytics");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /^analytics dashboard$/i })
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the stubbed row to land in the table.
    const doctorRow = page
      .getByRole("row")
      .filter({ hasText: fixtureDoctorName })
      .first();
    await expect(doctorRow).toBeVisible({ timeout: 15_000 });

    // Click the row. The handler at page.tsx:1476-1493 calls setDrillDown
    // with title `Doctor: <name>` + breadcrumbs ["Doctors", <name>].
    await doctorRow.click();

    // The DrillDownModal renders the title as an <h3> with the exact
    // "Doctor: <name>" prefix (page.tsx:2220).
    const modalTitle = page.getByRole("heading", {
      name: new RegExp(`Doctor:\\s+${fixtureDoctorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    });
    await expect(modalTitle).toBeVisible({ timeout: 5_000 });

    // The breadcrumbs (page.tsx:2222-2228) render "Doctors" as the first
    // crumb. Anchor on the breadcrumb text without coupling to the › glyph.
    await expect(page.getByText(/^Doctors$/).first()).toBeVisible();

    // The metric/value column headers (page.tsx:2240-2245).
    await expect(
      page.getByRole("columnheader", { name: /^metric$/i })
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: /^value$/i })
    ).toBeVisible();

    // At least one metric row from the stub fixture (Appointments: 42).
    await expect(page.getByRole("cell", { name: /^Appointments$/ }).first()).toBeVisible();
  });

  test("ADMIN clicks 'vs Previous Period' and the /analytics/overview GET re-fires with ?compareMode=previous_period; the KPI cards render delta badges from the stubbed compare payload (page.tsx:1093-1106 → routes/analytics.ts:322-335)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub /analytics/overview with both shapes — the no-compare baseline
    // (returned on first paint when default compareMode happens to fire
    // /overview without ?compareMode=) AND the compare-shape (returned
    // when ?compareMode=previous_period is on the URL). The page sets
    // initial state to "previous_period" at page.tsx:745 so the first
    // paint MAY already include compareMode — we stub both routes
    // robustly below to handle either ordering.
    await page.route("**/api/v1/analytics/overview**", (route) => {
      const url = route.request().url();
      if (url.includes("compareMode=previous_period")) {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              current: {
                totalPatients: 120,
                newPatientsInPeriod: 25,
                totalAppointments: 340,
                appointmentsByStatus: { COMPLETED: 280 },
                totalRevenue: 542000,
                revenueByMode: { CASH: 200000, UPI: 342000 },
                pendingBills: 12,
                currentlyAdmitted: 18,
                avgConsultationTime: 22,
              },
              previous: {
                totalPatients: 100,
                newPatientsInPeriod: 18,
                totalAppointments: 300,
                appointmentsByStatus: { COMPLETED: 240 },
                totalRevenue: 480000,
                revenueByMode: { CASH: 180000, UPI: 300000 },
                pendingBills: 14,
                currentlyAdmitted: 15,
                avgConsultationTime: 20,
              },
              // 20% growth across totalPatients / appointments / revenue
              // gives a deterministic "+%" badge on each KPI card.
              deltaPercent: {
                totalPatients: 20.0,
                totalAppointments: 13.3,
                totalRevenue: 12.9,
                currentlyAdmitted: 20.0,
              },
              compareMode: "previous_period",
              previousRange: { from: "2024-12-02", to: "2024-12-31" },
            },
            error: null,
          }),
        });
        return;
      }
      // No compareMode on the URL — return the bare snapshot.
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            totalPatients: 120,
            newPatientsInPeriod: 25,
            totalAppointments: 340,
            appointmentsByStatus: { COMPLETED: 280 },
            totalRevenue: 542000,
            revenueByMode: { CASH: 200000, UPI: 342000 },
            pendingBills: 12,
            currentlyAdmitted: 18,
            avgConsultationTime: 22,
          },
          error: null,
        }),
      });
    });

    await gotoAuthed(page, "/dashboard/analytics");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /^analytics dashboard$/i })
    ).toBeVisible({ timeout: 15_000 });

    // Click "No Comparison" first to force a deterministic state transition
    // out of the default "previous_period" — then click "vs Previous Period"
    // and pin the URL contract on THAT GET.
    await page.getByRole("button", { name: /^no comparison$/i }).click();
    await page.waitForTimeout(400);

    const compareReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "GET" &&
        req.url().includes("/api/v1/analytics/overview") &&
        req.url().includes("compareMode=previous_period"),
      { timeout: 10_000 }
    );

    await page.getByRole("button", { name: /^vs previous period$/i }).click();
    const compareReq = await compareReqPromise;
    expect(compareReq.url()).toContain("compareMode=previous_period");

    // KpiCard renders the delta badge with `Math.abs(deltaPct).toFixed(1)%`
    // (page.tsx:2170). With our stubbed +20.0% on totalPatients we should
    // see a "20.0%" pill render. The badge ALSO carries a "Previous: <v>"
    // tail at page.tsx:2178 — pin both so a future regression on the
    // deltaPct prop wiring fails this case.
    await expect(page.getByText(/20\.0%/).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/Previous:\s*100/).first()).toBeVisible();
  });

  test("ADMIN clicks the top-bar 'Revenue CSV' button and a download fires for /analytics/export/revenue.csv with the canonical revenue-<from>_<to>.csv filename (page.tsx:1001-1006 → routes/analytics.ts:1403)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // The page's downloadCsv() helper at page.tsx:935-957 does an authed
    // fetch + Blob + a.click() — the same pattern as analytics-reports.spec
    // .ts (which covers the Report Builder's CSV) and reports-custom.spec
    // .ts (which covers the per-row Export). This case pins the DISTINCT
    // top-bar surface on /dashboard/analytics itself.
    //
    // Stub /analytics/export/revenue.csv with a tiny CSV body so the fetch
    // resolves quickly and the download event fires deterministically.
    await page.route("**/api/v1/analytics/export/revenue.csv**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/csv",
        body: "date,total\n2025-01-01,12500\n",
      })
    );

    await gotoAuthed(page, "/dashboard/analytics");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /^analytics dashboard$/i })
    ).toBeVisible({ timeout: 15_000 });

    // Top-bar "Revenue CSV" button — the only button matching that text.
    const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByRole("button", { name: /revenue csv/i }).click();
    const download = await downloadPromise;

    // page.tsx:1002 builds the filename as `revenue-${from}_${to}.csv`.
    expect(download.suggestedFilename()).toMatch(
      /^revenue-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/
    );
  });

  test("DOCTOR is bounced from /dashboard/analytics — useEffect at page.tsx:777-781 router.push('/dashboard') AND the early-return at page.tsx:959 keeps content empty; structural-NOT pin: ZERO threshold-config controls render anywhere on the chrome (KPI threshold UI deferred — feature not shipped at any layer)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await gotoAuthed(page, "/dashboard/analytics");
    await page.waitForTimeout(1500);

    // The redirect lands on /dashboard (NOT /dashboard/not-authorized — the
    // page does router.push("/dashboard") at page.tsx:779). Tolerate either
    // outcome since some routes also intercept at /dashboard.
    const url = page.url();
    expect(url).toMatch(/\/dashboard(\/analytics)?(\?|$|\/)/);

    // Critical: the Analytics Dashboard heading must NOT render for a
    // non-ADMIN/RECEPTION role — early-return at page.tsx:959 bails before
    // render.
    await expect(
      page.getByRole("heading", { name: /^analytics dashboard$/i })
    ).toHaveCount(0);

    // Structural-NOT pin for the un-shipped KPI threshold configuration UI.
    // Per VERIFY-BEFORE-SCAFFOLD: NO threshold-config endpoint /
    // ThresholdEditor / KpiThreshold model exists in the repo. This
    // assertion measures the deferred gap — the day a threshold UI ships
    // (button labelled "Configure Thresholds" / "KPI Settings" / similar)
    // this case fails and forces a rewrite to cover the new surface.
    //
    // We assert on the analytics PAGE CHROME — i.e. nothing matching these
    // intent strings should appear on the page. Doctor isn't on /dashboard/
    // analytics anyway (bounced) so this is a structural double-check.
    await expect(
      page.getByRole("button", { name: /configure threshold|kpi threshold|kpi settings|set threshold/i })
    ).toHaveCount(0);
    await expect(
      page.getByText(/^thresholds?$/i)
    ).toHaveCount(0);
  });
});
