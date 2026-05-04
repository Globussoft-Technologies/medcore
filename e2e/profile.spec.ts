/**
 * Self-service Profile + /account redirect-alias e2e coverage.
 *
 * What this exercises:
 *   /dashboard/profile (apps/web/src/app/dashboard/profile/page.tsx, 519 lines)
 *     - Universal-access self-service surface: every authed role (PATIENT,
 *       DOCTOR, NURSE, RECEPTION, LAB_TECH, PHARMACIST, ADMIN) can view +
 *       edit their own /auth/me record. Page header explicitly: "No role
 *       gate: every authenticated role can view + edit their own record."
 *     - Sections rendered: header card (avatar initial, name, email, role
 *       badge, "Change Password" CTA), Personal Details card (Name, Email
 *       read-only, Phone, Preferred Language en/hi), Save Changes button.
 *     - The "Change Password" modal is a dialog (role=dialog, aria-labelledby)
 *       with Current/New/Confirm inputs and inline field-error rendering for
 *       Issue #394 + Issue #458 (noValidate React-owned validation path).
 *   /dashboard/account (apps/web/src/app/dashboard/account/page.tsx, 15 lines)
 *     - Server-component `redirect("/dashboard/profile")` — Issue #303 alias
 *       so old bookmarks / sidebar links / muscle memory keep working. Fires
 *       BEFORE the client bundle, so the user never sees a flash of an empty
 *       Account page.
 *   GET   /api/v1/auth/me              (load profile snapshot)
 *   PATCH /api/v1/auth/me              (save name/phone/preferredLanguage)
 *   POST  /api/v1/auth/change-password (modal — NOT exercised, see below)
 *
 * Surfaces touched:
 *   - /account → /profile redirect contract (alias pin from Issue #303).
 *   - ADMIN happy path: heading, header card name/email/role badge, Personal
 *     Details inputs, Change-Password CTA, Save button (disabled while clean).
 *   - DOCTOR happy path: same chrome — no role asymmetry, the page is
 *     deliberately universal.
 *   - PATIENT happy path: same chrome — proves the route is NOT gated.
 *   - Change-Password modal opens on CTA click and renders the dialog with
 *     Current / New / Confirm Password inputs + Update Password CTA. We
 *     pin the dialog's existence + close affordance without actually
 *     submitting a password change (would mutate the seeded test user's
 *     password and poison every subsequent run).
 *   - Negative: Change-Password mismatch surfaces inline field error
 *     ("Passwords do not match") via the Issue #458 React-owned noValidate
 *     path, with NO POST hitting /auth/change-password. Mirrors the inline
 *     error contract from Issue #394 without performing a real password
 *     mutation.
 *
 * Why these tests exist:
 *   §2.9 of docs/E2E_COVERAGE_BACKLOG.md flagged BOTH `/dashboard/profile`
 *   and `/dashboard/account` as zero-coverage. Issue #303 unified them: the
 *   canonical route is now `/dashboard/profile`, and `/dashboard/account` is
 *   a thin server-component redirect alias. A regression that breaks the
 *   redirect (e.g. a stray client-only refactor of account/page.tsx) would
 *   silently 404 every legacy bookmark; a regression that drops the
 *   universal-access shape (e.g. someone adding `VIEW_ALLOWED` to gate it
 *   to staff) would silently lock PATIENTs out of editing their own contact
 *   details. This spec pins both contracts plus the Issue #458 inline-
 *   validation path on the change-password modal.
 *
 *   Destructive flows (actually changing the password, enrolling 2FA) are
 *   intentionally SKIPPED — the test seed is shared across runs and a
 *   real password mutation would lock every subsequent test login. The
 *   modal's structural existence + client-side validation gate are pinned
 *   instead, which is the regression-detection value without the side
 *   effects.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Profile — /dashboard/profile self-service surface + /dashboard/account redirect alias (universal-access route shape; covers backlog §2.9)", () => {
  test("any authed role hitting /dashboard/account is redirected to /dashboard/profile (Issue #303 server-component alias contract)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // The redirect is a server-component `redirect()` call from
    // account/page.tsx — fires before the client bundle loads, so the URL
    // should already be on /dashboard/profile by the time
    // `domcontentloaded` resolves. Use gotoAuthed so the auth-cookie race
    // (helpers.ts:306) is handled the same way as every other dashboard
    // navigation.
    await gotoAuthed(page, "/dashboard/account");
    await page.waitForURL(/\/dashboard\/profile$/, { timeout: 10_000 });
    await expectNotForbidden(page);

    // Profile chrome should render — confirms the redirect didn't just
    // strip the path but actually landed on the canonical page.
    await expect(
      page.getByRole("heading", { name: /my profile/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="profile-page"]')).toBeVisible();
  });

  test("ADMIN lands on /dashboard/profile, header card renders name+email+role badge, Personal Details inputs visible, Save button disabled while form is clean", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await gotoAuthed(page, "/dashboard/profile");
    await expectNotForbidden(page);

    // Page heading + root container (page.tsx:182-183).
    await expect(
      page.getByRole("heading", { name: /my profile/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="profile-page"]')).toBeVisible();

    // Header card: name + email come from /auth/me; the role badge is
    // ADMIN-specific. Lock all three so a regression that strips any of
    // the header-card data-testids surfaces here.
    await expect(
      page.locator('[data-testid="profile-header-name"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="profile-header-email"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="profile-header-role"]')
    ).toBeVisible();

    // Personal Details card — the editable surface. All four fields
    // exist on every role (no asymmetry); Email is read-only by design
    // (page.tsx:254-266 — "Email changes require a verification flow").
    await expect(
      page.locator('[data-testid="profile-name-input"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="profile-email-input"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="profile-email-input"]')
    ).toHaveAttribute("readonly", "");
    await expect(
      page.locator('[data-testid="profile-phone-input"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="profile-language-input"]')
    ).toBeVisible();

    // Save button is disabled until the form is dirty AND valid
    // (page.tsx:179 — `saveDisabled = saving || !dirty || !formValid`).
    // On first paint the form mirrors the loaded snapshot, so it's clean.
    await expect(
      page.locator('[data-testid="profile-save-btn"]')
    ).toBeDisabled();

    // Change-Password CTA is on the header card.
    await expect(
      page.locator('[data-testid="profile-change-password-btn"]')
    ).toBeVisible();
  });

  test("DOCTOR lands on /dashboard/profile with the same chrome — proves the route has NO client-side role gate (page.tsx header: 'No role gate: every authenticated role can view + edit their own record')", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await gotoAuthed(page, "/dashboard/profile");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /my profile/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="profile-page"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="profile-name-input"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="profile-change-password-btn"]')
    ).toBeVisible();
  });

  test("PATIENT route-shape pin: /dashboard/profile renders for PATIENT (universally-accessible self-service; locks the no-VIEW_ALLOWED contract so a future RBAC tweak that gates this route surfaces in CI not after a deploy)", async ({
    patientPage,
  }) => {
    const page = patientPage;

    await gotoAuthed(page, "/dashboard/profile");
    // Allow any role-gate useEffect a tick to fire (there ISN'T one — this
    // is exactly what we're pinning, but the wait makes the test robust
    // to a future addition that *does* introduce one and we want a clean
    // failure rather than a flake).
    await page.waitForTimeout(800);

    // The page DOES NOT redirect for PATIENT — the point of the pin.
    expect(page.url()).toContain("/dashboard/profile");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /my profile/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-testid="profile-name-input"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="profile-phone-input"]')
    ).toBeVisible();
    // PATIENT must also see the Change-Password CTA — the universal
    // self-service contract — even though the profile page is otherwise
    // identical to staff. Issue #303's whole point was giving PATIENTs a
    // focused view to update their own contact details + password.
    await expect(
      page.locator('[data-testid="profile-change-password-btn"]')
    ).toBeVisible();
  });

  test("ADMIN clicking Change-Password CTA opens the modal with Current/New/Confirm inputs + Close affordance — pins the dialog structural contract without exercising a destructive submit", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await gotoAuthed(page, "/dashboard/profile");
    await expectNotForbidden(page);

    await expect(
      page.locator('[data-testid="profile-change-password-btn"]')
    ).toBeVisible();
    await page.locator('[data-testid="profile-change-password-btn"]').click();

    // Modal renders as role=dialog with aria-labelledby pointing at the
    // h2 (page.tsx:396-410). Lock the structural data-testid + the three
    // PasswordInput fields so a regression that swaps the modal for a
    // route-based password page (or breaks the testids) surfaces here.
    await expect(
      page.locator('[data-testid="change-password-modal"]')
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="change-password-current"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="change-password-new"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="change-password-confirm"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="change-password-submit"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="change-password-close"]')
    ).toBeVisible();

    // Close the modal via the X — onClose() unmounts the dialog
    // (page.tsx:328-330).
    await page.locator('[data-testid="change-password-close"]').click();
    await expect(
      page.locator('[data-testid="change-password-modal"]')
    ).toHaveCount(0, { timeout: 5_000 });
  });

  test("ADMIN Change-Password mismatch surfaces inline 'Passwords do not match' error and NO POST is sent (Issue #458 React-owned noValidate path; Issue #394 inline field-error contract)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await gotoAuthed(page, "/dashboard/profile");
    await expectNotForbidden(page);

    await page.locator('[data-testid="profile-change-password-btn"]').click();
    await expect(
      page.locator('[data-testid="change-password-modal"]')
    ).toBeVisible({ timeout: 5_000 });

    // Catch any rogue POST that slips past the client-side gate. Setting
    // this BEFORE the click means a regression that strips the JS guard
    // will trip serverHit=true even though the modal-still-open assertion
    // would also catch it.
    let serverHit = false;
    await page.route("**/api/v1/auth/change-password", (route) => {
      if (route.request().method() === "POST") serverHit = true;
      route.continue();
    });

    // Fill mismatched new + confirm. Use a clearly-fake current password
    // (the gate at page.tsx:363-366 short-circuits BEFORE the POST so
    // nothing leaves the browser).
    await page
      .locator('[data-testid="change-password-current"]')
      .fill("not-the-real-current-pw");
    await page
      .locator('[data-testid="change-password-new"]')
      .fill("MismatchOne123!");
    await page
      .locator('[data-testid="change-password-confirm"]')
      .fill("MismatchTwo456!");

    await page.locator('[data-testid="change-password-submit"]').click();

    // Inline field error renders next to the New Password input
    // (page.tsx:454-461). Locator is the testid so the assertion is
    // independent of the error copy reflowing.
    await expect(
      page.locator('[data-testid="error-change-password-newPassword"]')
    ).toBeVisible({ timeout: 3_000 });
    await expect(
      page.locator('[data-testid="error-change-password-newPassword"]')
    ).toHaveText(/passwords do not match/i);

    // Modal stays open — submit was blocked at page.tsx:363-366 BEFORE
    // any network round-trip.
    await expect(
      page.locator('[data-testid="change-password-modal"]')
    ).toBeVisible();

    // Give any in-flight (non-)request a tick to surface before asserting
    // it never went out.
    await page.waitForTimeout(500);
    expect(serverHit).toBe(false);
  });
});
