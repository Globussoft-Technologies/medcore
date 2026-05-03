/**
 * Pharmacy dashboard — beyond-the-landing e2e coverage.
 *
 * What this exercises:
 *   /dashboard/pharmacy (apps/web/src/app/dashboard/pharmacy/page.tsx)
 *   GET /api/v1/pharmacy/{inventory,inventory/expiring,movements,returns,transfers}
 *   (apps/api/src/routes/pharmacy.ts)
 *
 * Why this spec exists (and why it does NOT duplicate pharmacist.spec.ts):
 *   pharmacist.spec.ts covers ONLY the page-load assertion (heading +
 *   "Inventory" button render) plus dispense/Rx surfaces on adjacent pages.
 *   The §2.2 backlog flagged /dashboard/pharmacy as "only landing tested" —
 *   tabs (Low Stock / Expiring Soon / Movements / Returns / Transfers),
 *   the inventory search re-fetch, the ADMIN-only Valuation tab, and the
 *   RECEPTION RBAC redirect were all untested. This file owns those
 *   surfaces; pharmacist.spec.ts retains the bare landing smoke.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Pharmacy dashboard — tab navigation, inventory search re-fetch, ADMIN-only Valuation, and RECEPTION RBAC redirect (surfaces NOT covered by pharmacist.spec.ts)", () => {
  test("PHARMACIST can switch between Inventory → Low Stock → Expiring Soon → Movements → Returns → Transfers tabs and the URL stays on /dashboard/pharmacy across each click", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await page.goto("/dashboard/pharmacy", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Each tab is a <button> rendered inline (no data-testid). The test
    // walks the row left-to-right and asserts (a) the URL sticks (no SPA
    // re-route) and (b) either the in-tab skeleton appears OR the empty-
    // state placeholder copy renders. Either is a positive signal that
    // the tab swap fired its useEffect → load{X}() → render cycle.
    const tabs: Array<{ label: RegExp; emptyText: RegExp }> = [
      { label: /^inventory$/i, emptyText: /no inventory items|loading|search medicines/i },
      { label: /^low stock$/i, emptyText: /no inventory items|loading|search medicines/i },
      { label: /^expiring soon$/i, emptyText: /no inventory items|loading|search medicines/i },
      { label: /^movements$/i, emptyText: /no movements|loading/i },
      { label: /^returns$/i, emptyText: /no returns|loading/i },
      { label: /^transfers$/i, emptyText: /no transfers|loading/i },
    ];

    for (const t of tabs) {
      await page.getByRole("button", { name: t.label }).first().click();
      // URL must remain on the pharmacy landing — the tab is internal state,
      // not a route. A regression that turns these into Link-based nav would
      // surface as a path mismatch here.
      expect(page.url()).toContain("/dashboard/pharmacy");
      // Surface check: either the skeleton, the populated table, or the
      // empty-state copy must be visible within a generous timeout. We
      // don't assert specific row data because the seeded inventory is
      // shared mutable state across the suite.
      await expect(page.locator("body")).toContainText(t.emptyText, {
        timeout: 10_000,
      });
    }
  });

  test("PHARMACIST sees the inventory search input on Inventory/Low/Expiring tabs and typing into it triggers a /pharmacy/inventory re-fetch (search param wired through to the API)", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await page.goto("/dashboard/pharmacy", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    // Inventory tab is the default; the search input renders on
    // inventory/low/expiring (page.tsx:321-334) but NOT on movements/
    // returns/transfers/valuation. Lock the conditional render.
    const search = page.getByPlaceholder(/search medicines or batches/i);
    await expect(search).toBeVisible({ timeout: 15_000 });

    // Typing into the search box re-runs loadInventory() with
    // ?search=… in the query string (page.tsx:225). Wait for the
    // matching network request — the URL contains both /pharmacy/inventory
    // and the search term, which proves the wiring end-to-end.
    const uniqueTerm = `e2e-${Date.now().toString(36)}`;
    const searchReqPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/pharmacy/inventory") &&
        req.url().includes(`search=${uniqueTerm}`),
      { timeout: 10_000 }
    );
    await search.fill(uniqueTerm);
    const req = await searchReqPromise;
    expect(req.method()).toBe("GET");

    // Switch to Movements — the search input must disappear (page.tsx:321
    // gates on tab being inventory/low/expiring).
    await page.getByRole("button", { name: /^movements$/i }).first().click();
    await expect(search).toHaveCount(0);
  });

  test("PHARMACIST opens the Expiring Soon filter and the page issues a GET /pharmacy/inventory/expiring?days=30 request — the dedicated endpoint, not the generic inventory list", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await page.goto("/dashboard/pharmacy", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // page.tsx:228-230 picks /pharmacy/inventory/expiring?days=30 only when
    // tab === "expiring". Lock that endpoint choice — a regression that
    // sends the generic /pharmacy/inventory call (which would silently
    // return non-expiring stock too) would fail this assertion.
    const expReqPromise = page.waitForRequest(
      (req) => req.url().includes("/pharmacy/inventory/expiring"),
      { timeout: 10_000 }
    );
    await page.getByRole("button", { name: /^expiring soon$/i }).first().click();
    const req = await expReqPromise;
    expect(req.url()).toMatch(/days=30/);
  });

  test("ADMIN sees the Valuation tab (PHARMACIST/DOCTOR/NURSE do not — it's gated on isAdmin in page.tsx:311-318)", async ({
    adminPage,
    pharmacistPage,
  }) => {
    // ADMIN: Valuation button must render.
    await adminPage.goto("/dashboard/pharmacy", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(adminPage);
    await expect(
      adminPage.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      adminPage.getByRole("button", { name: /^valuation$/i }).first()
    ).toBeVisible();

    // PHARMACIST: same page, Valuation must NOT render. The role gate is
    // strictly `user?.role === "ADMIN"` so any drift (e.g. accidentally
    // adding PHARMACIST) would be caught here.
    await pharmacistPage.goto("/dashboard/pharmacy", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(pharmacistPage);
    await expect(
      pharmacistPage.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      pharmacistPage.getByRole("button", { name: /^valuation$/i })
    ).toHaveCount(0);
  });

  test("DOCTOR (a non-PHARMACIST role inside VIEW_ALLOWED for the inventory API) lands on /dashboard/pharmacy without forbidden, sees the tab row, and does NOT see the PHARMACIST-only 'Add Stock' CTA", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/pharmacy", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // DOCTOR is in the inventory-read RBAC set (pharmacy.ts:101) but is
    // NOT in canManage (page.tsx:130 — ADMIN | PHARMACIST only). The
    // 'Add Stock' button must not render, but the read-only tabs must.
    await expect(
      page.getByRole("button", { name: /add stock/i })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^inventory$/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^movements$/i }).first()
    ).toBeVisible();
  });

  test("RECEPTION is bounced to /dashboard/not-authorized — page.tsx:101-108 redirects RECEPTION away from the pharmacy landing with a toast (issue #98 + #179)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await page.goto("/dashboard/pharmacy", { waitUntil: "domcontentloaded" });
    // The role-gate useEffect needs a tick to fire and the router replace
    // to settle. Mirrors the timing pattern in symptom-diary.spec.ts.
    await page.waitForTimeout(800);

    // Either we're sitting on /dashboard/not-authorized (the explicit
    // target, page.tsx:104-106) or the dashboard layout has stripped us
    // back. Both are accepted per the issue-#179 RBAC pattern.
    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );

    // The pharmacy landing's tab row must NOT have rendered. We anchor
    // on the Inventory button — its presence would mean the redirect
    // gate failed silently and RECEPTION saw stock counts.
    await expect(
      page.getByRole("button", { name: /^inventory$/i })
    ).toHaveCount(0);
  });
});
