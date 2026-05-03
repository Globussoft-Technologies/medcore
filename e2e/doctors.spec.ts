/**
 * Doctor directory admin-only e2e coverage.
 *
 * What this exercises:
 *   /dashboard/doctors (apps/web/src/app/dashboard/doctors/page.tsx)
 *   GET /api/v1/doctors (apps/api/src/routes/doctors.ts)
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome renders, the search input + spec
 *     filter + "Add Doctor" CTA are visible (DOCTORS_ALLOWED is locked
 *     to ["ADMIN"] in page.tsx:61).
 *   - Search CTA: typing into #doctor-search-input narrows the rendered
 *     row count via the 300ms-debounced client-side filter
 *     (page.tsx:109-115, page.tsx:158-176).
 *   - Add-Doctor modal opens on CTA click (locks the modal testid
 *     contract used by the create flow on page.tsx:493-803).
 *   - RBAC: DOCTOR / NURSE / PATIENT bounce off /dashboard/doctors —
 *     page.tsx:100-107 redirects every non-ADMIN role to
 *     /dashboard/not-authorized.
 *
 * Why these tests exist:
 *   /dashboard/doctors was listed under §2.4 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "doctor directory" with no e2e
 *   coverage. The page is the admin's primary doctor-roster surface
 *   (Issue #168 rebuild on top of DataTable), and a regression in the
 *   admin-only RBAC gate would either expose roster PII to clinical
 *   staff or hide the page from admins entirely. This file pins the
 *   testid contract for the toolbar + modal and the redirect for every
 *   other role we have a fixture for.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Doctor directory — /dashboard/doctors (ADMIN-only roster + non-ADMIN RBAC bounces)", () => {
  test("ADMIN lands on /dashboard/doctors, the page heading + search + spec filter + Add-Doctor CTA all render", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/doctors", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    // Page heading is the literal "Doctors" in page.tsx:397.
    await expect(
      page.getByRole("heading", { name: /^doctors$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Toolbar contract: search input, specialization filter, Add-Doctor
    // button. All three are admin-only; if the role gate ever leaks the
    // CTA to non-ADMIN we want the RBAC tests below to fail BEFORE the
    // CTA testid lookup so the failure mode stays clear.
    await expect(
      page.locator('[data-testid="doctor-search-input"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="doctor-spec-filter"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="doctor-add-button"]')
    ).toBeVisible();
  });

  test("ADMIN search input filters the doctor list — typing a no-match string empties the table via the 300ms debounce", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/doctors", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    // Wait for the table to settle (loadDoctors → setLoading(false)). The
    // header subtitle echoes "{n} doctors" — once that text is present the
    // first GET /doctors round-trip is done.
    await expect(
      page.getByText(/\d+ doctors?/).first()
    ).toBeVisible({ timeout: 15_000 });

    // Type a recognisable no-match string. The page filters client-side
    // across name / email / phone / specialization / qualification, so a
    // long random alphabetic blob can never match a real seeded row.
    const noMatch = `zzz-no-match-${Date.now()}`;
    await page
      .locator('[data-testid="doctor-search-input"]')
      .fill(noMatch);

    // 300ms debounce + React render. The empty state from page.tsx:469-489
    // surfaces "No doctors match your filters" when the filter set is
    // active and the result list is empty.
    await expect(
      page.getByText(/no doctors match your filters/i).first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("ADMIN can open the Add-Doctor modal: clicking the CTA reveals the modal and the form-name input", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/doctors", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.locator('[data-testid="doctor-add-button"]')
    ).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="doctor-add-button"]').click();

    // Modal mounts in-DOM (NOT a native <dialog>) per page.tsx:493-499.
    // Locking `doctor-add-modal` + `doctor-form-name` here means a regression
    // in the testid contract of the create flow surfaces here as a quick
    // visibility failure instead of much-later flakes in any future
    // create-doctor specs that reuse these hooks.
    await expect(
      page.locator('[data-testid="doctor-add-modal"]')
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="doctor-form-name"]')
    ).toBeVisible();
  });

  test("DOCTOR bounces off /dashboard/doctors — DOCTORS_ALLOWED is admin-only in page.tsx:61", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/doctors", { waitUntil: "domcontentloaded" });
    // Allow the role-gate useEffect a tick to fire.
    await page.waitForTimeout(800);

    // Either we're on the access-denied surface or the app pushed us back
    // to /dashboard. Both are acceptable per the issue-#179 pattern (used
    // in symptom-diary.spec.ts:168-186 as the canonical assertion).
    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);

    // The admin-only Add-Doctor CTA must NOT render for DOCTOR.
    await expect(
      page.locator('[data-testid="doctor-add-button"]')
    ).toHaveCount(0);
  });

  test("NURSE bounces off /dashboard/doctors — DOCTORS_ALLOWED is admin-only in page.tsx:61", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/doctors", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );
    await expect(
      page.locator('[data-testid="doctor-add-button"]')
    ).toHaveCount(0);
  });

  test("PATIENT bounces off /dashboard/doctors — the doctor roster is HR/clinical-admin only, NOT a public directory (page.tsx:57-61)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/doctors", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );
    await expect(
      page.locator('[data-testid="doctor-add-button"]')
    ).toHaveCount(0);
  });
});
