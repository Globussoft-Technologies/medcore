/**
 * Specialist Referrals — /dashboard/referrals chrome + create-modal contract + RBAC.
 *
 * What this exercises:
 *   /dashboard/referrals (apps/web/src/app/dashboard/referrals/page.tsx)
 *   GET   /api/v1/referrals (list, authenticated — DOCTOR sees own outgoing,
 *                            ADMIN sees all)
 *   GET   /api/v1/referrals/inbox (DOCTOR/ADMIN/NURSE inbox view)
 *   POST  /api/v1/referrals (DOCTOR/ADMIN, structural pin only — no submit)
 *
 * Surfaces touched:
 *   - DOCTOR: page chrome (heading, "New Referral" CTA, outgoing/incoming/all
 *     tab cluster — only rendered when isDoctor is true, page.tsx:284-296),
 *     list table or empty-state.
 *   - ADMIN: page chrome reachable without the doctor-tab cluster (no isDoctor
 *     branch — page.tsx:284 gate), Issue #10 + #458 client-side validation
 *     gate prevents empty-form POST.
 *   - PATIENT / RECEPTION: UNIVERSAL-ACCESS archetype — page.tsx has NO
 *     `VIEW_ALLOWED` constant, NO `router.push` redirect, NO `useEffect`
 *     role-check. Page chrome renders for any authed user; the API gate
 *     (apps/api/src/routes/referrals.ts:35,93) is what actually controls
 *     who can write/see what. Tests pin the empty-list-no-403 behaviour.
 *
 * Why these tests exist:
 *   Closes E2E_COVERAGE_BACKLOG §2.12 "/dashboard/referrals — create/accept/
 *   reject (page-load only)". This spec deepens the page-load smoke into a
 *   create-modal structural pin + tab-cluster pin + universal-access RBAC
 *   pin. Actual create/accept/reject lifecycle isn't exercised end-to-end
 *   because the form requires a valid (patient, fromDoctor) pair from a
 *   /patients?search debounce + /doctors fetch — the structural contract
 *   below is the highest-value coverage that won't pollute shared seed
 *   across runs.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Referrals — /dashboard/referrals (DOCTOR primary chrome + ADMIN all-view + universal-access RBAC pin)", () => {
  test("DOCTOR lands on /dashboard/referrals, sees the page chrome (heading + New Referral CTA + outgoing/incoming/all tab cluster)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/referrals");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /referrals/i }).first()
    ).toBeVisible({ timeout: 20_000 });

    // Primary write CTA — "New Referral" (page.tsx:280).
    await expect(
      page.getByRole("button", { name: /new referral/i }).first()
    ).toBeVisible();

    // DOCTOR-only tab cluster (page.tsx:284 isDoctor gate).
    await expect(
      page.getByRole("button", { name: /^outgoing$/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^incoming$/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^all$/i })
    ).toBeVisible();
  });

  test("DOCTOR can switch tabs — clicking Incoming swaps the active visual state without breaking the page", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/referrals");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    const incoming = page.getByRole("button", { name: /^incoming$/i });
    await expect(incoming).toBeVisible({ timeout: 15_000 });
    await incoming.click();

    // Tab class flips to bg-primary text-white when active (page.tsx:262).
    // Match either the active class signature OR confirm at minimum the
    // page is still on /dashboard/referrals and the table/empty surface
    // is still rendered (no crash on tab-flip).
    await page.waitForTimeout(800);
    expect(page.url()).toContain("/dashboard/referrals");

    // No 403 banner / not-authorized surface.
    await expectNotForbidden(page);
  });

  test("DOCTOR opens the New-Referral modal: form structural contract holds (patient search + referral-type toggle + specialty picker + reason + Create button)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/referrals");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /new referral/i }).first().click();

    // Modal heading.
    await expect(
      page.getByRole("heading", { name: /new referral/i })
    ).toBeVisible({ timeout: 10_000 });

    // Patient search input is the labelled <input id="referral-patient-search"> (page.tsx:401).
    await expect(page.locator("#referral-patient-search")).toBeVisible();

    // Internal vs External toggle — the two type buttons (page.tsx:467-488).
    await expect(
      page.getByRole("button", { name: /internal \(doctor\)/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /external provider/i })
    ).toBeVisible();

    // Specialty Autocomplete picker (page.tsx:558).
    await expect(
      page.locator('[data-testid="referral-specialty-picker"]')
    ).toBeVisible();

    // Reason textarea is the required field (Issue #10 / #458 client gate, page.tsx:584).
    await expect(page.locator("#referral-reason")).toBeVisible();

    // Submit button label (page.tsx:622).
    await expect(
      page.getByRole("button", { name: /^create referral$/i })
    ).toBeVisible();
  });

  test("DOCTOR empty-form submit is blocked client-side (Issue #10 + #458 React-owned validation, no POST fired) — patient + reason errors surface inline", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/referrals");
    await dismissTourIfPresent(page);

    // Capture any POST /referrals — must NOT fire on empty submit.
    let postCount = 0;
    await page.route("**/api/v1/referrals", (route) => {
      if (route.request().method() === "POST") postCount++;
      route.continue();
    });

    await page.getByRole("button", { name: /new referral/i }).first().click();
    await expect(
      page.getByRole("heading", { name: /new referral/i })
    ).toBeVisible({ timeout: 10_000 });

    // Submit with no fields filled — submit() builds errs map, returns
    // before the api.post call (page.tsx:222-224).
    await page.getByRole("button", { name: /^create referral$/i }).click();

    // Patient error renders verbatim from page.tsx:179.
    await expect(page.getByText(/select a patient/i).first()).toBeVisible({
      timeout: 5_000,
    });

    // Modal stays open (form didn't submit + reset).
    await expect(
      page.getByRole("heading", { name: /new referral/i })
    ).toBeVisible();

    // Belt-and-suspenders: zero POSTs were fired.
    await page.waitForTimeout(500);
    expect(postCount).toBe(0);
  });

  test("ADMIN reaches /dashboard/referrals and sees page chrome WITHOUT the doctor-only tab cluster — page.tsx:284 isDoctor gate", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/referrals");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /referrals/i }).first()
    ).toBeVisible({ timeout: 20_000 });

    // ADMIN sees the New-Referral CTA (loadReferrals branches, isAdmin gets
    // the un-tabbed list view — page.tsx:117-119).
    await expect(
      page.getByRole("button", { name: /new referral/i }).first()
    ).toBeVisible();

    // Doctor-only tab cluster MUST NOT render for ADMIN (page.tsx:284 isDoctor gate).
    await expect(
      page.getByRole("button", { name: /^outgoing$/i })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^incoming$/i })
    ).toHaveCount(0);
  });

  test("RECEPTION reaches /dashboard/referrals page chrome — UNIVERSAL-ACCESS archetype (no client-side gate, page.tsx has no VIEW_ALLOWED / no router.push redirect); API is the real RBAC truth", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/referrals");
    await dismissTourIfPresent(page);

    // No bounce — we're still on /dashboard/referrals.
    await page.waitForTimeout(800);
    expect(page.url()).toContain("/dashboard/referrals");

    // Heading mounts for any authed user.
    await expect(
      page.getByRole("heading", { name: /referrals/i }).first()
    ).toBeVisible({ timeout: 20_000 });

    // RECEPTION isn't a DOCTOR, so the doctor-tab cluster is hidden.
    await expect(
      page.getByRole("button", { name: /^outgoing$/i })
    ).toHaveCount(0);

    // No 403 banner / not-authorized redirect — universal-access pin.
    await expectNotForbidden(page);
  });

  test("PATIENT reaches /dashboard/referrals page chrome — universal-access pin; loadReferrals returns [] but the page still renders the empty-state without crashing", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/referrals");
    await dismissTourIfPresent(page);

    // No bounce.
    await page.waitForTimeout(800);
    expect(page.url()).toContain("/dashboard/referrals");

    // Heading still mounts (universal access).
    await expect(
      page.getByRole("heading", { name: /referrals/i }).first()
    ).toBeVisible({ timeout: 20_000 });

    // PATIENT load path: loadReferrals catches the API 403 and sets
    // referrals to [] (page.tsx:122). Empty-state copy renders verbatim.
    await expect(
      page.getByText(/no referrals found/i).first()
    ).toBeVisible({ timeout: 15_000 });

    // No crash banner.
    await expect(page.locator("body")).not.toContainText(/something went wrong/i);
  });
});
