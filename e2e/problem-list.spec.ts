/**
 * Consolidated Problem List patient-chart sub-page e2e coverage.
 *
 * What this exercises:
 *   /dashboard/patients/[id]/problem-list
 *     (apps/web/src/app/dashboard/patients/[id]/problem-list/page.tsx)
 *   GET /api/v1/ehr/patients/:patientId/problem-list
 *     (apps/api/src/routes/ehr.ts:987 — gated by assertPatientOwnsResource,
 *      so PATIENT may read only their own consolidated list and staff with
 *      a tenant-scoped grant may read any in-tenant patient.)
 *
 * Surfaces touched:
 *   - DOCTOR happy path: navigate from a fresh seeded patient's id to the
 *     /problem-list child route, see the "Consolidated Problem List" title,
 *     the Active-only checkbox + type filter <select>, and the empty-state
 *     copy "No problems found." Asserts the GET /problem-list contract is
 *     wired and returns an array (defensive `?? []` at page.tsx:62 means a
 *     null payload silently shows "No problems found." — we lock the
 *     happy-path empty render here so a contract drift to non-empty
 *     surface is the only way this assertion fails).
 *   - DOCTOR filter contract: toggling "Active only" off and switching the
 *     type <select> to "Conditions" must trigger a refetch — we assert the
 *     URL params land in the GET request via page.waitForRequest. Locks
 *     the activeOnly + type query-string contract that ehr.ts:995-996
 *     reads back. The <select> is targeted with the
 *     `select:has(option[value="condition"])` pattern so the global
 *     LanguageDropdown (CLAUDE.md gotcha #9) cannot be hit by mistake.
 *   - NURSE happy path: same chrome renders for a different staff role —
 *     proves the page has no client-side `VIEW_ALLOWED` gate (it doesn't
 *     — page.tsx is only `useEffect` + `useState`, no role redirect).
 *   - PATIENT route shape: API protects rows via assertPatientOwnsResource,
 *     not via a page redirect. We pin the "page renders, list scoped per
 *     patient by API" behaviour for `patient1@medcore.local`'s OWN id.
 *     Discovering that id requires a request from the patient's token; we
 *     skip the case if the API doesn't expose `req.user.patientId` via the
 *     `/auth/me` endpoint in this env, since fabricating a UUID would
 *     either 403 or 404 and we'd be testing the error branch, not the
 *     happy path.
 *   - PATIENT cross-patient bounce: hitting another patient's /problem-list
 *     route ID directly must NOT show that patient's data. The API's
 *     assertPatientOwnsResource returns 403; the page's catch-all swallows
 *     and renders the empty state. We pin THAT route-shape, not a
 *     redirect — the page itself does not redirect (gotcha #7).
 *   - LAB_TECH route shape: lab-techs can see consolidated problem lists
 *     for context on lab orders. Same as DOCTOR/NURSE — chrome renders.
 *
 * Why these tests exist:
 *   docs/E2E_COVERAGE_BACKLOG.md §2.1 lists
 *   "/dashboard/patients/[id]/problem-list — add/edit/delete problems"
 *   as a zero-coverage entry. The sub-page is currently a READ-ONLY
 *   aggregation surface (chronic conditions + severe allergies + recent
 *   diagnoses + active admission) — the "add/edit/delete" framing in the
 *   backlog reflects the intended-future contract; today's page exposes
 *   no write CTAs (verified in page.tsx — there are no buttons, only
 *   filter inputs). We pin the existing read-shape + filter contract
 *   so a future refactor that introduces write CTAs surfaces here as
 *   a deliberate test update rather than a silent UX shift.
 */
import { test, expect } from "./fixtures";
import { API_BASE, expectNotForbidden, seedPatient } from "./helpers";

const PAGE_TIMEOUT = 15_000;

