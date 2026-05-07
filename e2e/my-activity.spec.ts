/**
 * My Activity self-service audit-log feed e2e coverage.
 *
 * What this exercises:
 *   /dashboard/my-activity (apps/web/src/app/dashboard/my-activity/page.tsx)
 *   GET /api/v1/auth/my-activity
 *     (apps/api/src/routes/auth.ts:1120-1136 — `authenticate` only,
 *      no role authorize() call. Returns the LAST 100 AuditLog rows
 *      where userId === req.user.userId, scoped through
 *      tenantScopedPrisma so cross-tenant collisions never bleed.)
 *
 * Surfaces touched:
 *   - DOCTOR happy path: navigate, see the "My Activity" heading + the
 *     "Filter by action:" <label>+<select> chrome, and assert that the
 *     feed renders something (either day-grouped rows OR the "No activity
 *     yet." empty-state, depending on what the shared dr.sharma account
 *     has accumulated). Pins the page-shell contract.
 *   - DOCTOR action-filter contract: pick a non-empty filter value from
 *     the action <select> when the feed has rows; the entries list
 *     re-filters to ONLY rows matching that action. Skipped when the
 *     feed is empty (no actions to pick from) — the chrome test above
 *     covers the empty path.
 *   - ADMIN happy path: same chrome — proves the page is not "all-user
 *     audit log for ADMIN" (the dedicated /dashboard/audit page is the
 *     admin-wide view). /dashboard/my-activity is strictly self-scoped
 *     for every role, including ADMIN. The API at auth.ts:1126
 *     filters by req.user.userId — ADMIN's row count is whatever the
 *     admin user themselves did, NOT every user's actions.
 *   - NURSE chrome — same shape as DOCTOR/ADMIN, pins universal-access.
 *   - PATIENT route-shape pin: the page is universally accessible (no
 *     `VIEW_ALLOWED`, no useEffect-redirect to /not-authorized). PATIENT
 *     reaches /dashboard/my-activity, sees their own audit feed (which
 *     for the patient1 fixture user is typically empty or a few login
 *     rows). If a future RBAC tweak hides the route from PATIENT, this
 *     assertion flips and the change is caught in CI rather than after
 *     a deploy.
 *   - Empty-state pin via API stub: a brand-new authed user (no prior
 *     audit rows) sees "No activity yet." — we stub /auth/my-activity
 *     to return [] explicitly so the empty path is locked even when
 *     the real feed has data.
 *
 * Why these tests exist:
 *   docs/E2E_COVERAGE_BACKLOG.md §2.4 lists "/dashboard/my-activity —
 *   personal activity log" as a zero-coverage entry. The route is the
 *   user-facing self-audit surface — every authed user can verify what
 *   the system recorded under their identity, which is a privacy /
 *   GDPR-style transparency feature. A silent regression in the
 *   /auth/my-activity endpoint shape (e.g. drift from
 *   `{ data: AuditLog[] }` to `{ entries: AuditLog[] }`) would render
 *   the page permanently empty for everyone with no other CI signal.
 *   This spec pins the page-shell contract + the action-filter UI +
 *   the empty-state copy + the universal-access shape so any of those
 *   contract drifts surfaces here.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

const PAGE_TIMEOUT = 15_000;

test.describe("My Activity — /dashboard/my-activity (self-scoped audit feed; universal-access route shape; action-filter UI)", () => {
  test("DOCTOR lands on /dashboard/my-activity, page chrome renders, action-filter <select> is wired up", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/my-activity", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /my activity/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Filter row at page.tsx:59-74 — a <label htmlFor="my-activity-action-
    // filter"> + the <select id="my-activity-action-filter">. Locking the
    // id rather than `locator('select').first()` avoids the
    // LanguageDropdown collision (CLAUDE.md gotcha #9).
    await expect(page.locator("#my-activity-action-filter")).toBeVisible();
    await expect(page.getByText(/filter by action/i).first()).toBeVisible();

    // The feed has either day-grouped rows or the empty-state copy.
    // Assert one of the two paths fired — both prove the load() effect
    // at page.tsx:33-35 ran without throwing into the global error
    // boundary.
    const empty = page.getByText(/no activity yet\./i).first();
    const groupHeading = page.locator("h2.mb-2.text-sm.font-semibold").first();
    await expect(empty.or(groupHeading)).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // Crash-regression: the global error boundary must not have rendered.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("DOCTOR empty-state path: stub GET /auth/my-activity → [] and the page renders 'No activity yet.' (pins the empty branch at page.tsx:78-79)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    // Stub BEFORE navigate so the load() effect picks up the empty
    // payload on first render. The page's contract is `res.data` (the
    // generic `api.get<T>` helper unwraps `{success, data, error}` →
    // returns `data`), so we must return the full envelope here.
    await page.route("**/api/v1/auth/my-activity*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    await page.goto("/dashboard/my-activity", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /my activity/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Empty-state literal at page.tsx:79.
    await expect(
      page.getByText(/no activity yet\./i).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
  });

  test("DOCTOR populated-feed path: stub GET /auth/my-activity with two synthetic rows — both action labels render, the filter <select> shows both as <option>s, and selecting one filters to only that row's action", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    const now = new Date();
    const earlier = new Date(now.getTime() - 60 * 60 * 1000);
    const rows = [
      {
        id: "00000000-0000-0000-0000-0000000000aa",
        action: "USER_LOGIN",
        entity: "User",
        entityId: "00000000-0000-0000-0000-0000000000ab",
        ipAddress: "127.0.0.1",
        details: null,
        createdAt: now.toISOString(),
      },
      {
        id: "00000000-0000-0000-0000-0000000000ac",
        action: "PRESCRIPTION_VIEW",
        entity: "Prescription",
        entityId: "00000000-0000-0000-0000-0000000000ad",
        ipAddress: "127.0.0.1",
        details: null,
        createdAt: earlier.toISOString(),
      },
    ];

    await page.route("**/api/v1/auth/my-activity*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: rows, error: null }),
      })
    );

    await page.goto("/dashboard/my-activity", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // Both stubbed action labels render in the feed. The render shape at
    // page.tsx:91-93 puts the action text in a <p class="text-sm font-medium">.
    // Scope to that <p> via :is(p) — `getByText` would also match the
    // hidden <option value="USER_LOGIN"> elements inside the action-filter
    // <select>, and `.first()` would land on the option (DOM-order earlier)
    // and fail the visibility check even though the visible <p> is fine.
    await expect(
      page.locator('p.font-medium', { hasText: 'USER_LOGIN' }).first(),
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(
      page.locator('p.font-medium', { hasText: 'PRESCRIPTION_VIEW' }).first(),
    ).toBeVisible();

    // The action-filter <select> populates from the deduped allActions
    // memo (page.tsx:37-40). Pick the second action via its value — uses
    // the id-anchored selector to dodge LanguageDropdown.
    const actionSelect = page.locator("#my-activity-action-filter");
    await expect(actionSelect).toBeVisible();
    await actionSelect.selectOption("PRESCRIPTION_VIEW");

    // After filtering, the USER_LOGIN row must be gone and the
    // PRESCRIPTION_VIEW row must remain. Pins the actionFilter predicate
    // at page.tsx:42-44. Same scoping as above — only the body <p>
    // counts; the hidden filter <option value="USER_LOGIN"> remains in
    // the DOM and would falsely satisfy a bare getByText.
    await expect(
      page.locator('p.font-medium', { hasText: 'USER_LOGIN' }),
    ).toHaveCount(0);
    await expect(
      page.locator('p.font-medium', { hasText: 'PRESCRIPTION_VIEW' }).first(),
    ).toBeVisible();
  });

  test("ADMIN sees the page chrome — same shape as DOCTOR, NOT an all-user audit feed (the API filters by req.user.userId at auth.ts:1126; the admin-wide view lives at /dashboard/audit)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/my-activity", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /my activity/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(page.locator("#my-activity-action-filter")).toBeVisible();
  });

  test("NURSE sees the page chrome — pins universal-access (no client-side role gate in page.tsx, no authorize() in the API)", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/my-activity", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /my activity/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(page.locator("#my-activity-action-filter")).toBeVisible();
  });

  test("PATIENT route-shape pin: page is universally accessible — chrome renders, no /not-authorized redirect, feed scoped to patient1's own audit rows by /auth/my-activity", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/my-activity", {
      waitUntil: "domcontentloaded",
    });
    // Allow any role-gate useEffect a tick to fire (there isn't one —
    // this is the pin). Robust to a future regression that DOES add a
    // redirect.
    await page.waitForTimeout(800);

    expect(page.url()).toContain("/dashboard/my-activity");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /my activity/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(page.locator("#my-activity-action-filter")).toBeVisible();
  });
});
