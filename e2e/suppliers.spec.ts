/**
 * Supplier directory access + CTA + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/suppliers (apps/web/src/app/dashboard/suppliers/page.tsx)
 *   GET  /api/v1/suppliers, GET /api/v1/suppliers/:id, POST /api/v1/suppliers
 *   (apps/api/src/routes/suppliers.ts)
 *
 * Surfaces touched:
 *   - Allowed roles (ADMIN, RECEPTION, PHARMACIST per
 *     suppliers.ts:21 authorize(...) on GET /suppliers): heading +
 *     "Add Supplier" CTA + search input render, and the list-fetch
 *     round-trip returns 200 with the table or empty-state.
 *   - Add-Supplier modal opens for ADMIN (the only role that can POST,
 *     suppliers.ts:74).
 *   - RBAC: DOCTOR + PATIENT are outside the GET /suppliers
 *     authorize(...) set so the in-page fetch comes back 403 — the
 *     page itself has no client-side gate (it renders the shell for
 *     anyone authenticated), so the regression we want to lock is
 *     "API still rejects with 403, table still falls back to the
 *     empty-state, no vendor rows leak".
 *
 * Why these tests exist:
 *   /dashboard/suppliers was listed under §2.2 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "supplier directory — no e2e
 *   coverage". The route exposes vendor PII (gstNumber, contactPerson,
 *   outstanding balances — see issue #174 note in suppliers.ts:18-20),
 *   so the API-side authorize(...) set is the actual security boundary.
 *   This file pins both the happy-path render for allowed roles AND
 *   the 403/empty-state for disallowed roles so a regression in either
 *   surface (e.g. someone widening the role list to include DOCTOR or
 *   removing authorize() altogether) is caught.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Suppliers — /dashboard/suppliers (vendor directory render + Add modal + API-level RBAC)", () => {
  test("ADMIN lands on /dashboard/suppliers, heading + Add CTA + search box render, and the list fetch returns 200", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Catch the GET /suppliers round-trip kicked off by the page's load()
    // effect (page.tsx:46-60). Asserting on 200 here is what locks the
    // ADMIN ∈ allowed-roles contract from the e2e side — if someone
    // tightens authorize(...) on the API and forgets to update the docs,
    // this test fires.
    const listPromise = page.waitForResponse((r) =>
      /\/api\/v1\/suppliers(\?|$)/.test(r.url()) &&
      r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/suppliers", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    const listRes = await listPromise;
    expect(listRes.status()).toBe(200);

    await expect(
      page.getByRole("heading", { name: /suppliers/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The page has no `data-testid` instrumentation (verified on
    // 2026-05-03), so we lock the visible CTA chrome by accessible name
    // / placeholder. Both elements are unconditionally rendered for any
    // authed user — this just nails down their existence so a layout
    // refactor that drops them surfaces here.
    await expect(
      page.getByRole("button", { name: /add supplier/i })
    ).toBeVisible();
    await expect(
      page.getByPlaceholder(/search suppliers/i)
    ).toBeVisible();
  });

  test("RECEPTION can read the supplier list — list fetch returns 200, page chrome renders, no 403/empty-state", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    const listPromise = page.waitForResponse((r) =>
      /\/api\/v1\/suppliers(\?|$)/.test(r.url()) &&
      r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/suppliers", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    const listRes = await listPromise;

    // RECEPTION ∈ authorize(ADMIN, RECEPTION, PHARMACIST) on
    // suppliers.ts:21. A 403 here would mean the role list drifted.
    expect(listRes.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: /suppliers/i }).first()
    ).toBeVisible();
  });

  test("ADMIN can type in the search box and the page re-fetches with the ?search= query param", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/suppliers", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    // Wait for the initial unfiltered list-load so we don't accidentally
    // capture it as the "search" call below.
    await page
      .waitForResponse((r) =>
        /\/api\/v1\/suppliers(\?|$)/.test(r.url()) &&
        r.request().method() === "GET",
        { timeout: 15_000 }
      )
      .catch(() => undefined);

    const searchPromise = page.waitForResponse((r) =>
      /\/api\/v1\/suppliers\?search=/.test(r.url()) &&
      r.request().method() === "GET",
      { timeout: 10_000 }
    );

    // page.tsx:91-96: typing into the search input updates `search`
    // state, and the load() effect re-runs with `?search=…`.
    await page.getByPlaceholder(/search suppliers/i).fill("e2e-search-tag");
    const searchRes = await searchPromise;
    expect(searchRes.status()).toBe(200);
    expect(searchRes.url()).toMatch(/[?&]search=e2e-search-tag/);
  });

  test("ADMIN can open the Add-Supplier modal — Name/GST inputs render so the create form is wired up", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/suppliers", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /suppliers/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // page.tsx:82-88: clicking "Add Supplier" toggles showAdd → renders
    // the modal (page.tsx:244-252 → AddSupplierModal). We're not
    // submitting (would create real DB rows in shared seed) — just
    // pinning the modal-open contract.
    await page.getByRole("button", { name: /add supplier/i }).click();

    await expect(
      page.getByRole("heading", { name: /^add supplier$/i })
    ).toBeVisible({ timeout: 10_000 });

    // The modal's <label>s are not associated with their <input>s via
    // htmlFor/id (page.tsx:326-390 — sibling-label pattern), so
    // getByLabel(...) won't resolve. We instead scope to the modal's
    // <form> (the only form on the page once the modal is open) and
    // assert on the form's text labels + the corresponding inputs by
    // structural position. This pins both the visible label text AND
    // the presence of the underlying input — what the original
    // getByLabel assertion was meant to cover.
    const modalForm = page.locator("form").filter({ hasText: /name \*/i });
    await expect(modalForm).toBeVisible();

    // Required Name field — page.tsx:328-334. The label text "Name *"
    // is the visible required-marker; if this disappears the form is
    // broken.
    await expect(
      modalForm.getByText(/^\s*name\s*\*\s*$/i)
    ).toBeVisible();
    // GST Number field — page.tsx:374-379. Vendor PII (issue #174).
    await expect(
      modalForm.getByText(/^\s*gst number\s*$/i)
    ).toBeVisible();
    // And the actual <input> elements exist + are interactable. The
    // Name input is the only `required` input in the modal
    // (page.tsx:330) so we lock it by that attribute. GST input is
    // pinned by its font-mono class (page.tsx:378) which is unique
    // within the modal.
    await expect(modalForm.locator("input[required]")).toBeVisible();
    await expect(modalForm.locator("input.font-mono")).toBeVisible();
  });

  test("DOCTOR is locked out at the API — page chrome renders but GET /suppliers comes back 403 and the list shows the empty-state", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    // DOCTOR is NOT in authorize(ADMIN, RECEPTION, PHARMACIST) on
    // suppliers.ts:21 (issue #174 — vendor PII gate). The page has no
    // client-side role check, so the chrome still renders, but the
    // load() fetch comes back 403 → catch{} sets suppliers=[] →
    // "No suppliers found" shows. This is the actual security
    // boundary so we lock the 403 here.
    const listPromise = page.waitForResponse((r) =>
      /\/api\/v1\/suppliers(\?|$)/.test(r.url()) &&
      r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/suppliers", { waitUntil: "domcontentloaded" });
    const listRes = await listPromise;
    expect(listRes.status()).toBe(403);

    // Empty-state copy from page.tsx:104.
    await expect(page.getByText(/no suppliers found/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("PATIENT is locked out at the API — vendor procurement data must not leak to a patient session", async ({
    patientPage,
  }) => {
    const page = patientPage;

    // PATIENT has zero business reading procurement data (the entire
    // §2.2 surface is staff-only). authorize(...) on suppliers.ts:21
    // excludes PATIENT, so the list-fetch comes back 403.
    const listPromise = page.waitForResponse((r) =>
      /\/api\/v1\/suppliers(\?|$)/.test(r.url()) &&
      r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/suppliers", { waitUntil: "domcontentloaded" });
    const listRes = await listPromise;
    expect(listRes.status()).toBe(403);

    // No supplier rows must render. Empty-state copy from page.tsx:104.
    await expect(page.getByText(/no suppliers found/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
