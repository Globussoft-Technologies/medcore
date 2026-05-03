/**
 * Medicine catalog list + role-gated mutate CTAs e2e coverage.
 *
 * What this exercises:
 *   /dashboard/medicines (apps/web/src/app/dashboard/medicines/page.tsx)
 *   GET /api/v1/medicines, GET /api/v1/medicines/:id
 *   POST/PATCH/DELETE /api/v1/medicines (apps/api/src/routes/medicines.ts)
 *
 * Surfaces touched:
 *   - Fully accessible page: there is NO role-redirect gate in page.tsx.
 *     All authenticated roles can land on the list. CTAs are role-gated
 *     instead — Add Medicine is ADMIN-only (page.tsx:185), Edit is
 *     ADMIN|DOCTOR (canEdit, page.tsx:71 — matches API authorize() on
 *     POST/PATCH), Delete is ADMIN-only (canDelete, page.tsx:72 —
 *     matches DELETE /medicines/:id authorize(Role.ADMIN), routes:187).
 *   - Search + category filters drive a re-fetch via useEffect on
 *     [search, category] (page.tsx:106-108) — typing into the search
 *     box should issue a /medicines?search=… request.
 *   - Detail modal opens on card click and shows the manufacturer / Rx /
 *     interactions sections (page.tsx:312-384).
 *
 * Why these tests exist:
 *   /dashboard/medicines was previously listed under §2.2 Inventory &
 *   Supply Chain of docs/E2E_COVERAGE_BACKLOG.md as the bare "medicine
 *   catalog" entry — no e2e coverage at all. The catalog underpins
 *   prescriptions, pharmacy stock, and the dose calculators, so a silent
 *   regression in the list-fetch contract or the ADMIN-only Add gate
 *   would cascade through the clinical surface. This file locks the
 *   data-testid contract for medicine cards, the ADMIN Add CTA, the
 *   ADMIN/DOCTOR Edit CTA, and the ADMIN-only Delete CTA — plus a
 *   PATIENT read-only happy path to prove the page renders without a
 *   role-redirect bounce.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Medicines — /dashboard/medicines (ADMIN/DOCTOR/NURSE/PATIENT read-only access; Add ADMIN-only, Edit ADMIN|DOCTOR, Delete ADMIN-only)", () => {
  test("ADMIN lands on /dashboard/medicines, sees the catalog heading and the ADMIN-only Add Medicine CTA renders", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/medicines", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^medicines$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Add Medicine button is gated on `isAdmin` (page.tsx:185). Its
    // presence proves the role gate fired correctly for ADMIN.
    await expect(
      page.getByRole("button", { name: /add medicine/i })
    ).toBeVisible();
  });

  test("DOCTOR can view the catalog and sees Edit CTAs on cards (canEdit gate, page.tsx:71) but no Add Medicine button (ADMIN-only)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/medicines", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^medicines$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the list-fetch round-trip to settle. If the seed has no
    // medicines, the empty-state copy renders instead — both are
    // acceptable here; we're locking the role gate, not the seed.
    await page.waitForTimeout(1500);

    // ADMIN-only Add CTA must NOT render for DOCTOR.
    await expect(
      page.getByRole("button", { name: /add medicine/i })
    ).toHaveCount(0);

    // If at least one medicine card rendered, DOCTOR sees Edit but not Delete.
    const cards = page.locator('[data-testid="medicine-card"]');
    const cardCount = await cards.count();
    if (cardCount > 0) {
      await expect(
        cards.first().locator('[data-testid="medicine-edit"]')
      ).toBeVisible();
      // Delete is ADMIN-only — DOCTOR must not see it (canDelete=false).
      await expect(
        cards.first().locator('[data-testid="medicine-delete"]')
      ).toHaveCount(0);
    }
  });

  test("Search box issues a /medicines?search=… request, exercising the useEffect re-fetch on filter change (page.tsx:106-108)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/medicines", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /^medicines$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The first list load fires before we can attach the listener,
    // so wait for the typing-driven refetch instead. The page reads
    // `URLSearchParams` and only sets `search` if non-empty (page.tsx:114),
    // so a non-empty input MUST hit /medicines?search=…
    const searchPromise = page.waitForResponse(
      (r) =>
        /\/api\/v1\/medicines(\?|$)/.test(r.url()) &&
        r.url().includes("search=") &&
        r.request().method() === "GET",
      { timeout: 10_000 }
    );
    await page
      .getByPlaceholder(/search medicines/i)
      .fill(`zzzNoSuchMed-${Date.now()}`);
    const res = await searchPromise;
    expect(res.status()).toBeLessThan(400);

    // With a junk query, the empty-state copy renders.
    await expect(
      page.locator("text=/no medicines found/i").first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("PATIENT can load /dashboard/medicines (no role-redirect gate) but sees neither Add, Edit, nor Delete CTAs", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/medicines", {
      waitUntil: "domcontentloaded",
    });
    // page.tsx has no RBAC redirect, so PATIENT must NOT bounce to
    // /dashboard/not-authorized — admissions-style "fully accessible
    // page, role-gated CTAs only" pattern.
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^medicines$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(1200);

    // None of the mutate CTAs should render for PATIENT.
    await expect(
      page.getByRole("button", { name: /add medicine/i })
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="medicine-edit"]')
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="medicine-delete"]')
    ).toHaveCount(0);
  });

  test("NURSE can load /dashboard/medicines (no role-redirect gate) but sees no mutate CTAs (canEdit and canDelete both false)", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/medicines", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^medicines$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(1200);

    // NURSE is excluded from canEdit (ADMIN|DOCTOR), canDelete (ADMIN), and
    // the Add CTA gate (ADMIN). All three CTAs must be absent.
    await expect(
      page.getByRole("button", { name: /add medicine/i })
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="medicine-edit"]')
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="medicine-delete"]')
    ).toHaveCount(0);
  });

  test("ADMIN opens the Add Medicine modal, fills name + manufacturer, saves, and the new entry appears in the list", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/medicines", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /^medicines$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Open the modal via the ADMIN-only CTA.
    await page.getByRole("button", { name: /add medicine/i }).click();

    // The form is rendered inline (no data-testid on the modal wrapper —
    // we anchor on the field labels and the medicine-save submit button).
    const uniqueTag = `e2e-${Date.now()}`;
    const medName = `E2E Med ${uniqueTag}`;

    await page.getByLabel(/^name$/i).fill(medName);
    await page.getByLabel(/manufacturer/i).fill(`E2E Pharma ${uniqueTag}`);

    // Submit and wait for the POST round-trip to confirm the create
    // contract didn't drift (server returns 201).
    const savePromise = page.waitForResponse(
      (r) =>
        /\/api\/v1\/medicines(\?|$)/.test(r.url()) &&
        r.request().method() === "POST",
      { timeout: 10_000 }
    );
    await page.locator('[data-testid="medicine-save"]').click();
    const saveRes = await savePromise;
    expect(saveRes.status()).toBeLessThan(400);

    // After success the modal closes (page.tsx:159) and load() refires.
    // The new card should land in the grid — anchor on the unique tag
    // so we don't depend on alphabetical ordering vs the seed.
    await expect(
      page.locator(`text=${medName}`).first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
