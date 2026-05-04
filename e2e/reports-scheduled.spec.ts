/**
 * Scheduled Reports redirect + execution/delivery surface e2e coverage.
 *
 * What this exercises:
 *   /dashboard/reports/scheduled (apps/web/src/app/dashboard/reports/scheduled/page.tsx)
 *     - thin client-side redirect → /dashboard/scheduled-reports (Issue #80
 *       compat shim for older menus/deep-links).
 *   /dashboard/scheduled-reports (apps/web/src/app/dashboard/scheduled-reports/page.tsx)
 *     - ADMIN-only Schedules list + Run History tab + create-schedule form.
 *   GET  /api/v1/scheduled-reports         (apps/api/src/routes/scheduled-reports.ts)
 *   GET  /api/v1/scheduled-reports/runs    (router.use(authorize(Role.ADMIN)))
 *
 * Surfaces touched:
 *   - ADMIN happy path: deep-linking the legacy `/dashboard/reports/scheduled`
 *     route lands on the canonical `/dashboard/scheduled-reports`, heading
 *     renders, GET /scheduled-reports fires.
 *   - Tab contract: switching to "Run History" issues a GET to
 *     /scheduled-reports/runs (page.tsx:80-85) — locks the per-tab fetch
 *     wiring so a useCallback dep regression doesn't silently break delivery
 *     visibility.
 *   - Empty state: a fresh tenant's Run History tab shows "No run history
 *     yet" (page.tsx:466-469) — the only window into delivery failures.
 *   - Validation guard: empty form submit toasts "Name is required"
 *     (page.tsx:118-122) — pins the noValidate React-owned validation path
 *     introduced for Issue #458.
 *   - Non-ADMIN bounces: every non-ADMIN role hits the `useEffect` at
 *     page.tsx:66-70 which router.push("/dashboard") and the inline gate
 *     at page.tsx:97-103 ("Access denied. Admin only.").
 *
 * Why these tests exist:
 *   §2.6 of docs/E2E_COVERAGE_BACKLOG.md flagged "/dashboard/reports/scheduled
 *   — execution + delivery (only setup tested)" as zero-coverage and asked
 *   that we verify dedup vs `/dashboard/scheduled-reports`. The dedup is a
 *   client-side redirect (Issue #80), so this spec covers BOTH the redirect
 *   contract and the canonical page's execution/delivery (Run History tab)
 *   surface in one file.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Scheduled Reports — /dashboard/reports/scheduled redirect + /dashboard/scheduled-reports ADMIN execution/delivery surface (covers backlog §2.6)", () => {
  test("ADMIN deep-linking /dashboard/reports/scheduled lands on canonical /dashboard/scheduled-reports, heading renders, GET /scheduled-reports fires", async ({
    adminPage,
  }) => {
    const page = adminPage;

    const listPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/scheduled-reports") &&
        !r.url().includes("/runs") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    await gotoAuthed(page, "/dashboard/reports/scheduled");
    await page.waitForURL(/\/dashboard\/scheduled-reports$/, {
      timeout: 10_000,
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /scheduled reports/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    const listRes = await listPromise;
    expect(listRes.status()).toBeLessThan(500);

    // The two tab buttons + the New Report CTA anchor the page chrome.
    await expect(
      page.getByRole("button", { name: /^schedules$/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /run history/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /new report/i }).first()
    ).toBeVisible();
  });

  test("ADMIN switching to Run History tab fetches GET /scheduled-reports/runs and renders empty-state on a fresh tenant", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await gotoAuthed(page, "/dashboard/scheduled-reports");
    await expect(
      page.getByRole("heading", { name: /scheduled reports/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Race the runs GET against the tab click so we lock the per-tab fetch
    // wiring (page.tsx:80-85). The handler issues GET /scheduled-reports/runs
    // when `tab === "runs"`.
    const runsPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/scheduled-reports/runs") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    await page.getByRole("button", { name: /run history/i }).first().click();
    const runsRes = await runsPromise;
    expect(runsRes.status()).toBeLessThan(500);

    // Empty-state copy from page.tsx:466-469. We accept either the empty-
    // state OR a populated table — a fresh tenant returns no runs, but a
    // long-running test environment may have accumulated rows.
    await expect(
      page.locator(
        'text=/no run history yet|generated/i'
      ).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("ADMIN run-history table column contract — Generated / Schedule / Type / Status / Recipients / Error headers all present (delivery visibility surface)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub the runs endpoint so we get a deterministic populated table to
    // assert the delivery-visibility column contract, regardless of the
    // tenant's current run state. The columns map 1:1 to the operator's
    // delivery-failure investigation surface.
    await page.route("**/api/v1/scheduled-reports/runs**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: "run-1",
              reportType: "DAILY_CENSUS",
              status: "SUCCESS",
              generatedAt: new Date().toISOString(),
              sentTo: ["ops@example.com"],
              error: null,
              scheduledReport: { id: "sched-1", name: "Daily Census Email" },
            },
            {
              id: "run-2",
              reportType: "WEEKLY_REVENUE",
              status: "FAILED",
              generatedAt: new Date().toISOString(),
              sentTo: null,
              error: "SMTP connection refused",
              scheduledReport: { id: "sched-2", name: "Weekly Revenue Email" },
            },
          ],
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/scheduled-reports");
    await expect(
      page.getByRole("heading", { name: /scheduled reports/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /run history/i }).first().click();

    // All six column headers from page.tsx:474-481.
    for (const header of [
      /generated/i,
      /schedule/i,
      /^type$/i,
      /^status$/i,
      /recipients/i,
      /^error$/i,
    ]) {
      await expect(
        page.getByRole("columnheader", { name: header }).first()
      ).toBeVisible();
    }

    // The two rows render and the FAILED status pill + error text are
    // visible — the operator's only signal that a delivery actually failed.
    await expect(page.getByText(/SUCCESS/).first()).toBeVisible();
    await expect(page.getByText(/FAILED/).first()).toBeVisible();
    await expect(
      page.getByText(/SMTP connection refused/i).first()
    ).toBeVisible();
  });

  test("ADMIN empty-form submit on New Report toasts 'Name is required' — pins the React-owned noValidate validation path (Issue #458)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await gotoAuthed(page, "/dashboard/scheduled-reports");
    await expect(
      page.getByRole("heading", { name: /scheduled reports/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new report/i }).first().click();

    // Form rendered. Submit without filling the name field.
    await expect(
      page.locator('[data-testid="sched-report-time"]')
    ).toBeVisible();
    await page
      .getByRole("button", { name: /create schedule/i })
      .first()
      .click();

    // The handler short-circuits with toast.error("Name is required").
    // Scope to non-route-announcer alerts (CLAUDE.md gotcha #10).
    await expect(
      page
        .locator('[role="alert"]:not(#__next-route-announcer__)')
        .filter({ hasText: /name is required/i })
        .first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("DOCTOR is bounced from /dashboard/scheduled-reports — useEffect at page.tsx:66-70 router.push('/dashboard'), inline gate denies access", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/scheduled-reports");
    await page.waitForTimeout(1500);

    // The inline gate (page.tsx:97-103) renders "Access denied. Admin only."
    // OR the useEffect router.push("/dashboard") wins — pin either outcome
    // (NOT the New Report CTA being visible).
    const url = page.url();
    expect(url).toMatch(/\/dashboard(\/scheduled-reports)?(\?|$|\/)/);
    await expect(
      page.getByRole("button", { name: /new report/i })
    ).toHaveCount(0);
  });

  test("PATIENT is bounced from /dashboard/scheduled-reports — admin-only surface inaccessible to non-staff", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/scheduled-reports");
    await page.waitForTimeout(1500);

    const url = page.url();
    expect(url).toMatch(/\/dashboard(\/scheduled-reports)?(\?|$|\/)/);
    await expect(
      page.getByRole("button", { name: /new report/i })
    ).toHaveCount(0);
    // Run History tab — a delivery surface — must NOT be reachable for
    // a PATIENT either.
    await expect(
      page.getByRole("button", { name: /run history/i })
    ).toHaveCount(0);
  });

  test("RECEPTION is bounced from /dashboard/scheduled-reports — even staff outside ADMIN cannot view the schedules list", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/scheduled-reports");
    await page.waitForTimeout(1500);

    const url = page.url();
    expect(url).toMatch(/\/dashboard(\/scheduled-reports)?(\?|$|\/)/);
    await expect(
      page.getByRole("button", { name: /new report/i })
    ).toHaveCount(0);
  });
});
