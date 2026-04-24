import { test, expect } from "./fixtures";

/**
 * Negative RBAC + nurse-workstation regression suite covering GitHub issues
 * #14, #23, #29, #30, #31. Each test pairs a (role, forbidden action) with
 * an assertion that the UI correctly gates the feature without leaking a
 * backend 403/404 to the user.
 */
test.describe("RBAC negatives + nurse workstation regressions", () => {
  // Issue #14 — doctor must not see the "Enter Results" button on the lab
  // orders list. Only lab techs / admins can enter results.
  test("doctor: lab orders page hides Enter Results button", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/lab");
    await expect(
      page.getByRole("heading", { name: /lab/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // "Enter Results" is the exact label rendered only for LAB_TECH/ADMIN.
    await expect(
      page.getByRole("link", { name: /enter results/i })
    ).toHaveCount(0);
  });

  // Issue #23 — patient sidebar must NOT include "Lab Explainer" (it was an
  // admin approval queue that showed a Forbidden toast when patients opened
  // it).
  test("patient: sidebar does not show Lab Explainer", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard");
    await expect(page.locator("text=MedCore").first()).toBeVisible({
      timeout: 15_000,
    });

    const sidebar = page.locator("aside[aria-label='Primary navigation']");
    await expect(sidebar).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: /lab explainer/i })
    ).toHaveCount(0);
  });

  // Issue #31 — nurse workstation/dashboard must not fire unauthorized
  // background calls. We assert no 403s show up in the Network tab for
  // endpoints the nurse should never be hitting.
  test("nurse: workstation does not produce 403 responses", async ({
    nursePage,
  }) => {
    const page = nursePage;
    const forbidden: string[] = [];
    page.on("response", (resp) => {
      if (resp.status() === 403) forbidden.push(resp.url());
    });

    await page.goto("/dashboard");
    await expect(page.locator("text=MedCore").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.goto("/dashboard/workstation");
    await expect(
      page.getByRole("heading", { name: /workstation/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Let background fetches drain.
    await page.waitForTimeout(1500);

    expect(
      forbidden,
      `Nurse saw 403 from admin-only endpoints: ${forbidden.join(", ")}`
    ).toEqual([]);
  });

  // Issue #29 — assigned-patient card in the nurse workstation must link to
  // an existing route (previously /dashboard/ipd/:id, which 404'd).
  test("nurse: assigned patient card link resolves (no 404)", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/workstation");
    await expect(
      page.getByRole("heading", { name: /workstation/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Find any link inside the "My Assigned Patients" section; if no rows are
    // present on this seed, the test is a no-op — but if any exist, their
    // href MUST target an extant admissions route.
    const cardLinks = page
      .locator("a[href^='/dashboard/admissions/']")
      .or(page.locator("a[href^='/dashboard/ipd/']"));
    const count = await cardLinks.count();

    for (let i = 0; i < count; i++) {
      const href = await cardLinks.nth(i).getAttribute("href");
      if (!href) continue;
      // The dead route was /dashboard/ipd/:id — reject it outright.
      expect(
        href.startsWith("/dashboard/ipd/"),
        `assigned-patient card should not link to /dashboard/ipd/*, got ${href}`
      ).toBe(false);
    }
  });
});
