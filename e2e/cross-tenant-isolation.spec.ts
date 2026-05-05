/**
 * Cross-tenant data isolation — e2e structural beacons.
 *
 * What this exercises
 * -------------------
 *   apps/web/** — browser-side (this file)
 *   apps/api/src/middleware/tenant.ts + services/tenant-context.ts +
 *     packages/db/src/tenant-prisma.ts (covered server-side by
 *     apps/api/src/test/integration/cross-tenant.test.ts)
 *
 * The HEAVY lifting for cross-tenant isolation is in the integration
 * suite — `cross-tenant.test.ts` exercises the full middleware chain
 * (tenantContextMiddleware → withTenantContext → tenantScopedPrisma)
 * with two real Tenant rows seeded in `beforeAll` + 8 cases covering
 * list reads, URL probes, audit reads, write auto-tagging, the ALS
 * extension layer directly, and two negative paths (legacy + forged
 * tokens).
 *
 * This e2e is a SMALL companion that pins two browser-side facts:
 *   1. STRUCTURAL-NOT BEACON — the dashboard chrome currently does
 *      NOT surface which tenant the user is in (no tenant badge, no
 *      subdomain display, no tenant switcher in the sidebar). This
 *      is the multi-tenant subsystem's "all-server-side" property as
 *      it ships today. The beacon fires on the day a tenant-aware
 *      UI lands so the test gets updated to assert the new shape.
 *   2. STRUCTURAL-NOT BEACON — the login page does NOT surface a
 *      tenant selector (single-tenant dev seed reality). Same flip
 *      semantic when multi-tenant login UX ships.
 *
 * Why structural-NOT and not real isolation
 * -----------------------------------------
 * The dev/staging seed has exactly one tenant (`default`). Provisioning
 * Tenant B in dev would pollute every other team member's environment,
 * and stubbing the API via `page.route` would only test the page-renders-
 * what-the-API-returns plumbing, which is below e2e value. The integration
 * test gives us real isolation verification with real DB rows under both
 * tenants — this file's job is the browser-side complement.
 *
 * Companion specs (read for context, do NOT modify):
 *   - apps/api/src/test/integration/cross-tenant.test.ts (heavy)
 *   - e2e/rbac-matrix-deep.spec.ts (delegation + cross-tenant beacon
 *     at the /auth/me payload layer)
 */
import { test, expect } from "./fixtures";
import { gotoAuthed } from "./helpers";

test.describe("Cross-tenant isolation — e2e structural beacons (2026-05-05)", () => {
  test("dashboard chrome MUST NOT surface a tenant badge / tenant name / subdomain on /dashboard — structural-NOT beacon, fires when multi-tenant UX ships", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard");

    // Tenant-aware UI signatures that DON'T exist today. Listed here so
    // a future PR adding any of them will trip this assertion and force
    // the test to be rewritten as a real positive assertion.
    const tenantBadge = page.locator('[data-testid="tenant-badge"]');
    const tenantName = page.locator('[data-testid="tenant-name"]');
    const tenantSwitcher = page.locator('[data-testid="tenant-switcher"]');
    const subdomainPill = page.locator('[data-testid="tenant-subdomain"]');
    await expect(tenantBadge).toHaveCount(0);
    await expect(tenantName).toHaveCount(0);
    await expect(tenantSwitcher).toHaveCount(0);
    await expect(subdomainPill).toHaveCount(0);

    // Sanity: the dashboard DID render — we don't want a false-pass
    // from a blank page where everything is absent.
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("/auth/me payload MUST carry a tenantId field for the seeded admin — wire-level beacon that the multi-tenant claim is being plumbed through login", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard");
    // Once authenticated, fetch /auth/me from the browser context so
    // cookies are sent. Confirms the access-token's tenantId claim is
    // round-tripped through login + decoded by `authenticate`.
    const me = await page.evaluate(async () => {
      const r = await fetch("/api/v1/auth/me", { credentials: "include" });
      return { status: r.status, body: r.ok ? await r.json() : null };
    });
    expect(me.status).toBe(200);
    // The seeded admin in dev belongs to the `default` tenant; the
    // tenantId field must be PRESENT on the payload (string, not undefined,
    // not null). If a future change drops the claim from the access-
    // token sign step, this fails and forces the wire investigation.
    const tenantId = me.body?.data?.user?.tenantId ?? me.body?.data?.tenantId;
    expect(tenantId == null ? null : typeof tenantId).toBe("string");
  });

  test("login page MUST NOT surface a tenant-selector dropdown / subdomain input — structural-NOT beacon, fires when multi-tenant login UX ships", async ({
    page,
  }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const tenantSelect = page.locator(
      '[data-testid="login-tenant-select"], select[name="tenantSubdomain"], input[name="tenantSubdomain"]'
    );
    await expect(tenantSelect).toHaveCount(0);
    // Sanity: the login form DID render.
    await expect(page.locator('input[type="email"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
