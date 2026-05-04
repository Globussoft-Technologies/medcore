/**
 * Multi-tenant administration console — /dashboard/tenants chrome + RBAC.
 *
 * What this exercises:
 *   /dashboard/tenants (apps/web/src/app/dashboard/tenants/page.tsx)
 *   GET    /api/v1/tenants (list, ADMIN + super-admin guard)
 *   GET    /api/v1/tenants/:id (detail drawer payload)
 *   POST   /api/v1/tenants (create modal — structural pin only, no submit)
 *
 * Surfaces touched:
 *   - ADMIN (super-admin on the seeded `default` tenant): list table + filter
 *     cluster (search input, plan select, active select), Create-Tenant
 *     modal structural contract.
 *   - DOCTOR / PATIENT: REDIRECT-BOUNCE archetype — page.tsx:124-128
 *     `useEffect(...) router.push("/dashboard")` fires for any role !== ADMIN.
 *     Bounce target is /dashboard (NOT /dashboard/not-authorized).
 *
 * Why these tests exist:
 *   Closes E2E_COVERAGE_BACKLOG §2.11 "/dashboard/tenants — tenant list
 *   (touched, no isolation verification)". Wave 9 BOLA audit verified the
 *   API as router-level `authorize(Role.ADMIN)` + `requireSuperAdmin`
 *   guard (apps/api/src/routes/tenants.ts:110-112) — there's literally no
 *   per-row ownership check because tenant administration is super-admin-
 *   only by definition. Deeper isolation verification is multi-tenant
 *   data-leak territory (separate spec class); this file pins the LIST +
 *   filter contract + RBAC bounce so future regressions of the page chrome
 *   are caught.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Tenants admin — /dashboard/tenants (ADMIN super-admin chrome + non-ADMIN redirect-bounce)", () => {
  test("ADMIN lands on /dashboard/tenants, sees the page chrome (heading, Create-Tenant CTA, filter cluster)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/tenants");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Heading is the page-title regex — i18n key "tenants.title" defaults to "Tenants".
    await expect(
      page.getByRole("heading", { name: /tenants/i }).first()
    ).toBeVisible({ timeout: 20_000 });

    // Page-shell testid the page wraps everything in (page.tsx:212).
    await expect(page.locator('[data-testid="tenants-page"]')).toBeVisible();

    // Primary write CTA — opens the Create-Tenant modal (page.tsx:226).
    await expect(
      page.locator('[data-testid="tenants-create-open"]')
    ).toBeVisible();
  });

  test("ADMIN filter cluster pins: search input + plan-filter <select> + active-filter <select> are all wired and accept input", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/tenants");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    const search = page.locator('[data-testid="tenants-search"]');
    const planFilter = page.locator('[data-testid="tenants-plan-filter"]');
    const activeFilter = page.locator('[data-testid="tenants-active-filter"]');

    await expect(search).toBeVisible({ timeout: 15_000 });
    await expect(planFilter).toBeVisible();
    await expect(activeFilter).toBeVisible();

    // Search box accepts input — non-destructive, just pins wiring.
    await search.fill("default");
    await expect(search).toHaveValue("default");

    // Plan filter — option set is BASIC / PRO / ENTERPRISE (page.tsx:255-258).
    await planFilter.selectOption("PRO");
    await expect(planFilter).toHaveValue("PRO");
    await planFilter.selectOption("");

    // Active filter — defaults to "active" (page.tsx:117). Flip to "all" then back.
    await activeFilter.selectOption("all");
    await expect(activeFilter).toHaveValue("all");
    await activeFilter.selectOption("active");

    // Body either renders the table or the empty-state — both are
    // valid no-error states. We just want zero crash + zero forbidden.
    const tableOrEmpty = await Promise.race([
      page
        .locator('[data-testid="tenants-table"]')
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => "table" as const)
        .catch(() => null),
      page
        .locator('[data-testid="tenants-empty"]')
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => "empty" as const)
        .catch(() => null),
    ]);
    expect(tableOrEmpty === "table" || tableOrEmpty === "empty").toBeTruthy();
  });

  test("ADMIN opens the Create-Tenant modal and the form structural contract holds (name + subdomain + plan + admin section + submit)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/tenants");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await page.locator('[data-testid="tenants-create-open"]').click();

    // Modal-shell testid (page.tsx:486).
    const modal = page.locator('[data-testid="tenants-create-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Required-field inputs all rendered — pin each by testid so a
    // future field rename surfaces here, not in a vague flake.
    await expect(modal.locator('[data-testid="tenants-create-name"]')).toBeVisible();
    await expect(modal.locator('[data-testid="tenants-create-subdomain"]')).toBeVisible();
    await expect(modal.locator('[data-testid="tenants-create-plan"]')).toBeVisible();
    await expect(modal.locator('[data-testid="tenants-create-admin-name"]')).toBeVisible();
    await expect(modal.locator('[data-testid="tenants-create-admin-email"]')).toBeVisible();
    await expect(modal.locator('[data-testid="tenants-create-admin-password"]')).toBeVisible();

    // Submit button starts disabled (canSubmit gate at page.tsx:435-443).
    const submit = modal.locator('[data-testid="tenants-create-submit"]');
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();

    // Don't actually create — would pollute the seed across runs and the
    // seeded "default" tenant is the only one we can guarantee.
  });

  test("ADMIN client-side subdomain validation rejects RESERVED words inline (page.tsx:64-83) before any POST is fired", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/tenants");
    await dismissTourIfPresent(page);

    await page.locator('[data-testid="tenants-create-open"]').click();
    const modal = page.locator('[data-testid="tenants-create-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Fill enough that the only failing gate is the subdomain reserved-word check.
    await modal.locator('[data-testid="tenants-create-name"]').fill("Test Hospital");
    await modal.locator('[data-testid="tenants-create-subdomain"]').fill("admin");
    await modal.locator('[data-testid="tenants-create-admin-name"]').fill("Admin User");
    await modal.locator('[data-testid="tenants-create-admin-email"]').fill("ops@example.com");
    await modal.locator('[data-testid="tenants-create-admin-password"]').fill("StrongPass!234");

    // Reserved-word inline error renders verbatim from validateSubdomain
    // (page.tsx:90 — "This subdomain is reserved").
    await expect(
      modal.getByText(/this subdomain is reserved/i)
    ).toBeVisible();

    // Submit stays disabled — canSubmit pred excludes subdomainError.
    await expect(
      modal.locator('[data-testid="tenants-create-submit"]')
    ).toBeDisabled();
  });

  test("DOCTOR is bounced off /dashboard/tenants — REDIRECT-BOUNCE archetype, page.tsx:124-128 useEffect router.push('/dashboard') for any role !== ADMIN", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/tenants");

    // The redirect target is /dashboard (NOT /dashboard/not-authorized) —
    // useEffect uses router.push, so URL flips after the auth-store loads.
    // Allow a settle window then assert URL has left /dashboard/tenants.
    await page.waitForTimeout(1500);
    expect(page.url()).not.toMatch(/\/dashboard\/tenants(?:[\/?#]|$)/);

    // Belt-and-suspenders: the tenants-page testid never mounted (the
    // component returns null when role !== ADMIN, page.tsx:209).
    await expect(page.locator('[data-testid="tenants-page"]')).toHaveCount(0);
  });

  test("PATIENT is bounced off /dashboard/tenants — same redirect-bounce gate (no Create-Tenant CTA visible)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/tenants");

    await page.waitForTimeout(1500);
    expect(page.url()).not.toMatch(/\/dashboard\/tenants(?:[\/?#]|$)/);
    await expect(
      page.locator('[data-testid="tenants-create-open"]')
    ).toHaveCount(0);
  });
});
