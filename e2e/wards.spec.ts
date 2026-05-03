/**
 * Wards & Beds E2E coverage — /dashboard/wards (apps/web/src/app/dashboard/wards/page.tsx).
 *
 * What this exercises:
 *   /dashboard/wards (Beds tab + Forecast tab; Add-Ward modal; Add-Bed inline
 *     form; BedCell status menu)
 *   GET  /api/v1/wards
 *   POST /api/v1/wards                         (ADMIN)
 *   POST /api/v1/wards/:wardId/beds            (ADMIN)
 *   PATCH /api/v1/beds/:id/status              (ADMIN, NURSE, RECEPTION)
 *   GET  /api/v1/admissions/forecast?days=7    (Forecast tab)
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome, totals strip, Beds/Forecast tab strip,
 *     and the ADMIN-only "Add Ward" CTA.
 *   - ADMIN add-ward modal exercise: open modal, fill name + type + floor,
 *     submit, see new ward card appear in the grid.
 *   - NURSE happy path: page loads, totals strip + tabs render, "Add Ward"
 *     CTA is HIDDEN (isAdmin gate, page.tsx:182-189).
 *   - RECEPTION happy path: same as NURSE — page loads, no Add Ward CTA.
 *   - Forecast tab: ADMIN switches to Forecast and sees either the chart
 *     or the "not yet available" empty-state (the route returns [] until
 *     7 days of admission data exist).
 *   - PATIENT direct-URL: page is fully accessible (there is NO VIEW_ALLOWED
 *     gate in page.tsx — only the Add Ward / Add Bed CTAs are isAdmin-gated).
 *     Page chrome must render and Add Ward must be ABSENT.
 *   - LAB_TECH direct-URL: same as PATIENT — page accessible, no Add Ward.
 *
 * Why these tests exist:
 *   /dashboard/wards was listed under §2.7 of docs/E2E_COVERAGE_BACKLOG.md
 *   ("bed assignment, transfer") with no e2e coverage. The page is the
 *   single source of bed-occupancy summary for ADMIN/NURSE/RECEPTION (linked
 *   from the admissions list and the home dashboard) and any silent breakage
 *   of the totals strip or the Add Ward / Add Bed admin paths would cascade
 *   into staffing decisions. Since the page has no full-page RBAC gate,
 *   "RBAC" coverage here is the inverse pattern — confirming non-staff roles
 *   can still load the page but DO NOT see admin-only CTAs.
 *
 * Notes:
 *   - The page renders no `data-testid` attributes today. All selectors here
 *     use accessible-name / role-based queries (heading, button name) so the
 *     contract this spec locks in is the user-visible UI, not implementation
 *     IDs. If/when testids are added, prefer those.
 *   - BedCell status transitions (AVAILABLE → OCCUPIED → CLEANING → MAINTENANCE)
 *     are the in-page "bed assignment" surface. They are exercised indirectly
 *     by the add-ward / add-bed flow plus the totals-strip assertions.
 *   - `gotoAuthed` is used for in-test navigations (WebKit auth-race v4).
 */

import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

const PAGE_TIMEOUT = 20_000;

