/**
 * Asset / equipment register access + CTA + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/assets (apps/web/src/app/dashboard/assets/page.tsx)
 *   GET  /api/v1/assets, GET /api/v1/assets/warranty/expiring,
 *   GET  /api/v1/assets/maintenance/due, GET /api/v1/assets/:id
 *   (apps/api/src/routes/assets.ts — issue #174 ADMIN/RECEPTION gate)
 *
 * Surfaces touched:
 *   - ADMIN + RECEPTION (∈ authorize(ADMIN, RECEPTION) on GET /assets,
 *     assets.ts:134): page chrome renders, list fetch returns 200,
 *     header tabs visible.
 *   - ADMIN-only manage CTAs: "Add Asset" button is gated client-side
 *     by `canManage = role === 'ADMIN'` (page.tsx:88, 152-159) — locks
 *     the contract that the create-asset surface only renders for ADMIN.
 *   - Tab interaction: clicking the "warranty" tab swaps the displayed
 *     list to the warranty-expiring fetch result without a fresh page
 *     load — pins the in-page state-machine wiring.
 *   - RBAC: DOCTOR + PATIENT are NOT in authorize(ADMIN, RECEPTION) on
 *     assets.ts:134, so the in-page fetch comes back 403. The page
 *     itself has no client-side gate (renders the shell for any authed
 *     user, mirrors suppliers.spec precedent), so the regression we
 *     want to lock is "API still rejects with 403, no asset rows leak".
 *
 * Why these tests exist:
 *   /dashboard/assets was listed under §2.2 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "equipment register — no e2e
 *   coverage". The route exposes serial numbers, purchase costs, and
 *   live assignee identity (issue #174 in assets.ts:135-137), so the
 *   API-side authorize(...) set IS the security boundary. This file
 *   pins both the happy-path render for allowed roles AND the 403 for
 *   disallowed roles so a regression in either surface (someone widens
 *   the role list or drops authorize() altogether) is caught.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Assets — /dashboard/assets (equipment register render + Add CTA + tab swap + API-level RBAC)", () => {
  test("ADMIN lands on /dashboard/assets, heading + Add CTA + Total-Assets stat render, and the list fetch returns 200", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Catch the GET /assets round-trip kicked off by the page's load()
    // effect (page.tsx:100-104). Asserting on 200 here locks the
    // ADMIN ∈ authorize(ADMIN, RECEPTION) contract from the e2e side —
    // if someone tightens authorize(...) and drops ADMIN, this fires.
    const listPromise = page.waitForResponse((r) =>
      /\/api\/v1\/assets\?/.test(r.url()) &&
      r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/assets", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    const listRes = await listPromise;
    expect(listRes.status()).toBe(200);

    await expect(
      page.getByRole("heading", { name: /asset management/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // No data-testid instrumentation on the page (verified 2026-05-03),
    // so we lock the visible chrome by accessible name / text. The Add
    // CTA is ADMIN-gated (page.tsx:152) so its visibility for this role
    // is itself part of the contract.
    await expect(
      page.getByRole("button", { name: /add asset/i })
    ).toBeVisible();
    await expect(page.getByText(/total assets/i)).toBeVisible();
  });

  test("RECEPTION can read the asset register — list fetch returns 200, page chrome renders, but the Add-Asset CTA is hidden (ADMIN-only)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    const listPromise = page.waitForResponse((r) =>
      /\/api\/v1\/assets\?/.test(r.url()) &&
      r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/assets", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    const listRes = await listPromise;

    // RECEPTION ∈ authorize(ADMIN, RECEPTION) on assets.ts:134. A 403
    // here would mean the role list drifted (issue #174).
    expect(listRes.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: /asset management/i }).first()
    ).toBeVisible();

    // canManage is false for RECEPTION (page.tsx:88) — Add CTA must
    // NOT render. This pins the create-side ADMIN-only contract.
    await expect(
      page.getByRole("button", { name: /add asset/i })
    ).toHaveCount(0);
  });

  test("ADMIN can switch to the Warranty Alerts tab — the warranty/expiring fetch fires and the warranty header column renders", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/assets", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /asset management/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The warranty/expiring call fires on initial load too (page.tsx:102),
    // so wait for the *next* invocation triggered by clicking the tab.
    // Empirically the page re-issues all three fetches on tab change
    // (load() runs in the [tab] effect, page.tsx:115-118).
    const warrantyPromise = page.waitForResponse((r) =>
      /\/api\/v1\/assets\/warranty\/expiring/.test(r.url()) &&
      r.request().method() === "GET",
      { timeout: 15_000 }
    );

    // page.tsx:185-199 — buttons are rendered for each Tab. The
    // "warranty" key shows label "Warranty Alerts".
    await page.getByRole("button", { name: /warranty alerts/i }).click();
    const warrantyRes = await warrantyPromise;
    expect(warrantyRes.status()).toBe(200);

    // tab === "warranty" injects an extra "Warranty Expires" column
    // header (page.tsx:235). Its presence is the cleanest proof that
    // the tab state actually swapped the rendered list source.
    await expect(
      page.getByRole("columnheader", { name: /warranty expires/i })
    ).toBeVisible({ timeout: 5_000 });
  });

  test("ADMIN can open the Add-Asset modal — Asset Tag + Name inputs render so the create form is wired up", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/assets", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /asset management/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // page.tsx:153-159 — clicking "Add Asset" toggles showAdd →
    // renders AddAssetModal (page.tsx:448-456). We're not submitting
    // (would create real DB rows in shared seed) — just pinning the
    // modal-open contract + the two required fields.
    await page.getByRole("button", { name: /add asset/i }).click();

    await expect(
      page.getByRole("heading", { name: /^add asset$/i })
    ).toBeVisible({ timeout: 5_000 });
    // page.tsx:541-552 — both inputs are required for the save button
    // to enable (disabled={!form.assetTag || !form.name}, page.tsx:659).
    await expect(
      page.getByPlaceholder(/asset tag/i)
    ).toBeVisible();
    await expect(page.getByPlaceholder(/^name$/i)).toBeVisible();
  });

  test("DOCTOR is locked out at the API — page chrome renders but GET /assets comes back 403 and the list shows the empty-state", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    // DOCTOR is NOT in authorize(ADMIN, RECEPTION) on assets.ts:134
    // (issue #174 — clinical roles don't need fleet/biomedical
    // inventory). The page has no client-side role check, so the
    // chrome still renders, but the load() fetch comes back 403 →
    // catch{} swallows the error → assets stays [] → "No assets"
    // shows. This is the actual security boundary so we lock the 403
    // here, mirroring the suppliers.spec.ts:153-177 precedent.
    const listPromise = page.waitForResponse((r) =>
      /\/api\/v1\/assets\?/.test(r.url()) &&
      r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/assets", { waitUntil: "domcontentloaded" });
    const listRes = await listPromise;
    expect(listRes.status()).toBe(403);

    // Empty-state copy from page.tsx:303.
    await expect(page.getByText(/^no assets$/i)).toBeVisible({
      timeout: 10_000,
    });
    // Add CTA must not render (DOCTOR is not ADMIN, page.tsx:152).
    await expect(
      page.getByRole("button", { name: /add asset/i })
    ).toHaveCount(0);
  });

  test("PATIENT is locked out at the API — equipment serial numbers + assignee PII must not leak to a patient session", async ({
    patientPage,
  }) => {
    const page = patientPage;

    // PATIENT has zero business reading the equipment register (the
    // entire §2.2 surface is staff-only). authorize(...) on
    // assets.ts:134 excludes PATIENT, so the list-fetch comes back 403.
    const listPromise = page.waitForResponse((r) =>
      /\/api\/v1\/assets\?/.test(r.url()) &&
      r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/assets", { waitUntil: "domcontentloaded" });
    const listRes = await listPromise;
    expect(listRes.status()).toBe(403);

    // Empty-state copy from page.tsx:303 — no asset rows must render.
    await expect(page.getByText(/^no assets$/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
