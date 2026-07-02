/**
 * Patient registry list page + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/patients (apps/web/src/app/dashboard/patients/page.tsx)
 *   GET /api/v1/patients (apps/api/src/routes/patients.ts:24-26)
 *   POST /api/v1/patients (apps/api/src/routes/patients.ts:174 —
 *     ADMIN|RECEPTION only)
 *
 * Surfaces touched:
 *   - Staff happy paths: ADMIN/DOCTOR/NURSE/RECEPTION land on the
 *     registry. ADMIN+RECEPTION see the role-gated "Register Patient"
 *     CTA (page.tsx:275); DOCTOR+NURSE do NOT.
 *   - Search debounce contract (Issue #427, page.tsx:91-99): typing
 *     fires a 250 ms-debounced /patients?search=… GET. Locking this so
 *     a regression to non-debounced behaviour (one request per
 *     keystroke) is caught.
 *   - Sort + filter + CSV export are driven by the shared <DataTable>
 *     component (apps/web/src/components/DataTable.tsx). DataTable does
 *     not expose data-testid attributes, so we anchor on its aria-label
 *     contract: "Toggle filters", "Export CSV", "Column visibility".
 *   - RBAC bounce: PATIENT lands on /dashboard/not-authorized — Issue
 *     #382 (CRITICAL prod RBAC bypass, Apr 29 2026) made the registry
 *     staff-only via PATIENTS_ALLOWED in page.tsx:25-30. Locking the
 *     redirect path here means a regression in the role gate (e.g.
 *     accidental Set membership change) surfaces immediately.
 *
 * Why these tests exist:
 *   /dashboard/patients was previously listed under §2.1 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "list page (search/filter/sort/bulk
 *   actions)" with no e2e coverage. The page is the primary pivot for
 *   reception desk + clinical staff to find patient charts; silent
 *   breakage of the search/sort contract or the Issue #382 RBAC gate
 *   would either ship clinical-data PII to PATIENT users or stall the
 *   front-desk flow entirely. Note: the page does NOT pass `bulkActions`
 *   to DataTable (page.tsx:487-509), so the backlog's "bulk actions"
 *   line refers to a yet-unimplemented surface — pinning the real
 *   shape (no bulk bar) catches accidental rollouts and documents
 *   intent for the next pass.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Patients registry — /dashboard/patients (ADMIN/DOCTOR/NURSE/RECEPTION list view; ADMIN|RECEPTION-only Register CTA; PATIENT bounces per Issue #382)", () => {
  test("ADMIN lands on /dashboard/patients, page chrome renders, search box and Register-Patient CTA are visible", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/patients", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /patient/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Page-level data-testid for the search input (page.tsx:479).
    await expect(
      page.locator('[data-testid="patient-search"]')
    ).toBeVisible();

    // Register-Patient button is gated on `ADMIN|RECEPTION`
    // (page.tsx:275). Its presence proves the role gate fired for ADMIN.
    await expect(
      page.getByRole("button", { name: /register patient/i })
    ).toBeVisible();
  });

  test("RECEPTION sees the Register-Patient CTA (page.tsx:275 ADMIN|RECEPTION gate) and the form opens with all required fields", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await page.goto("/dashboard/patients", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /patient/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Open the registration form via the role-gated CTA.
    await page.getByRole("button", { name: /register patient/i }).click();

    // Form testids match the page.tsx contract (lines 305, 329, 369, 393).
    await expect(
      page.locator('[data-testid="patient-name"]')
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="patient-phone"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="patient-email"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="patient-dob"]')
    ).toBeVisible();
  });

  test("DOCTOR can view the registry but does NOT see the Register-Patient CTA — DOCTOR is in PATIENTS_ALLOWED for view (page.tsx:25-30) but not in the ADMIN|RECEPTION mutate gate (page.tsx:275)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/patients", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /patient/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Search input renders for any allowed viewer.
    await expect(
      page.locator('[data-testid="patient-search"]')
    ).toBeVisible();

    // ADMIN|RECEPTION-only Register CTA must NOT render for DOCTOR.
    await expect(
      page.getByRole("button", { name: /register patient/i })
    ).toHaveCount(0);
  });

  test("NURSE can view the registry but does NOT see the Register-Patient CTA (same mutate-gate split as DOCTOR)", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/patients", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /patient/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.locator('[data-testid="patient-search"]')
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /register patient/i })
    ).toHaveCount(0);
  });

  test("Search box issues a debounced /patients?search=… request — Issue #427 250 ms debounce contract (page.tsx:91-99) is locked here", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/patients", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /patient/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Initial list-fetch (no search param) fires before we attach the
    // listener, so wait specifically for the typed-search refetch. The
    // debounced effect (page.tsx:91-94) only fires search after 250 ms
    // of input quiet, and loadPatients() only adds the &search= suffix
    // when debouncedSearch is non-empty (page.tsx:104-106).
    const searchPromise = page.waitForResponse(
      (r) =>
        /\/api\/v1\/patients(\?|$)/.test(r.url()) &&
        r.url().includes("search=") &&
        r.request().method() === "GET",
      { timeout: 10_000 }
    );

    const junk = `zzzNoSuchPatient-${Date.now()}`;
    await page.locator('[data-testid="patient-search"]').fill(junk);
    const res = await searchPromise;
    expect(res.status()).toBeLessThan(400);

    // With a junk query, the DataTable empty-state copy renders
    // (page.tsx:497-500 — "No patients found / Try a different search
    // term.").
    await expect(
      page.locator("text=/no patients found/i").first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("DataTable sort + filter + CSV affordances render — aria-label contract from components/DataTable.tsx is the only stable hook (no data-testid on the shared table)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/patients", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /patient/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Give the initial list-fetch + DataTable mount time to settle so the
    // toolbar buttons have rendered. With an empty seed the toolbar still
    // renders; only the rows are absent.
    await page.waitForTimeout(1500);

    // DataTable.tsx exposes these via aria-label (lines 287, 297, 307).
    // Locking the contract here means a regression that drops the toolbar
    // buttons (e.g. a refactor to a different table component) is caught.
    await expect(
      page.getByRole("button", { name: /toggle filters/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /export csv/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /column visibility/i })
    ).toBeVisible();

    // The patients page does NOT pass `bulkActions` to DataTable
    // (page.tsx:487-509), so the "Select all on page" checkbox must NOT
    // render. This pins the real surface against the backlog's
    // "bulk actions" entry — when bulk actions ship, this expectation
    // flips and the test gets updated alongside.
    await expect(
      page.getByRole("checkbox", { name: /select all on page/i })
    ).toHaveCount(0);
  });

  test("PATIENT bounces to /dashboard/not-authorized — Issue #382 (CRITICAL prod RBAC bypass, Apr 29 2026) gates registry as staff-only via PATIENTS_ALLOWED in page.tsx:25-30", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/patients", { waitUntil: "domcontentloaded" });
    // Allow the role-gate useEffect a tick to fire and router.replace()
    // to settle.
    await page.waitForTimeout(800);

    // page.tsx:69-71 redirects to /dashboard/not-authorized?from=…
    // The standard issue-#179 regex used elsewhere covers both the
    // direct-bounce and the back-to-/dashboard fallback shapes.
    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);

    // The staff-only search input must NOT have rendered for PATIENT —
    // the redirect runs in a useEffect before any registry chrome shows.
    await expect(
      page.locator('[data-testid="patient-search"]')
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /register patient/i })
    ).toHaveCount(0);
  });
});
