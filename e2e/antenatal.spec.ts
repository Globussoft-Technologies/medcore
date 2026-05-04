/**
 * Antenatal Care case list — /dashboard/antenatal chrome + Add-Case modal contract + RBAC.
 *
 * What this exercises:
 *   /dashboard/antenatal (apps/web/src/app/dashboard/antenatal/page.tsx)
 *   GET   /api/v1/antenatal/cases       (list, no authorize() — every authed
 *                                        user, antenatal.ts:278.)
 *   GET   /api/v1/antenatal/dashboard   (KPI tiles, antenatal.ts:119.)
 *   POST  /api/v1/antenatal/cases       (DOCTOR / NURSE / ADMIN, structural
 *                                        pin only — no submit. Issue #459 RBAC
 *                                        drift fix surfaced NURSE in the
 *                                        canCreate predicate, page.tsx:96-97.)
 *
 * Surfaces touched:
 *   - DOCTOR: page chrome (heading + tab cluster Active/High Risk/Delivered/All
 *     + "New ANC Case" CTA + 4 KPI tiles once /antenatal/dashboard resolves).
 *   - NURSE: parity, INCLUDING the New-ANC-Case CTA — page.tsx:96-97 expanded
 *     canCreate to NURSE per Issue #459 (server-side `POST /antenatal/cases`
 *     accepts NURSE, antenatal.ts:192).
 *   - DOCTOR opens the New-ANC-Case modal: form structural contract holds
 *     (anc-patient-search input + anc-doctor select scoped to dodge the
 *     LanguageDropdown gotcha #9 + anc-lmp-date with `max=today` Issue #57
 *     guard + anc-gravida (min=1) + anc-parity (min=0) + anc-blood-group
 *     select + High-Risk checkbox + Cancel teardown).
 *   - PATIENT / RECEPTION: UNIVERSAL-ACCESS archetype (CLAUDE.md gotcha #7
 *     archetype 3) — page.tsx has NO `VIEW_ALLOWED` constant, NO
 *     `router.push`/`router.replace` redirect. Page chrome renders for any
 *     authed user; the API gate (`POST /cases` authorize() in
 *     antenatal.ts:192) is the real truth, and `GET /cases` has no
 *     authorize() at all (handler-level BOLA verdict on detail rows lives in
 *     antenatal.ts:355 via assertPatientOwnsResource). Tests pin the
 *     page-renders + canCreate-flag-hides-CTA contract for non-staff roles.
 *
 * Why these tests exist:
 *   docs/E2E_COVERAGE_BACKLOG.md §2.12 line 174 lists "/dashboard/antenatal,
 *   /dashboard/antenatal/[id] — antenatal care" as a zero-coverage entry.
 *   The list page is the entry into the maternity workflow — a regression
 *   that hides the New-ANC-Case CTA from NURSE (re-introducing the Issue
 *   #459 RBAC drift) or breaks the tab-cluster query-string wiring would
 *   silently regress a high-volume clinical surface. We pin the chrome,
 *   the canCreate matrix, and the modal structural contract; we do NOT
 *   submit the form (a real POST requires a FEMALE patient + a doctor,
 *   each of which would pollute shared seed across runs — coverage of
 *   the lifecycle write paths happens via API in antenatal-id.spec.ts).
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

const PAGE_TIMEOUT = 15_000;

test.describe("Antenatal — /dashboard/antenatal (DOCTOR/NURSE primary chrome + create-modal contract + universal-access RBAC pin)", () => {
  test("DOCTOR lands on /dashboard/antenatal — page chrome (heading + tab cluster + KPI tiles + New-ANC-Case CTA) all render", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/antenatal");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /antenatal care/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Subtitle copy locks the page-level intro line — page.tsx:252-254.
    await expect(
      page.getByText(/pregnancy monitoring and maternity management/i)
    ).toBeVisible();

    // Tab cluster — page.tsx:316-328. All 4 tabs present.
    await expect(page.getByRole("button", { name: /^active$/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^high risk$/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^delivered$/i })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^all$/i })).toBeVisible();

    // "New ANC Case" CTA — DOCTOR satisfies canCreate (page.tsx:96-97).
    await expect(
      page.getByRole("button", { name: /new anc case/i })
    ).toBeVisible();

    // KPI tiles paint once /antenatal/dashboard resolves — page.tsx:267-313.
    // We anchor on the unique label copy for each tile rather than colour
    // classes (which can drift). Use `.first()` because the live-region
    // announcer can briefly mirror the labels on first paint.
    await expect(page.getByText(/active cases/i).first()).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });
    await expect(page.getByText(/^high risk$/i).first()).toBeVisible();
    await expect(
      page.getByText(/upcoming deliveries \(30d\)/i)
    ).toBeVisible();
    await expect(page.getByText(/overdue deliveries/i)).toBeVisible();
  });

  test("NURSE lands on /dashboard/antenatal — staff role parity, New-ANC-Case CTA visible (Issue #459 RBAC-drift fix)", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await gotoAuthed(page, "/dashboard/antenatal");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /antenatal care/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // The Issue #459 fix expanded `canCreate` to include NURSE (page.tsx:96-97)
    // because antenatal is a nurse-led workflow and the server-side
    // `POST /antenatal/cases` already accepts NURSE (antenatal.ts:192). This
    // assertion locks that fix so a future regression hiding the CTA from
    // NURSE shows up here.
    await expect(
      page.getByRole("button", { name: /new anc case/i })
    ).toBeVisible();
  });

  test("DOCTOR can flip tabs — clicking 'High Risk' refires GET /antenatal/cases?isHighRisk=true&delivered=false (page.tsx:117-130 query-string contract)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/antenatal");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("button", { name: /^high risk$/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Listen for the refetch — the tab effect (page.tsx:99-102) re-issues
    // GET /antenatal/cases with the new query-string when `tab` changes.
    const reqP = page.waitForRequest(
      (r) =>
        r.method() === "GET" &&
        /\/antenatal\/cases\?isHighRisk=true&delivered=false/.test(r.url()),
      { timeout: PAGE_TIMEOUT }
    );

    await page.getByRole("button", { name: /^high risk$/i }).click();
    const req = await reqP;
    expect(req.url()).toContain("isHighRisk=true");
    expect(req.url()).toContain("delivered=false");

    // Page must remain mounted (no crash on tab flip).
    expect(page.url()).toContain("/dashboard/antenatal");
    await expectNotForbidden(page);
  });

  test("DOCTOR opens the New-ANC-Case modal: form structural contract holds (patient-search + doctor select + LMP-date with max=today + gravida/parity numeric guards + blood-group select + High-Risk checkbox + Cancel teardown)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/antenatal");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("button", { name: /new anc case/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await page.getByRole("button", { name: /new anc case/i }).click();

    // Modal heading is the unique anchor (page.tsx:431).
    await expect(
      page.getByRole("heading", { name: /new antenatal case/i })
    ).toBeVisible({ timeout: 5_000 });

    // Patient picker (search input — page.tsx:467-473, has aria-required).
    const patientSearch = page.locator('[data-testid="anc-patient-search"]');
    await expect(patientSearch).toBeVisible();
    await expect(patientSearch).toHaveAttribute("aria-required", "true");

    // Doctor <select>. Scope by has(option) to dodge the LanguageDropdown
    // <select> the dashboard layout injects (CLAUDE.md gotcha #9). We use
    // the placeholder option text "Select Doctor" which is unique to this
    // select on the page (page.tsx:506).
    const doctorSelect = page.locator(
      'select:has(option[value=""]:has-text("Select Doctor"))'
    );
    await expect(doctorSelect).toBeVisible();

    // LMP date — Issue #57 max=today guard (page.tsx:521).
    const lmpDate = page.locator('[data-testid="anc-lmp-date"]');
    await expect(lmpDate).toBeVisible();
    const today = new Date().toISOString().slice(0, 10);
    await expect(lmpDate).toHaveAttribute("max", today);

    // Gravida (min=1, step=1 — Issue #57 page.tsx:538-539).
    const gravida = page.locator('[data-testid="anc-gravida"]');
    await expect(gravida).toBeVisible();
    await expect(gravida).toHaveAttribute("min", "1");

    // Parity (min=0 — page.tsx:553).
    const parity = page.locator('[data-testid="anc-parity"]');
    await expect(parity).toBeVisible();
    await expect(parity).toHaveAttribute("min", "0");

    // Blood-group select (Issue #57 canonical ABO+Rh tokens — page.tsx:567).
    const bloodGroup = page.locator('[data-testid="anc-blood-group"]');
    await expect(bloodGroup).toBeVisible();
    // At least one canonical ABO+Rh option must be there — A_POSITIVE is the
    // first canonical token from ALL_BLOOD_GROUPS in @medcore/shared.
    await expect(
      bloodGroup.locator('option[value="A_POSITIVE"]')
    ).toHaveCount(1);

    // High-Risk checkbox — page.tsx:585-595. The label includes the literal
    // copy "Mark as High Risk Pregnancy".
    await expect(
      page.getByLabel(/mark as high risk pregnancy/i)
    ).toBeVisible();

    // Cancel teardown — modal must unmount cleanly.
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect(
      page.getByRole("heading", { name: /new antenatal case/i })
    ).toHaveCount(0);
  });

  test("PATIENT lands on /dashboard/antenatal (UNIVERSAL-ACCESS archetype — no router.replace gate; New-ANC-Case CTA hidden via canCreate=false predicate)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/antenatal");
    // Allow the (intentionally absent) gate effect a tick to NOT fire.
    await page.waitForTimeout(800);

    // Pin reality: page has NO `VIEW_ALLOWED` constant, NO `router.push`/
    // `router.replace` redirect (`grep -n` confirms zero hits). PATIENT
    // stays on the page. This matches CLAUDE.md gotcha #7 archetype 3.
    expect(page.url()).toMatch(/\/dashboard\/antenatal(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /antenatal care/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // canCreate predicate (page.tsx:96-97) excludes PATIENT, so the
    // New-ANC-Case CTA must NOT render for the patient role.
    await expect(
      page.getByRole("button", { name: /new anc case/i })
    ).toHaveCount(0);
  });

  test("RECEPTION lands on /dashboard/antenatal (UNIVERSAL-ACCESS archetype — chrome renders, but RECEPTION is outside canCreate so the New-ANC-Case CTA is hidden)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/antenatal");
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard\/antenatal(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /antenatal care/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // canCreate is DOCTOR/ADMIN/NURSE only — RECEPTION sees no CTA.
    await expect(
      page.getByRole("button", { name: /new anc case/i })
    ).toHaveCount(0);
  });
});
