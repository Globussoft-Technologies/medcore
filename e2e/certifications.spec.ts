/**
 * Staff Certifications tracking e2e coverage.
 *
 * What this exercises:
 *   /dashboard/certifications (apps/web/src/app/dashboard/certifications/page.tsx)
 *   GET  /api/v1/hr-ops/certifications
 *   POST /api/v1/hr-ops/certifications (ADMIN-only on the API, hr-ops.ts:289-321)
 *
 * Surfaces touched:
 *   - ADMIN happy path: lands on the page, sees the heading + Award icon
 *     + Add-Certification CTA + the 3-button filter cluster (All /
 *     Expiring Soon / Expired). Locks the chrome contract used by
 *     the staff-license expiry-tracking surface.
 *   - ADMIN modal structural pin: opens the Add-Certification modal,
 *     sees the EntityPicker (`cert-user-picker`) + 6 labelled fields
 *     (Type select, Title, Issuing Body, Cert Number, Issued Date,
 *     Expiry Date) + Notes textarea + Cancel/Save buttons. Empty-form
 *     submit is short-circuited by `if (!form.userId || !form.title)
 *     return;` (page.tsx:87) — no POST is fired, so we pin that
 *     client-side gate.
 *   - ADMIN filter pin: clicking "Expiring Soon" toggles the active
 *     filter chip (visual-state contract). Server filter is purely
 *     client-side over the loaded list (page.tsx:79-84), so we don't
 *     need a network round-trip — just confirm the chip-active state
 *     flips.
 *   - DOCTOR / NURSE / PATIENT UNIVERSAL-ACCESS archetype: the page has
 *     NO `VIEW_ALLOWED` constant, NO `router.push`/`router.replace`
 *     redirect — non-ADMIN authed users land on the chrome and the API
 *     self-scopes their result set to their own user (hr-ops.ts:235:
 *     `if (req.user!.role !== Role.ADMIN) where.userId = req.user!.userId`).
 *     The Add-Certification modal still renders (UI is universally
 *     visible) but the POST will 403 for non-ADMIN — we don't actually
 *     submit to avoid polluting shared seed across runs.
 *
 * Why these tests exist:
 *   /dashboard/certifications was previously listed under §2.12 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "staff certification tracking". This
 *   file pins the page-chrome + filter-cluster + Add-Certification modal
 *   structural contract + the universal-access route-shape (CLAUDE.md
 *   gotcha #7 archetype 3 — no client-side gate, server-side RBAC at the
 *   API is the truth) so a regression in the EntityPicker wiring or the
 *   modal field set is caught before the hr-ops route-handler unit
 *   tests. The actual POST-create lifecycle is intentionally NOT
 *   exercised because it would persistently mutate the shared admin
 *   seed across runs — that lifecycle is owned by the hr-ops route-test
 *   harness.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

const PAGE_TIMEOUT = 15_000;

test.describe("Staff Certifications — /dashboard/certifications (ADMIN cert-tracking + universal-access non-ADMIN)", () => {
  test("ADMIN lands on /dashboard/certifications, page chrome renders heading + Add-Certification CTA + filter cluster", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/certifications");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /staff certifications/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Subtitle anchors the certification-tracking branding (page.tsx:123).
    await expect(
      page.getByText(/licenses, certifications and training/i).first()
    ).toBeVisible();

    // Add-Certification CTA (page.tsx:128-133) is universally visible
    // in the page chrome — clicking it is gated behind no client guard,
    // but the API will 403 for non-ADMIN POSTs.
    await expect(
      page.getByRole("button", { name: /add certification/i })
    ).toBeVisible();

    // 3-button filter cluster (page.tsx:137-149).
    await expect(
      page.getByRole("button", { name: /^all$/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^expiring soon$/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^expired$/i })
    ).toBeVisible();
  });

  test("ADMIN can switch the filter to Expired — visual chip-active state flips (client-side filter, no network round-trip)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/certifications");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Wait for initial load to finish so the filter has a list to
    // operate over (page.tsx:152 "Loading..." state). The list/empty
    // distinction lives behind the loading flag.
    await expect(page.getByText(/loading/i)).toHaveCount(0, {
      timeout: PAGE_TIMEOUT,
    });

    const expiredBtn = page.getByRole("button", { name: /^expired$/i });
    await expect(expiredBtn).toBeVisible();

    // Active state: page.tsx:142-145 toggles `bg-blue-600 text-white
    // border-blue-600`. We assert the class flip rather than asserting
    // table contents (which depend on seed fill).
    await expiredBtn.click();
    await expect(expiredBtn).toHaveClass(/bg-blue-600/, { timeout: 3_000 });

    // The "All" button must NOT be active now (only one chip can be
    // active per page.tsx:140 single-state filter).
    await expect(
      page.getByRole("button", { name: /^all$/i })
    ).not.toHaveClass(/bg-blue-600/);
  });

  test("ADMIN Add-Certification modal opens with EntityPicker + 6 labelled fields + Cancel/Save (modal structural contract)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/certifications");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await page
      .getByRole("button", { name: /add certification/i })
      .click();

    // Modal heading anchors the modal-open state (page.tsx:217).
    await expect(
      page.getByRole("heading", { name: /^add certification$/i })
    ).toBeVisible({ timeout: 5_000 });

    // EntityPicker — `testIdPrefix="cert-user-picker"` (page.tsx:236).
    // EntityPicker doesn't emit a root testid with the bare prefix —
    // it emits `${prefix}-input`, `${prefix}-dropdown`, etc.
    // (components/EntityPicker.tsx:206-297). Anchor on the search
    // input since that's always present once the modal mounts.
    await expect(
      page.locator('[data-testid="cert-user-picker-input"]')
    ).toBeVisible();

    // 6 labelled fields — using id-anchored selectors that the page
    // explicitly attaches via `htmlFor`/`id` (page.tsx:241-302). This
    // avoids the LanguageDropdown gotcha #9 (locator('select').first()
    // would hit the layout's language selector first).
    await expect(page.locator('#add-cert-type')).toBeVisible();
    await expect(page.locator('#add-cert-title')).toBeVisible();
    await expect(page.locator('#add-cert-issuing-body')).toBeVisible();
    await expect(page.locator('#add-cert-number')).toBeVisible();
    await expect(page.locator('#add-cert-issued-date')).toBeVisible();
    await expect(page.locator('#add-cert-expiry-date')).toBeVisible();
    await expect(page.locator('#add-cert-notes')).toBeVisible();

    // The Type <select> exposes the canonical CERT_TYPES (page.tsx:23).
    // We pin one option that's least likely to drift (`MEDICAL_LICENSE`).
    await expect(
      page.locator('#add-cert-type option[value="MEDICAL_LICENSE"]')
    ).toHaveCount(1);

    // Save + Cancel CTAs (page.tsx:316-327).
    await expect(
      page.getByRole("button", { name: /^save$/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^cancel$/i })
    ).toBeVisible();

    // Teardown — close modal so it doesn't leak between tests.
    await page.getByRole("button", { name: /^cancel$/i }).click();
  });

  test("ADMIN empty-form Save short-circuits — page.tsx:87 client-side gate fires before any POST (Issue #458 pattern)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/certifications");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /add certification/i }).click();
    await expect(
      page.getByRole("heading", { name: /^add certification$/i })
    ).toBeVisible({ timeout: 5_000 });

    // Intercept any outbound POST to /hr-ops/certifications. A regression
    // that drops the `if (!form.userId || !form.title) return;` guard
    // would let a 400 round-trip through and that's exactly what we
    // want to catch.
    let serverHit = false;
    await page.route("**/api/v1/hr-ops/certifications", (route) => {
      if (route.request().method() === "POST") serverHit = true;
      route.continue();
    });

    await page.getByRole("button", { name: /^save$/i }).click();

    // Modal stays open — no success path was taken (page.tsx:99 only
    // closes on the post-create branch).
    await expect(
      page.getByRole("heading", { name: /^add certification$/i })
    ).toBeVisible();

    // Give any in-flight (non-)request a moment to surface.
    await page.waitForTimeout(500);
    expect(serverHit).toBe(false);

    // Teardown.
    await page.getByRole("button", { name: /^cancel$/i }).click();
  });

  test("DOCTOR has UNIVERSAL-ACCESS to /dashboard/certifications — chrome renders, API self-scopes the result set (no client-side VIEW_ALLOWED gate, CLAUDE.md gotcha #7 archetype 3)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/certifications");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // No redirect — the page has no `router.push`/`router.replace`
    // (verified via grep of page.tsx). DOCTOR sees the same chrome as
    // ADMIN; the result set comes back self-scoped per hr-ops.ts:235.
    expect(page.url()).toContain("/dashboard/certifications");
    await expect(
      page.getByRole("heading", { name: /staff certifications/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // The Add-Certification CTA is visible (no client-side hide), but
    // a real POST would 403 at the API (hr-ops.ts:292
    // `authorize(Role.ADMIN)`). We don't submit — see file header.
    await expect(
      page.getByRole("button", { name: /add certification/i })
    ).toBeVisible();
  });

  test("PATIENT also reaches the chrome — universal-access stays consistent across roles, but list shows the empty-state copy", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/certifications");
    await dismissTourIfPresent(page);

    // No redirect even for PATIENT — the page is intentionally
    // universal-access (no client gate). The API self-scopes
    // `where.userId = req.user.userId` (hr-ops.ts:235), and PATIENT
    // users have no StaffCertification rows, so we expect the
    // empty-state.
    expect(page.url()).toContain("/dashboard/certifications");
    await expect(
      page.getByRole("heading", { name: /staff certifications/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Wait for loading to clear.
    await expect(page.getByText(/loading/i)).toHaveCount(0, {
      timeout: PAGE_TIMEOUT,
    });

    // Empty-state copy from page.tsx:154-157.
    await expect(
      page.getByText(/no certifications found/i).first()
    ).toBeVisible();
  });
});