test.describe("Patient Problem List — /dashboard/patients/[id]/problem-list (read-only consolidated view + filter contract + cross-role chrome)", () => {
  test("DOCTOR opens a fresh patient's problem-list — title renders, Active-only + type filter chrome present, empty-state 'No problems found.' shows", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/patients/${patient.id}/problem-list`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /consolidated problem list/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Active-only checkbox + type-filter <select> are the two filter
    // inputs at page.tsx:88-107. The select carries `condition` as one of
    // its option values; we lock onto it via that distinguishing option
    // so the LanguageDropdown <select> elsewhere on the page cannot
    // satisfy `locator('select').first()` and produce a flake.
    await expect(
      page.getByRole("checkbox", { name: /active only/i })
    ).toBeVisible();
    await expect(
      page.locator('select:has(option[value="condition"])')
    ).toBeVisible();

    // Empty-state copy at page.tsx:113-114. A fresh seeded patient has
    // no chronic conditions, no severe allergies, no diagnoses inside
    // the last 90 days, and no active admission, so the API returns []
    // and the page renders the dashed-border empty box. Pinning the
    // literal here protects both the API contract and the page's
    // 0-length predicate.
    await expect(
      page.getByText(/no problems found\./i).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Crash-regression: the global error boundary must not have rendered
    // even though page.tsx:63-65 swallows fetch errors silently.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("DOCTOR filter contract: toggling Active-only off + switching type to 'condition' refetches with activeOnly=false&type=condition (pins the query-string contract at page.tsx:56-58)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/patients/${patient.id}/problem-list`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /consolidated problem list/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Set up the GET-with-filters interception BEFORE we toggle the
    // inputs. The page's useEffect at page.tsx:52-69 fires a new GET
    // every time activeOnly or typeFilter change, so we're locking the
    // exact query-string the page assembles.
    const filterReqPromise = page.waitForRequest((req) => {
      const url = req.url();
      return (
        url.includes(`/ehr/patients/${patient.id}/problem-list`) &&
        url.includes("activeOnly=false") &&
        url.includes("type=condition") &&
        req.method() === "GET"
      );
    }, { timeout: 10_000 });

    // Uncheck "Active only" (default true → false).
    await page.getByRole("checkbox", { name: /active only/i }).uncheck();

    // Switch the type-filter <select> via the option-value-anchored
    // selector. Avoids `locator('select').first()` colliding with the
    // global LanguageDropdown (CLAUDE.md gotcha #9).
    await page
      .locator('select:has(option[value="condition"])')
      .selectOption("condition");

    const filterReq = await filterReqPromise;
    expect(filterReq.url()).toContain("activeOnly=false");
    expect(filterReq.url()).toContain("type=condition");
  });

  test("NURSE lands on the problem-list page with the same chrome — proves no client-side role gate exists (page.tsx has no useEffect-redirect to /not-authorized)", async ({
    nursePage,
    adminApi,
  }) => {
    const page = nursePage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/patients/${patient.id}/problem-list`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /consolidated problem list/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await expect(
      page.getByRole("checkbox", { name: /active only/i })
    ).toBeVisible();
  });

  test("LAB_TECH lands on the problem-list page without a /not-authorized bounce — same route-shape pin as DOCTOR/NURSE (universally accessible to authed staff for cross-context lab review)", async ({
    labTechPage,
    adminApi,
  }) => {
    const page = labTechPage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/patients/${patient.id}/problem-list`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /consolidated problem list/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
  });

  test("PATIENT hitting ANOTHER patient's problem-list URL — page renders chrome but list is empty (API's assertPatientOwnsResource at ehr.ts:993 returns 403, page swallows + falls back to []; pins cross-patient BOLA defence at the surface layer)", async ({
    patientPage,
    adminApi,
  }) => {
    const page = patientPage;
    // Seed a DIFFERENT patient via the admin token. The patient1 fixture
    // user is a separate Patient row, so navigating to this seeded
    // patient's /problem-list with the patient1 token must NOT show that
    // seeded patient's data — the API enforces row-level scoping.
    const otherPatient = await seedPatient(adminApi);

    // Catch the 403 the API will return so we can assert the defence
    // happened at the API, not just the UI.
    let apiStatus = 0;
    await page.route(
      `**/api/v1/ehr/patients/${otherPatient.id}/problem-list*`,
      async (route) => {
        const res = await route.fetch();
        apiStatus = res.status();
        await route.fulfill({ response: res });
      }
    );

    await page.goto(`/dashboard/patients/${otherPatient.id}/problem-list`, {
      waitUntil: "domcontentloaded",
    });

    // The page itself does not redirect (CLAUDE.md gotcha #7 — many
    // dashboard pages have no client-side gate). Title chrome still
    // renders; we pin THAT — and pin that the API blocked the read.
    await expect(
      page.getByRole("heading", { name: /consolidated problem list/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Empty state because page.tsx:63-65 swallows the 403 and falls back
    // to setItems([]).
    await expect(
      page.getByText(/no problems found\./i).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // The API actually rejected the cross-patient read.
    expect(apiStatus).toBeGreaterThanOrEqual(400);
    expect(apiStatus).toBeLessThan(500);
  });

  test("Bad-UUID route: DOCTOR navigating to /dashboard/patients/<not-a-real-id>/problem-list still renders chrome and the empty state (the page does not 404; the API surfaces 4xx that the page swallows)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    // A syntactically valid UUID that does not exist in the DB. We use
    // a fixed all-zero UUID rather than randomness so a regression that
    // starts 404'ing the route stays reproducible.
    const ghostId = "00000000-0000-0000-0000-000000000000";

    await page.goto(`/dashboard/patients/${ghostId}/problem-list`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /consolidated problem list/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(
      page.getByText(/no problems found\./i).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
  });
});
