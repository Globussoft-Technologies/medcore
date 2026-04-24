import { test, expect } from "./fixtures";

/**
 * Regression for issues #3 (admin) and #26 (reception) — the Reports page
 * used to throw a client-side exception ("white screen") because the web
 * client destructured `paymentModeBreakdown` / `recentPayments` which the
 * API returns under different keys (`byMode` / `payments`). A null-access
 * inside `Math.max(...Object.values(undefined))` then took down React.
 *
 * This spec loads the page for both roles and asserts:
 *   1. the page heading renders
 *   2. Next.js's default error boundary does NOT show
 *   3. no uncaught errors hit the browser console while the page loads
 */
test.describe("Reports page regression (#3 / #26)", () => {
  test("admin can open /dashboard/reports without a client-side crash", async ({
    adminPage,
  }) => {
    const page = adminPage;
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e.message)));

    await page.goto("/dashboard/reports", { waitUntil: "domcontentloaded" });

    // Heading renders
    await expect(
      page.getByRole("heading", { name: /billing reports/i })
    ).toBeVisible({ timeout: 15_000 });

    // No Next.js error-boundary UI
    await expect(
      page.getByText(/application error|client-side exception|something went wrong/i)
    ).toHaveCount(0);

    // No uncaught React errors
    expect(
      consoleErrors.filter((m) => !/ResizeObserver|Hydration/i.test(m))
    ).toEqual([]);
  });

  test("reception can open /dashboard/reports without a client-side crash", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e.message)));

    await page.goto("/dashboard/reports", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: /billing reports/i })
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByText(/application error|client-side exception|something went wrong/i)
    ).toHaveCount(0);

    expect(
      consoleErrors.filter((m) => !/ResizeObserver|Hydration/i.test(m))
    ).toEqual([]);
  });
});