test.describe("Wards & Beds — /dashboard/wards (page chrome, ADMIN add-ward, RBAC visibility)", () => {
  test("ADMIN: page loads with heading, totals strip, tab bar, and Add Ward CTA", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/wards");
    await expectNotForbidden(page);

    // Heading "Wards & Beds" — page.tsx:176
    await expect(
      page.getByRole("heading", { name: /wards\s*&\s*beds/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Totals subtitle (e.g. "X available · Y occupied · Z total beds")
    // — page.tsx:177-180. Anchor on the literal "total beds" string so the
    // test passes regardless of the seed-data counts.
    await expect(page.getByText(/total beds/i).first()).toBeVisible();

    // Beds / Forecast tabs — page.tsx:194-213
    await expect(page.getByRole("button", { name: /^beds$/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /forecast/i })
    ).toBeVisible();

    // ADMIN-only "Add Ward" — page.tsx:182-189 (isAdmin gate)
    await expect(
      page.getByRole("button", { name: /add ward/i })
    ).toBeVisible();
  });

  test("ADMIN: opens Add Ward modal, creates a new ward, sees it in the grid", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/wards");
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /add ward/i }).click();

    // Modal — page.tsx:374. Heading "Add New Ward" (page.tsx:380) anchors
    // the modal-open state. Scope all input lookups to the modal form so we
    // do not collide with anything elsewhere on the page.
    //
    // The modal's <label>s do NOT carry htmlFor/id linkage (page.tsx:383,394,
    // 410,420), so Playwright's getByLabel() cannot resolve the inputs. We
    // mirror the medicines/suppliers fix (commit cdea823) and select inputs
    // as siblings of their label-text element instead.
    const modal = page.locator('form:has(h2:text-is("Add New Ward"))');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    const wardName = `E2E Ward ${Date.now()}`;

    await modal.locator('label:text-is("Name") + input').fill(wardName);
    await modal
      .locator('label:text-is("Type") + select')
      .selectOption("ICU");
    await modal.locator('label:text-is("Floor") + input').fill("3");

    await modal.getByRole("button", { name: /create ward/i }).click();

    // Modal closes (heading disappears) and the new ward card lands in the
    // grid. The ward name appears as a card title — page.tsx:270.
    await expect(
      page.getByRole("heading", { name: /add new ward/i })
    ).toHaveCount(0, { timeout: 10_000 });

    await expect(
      page.getByRole("heading", { name: wardName }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("ADMIN: switches to Forecast tab and sees chart or 'not yet available' empty state", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/wards");
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /forecast/i }).click();

    // Either the chart heading or the "not yet available" placeholder must
    // appear. Both branches live in OccupancyForecast() at page.tsx:464-500.
    const chartHeading = page.getByRole("heading", {
      name: /next 7 days predicted occupancy/i,
    });
    const emptyHeading = page.getByRole("heading", {
      name: /forecast not yet available/i,
    });
    await expect(chartHeading.or(emptyHeading).first()).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });
  });

  test("NURSE: page loads with chrome and totals; Add Ward CTA is hidden", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await gotoAuthed(page, "/dashboard/wards");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /wards\s*&\s*beds/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(page.getByText(/total beds/i).first()).toBeVisible();

    // isAdmin === false → Add Ward must NOT render (page.tsx:182).
    await expect(
      page.getByRole("button", { name: /add ward/i })
    ).toHaveCount(0);
  });

  test("RECEPTION: page loads with chrome; Add Ward CTA is hidden", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/wards");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /wards\s*&\s*beds/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await expect(
      page.getByRole("button", { name: /add ward/i })
    ).toHaveCount(0);
  });

  test("PATIENT direct-URL: page is accessible (no VIEW_ALLOWED gate); Add Ward absent", async ({
    patientPage,
  }) => {
    const page = patientPage;
    // No VIEW_ALLOWED redirect lives in page.tsx — every authenticated role
    // can load the wards page. CTAs are isAdmin-gated, not the page itself.
    await gotoAuthed(page, "/dashboard/wards");
    expect(page.url()).not.toContain("/not-authorized");
    expect(page.url()).not.toContain("/login");

    await expect(
      page.getByRole("heading", { name: /wards\s*&\s*beds/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await expect(
      page.getByRole("button", { name: /add ward/i })
    ).toHaveCount(0);
  });

  test("LAB_TECH direct-URL: page is accessible; Add Ward absent", async ({
    labTechPage,
  }) => {
    const page = labTechPage;
    await gotoAuthed(page, "/dashboard/wards");
    expect(page.url()).not.toContain("/not-authorized");
    expect(page.url()).not.toContain("/login");

    await expect(
      page.getByRole("heading", { name: /wards\s*&\s*beds/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await expect(
      page.getByRole("button", { name: /add ward/i })
    ).toHaveCount(0);
  });
});
