/**
 * Pharmacy inventory & stock management — deeper coverage of /dashboard/pharmacy
 * stock surfaces (low-stock, expiring-soon, reorder, valuation) that go beyond
 * the tab-chrome pin in `e2e/pharmacy.spec.ts`.
 *
 * What this exercises:
 *   /dashboard/pharmacy (apps/web/src/app/dashboard/pharmacy/page.tsx)
 *   GET  /api/v1/pharmacy/inventory?lowStock=true                (Low-Stock tab data — STUBBED via page.route)
 *   GET  /api/v1/pharmacy/inventory/expiring?days=30             (Expiring-Soon tab data — STUBBED)
 *   POST /api/v1/pharmacy/inventory/:id/order-from-supplier      (per-row reorder CTA — STUBBED)
 *   (apps/api/src/routes/pharmacy.ts)
 *
 * Surfaces touched (deliberately NOT overlapping with pharmacy.spec.ts /
 * pharmacy-forecast.spec.ts / medicines.spec.ts / purchase-orders.spec.ts):
 *   pharmacy.spec.ts already pins:
 *     - tab navigation across all 6 (+1 Valuation) tabs
 *     - search-input re-fetch wiring
 *     - the /pharmacy/inventory/expiring?days=30 endpoint choice
 *     - ADMIN-only Valuation gating + RECEPTION redirect
 *     - DOCTOR sees read-only chrome (no Add Stock CTA)
 *
 *   pharmacy-forecast.spec.ts already pins:
 *     - /dashboard/pharmacy-forecast (the consumption-trend / forecast page)
 *
 *   medicines.spec.ts already pins:
 *     - /dashboard/medicines catalog + role matrix + ADMIN create round-trip
 *
 *   purchase-orders.spec.ts owns the full PO create→receive→stock-incremented
 *   pipeline.
 *
 *   This spec adds:
 *     - LOW-STOCK ROW SHAPE: Low-Stock tab renders quantity in the orange
 *       low-stock band (page.tsx:258-262) AND surfaces an "Order from
 *       Supplier" reorder CTA next to each low row when canManage=true
 *       (page.tsx:600-609). Pins the conditional `isLow` band so a refactor
 *       that drops the colour/CTA on low rows surfaces here.
 *     - REORDER CTA POST: clicking "Order from Supplier" hits the dialog
 *       confirm and POSTs to /pharmacy/inventory/:id/order-from-supplier
 *       (page.tsx:213-221). Pins the URL pattern + method so a route move
 *       would surface immediately. Uses page.route stub so no real PO is
 *       written — concurrent agents seeding inventory in the same DB don't
 *       see phantom draft POs.
 *     - EXPIRING-SOON COLOR BAND: Expiring tab shows expiry-soon rows in
 *       the red/orange band per the `expiryColor` thresholds (page.tsx:265-
 *       269) — < 0 days → red, < 30 days → orange. We stub
 *       /pharmacy/inventory/expiring with one already-expired and one
 *       expiring-this-week row so both bands are pinned.
 *     - PHARMACIST sees the "Add Stock" CTA (page.tsx:288-295 — gated on
 *       canManage = ADMIN | PHARMACIST). NURSE in the inventory-read RBAC
 *       set (pharmacy.ts:101) does NOT see it.
 *     - PATIENT bounces to /dashboard/not-authorized — VIEW_ALLOWED
 *       (page.tsx:96) excludes PATIENT, the redirect useEffect at
 *       page.tsx:107-114 fires.
 *
 * Why these tests exist:
 *   docs/E2E_COVERAGE_BACKLOG.md §5 P3 (Pharmacy inventory & stock
 *   management) listed 7 deeper scenarios. Verification found 4 of those 7
 *   are shipped on the web UI today; the remaining 3 are documented as
 *   deferred (UI-not-shipped) inline below — a future ship lights this spec
 *   back up.
 *
 *   DEFERRED — backlog scenarios not e2e-testable on the current web UI:
 *     - "View /dashboard/medicines catalog WITH stock levels" — the
 *       /dashboard/medicines page (apps/web/src/app/dashboard/medicines/
 *       page.tsx) renders the catalog without on-hand stock counts. Stock
 *       lives only on /dashboard/pharmacy. The catalog itself is already
 *       covered by medicines.spec.ts, so we deliberately do NOT duplicate.
 *     - "Dispense-after-expiry blocked at pharmacy" — the server-side
 *       guard exists (apps/api/src/routes/pharmacy.ts:504 — the dispense
 *       transaction queries `expiryDate: { gt: new Date() }` so an expired
 *       batch is never selected) but no /dispense UI exists in apps/web —
 *       grep across apps/web/src/app/dashboard for `pharmacy/dispense`
 *       returned 0 hits. Dispense is invoked from the staff console /
 *       mobile flow, not Playwright's web target. Server guard is unit-
 *       tested elsewhere; e2e cannot exercise it without a UI surface.
 *     - "Stock count adjustment with reason + audit" — POST
 *       /pharmacy/stock-adjustments exists (pharmacy.ts:1064) but grep
 *       across apps/web/src for "stock-adjustments" returned 0 hits — no
 *       UI consumer. The Add Stock / Return / Transfer modals are the only
 *       inventory-write surfaces; none of them is an arbitrary
 *       count-correction with reasonCode. Pinning at API layer only is
 *       correct here; this spec deliberately does not stub a phantom UI.
 *     - "Consumption trend per medicine" — already owned by
 *       /dashboard/pharmacy-forecast and pinned by pharmacy-forecast.spec.ts.
 *     - "Purchase-order creation → receive → stock incremented" — owned
 *       by purchase-orders.spec.ts. The "Order from Supplier" CTA we DO
 *       pin here is the pharmacy-page proxy (it creates a draft PO from
 *       the low-stock row); the receive→stock pipeline is the PO spec's.
 */
