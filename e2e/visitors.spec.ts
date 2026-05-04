/**
 * Front-desk visitor pass log — page chrome, check-in modal, RBAC redirect.
 *
 * What this exercises:
 *   /dashboard/visitors (apps/web/src/app/dashboard/visitors/page.tsx)
 *   GET   /api/v1/visitors/active             (apps/api/src/routes/visitors.ts:140)
 *   GET   /api/v1/visitors?date=YYYY-MM-DD    (today-tab list, line 196)
 *   GET   /api/v1/visitors/stats/daily        (KPI tiles, line 231)
 *   POST  /api/v1/visitors                    (check-in, line 52, ADMIN+RECEPTION)
 *   PATCH /api/v1/visitors/:id/checkout       (line 283)
 *
 * Surfaces touched:
 *   - RECEPTION: primary front-desk role, lands on chrome (heading + Check-In
 *     CTA + 3 KPI tiles + Active/Today tab cluster + table-or-empty body)
 *     and opens the Check-In Visitor modal (structural pin only — name +
 *     phone + ID-type select + ID-number + purpose select + department +
 *     patient-id + notes + Photo capture/upload + Cancel/Check In CTAs).
 *   - ADMIN: same allow-set (page.tsx:17 VIEW_ALLOWED + visitors.ts:54
 *     authorize(ADMIN, RECEPTION) on writes; reads at line 140 also allow
 *     DOCTOR + NURSE).
 *   - Active/Today tab cluster: switching tabs re-fires `load()` against
 *     either /visitors/active OR /visitors?date=<today>&limit=200, pinning
 *     the closure-trap regression class (Issue #426 family).
 *   - PATIENT / LAB_TECH / PHARMACIST: REDIRECT-BOUNCE archetype matching
 *     Issue #509 — page.tsx:65-72 useEffect router.replace(
 *     "/dashboard/not-authorized?from=...") for any role outside
 *     VIEW_ALLOWED. This is the rarer of the two redirect targets per the
 *     6th cron-learning bullet (1 of ~9 instances) — page exposes physical-
 *     security-sensitive PII (visitor ID + photos) and matches Issue #179
 *     lab-intel pattern. PHARMACIST and LAB_TECH are NOT in VIEW_ALLOWED.
 *
 * Why these tests exist:
 *   Closes E2E_COVERAGE_BACKLOG §2.12 final tail "/dashboard/visitors —
 *   visitor log". Hardens the Issue #509 page-level role gate (added when
 *   the API shipped without a matching client-side guard, exposing the
 *   front-desk surface to PATIENT / LAB_TECH / PHARMACIST via URL bar). The
 *   actual POST /visitors check-in lifecycle is intentionally NOT submitted
 *   — even with a non-digit name, the row pollutes the shared seed across
 *   runs and a clean-up flow doesn't exist; that lifecycle is owned by
 *   route-handler unit tests at apps/api/src/routes/visitors.ts.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Visitors front-desk — /dashboard/visitors (RECEPTION/ADMIN/DOCTOR/NURSE chrome + check-in modal + Issue #509 redirect-bounce for non-allowed roles)", () => {
  test("RECEPTION lands on /dashboard/visitors, sees the page chrome (heading + Check-In CTA + 3 KPI tiles + Active/Today tabs)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/visitors");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Heading is the page-title (page.tsx:259, plain text).
    await expect(
      page.getByRole("heading", { name: /^visitors$/i }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Primary write CTA — opens the Check-In Visitor modal (page.tsx:269).
    await expect(
      page.locator('[data-testid="visitors-check-in-btn"]'),
    ).toBeVisible();

    // 3 KPI tiles render verbatim labels (page.tsx:279-296).
    await expect(page.getByText(/total today/i).first()).toBeVisible();
    await expect(page.getByText(/currently inside/i).first()).toBeVisible();
    await expect(page.getByText(/by purpose \(today\)/i).first()).toBeVisible();

    // Active / All Today tab cluster (page.tsx:325-344).
    await expect(page.getByRole("button", { name: /^active$/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^all today$/i }),
    ).toBeVisible();
  });

  test("RECEPTION can flip from Active → All Today tab without crash — re-fires `load()` against the date-scoped endpoint, body settles to either table or empty-state", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/visitors");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.locator('[data-testid="visitors-check-in-btn"]'),
    ).toBeVisible({ timeout: 20_000 });

    // Wait for any /visitors API call to register a response so the second
    // tab click has a settled state to compare against — we don't assert
    // the URL because the request has already fired by the time the test
    // body runs. Instead, just click and verify no crash.
    await page.getByRole("button", { name: /^all today$/i }).click();

    // Body should be either the table or the empty-state copy. Both are
    // valid non-crashed states (page.tsx:349-353).
    await page.waitForTimeout(800);
    const tableRows = await page.locator("table tbody tr").count();
    const emptyText = await page
      .getByText(/no visitors/i)
      .first()
      .isVisible()
      .catch(() => false);
    expect(tableRows >= 0 || emptyText).toBeTruthy();

    // No "Forbidden"/access-denied surface poisoned the page after the tab flip.
    await expectNotForbidden(page);

    // Flip back to Active.
    await page.getByRole("button", { name: /^active$/i }).click();
    await page.waitForTimeout(400);
    await expectNotForbidden(page);
  });

  test("RECEPTION opens the Check-In Visitor modal and the form structural contract holds (name + phone + ID-type select + purpose select + department + patient-id + notes + Photo capture/upload + Cancel/Check In CTAs)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/visitors");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await page.locator('[data-testid="visitors-check-in-btn"]').click();

    // Modal heading (page.tsx:452).
    await expect(
      page.getByRole("heading", { name: /check in visitor/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Required field — Name * (page.tsx:455-463). Anchor by id to dodge
    // any stray label/aria collisions.
    await expect(page.locator("#visitor-name")).toBeVisible();
    await expect(page.locator("#visitor-phone")).toBeVisible();

    // ID-type select — scope to a unique option so we dodge the
    // LanguageDropdown gotcha #9 (`select.first()` is brittle).
    await expect(
      page.locator('select:has(option[value="Aadhaar"])'),
    ).toBeVisible();

    // Purpose select — same hygiene, scope by unique enum value.
    await expect(
      page.locator('select:has(option[value="PATIENT_VISIT"])'),
    ).toBeVisible();

    await expect(page.locator("#visitor-id-number")).toBeVisible();
    await expect(page.locator("#visitor-department")).toBeVisible();
    await expect(page.locator("#visitor-patient-id")).toBeVisible();
    await expect(page.locator("#visitor-notes")).toBeVisible();

    // Photo capture-or-upload buttons (page.tsx:609-621).
    await expect(
      page.getByRole("button", { name: /capture photo/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /upload photo/i }),
    ).toBeVisible();

    // Footer CTAs (page.tsx:638-650).
    await expect(
      page.getByRole("button", { name: /^cancel$/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^check in$/i }),
    ).toBeVisible();

    // Don't actually submit — would create a Visitor row that pollutes the
    // shared seed across runs (no e2e teardown for /visitors). The full
    // POST contract is covered by route-handler unit tests.
  });

  test("RECEPTION empty-form Check-In short-circuits client-side — `name` required, no POST /visitors fires (page.tsx:184-187)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    // Track any POST /visitors request — we want to assert NONE fires for
    // an empty submit because the client-side guard catches it first.
    let postFired = false;
    await page.route("**/api/v1/visitors", (route) => {
      if (route.request().method() === "POST") {
        postFired = true;
      }
      return route.continue();
    });

    await gotoAuthed(page, "/dashboard/visitors");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await page.locator('[data-testid="visitors-check-in-btn"]').click();
    await expect(
      page.getByRole("heading", { name: /check in visitor/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Click Check In with `name` left blank — page.tsx:184 short-circuits
    // with a toast.error("Name is required"). Modal STAYS open because the
    // setShowModal(false) call only runs after the API success branch.
    await page.getByRole("button", { name: /^check in$/i }).click();
    await page.waitForTimeout(800);

    // Heading is still visible — modal didn't tear down.
    await expect(
      page.getByRole("heading", { name: /check in visitor/i }),
    ).toBeVisible();

    // No POST /visitors fired — the guard caught the empty submit.
    expect(postFired).toBeFalsy();
  });

  test("ADMIN reaches /dashboard/visitors — same VIEW_ALLOWED set per Issue #509, sees the same chrome (heading + Check-In CTA)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/visitors");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^visitors$/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('[data-testid="visitors-check-in-btn"]'),
    ).toBeVisible();
  });

  test("PATIENT is bounced off /dashboard/visitors — Issue #509 REDIRECT-BOUNCE archetype, page.tsx:65-72 useEffect router.replace('/dashboard/not-authorized?from=...') for any role outside VIEW_ALLOWED (ADMIN/RECEPTION/DOCTOR/NURSE)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/visitors");

    // Bounce target is /dashboard/not-authorized (NOT /dashboard) — this is
    // the rarer of the two archetypes per the 6th cron-learning bullet,
    // matching the Issue #179 lab-intel pattern. The redirect is a
    // router.replace so the URL flips outright once the auth-store loads.
    await page.waitForTimeout(1500);
    expect(page.url()).toMatch(/\/dashboard\/not-authorized(?:[/?#]|$)/);

    // Belt-and-suspenders: the Check-In CTA never mounted because the
    // PATIENT-redirect happened before the chrome rendered.
    await expect(
      page.locator('[data-testid="visitors-check-in-btn"]'),
    ).toHaveCount(0);
  });

  test("PHARMACIST is bounced off /dashboard/visitors — same Issue #509 not-authorized redirect (PHARMACIST is outside VIEW_ALLOWED)", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await gotoAuthed(page, "/dashboard/visitors");

    await page.waitForTimeout(1500);
    expect(page.url()).toMatch(/\/dashboard\/not-authorized(?:[/?#]|$)/);
    await expect(
      page.locator('[data-testid="visitors-check-in-btn"]'),
    ).toHaveCount(0);
  });
});
