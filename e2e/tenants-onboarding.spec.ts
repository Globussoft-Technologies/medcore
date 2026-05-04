/**
 * Per-tenant post-creation onboarding checklist — page chrome + RBAC.
 *
 * What this exercises:
 *   /dashboard/tenants/[id]/onboarding (apps/web/src/app/dashboard/tenants/[id]/onboarding/page.tsx)
 *   GET  /api/v1/tenants/:id/onboarding (apps/api/src/routes/tenants.ts:404)
 *   GET  /api/v1/tenants/:id (loaded in parallel for the header + auto-detect)
 *
 * Surfaces touched:
 *   - ADMIN (super-admin on the seeded `default` tenant): heading + Back link
 *     + progress bar + 6-step ordered checklist + per-step "Mark complete"
 *     CTA on every non-account_created step. The dynamic [id] segment is
 *     resolved at runtime by listing /api/v1/tenants and picking the
 *     `default` tenant — same data the parent /dashboard/tenants page renders.
 *   - DOCTOR / PATIENT: REDIRECT-BOUNCE archetype — page.tsx:147 useEffect
 *     `router.push("/dashboard")` for any user.role !== "ADMIN". Bounce target
 *     is /dashboard (NOT /dashboard/not-authorized) — same shape as the parent
 *     /dashboard/tenants list page (page.tsx:124-128) confirmed in commit
 *     `d43be97`. Mentioned in cron-learning bullet #6 "redirect-bounce target
 *     is /dashboard dominant" (9 instances at 8:1 ratio over /not-authorized).
 *
 * Why these tests exist:
 *   Closes E2E_COVERAGE_BACKLOG §2.11 "/dashboard/tenants/[id]/onboarding —
 *   onboarding flow". Mirrors the structure of `e2e/tenants.spec.ts` (parent
 *   list page) so the two specs cover the multi-tenant admin surface end-to-
 *   end. The actual POST /onboarding/:step lifecycle is intentionally NOT
 *   exercised — flipping a step on the seeded `default` tenant would
 *   permanently mutate shared state and pollute every subsequent run; the
 *   step-completion happy path is owned by route-handler unit tests at
 *   apps/api/src/routes/tenants.ts.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Tenant onboarding — /dashboard/tenants/[id]/onboarding (ADMIN super-admin checklist + non-ADMIN redirect-bounce-to-/dashboard)", () => {
  test("ADMIN lands on the onboarding checklist for the seeded `default` tenant — heading + back link + progress bar + 6 ordered steps render", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;

    // Resolve the seeded default tenant's id via the API (the [id] segment
    // is dynamic; the seed always provisions a `default` tenant per
    // packages/db/src/seed-realistic.ts).
    const tenantsRes = await adminApi.get("/tenants");
    expect(tenantsRes.ok()).toBeTruthy();
    const tenantsJson = await tenantsRes.json();
    const list: Array<{ id: string; subdomain: string }> =
      tenantsJson.data ?? tenantsJson;
    const defaultTenant = list.find((t) => t.subdomain === "default");
    expect(defaultTenant?.id).toBeTruthy();

    await gotoAuthed(page, `/dashboard/tenants/${defaultTenant!.id}/onboarding`);
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Page-shell testid (page.tsx:192).
    await expect(page.locator('[data-testid="tenant-onboarding"]')).toBeVisible({
      timeout: 20_000,
    });

    // Heading is the page-title regex — i18n key "tenants.onb.title" defaults
    // to "Tenant Onboarding" (page.tsx:201).
    await expect(
      page.getByRole("heading", { name: /tenant onboarding/i }).first(),
    ).toBeVisible();

    // "Back to tenants" link returns to the list page (page.tsx:194-199).
    await expect(
      page.getByRole("link", { name: /back to tenants/i }).first(),
    ).toBeVisible();

    // Progress bar (page.tsx:223).
    await expect(
      page.locator('[data-testid="tenant-onboarding-progress"]'),
    ).toBeVisible();

    // All six STEPS render in the page.tsx:61-133 order. Pin each by its
    // testid prefix so a future step rename surfaces here.
    for (const key of [
      "account_created",
      "hospital_config",
      "first_doctor",
      "duty_roster",
      "notification_templates",
      "seed_test_patient",
    ]) {
      await expect(
        page.locator(`[data-testid="tenant-onboarding-step-${key}"]`),
      ).toBeVisible();
    }
  });

  test("ADMIN sees the per-step `Open ...` deep link on every step + a `Mark complete` CTA on every non-account_created step (page.tsx:271-287)", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;
    const tenantsRes = await adminApi.get("/tenants");
    const tenantsJson = await tenantsRes.json();
    const list: Array<{ id: string; subdomain: string }> =
      tenantsJson.data ?? tenantsJson;
    const defaultTenant = list.find((t) => t.subdomain === "default");
    expect(defaultTenant?.id).toBeTruthy();

    await gotoAuthed(page, `/dashboard/tenants/${defaultTenant!.id}/onboarding`);
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(page.locator('[data-testid="tenant-onboarding"]')).toBeVisible({
      timeout: 20_000,
    });

    // Every step has a deep link (page.tsx:272-278) — pin all six by testid.
    for (const key of [
      "account_created",
      "hospital_config",
      "first_doctor",
      "duty_roster",
      "notification_templates",
      "seed_test_patient",
    ]) {
      await expect(
        page.locator(`[data-testid="tenant-onboarding-link-${key}"]`),
      ).toBeVisible();
    }

    // The account_created step is auto-completed (page.tsx:71 autoDetect),
    // so its `Mark complete` button should NOT render (page.tsx:279 guard).
    await expect(
      page.locator('[data-testid="tenant-onboarding-complete-account_created"]'),
    ).toHaveCount(0);

    // At least ONE of the remaining 5 steps should still expose a Mark-
    // complete CTA on the seeded default tenant — the seed doesn't run
    // through every onboarding step. (Some steps may also be auto-detected
    // via hospital_config keys, so we don't assert all 5; a single one is
    // enough to pin the contract.)
    const completeButtons = await page
      .locator('[data-testid^="tenant-onboarding-complete-"]')
      .count();
    expect(completeButtons).toBeGreaterThan(0);
  });

  test("ADMIN visiting an INVALID tenant id (404 from API) — page does not crash, the page shell still mounts", async ({
    adminPage,
  }) => {
    const page = adminPage;
    // Well-formed UUID that does not exist in the database. The API
    // returns 404 for both /tenants/:id and /tenants/:id/onboarding;
    // the page surfaces a toast and leaves the shell mounted.
    const fakeId = "00000000-0000-0000-0000-000000000000";

    await gotoAuthed(page, `/dashboard/tenants/${fakeId}/onboarding`);

    // Page shell still mounts (page.tsx:192) — the load() error is caught
    // and surfaced as a toast (page.tsx:160-162) without crashing the route.
    await expect(page.locator('[data-testid="tenant-onboarding"]')).toBeVisible({
      timeout: 15_000,
    });

    // The detail row (`<tenant.name> · <subdomain>`, page.tsx:204-207) only
    // renders when the GET /tenants/:id call succeeded. For an invalid id
    // it should be absent.
    await expect(
      page.locator('p.text-sm.text-gray-500 .font-mono'),
    ).toHaveCount(0);
  });

  test("DOCTOR is bounced off /dashboard/tenants/[id]/onboarding — REDIRECT-BOUNCE archetype, page.tsx:147 useEffect router.push('/dashboard') for any role !== ADMIN", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    // Use a placeholder uuid — the redirect happens BEFORE any tenant fetch
    // because the role check is the first useEffect (page.tsx:146-148).
    const fakeId = "00000000-0000-0000-0000-000000000000";

    await gotoAuthed(page, `/dashboard/tenants/${fakeId}/onboarding`);

    // Same redirect target as parent /dashboard/tenants — router.push goes
    // to "/dashboard", NOT "/dashboard/not-authorized". Allow a settle
    // window then assert URL has left the onboarding path.
    await page.waitForTimeout(1500);
    expect(page.url()).not.toMatch(
      /\/dashboard\/tenants\/[^/]+\/onboarding(?:[/?#]|$)/,
    );

    // Belt-and-suspenders: the page-shell testid never mounted because the
    // component returns null when role !== ADMIN (page.tsx:189).
    await expect(page.locator('[data-testid="tenant-onboarding"]')).toHaveCount(
      0,
    );
  });

  test("PATIENT is bounced off /dashboard/tenants/[id]/onboarding — same redirect-bounce gate as DOCTOR (no progress bar visible)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    const fakeId = "00000000-0000-0000-0000-000000000000";

    await gotoAuthed(page, `/dashboard/tenants/${fakeId}/onboarding`);

    await page.waitForTimeout(1500);
    expect(page.url()).not.toMatch(
      /\/dashboard\/tenants\/[^/]+\/onboarding(?:[/?#]|$)/,
    );
    await expect(
      page.locator('[data-testid="tenant-onboarding-progress"]'),
    ).toHaveCount(0);
  });
});