import type { Route } from "@playwright/test";
import { test, expect } from "./fixtures";
import { gotoAuthed, expectNotForbidden } from "./helpers";

// Stable stub IDs — UUIDv4 shape so any soft Zod uuid() validation passes.
const STUB_LOW_ITEM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const STUB_LOW_MED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const STUB_EXPIRED_ITEM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const STUB_EXPIRED_MED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const STUB_EXPIRING_ITEM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
const STUB_EXPIRING_MED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";

const HEADING_TIMEOUT = 15_000;

test.describe("Pharmacy inventory & stock management — /dashboard/pharmacy deeper coverage (low-stock reorder CTA, expiring-soon colour bands, write-CTA RBAC) — disjoint from pharmacy.spec.ts / pharmacy-forecast.spec.ts / medicines.spec.ts / purchase-orders.spec.ts", () => {
  test("PHARMACIST opens the Low-Stock tab, sees a stubbed low-stock row in the orange quantity band with the 'Order from Supplier' CTA visible — pins page.tsx:258-262 (qtyColor) + page.tsx:600-609 (isLow CTA gating)", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;

    // Stub the Low-Stock tab fetch. The tab swaps to ?lowStock=true at
    // page.tsx:225-227; we match that AND the bare /pharmacy/inventory
    // call so the default Inventory tab rendering keeps a sane shape too.
    await page.route(
      (url) => url.pathname.endsWith("/pharmacy/inventory") || url.pathname.endsWith("/api/v1/pharmacy/inventory"),
      async (route: Route) => {
        const reqUrl = route.request().url();
        // Both Inventory + Low-Stock tabs hit /pharmacy/inventory; the
        // tab differentiates by ?lowStock=true. Return the SAME single
        // low-stock row in both cases so the assertions below find the
        // row whether the tab swap happened to fire a fetch or not.
        const isLowStockOnly = reqUrl.includes("lowStock=true");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [
              {
                id: STUB_LOW_ITEM_ID,
                batchNumber: "LOW-BATCH-001",
                quantity: 3, // <= reorderLevel triggers isLow at page.tsx:557
                unitCost: 10,
                sellingPrice: 25,
                expiryDate: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
                supplier: "AcmeMed",
                location: "Shelf-A1",
                reorderLevel: 10,
                medicine: {
                  id: STUB_LOW_MED_ID,
                  name: "PharmaInvE2E-LowMed",
                  genericName: "Generic-Low",
                },
              },
            ],
            error: null,
            meta: { page: 1, limit: 50, total: isLowStockOnly ? 1 : 1 },
          }),
        });
      }
    );

    await gotoAuthed(page, "/dashboard/pharmacy");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: HEADING_TIMEOUT });

    // Switch to the Low-Stock tab. The tabs are <button>s declared inline
    // (page.tsx:298-307) — match by accessible name.
    await page.getByRole("button", { name: /^low stock$/i }).first().click();

    // Stubbed medicine name surfaces — proves the Low-Stock fetch fired
    // and its data hit the table render path (page.tsx:556-612).
    await expect(
      page.getByText(/PharmaInvE2E-LowMed/i).first()
    ).toBeVisible({ timeout: 10_000 });

    // qtyColor (page.tsx:258-262) returns the orange band for `quantity
    // <= reorderLevel`. Locate the cell by its text — the only "3" we
    // stubbed sits in the qty column. Tailwind's `text-orange-600` class
    // is the contract; pin it so a colour-swap regression surfaces here.
    const qtyCell = page
      .locator('td.text-orange-600.font-semibold')
      .filter({ hasText: /^3$/ });
    await expect(qtyCell).toBeVisible();

    // isLow gates the "Order from Supplier" CTA (page.tsx:600-609). It
    // only renders when canManage=true (PHARMACIST qualifies, page.tsx:
    // 136). Pin its visibility on the low row.
    await expect(
      page.getByRole("button", { name: /order from supplier/i }).first()
    ).toBeVisible();
  });

  test("PHARMACIST clicks 'Order from Supplier' on a low-stock row — POST /pharmacy/inventory/:id/order-from-supplier fires with the row's id (page.tsx:213-221) and the success toast surfaces the stub PO number", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;

    await page.route(
      (url) => url.pathname.endsWith("/pharmacy/inventory") || url.pathname.endsWith("/api/v1/pharmacy/inventory"),
      async (route: Route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [
              {
                id: STUB_LOW_ITEM_ID,
                batchNumber: "LOW-BATCH-002",
                quantity: 2,
                unitCost: 8,
                sellingPrice: 18,
                expiryDate: new Date(Date.now() + 200 * 24 * 3600 * 1000).toISOString(),
                supplier: "AcmeMed",
                location: "Shelf-A2",
                reorderLevel: 10,
                medicine: {
                  id: STUB_LOW_MED_ID,
                  name: "PharmaInvE2E-ReorderMed",
                  genericName: "Generic-Reorder",
                },
              },
            ],
            error: null,
            meta: { page: 1, limit: 50, total: 1 },
          }),
        });
      }
    );

    // Stub the order-from-supplier POST so no real PO is written. Capture
    // the request via waitForRequest — that's how we pin the URL pattern
    // and the row-id binding (page.tsx:215 templates the inventory item
    // id into the POST URL).
    let observedPostUrl = "";
    await page.route(
      (url) =>
        url.pathname.includes("/pharmacy/inventory/") &&
        url.pathname.endsWith("/order-from-supplier"),
      async (route: Route) => {
        observedPostUrl = route.request().url();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              po: { poNumber: "PO-E2E-INV-001" },
              emailStub: "Email queued to AcmeMed",
            },
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, "/dashboard/pharmacy");
    await expectNotForbidden(page);

    // Land on Low-Stock tab — that's where the CTA lives.
    await page.getByRole("button", { name: /^low stock$/i }).first().click();
    await expect(page.getByText(/PharmaInvE2E-ReorderMed/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // page.tsx:213-225 wraps the click in a useConfirm() dialog. Auto-
    // accept any confirm dialog that surfaces during the click so the
    // POST actually fires.
    page.once("dialog", (d) => d.accept().catch(() => undefined));

    const postPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        req.url().includes("/pharmacy/inventory/") &&
        req.url().endsWith("/order-from-supplier"),
      { timeout: 10_000 }
    );

    // The CTA is rendered next to each low row; .first() picks our single
    // stubbed row.
    await page
      .getByRole("button", { name: /order from supplier/i })
      .first()
      .click();

    // The page also surfaces an in-app useConfirm() modal (NOT a native
    // browser dialog). Its accept-button label is set by `confirm({
    // title: "Create draft PO..." })` — confirm dialogs in this codebase
    // render a "Confirm" / "OK" button. Click it if present so the POST
    // fires; tolerate absence (some confirm shells auto-accept).
    const confirmBtn = page.getByRole("button", {
      name: /^(confirm|ok|yes|create|proceed)$/i,
    });
    if (await confirmBtn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirmBtn.first().click().catch(() => undefined);
    }

    const postReq = await postPromise;
    // Pin the URL shape: contains the row id we stubbed. A regression
    // that templated the wrong id (e.g. medicine.id instead of item.id)
    // would fail here.
    expect(postReq.url()).toContain(STUB_LOW_ITEM_ID);
    expect(postReq.url()).toContain("/order-from-supplier");
    expect(observedPostUrl).toContain(STUB_LOW_ITEM_ID);

    // Toast surfaces the stub PO number — confirms the success path
    // wired through (page.tsx:217-220 calls toast.success with poNumber).
    // toast.success uses role="status" (Toast.tsx commit e60e8be —
    // only error toasts use role="alert"). Match both roles to keep
    // the assertion robust if the toast type ever changes.
    await expect(
      page
        .locator(
          '[role="status"]:not([aria-busy]), [role="alert"]:not(#__next-route-announcer__)'
        )
        .filter({ hasText: /PO-E2E-INV-001/i })
        .first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("PHARMACIST opens the Expiring-Soon tab — already-expired row renders in the red expiryColor band, expiring-this-week row renders in the orange band (page.tsx:265-269 thresholds)", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;

    // Stub /pharmacy/inventory/expiring (the dedicated endpoint, page.tsx:
    // 234-235 chooses it only when tab === "expiring"). Two rows: one
    // already expired (negative days → red), one within 14 days (orange).
    await page.route(
      (url) => url.pathname.endsWith("/pharmacy/inventory/expiring"),
      async (route: Route) => {
        const expiredDate = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
        const soonDate = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [
              {
                id: STUB_EXPIRED_ITEM_ID,
                batchNumber: "EXPIRED-BATCH-X",
                quantity: 50,
                unitCost: 4,
                sellingPrice: 12,
                expiryDate: expiredDate,
                supplier: "AcmeMed",
                location: "Quarantine-1",
                reorderLevel: 5,
                medicine: {
                  id: STUB_EXPIRED_MED_ID,
                  name: "PharmaInvE2E-AlreadyExpired",
                  genericName: "Generic-AE",
                },
              },
              {
                id: STUB_EXPIRING_ITEM_ID,
                batchNumber: "SOON-BATCH-Y",
                quantity: 75,
                unitCost: 6,
                sellingPrice: 15,
                expiryDate: soonDate,
                supplier: "AcmeMed",
                location: "Shelf-B3",
                reorderLevel: 5,
                medicine: {
                  id: STUB_EXPIRING_MED_ID,
                  name: "PharmaInvE2E-SoonToExpire",
                  genericName: "Generic-SE",
                },
              },
            ],
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, "/dashboard/pharmacy");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: HEADING_TIMEOUT });

    await page.getByRole("button", { name: /^expiring soon$/i }).first().click();

    // Both rows render — proves the dedicated endpoint fired.
    await expect(
      page.getByText(/PharmaInvE2E-AlreadyExpired/i).first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/PharmaInvE2E-SoonToExpire/i).first()
    ).toBeVisible();

    // Red band: expiryColor returns text-red-700 font-semibold for days < 0
    // (page.tsx:266-267). Find the row by its medicine name, then the
    // expiry cell within it. Each <tr> has the medicine + the colour-banded
    // <td>; we scope by row to avoid colliding with the second row.
    const expiredRow = page
      .locator("tr")
      .filter({ hasText: /PharmaInvE2E-AlreadyExpired/i });
    await expect(
      expiredRow.locator("td.text-red-700.font-semibold").first()
    ).toBeVisible();

    // Orange band: text-orange-600 font-semibold for 0 <= days < 30
    // (page.tsx:268). 14 days out lands squarely in this band.
    const soonRow = page
      .locator("tr")
      .filter({ hasText: /PharmaInvE2E-SoonToExpire/i });
    await expect(
      soonRow.locator("td.text-orange-600.font-semibold").first()
    ).toBeVisible();
  });

  test("PHARMACIST sees the 'Add Stock' write CTA on /dashboard/pharmacy — NURSE (read-only role inside VIEW_ALLOWED) does NOT — pins page.tsx:288-295 canManage gate (ADMIN | PHARMACIST)", async ({
    pharmacistPage,
    nursePage,
  }) => {
    // PHARMACIST: Add Stock CTA must render.
    await gotoAuthed(pharmacistPage, "/dashboard/pharmacy");
    await expectNotForbidden(pharmacistPage);
    await expect(
      pharmacistPage.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: HEADING_TIMEOUT });
    await expect(
      pharmacistPage.getByRole("button", { name: /add stock/i }).first()
    ).toBeVisible();

    // NURSE: same page, Add Stock CTA must NOT render. NURSE is in the
    // VIEW_ALLOWED set (page.tsx:96) so the page itself loads — but
    // canManage at page.tsx:136 is strictly ADMIN | PHARMACIST, so the
    // write CTA must be hidden. A regression that loosened canManage to
    // include NURSE would surface here.
    await gotoAuthed(nursePage, "/dashboard/pharmacy");
    await expectNotForbidden(nursePage);
    await expect(
      nursePage.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: HEADING_TIMEOUT });
    await expect(
      nursePage.getByRole("button", { name: /add stock/i })
    ).toHaveCount(0);
  });

  test("PATIENT bounces away from /dashboard/pharmacy — VIEW_ALLOWED at page.tsx:96 excludes PATIENT, the redirect useEffect at page.tsx:107-114 fires (issue #509)", async ({
    patientPage,
  }) => {
    const page = patientPage;

    await page.goto("/dashboard/pharmacy", { waitUntil: "domcontentloaded" });
    // The redirect useEffect needs a tick to fire and the router replace
    // to settle. Mirrors pharmacy.spec.ts RECEPTION redirect timing.
    await page.waitForTimeout(800);

    // Either we're sitting on /dashboard/not-authorized (the explicit
    // target, page.tsx:110-112) or the dashboard layout has stripped us
    // back. Both shapes are accepted per the issue-#179 RBAC pattern that
    // pharmacy.spec.ts already uses for RECEPTION.
    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);

    // The pharmacy landing's tab strip must NOT have rendered. Anchoring
    // on the Inventory button — its presence would mean the redirect
    // gate failed silently and PATIENT saw stock counts.
    await expect(
      page.getByRole("button", { name: /^inventory$/i })
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /add stock/i })).toHaveCount(0);
  });
});
