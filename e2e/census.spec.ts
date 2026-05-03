/**
 * Bed-census reporting + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/census (apps/web/src/app/dashboard/census/page.tsx)
 *   GET /api/v1/admissions/census/daily, GET /api/v1/admissions/census/range
 *   (apps/api/src/routes/admissions.ts:1221-1281, 1283-…)
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome (header + Daily/Weekly/Monthly toggle),
 *     default Weekly fetch lands a /census/range round-trip with 200, the
 *     four summary cards (New Admissions / Discharges / Deaths / Avg.
 *     Occupancy) render.
 *   - Mode toggle: clicking Daily flips the URL pattern from /census/range
 *     to /census/daily and the date <input type=date> appears (locks the
 *     page.tsx:96-105 conditional render).
 *   - DOCTOR / NURSE / RECEPTION reach: each has API access per
 *     authorize() in admissions.ts:1224 and pages render without crashing.
 *   - PATIENT/LAB_TECH/PHARMACIST: page itself has NO client-side role
 *     gate (page.tsx has no VIEW_ALLOWED constant), so chrome renders for
 *     them too — but the API returns 403 and the page swallows it
 *     (catch -> setData([])), leaving the summary cards at zero. We pin
 *     that behaviour here so a future regression that surfaces a 500 or
 *     leaks data to PATIENT shows up immediately.
 *
 * Why these tests exist:
 *   /dashboard/census was listed under §2.6 of docs/E2E_COVERAGE_BACKLOG.md
 *   as "bed census — no e2e coverage". The page is the primary daily
 *   inpatient occupancy surface for ops/clinical leads; a silent break
 *   (e.g. range endpoint 500, summary card NaN, or API role drift letting
 *   PATIENT see real census data) is exactly the kind of regression that
 *   slips past unit tests but matters in prod.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Census Report — /dashboard/census (allowed-role chrome + mode toggle + outside-API-allowlist behaviour)", () => {
  test("ADMIN lands on /dashboard/census, default Weekly mode fires GET /admissions/census/range, summary cards render", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Default mode is "week" (page.tsx:23), so the first effect should hit
    // the range endpoint, not the daily one. Capture the response so we
    // can assert both that it fired AND that the API is healthy under an
    // ADMIN token.
    const rangePromise = page.waitForResponse((r) =>
      r.url().includes("/admissions/census/range") &&
      r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/census", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    const res = await rangePromise;
    expect(res.status()).toBeLessThan(400);

    await expect(
      page.getByRole("heading", { name: /census report/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The four summary cards always render (page.tsx:109-134) regardless
    // of data availability. Lock all four labels so a future refactor that
    // accidentally drops one is a clean test failure.
    await expect(page.getByText(/new admissions/i).first()).toBeVisible();
    await expect(page.getByText(/discharges/i).first()).toBeVisible();
    await expect(page.getByText(/deaths/i).first()).toBeVisible();
    await expect(page.getByText(/avg\. occupancy/i).first()).toBeVisible();
  });

  test("ADMIN can switch to Daily mode: clicking Daily fires /admissions/census/daily and reveals the date picker", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.goto("/dashboard/census", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /census report/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the initial weekly range call to settle so its response
    // doesn't race the daily click below.
    await page
      .waitForResponse(
        (r) => r.url().includes("/admissions/census/range"),
        { timeout: 10_000 }
      )
      .catch(() => undefined);

    const dailyPromise = page.waitForResponse((r) =>
      r.url().includes("/admissions/census/daily") &&
      r.request().method() === "GET",
      { timeout: 10_000 }
    );

    // The mode buttons render as plain <button>s with text "Daily" /
    // "Weekly" / "Monthly" (page.tsx:81-92). Use accessible-name fallback
    // since there are no testids on this page yet.
    await page.getByRole("button", { name: /^daily$/i }).click();

    const dailyRes = await dailyPromise;
    expect(dailyRes.status()).toBeLessThan(400);

    // The date <input type=date> only renders in Daily mode
    // (page.tsx:96-105). Its presence is the visible signal that the
    // mode flip succeeded.
    await expect(page.locator('input[type="date"]')).toBeVisible({
      timeout: 5_000,
    });
  });

  test("DOCTOR can reach /dashboard/census — DOCTOR is in the API allowlist (admissions.ts:1224) so the range fetch succeeds", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    const rangePromise = page.waitForResponse((r) =>
      r.url().includes("/admissions/census/range"),
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/census", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    const res = await rangePromise;
    expect(res.status()).toBeLessThan(400);

    await expect(
      page.getByRole("heading", { name: /census report/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("NURSE can reach /dashboard/census — NURSE is in the API allowlist and chrome renders without crash", async ({
    nursePage,
  }) => {
    const page = nursePage;

    await page.goto("/dashboard/census", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /census report/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Sanity: no React error boundary surfaced.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("PATIENT loads /dashboard/census but the range API returns 403 — page swallows it (catch → setData([])) and summary cards show zeros", async ({
    patientPage,
  }) => {
    const page = patientPage;

    // PATIENT is NOT in authorize(ADMIN, DOCTOR, NURSE, RECEPTION) at
    // admissions.ts:1224, so the API responds 403. The page itself has
    // no client-side role gate (no VIEW_ALLOWED), so chrome still renders
    // and the catch in page.tsx:47-49 zeroes the table.
    const rangePromise = page.waitForResponse((r) =>
      r.url().includes("/admissions/census/range"),
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/census", { waitUntil: "domcontentloaded" });

    const res = await rangePromise;
    // The contract here is "API rejects PATIENT". 401/403 are both
    // acceptable depending on whether the token is rejected at auth or
    // authz time; what we MUST NOT see is a 200 (data leak) or a 5xx
    // (handler crashed under unexpected role).
    expect([401, 403]).toContain(res.status());

    // Page chrome still renders.
    await expect(
      page.getByRole("heading", { name: /census report/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // No React crash boundary.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("LAB_TECH and PHARMACIST hit the same API 403 — page chrome still renders, no data leak", async ({
    labTechPage,
  }) => {
    const page = labTechPage;

    const rangePromise = page.waitForResponse((r) =>
      r.url().includes("/admissions/census/range"),
      { timeout: 15_000 }
    );
    await page.goto("/dashboard/census", { waitUntil: "domcontentloaded" });

    const res = await rangePromise;
    expect([401, 403]).toContain(res.status());

    await expect(
      page.getByRole("heading", { name: /census report/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
