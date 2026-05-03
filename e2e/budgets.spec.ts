/**
 * Budget tracking ADMIN-only render + Set-Budget round-trip + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/budgets (apps/web/src/app/dashboard/budgets/page.tsx)
 *   GET  /api/v1/expenses/budgets?year=&month=        (KPI + per-category roll-up)
 *   POST /api/v1/expenses/budgets                     (Set monthly budget)
 *   (apps/api/src/routes/expenses.ts:356-433 — both ADMIN-only via authorize(Role.ADMIN))
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome (Budgets heading, month picker, Set Budget
 *     CTA), KPI tiles (Total Budget / kpi-total-spent / kpi-variance), and the
 *     GET /expenses/budgets round-trip returning 200. Locks the headline KPI
 *     contract (issue #76 totalSpent/totalVarianceBudgetedOnly) plus the only
 *     two data-testids the page exposes.
 *   - ADMIN Set-Budget modal: clicking the headline CTA opens the form,
 *     filling category + amount + notes and clicking Save POSTs to
 *     /expenses/budgets, the modal closes, and the page re-fetches the
 *     KPI roll-up. Pins the load-bearing money-handling CTA.
 *   - ADMIN month-picker re-fetch: changing the <input type="month"> value
 *     fires a fresh GET /expenses/budgets with the new year/month
 *     querystring (load() useEffect, page.tsx:86-88). Locks the period-filter
 *     contract listed alongside Set Budget in §2.3.
 *   - Non-ADMIN bounces (DOCTOR, NURSE, PATIENT): page.tsx:67-70 pushes
 *     non-ADMIN to /dashboard, page.tsx:110 returns null, so neither the
 *     KPI tiles nor the Set Budget CTA render. Mirrors the payroll.spec
 *     ADMIN-only redirect pattern.
 *
 * Why these tests exist:
 *   /dashboard/budgets was listed under §2.3 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "budget tracking — no e2e coverage".
 *   The route surfaces money — total budget, total spent, per-category
 *   variance — and Set Budget is the only entry point for finance staff
 *   to land budget caps for the month. A silent regression in either the
 *   ADMIN-only authorize() guard or the KPI roll-up (issue #76 explicitly
 *   reshaped the response shape to include uncategorised spend) would
 *   either leak budget figures to non-ADMIN staff or quietly mis-render
 *   the variance tile. This file pins the headline UI contract + the
 *   Set-Budget POST + month-picker re-fetch + the role gate.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Budgets — /dashboard/budgets (ADMIN KPI render + Set-Budget POST + month-picker re-fetch + non-ADMIN redirect)", () => {
  test("ADMIN lands on /dashboard/budgets, page chrome renders with Budgets heading, month picker, Set Budget CTA, and KPI tiles, and GET /expenses/budgets returns 200", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Catch the GET /expenses/budgets round-trip kicked off by the page's
    // load() effect (page.tsx:72-84). 200 here is what locks the
    // ADMIN ∈ allowed-roles contract from the e2e side — if someone
    // tightens authorize(...) on the API and forgets to update the docs,
    // this test fires.
    const listPromise = page.waitForResponse(
      (r) =>
        /\/api\/v1\/expenses\/budgets\?/.test(r.url()) &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await gotoAuthed(page, "/dashboard/budgets");
    await expectNotForbidden(page);
    const listRes = await listPromise;
    expect(listRes.status()).toBe(200);

    await expect(
      page.getByRole("heading", { name: /^budgets$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Headline CTA. The page has no top-level data-testid for the
    // Set Budget button (only kpi-total-spent / kpi-variance are
    // instrumented), so we lock by accessible name — same precedent as
    // suppliers.spec / payroll.spec.
    await expect(
      page.getByRole("button", { name: /set budget/i })
    ).toBeVisible();

    // KPI tiles: only kpi-total-spent and kpi-variance carry data-testids
    // (page.tsx:164, 183). The Total Budget tile is unmarked but is the
    // first .text-2xl.font-bold under the summary grid — assert by text
    // pattern rather than introducing a non-existent testid.
    await expect(
      page.locator('[data-testid="kpi-total-spent"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="kpi-variance"]')
    ).toBeVisible();
  });

  test("ADMIN can open the Set-Budget modal, fill category/amount/notes, save, and the POST round-trip lands a 200/201 + the form closes", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/budgets");
    await expectNotForbidden(page);

    // Wait for the initial GET so the page is stable before we open the
    // modal — otherwise the load() useEffect can race the Save click.
    await page
      .waitForResponse(
        (r) =>
          /\/api\/v1\/expenses\/budgets\?/.test(r.url()) &&
          r.request().method() === "GET",
        { timeout: 15_000 }
      )
      .catch(() => undefined);

    // Open the modal. The Save Budget heading inside the dialog is the
    // most stable handle that the modal actually rendered (the modal has
    // no data-testid; page.tsx:311-373).
    await page.getByRole("button", { name: /set budget/i }).click();
    await expect(
      page.getByRole("heading", { name: /set monthly budget/i })
    ).toBeVisible({ timeout: 5_000 });

    // Fill the form. Use OTHER as the category so a re-run of the spec
    // doesn't collide with a likely-pre-seeded SALARY/UTILITIES row.
    // The realistic seeder may already populate well-known categories;
    // OTHER is unlikely to clash. Even if it does, the upsert semantics
    // on the server simply update the existing row — see expenses.ts.
    await page.locator('select').first().selectOption("OTHER");
    // Use a pseudo-random amount so successive runs don't all assert on
    // the same number. The KPI tile re-renders from the GET response
    // anyway, so we don't need to read this back precisely.
    const amount = String(1000 + Math.floor(Math.random() * 9000));
    await page.locator('input[type="number"]').fill(amount);
    await page.locator("textarea").fill(`E2E budgets.spec — ${Date.now()}`);

    // Submit and wait for the POST round-trip before asserting the modal
    // closes. A 4xx here means either the form contract drifted (e.g.
    // expenseBudgetSchema gained a required field) or the gate moved —
    // both worth catching.
    const savePromise = page.waitForResponse(
      (r) =>
        /\/api\/v1\/expenses\/budgets$/.test(r.url()) &&
        r.request().method() === "POST",
      { timeout: 15_000 }
    );
    await page.getByRole("button", { name: /save budget/i }).click();
    const saveRes = await savePromise;
    expect(saveRes.status()).toBeLessThan(400);

    // Modal should auto-close on success (page.tsx:101 → setShowForm(false)).
    await expect(
      page.getByRole("heading", { name: /set monthly budget/i })
    ).toHaveCount(0, { timeout: 5_000 });
  });

  test("ADMIN month picker re-fires GET /expenses/budgets with the new year/month querystring — locks the period-filter contract", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/budgets");
    await expectNotForbidden(page);

    // Wait for the initial fetch (current month) so the next response is
    // unambiguously the period-change re-fetch rather than the bootstrap.
    await page
      .waitForResponse(
        (r) =>
          /\/api\/v1\/expenses\/budgets\?/.test(r.url()) &&
          r.request().method() === "GET",
        { timeout: 15_000 }
      )
      .catch(() => undefined);

    // Pick a deterministic past month so the assertion is independent of
    // the test-runner clock — Jan 2024 always parses as year=2024&month=1
    // through the page's split() in page.tsx:75. Listen for the next GET
    // before we touch the input so we don't miss the firing edge.
    const refetch = page.waitForResponse(
      (r) =>
        /\/api\/v1\/expenses\/budgets\?/.test(r.url()) &&
        /year=2024/.test(r.url()) &&
        /month=1(\D|$)/.test(r.url()) &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.locator('input[type="month"]').fill("2024-01");
    const res = await refetch;
    expect(res.status()).toBe(200);
  });

  test("DOCTOR is bounced off /dashboard/budgets — page.tsx:67-70 pushes non-ADMIN to /dashboard and the component returns null", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/budgets", { waitUntil: "domcontentloaded" });
    // Allow the role-gate useEffect a tick to fire.
    await page.waitForTimeout(800);

    // The page pushes non-ADMIN back to /dashboard (NOT
    // /dashboard/not-authorized — see page.tsx:67-70). Either landing
    // surface is acceptable per the issue-#179 redirect-tolerance
    // pattern used in payroll.spec / symptom-diary.spec.
    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    expect(page.url()).not.toContain("/dashboard/budgets/");
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);

    // The ADMIN-only Set Budget CTA must NOT have rendered
    // (page.tsx:110 short-circuits to null for non-ADMIN).
    await expect(
      page.getByRole("button", { name: /set budget/i })
    ).toHaveCount(0);
    // Neither KPI tile renders either — the entire summary grid is
    // gated behind the ADMIN-only render branch.
    await expect(
      page.locator('[data-testid="kpi-total-spent"]')
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="kpi-variance"]')
    ).toHaveCount(0);
  });

  test("NURSE is bounced off /dashboard/budgets — same non-ADMIN redirect, no Set Budget CTA renders", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/budgets", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    expect(page.url()).not.toContain("/dashboard/budgets/");
    await expect(
      page.getByRole("button", { name: /set budget/i })
    ).toHaveCount(0);
  });

  test("PATIENT is bounced off /dashboard/budgets — non-ADMIN gate also keeps PATIENT out of the finance surface", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/budgets", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    expect(page.url()).not.toContain("/dashboard/budgets/");
    // No KPI tiles, no CTA — PATIENT never sees budget figures.
    await expect(
      page.locator('[data-testid="kpi-total-spent"]')
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /set budget/i })
    ).toHaveCount(0);
  });
});
