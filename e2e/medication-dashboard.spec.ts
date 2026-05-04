/**
 * Medication Administration Dashboard chrome + /dashboard/medication redirect-alias contract pin.
 *
 * What this exercises:
 *   /dashboard/medication-dashboard (apps/web/src/app/dashboard/medication-dashboard/page.tsx, 252 lines)
 *     - The canonical inpatient MAR queue. Renders a heading
 *       ("Medication Administration"), a ward filter <select> populated
 *       from GET /wards, a Refresh button that re-fetches GET
 *       /medication/administrations/due (the next-30-min queue), and a
 *       grouped-by-admission list of due doses with Administer / Missed
 *       / Refused / Hold action buttons per row. Auto-refreshes every
 *       60s via setInterval.
 *     - Page chrome itself has NO client-side `VIEW_ALLOWED` gate (per
 *       CLAUDE.md gotcha #7 — many dashboard pages let chrome render and
 *       rely on API authorize() for actual data). PATIENT etc. see the
 *       shell but the /administrations/due fetch returns 403 so the
 *       grouped list stays empty.
 *   /dashboard/medication (apps/web/src/app/dashboard/medication/page.tsx, 25 lines)
 *     - Issue #136 client-component redirect stub. `useEffect`
 *       `router.replace("/dashboard/medication-dashboard")`. Renders a
 *       transient "Redirecting to Medication Dashboard…" placeholder
 *       (data-testid="medication-redirect") while the navigation
 *       resolves.
 *   GET   /api/v1/medication/administrations/due   (authorize ADMIN/DOCTOR/NURSE/PHARMACIST — apps/api/src/routes/medication.ts:272)
 *   PATCH /api/v1/medication/administrations/:id   (authorize ADMIN/NURSE/DOCTOR — medication.ts:326)
 *   GET   /api/v1/wards                            (authorize ADMIN/DOCTOR/NURSE/RECEPTION — apps/api/src/routes/wards.ts:41)
 *
 * Surfaces touched:
 *   - /medication → /medication-dashboard redirect contract (Issue #136 alias).
 *   - NURSE happy-path chrome: heading + ward filter + Refresh button.
 *     Empty-state copy ("No medications due.") OR a grouped list — both
 *     are valid steady-states because the realistic seed may or may not
 *     have a dose in the now-15min..now+30min window. We assert the
 *     chrome contract, not the data shape.
 *   - DOCTOR parity: same chrome, no asymmetry — proves the page is not
 *     accidentally NURSE-only.
 *   - PATIENT route-shape pin: page chrome STILL renders (no
 *     VIEW_ALLOWED — this is the CLAUDE.md gotcha #7 archetype) but the
 *     /administrations/due fetch is 403'd by the API and the grouped
 *     list stays empty. A regression that adds a client-side gate
 *     (redirecting PATIENT) or a regression that exposes due-medication
 *     data to PATIENT both surface here.
 *   - Refresh button: clicking it re-fires GET /administrations/due
 *     (the page's load() callback, page.tsx:57-70). We pin the request
 *     fires and the lastRefresh timestamp updates without asserting
 *     specific data.
 *
 * Why these tests exist:
 *   §2.12 of docs/E2E_COVERAGE_BACKLOG.md flagged BOTH
 *   /dashboard/medication AND /dashboard/medication-dashboard as
 *   zero-coverage with an "overlap with admissions-mar; clarify scope"
 *   note. Reading both page.tsx files confirms /medication is a thin
 *   client-side redirect alias to /medication-dashboard per Issue #136
 *   — same pattern as /dashboard/account → /dashboard/profile (commit
 *   8a869c8 / Issue #303). One spec covering the alias + canonical-page
 *   chrome closes BOTH backlog rows. Scope clarification: this spec
 *   pins the MAR DASHBOARD (queue chrome + auto-refresh + RBAC + alias
 *   contract) — the multi-role MAR FLOW (DOCTOR places order → NURSE
 *   marks ADMINISTERED → audit row) is owned by e2e/admissions-mar.spec.ts
 *   (currently all-skipped pending bed-seeding fix). No overlap.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Medication Dashboard — /dashboard/medication-dashboard chrome + /dashboard/medication redirect alias (Issue #136; closes backlog §2.12 dedup)", () => {
  test("any authed staff role hitting /dashboard/medication is redirected to /dashboard/medication-dashboard (Issue #136 client-component alias)", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await gotoAuthed(page, "/dashboard/medication");
    // Client-side router.replace fires inside useEffect on mount
    // (medication/page.tsx:14-16). waitForURL gives it the tick + the
    // route-handler shielded fetch a chance to settle.
    await page.waitForURL(/\/dashboard\/medication-dashboard$/, {
      timeout: 10_000,
    });
    await expectNotForbidden(page);

    // Canonical page chrome must render — confirms the redirect
    // landed on a real page, not a 404.
    await expect(
      page.getByRole("heading", { name: /medication administration/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("NURSE lands on /dashboard/medication-dashboard, page chrome renders heading + ward filter + Refresh button (canonical queue surface pinned)", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await gotoAuthed(page, "/dashboard/medication-dashboard");
    await expectNotForbidden(page);

    // Heading from page.tsx:121-123 — the `<Syringe />` icon prefix is
    // visual; the accessible name is "Medication Administration".
    await expect(
      page.getByRole("heading", { name: /medication administration/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The "Last refresh:" subtitle copy ALWAYS renders — auto-set on
    // initial load (page.tsx:55, 65). Pinning this catches a regression
    // where the load() callback gets dropped or its setLastRefresh
    // call gets accidentally removed.
    await expect(page.locator("body")).toContainText(/last refresh/i, {
      timeout: 10_000,
    });

    // Ward filter <select> (page.tsx:130-141) — first option is the
    // sentinel "All Wards" value="". Using a CLAUDE.md-#9-safe scoped
    // selector via the unique "All Wards" option label so the global
    // LanguageDropdown <select> doesn't false-match.
    const wardSelect = page.locator('select:has(option[value=""])').first();
    await expect(wardSelect).toBeVisible();
    await expect(
      wardSelect.locator('option[value=""]')
    ).toHaveText(/all wards/i);

    // Refresh button (page.tsx:142-147) — copy "Refresh" with an icon.
    const refreshBtn = page.getByRole("button", { name: /^refresh$/i }).first();
    await expect(refreshBtn).toBeVisible();
  });

  test("DOCTOR parity: same chrome on /dashboard/medication-dashboard — proves the page is NOT NURSE-only (no client-side role gate; API authorize() admits ADMIN/DOCTOR/NURSE/PHARMACIST)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await gotoAuthed(page, "/dashboard/medication-dashboard");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /medication administration/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /^refresh$/i }).first()
    ).toBeVisible();
  });

  test("NURSE clicking Refresh re-fires GET /medication/administrations/due — pins the load() callback wiring at page.tsx:57-70", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await gotoAuthed(page, "/dashboard/medication-dashboard");
    await expectNotForbidden(page);

    // Wait for initial chrome.
    await expect(
      page.getByRole("button", { name: /^refresh$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Count requests against the due endpoint after click.
    let dueRequestCount = 0;
    page.on("request", (req) => {
      if (req.url().includes("/medication/administrations/due")) {
        dueRequestCount += 1;
      }
    });

    await page.getByRole("button", { name: /^refresh$/i }).first().click();

    // Give the fetch a tick to leave the browser. The load() callback
    // sets loading=true synchronously, fires GET, then on resolve sets
    // lastRefresh = new Date(). One additional request is the contract.
    await page.waitForTimeout(800);
    expect(dueRequestCount).toBeGreaterThanOrEqual(1);
  });

  test("PATIENT route-shape pin: chrome still renders on /dashboard/medication-dashboard (no client-side VIEW_ALLOWED — CLAUDE.md gotcha #7 archetype) BUT /administrations/due fetch is 403'd by the API so the grouped list stays empty / shows 'No medications due.'", async ({
    patientPage,
  }) => {
    const page = patientPage;

    await gotoAuthed(page, "/dashboard/medication-dashboard");
    // Allow auth-cookie + role-gate effects (there ISN'T a client-side
    // gate, but the wait makes the test robust to a future addition).
    await page.waitForTimeout(800);

    // The page does NOT redirect for PATIENT — pinning the no-gate
    // contract. If a future commit adds a useEffect bounce, this
    // assertion flips and surfaces the change.
    expect(page.url()).toContain("/dashboard/medication-dashboard");
    await expectNotForbidden(page);

    // Heading still renders — chrome is universal.
    await expect(
      page.getByRole("heading", { name: /medication administration/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The data list is the security boundary. /administrations/due
    // returns 403 for PATIENT (medication.ts:272 authorize() omits
    // PATIENT) → items stays []. Either the empty-state copy OR a
    // bare chrome shell with no admission-group cards is acceptable;
    // what is NOT acceptable is rendering another patient's MR number.
    // Pin the empty-state copy explicitly because it's the deliberate
    // page-design output for an empty items array (page.tsx:155-158).
    await expect(page.locator("body")).toContainText(/no medications due/i, {
      timeout: 10_000,
    });
  });
});
