/**
 * Holiday calendar admin-flow + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/holidays (apps/web/src/app/dashboard/holidays/page.tsx)
 *   GET / POST / DELETE /api/v1/hr-ops/holidays
 *   (apps/api/src/routes/hr-ops.ts:29-99)
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome renders + year selector visible +
 *     Add-Holiday CTA visible. The page is ADMIN-only (page.tsx:69 —
 *     non-ADMIN are redirected to /dashboard) so this also locks the
 *     positive-side of that gate.
 *   - Add-holiday modal interaction: opening the form via the
 *     Add-Holiday CTA reveals the holiday-date / holiday-name inputs,
 *     and submitting an empty form raises the field-level error-date /
 *     error-name surfaces (issue #293 contract — page.tsx:91-99).
 *   - Year-selector navigation: changing the year fires a fresh
 *     /hr-ops/holidays?year= GET so the calendar reloads. Locks the
 *     useEffect → load() wiring at page.tsx:87-89.
 *   - RBAC bounces for DOCTOR / NURSE / RECEPTION: page.tsx:69
 *     hard-redirects every non-ADMIN to /dashboard, and the early
 *     `return null` at page.tsx:174 means the Add CTA must never render.
 *
 * Why these tests exist:
 *   /dashboard/holidays was listed under §2.4 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "holiday calendar — no e2e
 *   coverage". The page is the only ADMIN-side surface for managing
 *   the org-wide holiday list that drives payroll + leave-calendar
 *   workings-day arithmetic, so a silent regression (e.g. role-gate
 *   drift, modal contract change, year-selector breaking the load
 *   effect) cascades into HR/payroll surfaces. This spec adds the
 *   first positive-path assertions plus the standard issue-#179 RBAC
 *   redirect coverage.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Holidays — /dashboard/holidays (ADMIN calendar management + non-ADMIN bounces)", () => {
  test("ADMIN lands on /dashboard/holidays, page chrome renders, Add-Holiday CTA + year selector are visible", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/holidays", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /holidays/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Add-Holiday CTA only renders for ADMIN (page.tsx:174 returns null
    // for any other role). Locking visibility here means a regression in
    // the role gate surfaces as a test failure rather than a silent
    // empty page.
    await expect(
      page.getByRole("button", { name: /add holiday/i })
    ).toBeVisible();

    // The year <select> mounts five years centered on `current ± 2`
    // (page.tsx:186). Confirm at least the current year is an option so
    // the dropdown didn't shrink to zero.
    const currentYear = new Date().getFullYear();
    await expect(
      page.locator(`select option[value="${currentYear}"]`).first()
    ).toHaveCount(1);
  });

  test("ADMIN opens the Add-Holiday modal, the date + name inputs render with their data-testid contract", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/holidays", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /add holiday/i }).click();

    // Modal heading is the only positive marker the dialog rendered.
    await expect(
      page.getByRole("heading", { name: /add holiday/i })
    ).toBeVisible({ timeout: 5_000 });

    // The two locked-in form inputs from page.tsx:288 / 311 — used by
    // both manual add and template-import. A regression renaming these
    // testids would silently break automation.
    await expect(
      page.locator('[data-testid="holiday-date"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="holiday-name"]')
    ).toBeVisible();
  });

  test("ADMIN submitting empty Add-Holiday form raises both field-level errors (issue #293 — error-date / error-name)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/holidays", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /add holiday/i }).click();
    await expect(
      page.getByRole("heading", { name: /add holiday/i })
    ).toBeVisible({ timeout: 5_000 });

    // Click Save with both inputs empty. Server is never reached —
    // page.tsx:103-115 short-circuits and writes both field errors.
    let serverHit = false;
    await page.route("**/api/v1/hr-ops/holidays", (route) => {
      if (route.request().method() === "POST") serverHit = true;
      route.continue();
    });

    await page.getByRole("button", { name: /^save$/i }).click();

    await expect(
      page.locator('[data-testid="error-date"]')
    ).toBeVisible({ timeout: 3_000 });
    await expect(
      page.locator('[data-testid="error-name"]')
    ).toBeVisible({ timeout: 3_000 });

    // Modal stays open — submit short-circuited before the POST.
    await expect(
      page.getByRole("heading", { name: /add holiday/i })
    ).toBeVisible();

    await page.waitForTimeout(500);
    expect(serverHit).toBe(false);
  });

  test("ADMIN year-selector navigation refetches /hr-ops/holidays?year= for the chosen year", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/holidays", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // Pick a different year from the default. The selector window is
    // current±2 (page.tsx:186), so `current - 2` is always a valid
    // option and avoids picking the same value already loaded on mount.
    const currentYear = new Date().getFullYear();
    const targetYear = currentYear - 2;

    // The page renders a native <select> at page.tsx:181 with the year
    // options. Disambiguate from the modal's Type-select (PUBLIC /
    // OPTIONAL / RESTRICTED at page.tsx:326) by scoping to the select
    // that contains the current-year option — the year-select is the
    // only one with numeric year options.
    const yearSelect = page.locator(
      `select:has(option[value="${currentYear}"])`
    );
    await expect(yearSelect).toBeVisible({ timeout: 15_000 });
    // Wait for the page-load GET to settle so the year-selector handler
    // is wired before we change the value (page.tsx:87-89).
    await expect(yearSelect).toBeEnabled({ timeout: 5_000 });

    // Set up the response listener BEFORE the selectOption call so we
    // never miss a fast network reply.
    const refetch = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/hr-ops/holidays") &&
        r.url().includes(`year=${targetYear}`) &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    await yearSelect.selectOption(String(targetYear));

    const res = await refetch;
    // GET is open-auth (hr-ops.ts:32 has no `authorize`), so any 2xx is
    // acceptable. A 4xx/5xx here means the year-selector → load()
    // wiring drifted.
    expect(res.status()).toBeLessThan(400);
  });

  test("DOCTOR is bounced from /dashboard/holidays — page.tsx:69 redirects every non-ADMIN to /dashboard", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/holidays", {
      waitUntil: "domcontentloaded",
    });
    // Allow the role-gate useEffect a tick to run.
    await page.waitForTimeout(800);

    // DOCTOR is not ADMIN, so they are pushed back to /dashboard. The
    // early `return null` at page.tsx:174 ensures the Add-Holiday CTA
    // never renders even briefly.
    expect(page.url()).toMatch(/\/dashboard(\?|$|\/)/);
    expect(page.url()).not.toMatch(/\/dashboard\/holidays/);
    await expect(
      page.getByRole("button", { name: /add holiday/i })
    ).toHaveCount(0);
  });

  test("NURSE is bounced from /dashboard/holidays — page.tsx:69 admin-only gate", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/holidays", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).not.toMatch(/\/dashboard\/holidays/);
    await expect(
      page.getByRole("button", { name: /add holiday/i })
    ).toHaveCount(0);
  });

  test("RECEPTION is bounced from /dashboard/holidays — page.tsx:69 admin-only gate", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await page.goto("/dashboard/holidays", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).not.toMatch(/\/dashboard\/holidays/);
    await expect(
      page.getByRole("button", { name: /add holiday/i })
    ).toHaveCount(0);
  });
});
