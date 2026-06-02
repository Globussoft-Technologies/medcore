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

  test("ADMIN filter cluster pins: search input + plan-filter <select> + active-filter segmented control are all wired and accept input", async ({
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

    // Plan filter is now driven by the dynamic PlatformPlan catalog (values
    // are plan keys like STARTER/GROWTH, fetched async on mount), not the old
    // hardcoded BASIC/PRO/ENTERPRISE. Wait for the catalog options to load,
    // then select whichever real plan is first so the assertion isn't pinned
    // to a specific seeded key.
    await expect
      .poll(async () => planFilter.locator("option").count(), {
        timeout: 15_000,
      })
      .toBeGreaterThan(1);
    const firstPlanValue = await planFilter
      .locator("option")
      .nth(1)
      .getAttribute("value");
    await planFilter.selectOption(firstPlanValue!);
    await expect(planFilter).toHaveValue(firstPlanValue!);
    await planFilter.selectOption("");

    // Active filter — used to be a <select>; now a segmented radiogroup
    // (page.tsx:552 — `role="radiogroup"`) with `tenants-active-filter-*`
    // testids per option. Defaults to "active". Click "all" then back to
    // "active" and check aria-checked on each step.
    const allRadio = page.locator(
      '[data-testid="tenants-active-filter-all"]',
    );
    const activeRadio = page.locator(
      '[data-testid="tenants-active-filter-active"]',
    );
    await allRadio.click();
    await expect(allRadio).toHaveAttribute("aria-checked", "true");
    await activeRadio.click();
    await expect(activeRadio).toHaveAttribute("aria-checked", "true");

    // Body either renders the table or the empty-state — both are
    // valid no-error states. We just want zero crash + zero forbidden.
    // 15s timeout (was 8s) so WebKit's slower hydration on shard 11 has
    // enough time to render either the table or the empty-state.
    const tableOrEmpty = await Promise.race([
      page
        .locator('[data-testid="tenants-table"]')
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => "table" as const)
        .catch(() => null),
      page
        .locator('[data-testid="tenants-empty"]')
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => "empty" as const)
        .catch(() => null),
    ]);
    expect(tableOrEmpty === "table" || tableOrEmpty === "empty").toBeTruthy();
  });

  test("ADMIN opens the Create-Tenant modal and the form structural contract holds (name + plan + admin section + submit; subdomain is auto-derived, no input rendered)", async ({
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
    await expect(modal.locator('[data-testid="tenants-create-plan"]')).toBeVisible();
    await expect(modal.locator('[data-testid="tenants-create-admin-name"]')).toBeVisible();
    await expect(modal.locator('[data-testid="tenants-create-admin-email"]')).toBeVisible();
    await expect(modal.locator('[data-testid="tenants-create-admin-password"]')).toBeVisible();
    // Subdomain is auto-derived from the Hospital Name on submit
    // (page.tsx:1020 deriveSubdomain) — operators no longer pick it,
    // so the input MUST NOT render. Lock that contract here so a
    // future re-introduction of the field also surfaces in this test.
    await expect(
      modal.locator('[data-testid="tenants-create-subdomain"]'),
    ).toHaveCount(0);

    // Submit button starts disabled (canSubmit gate at page.tsx:435-443).
    const submit = modal.locator('[data-testid="tenants-create-submit"]');
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();

    // Don't actually create — would pollute the seed across runs and the
    // seeded "default" tenant is the only one we can guarantee.
  });

  test("ADMIN Create-Tenant submit is gated on name + admin fields (subdomain auto-derived; backend handles reserved-word + collision via 409)", async ({
    adminPage,
  }) => {
    // The legacy spec asserted a client-side "This subdomain is reserved"
    // inline error when the operator typed `admin` into a subdomain input.
    // That UI is gone — operators no longer pick the subdomain at all;
    // it's derived from Hospital Name at submit time (page.tsx:1020
    // deriveSubdomain), and reserved-word / collision detection moved
    // to the backend (POST /tenants returns 409, surfaced as a "name
    // conflict" toast at page.tsx:1076). The new contract this test
    // locks: submit is disabled until name + adminName + adminEmail +
    // adminPassword are all filled to spec — independent of any
    // subdomain input that no longer exists.
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/tenants");
    await dismissTourIfPresent(page);

    await page.locator('[data-testid="tenants-create-open"]').click();
    const modal = page.locator('[data-testid="tenants-create-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    const submit = modal.locator('[data-testid="tenants-create-submit"]');

    // 1. Empty form → submit disabled.
    await expect(submit).toBeDisabled();

    // 2. Filling only Hospital Name → submit still disabled (admin
    //    credentials are required by canSubmit at page.tsx:1040).
    await modal.locator('[data-testid="tenants-create-name"]').fill("Test Hospital");
    await expect(submit).toBeDisabled();

    // 3. Filling all required fields with valid values → submit ENABLED.
    //    We don't actually click it; submitting would persist a tenant.
    await modal.locator('[data-testid="tenants-create-admin-name"]').fill("Admin User");
    await modal.locator('[data-testid="tenants-create-admin-email"]').fill("ops@example.com");
    await modal.locator('[data-testid="tenants-create-admin-password"]').fill("StrongPass!234");
    await expect(submit).toBeEnabled();
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
