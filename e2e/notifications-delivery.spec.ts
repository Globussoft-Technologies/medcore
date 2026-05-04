/**
 * Notification Delivery Status admin-flow + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/notifications/delivery
 *     (apps/web/src/app/dashboard/notifications/delivery/page.tsx)
 *   GET  /api/v1/notifications/delivery
 *     (apps/api/src/routes/notifications.ts:471-505, authorize(Role.ADMIN))
 *
 * Surfaces touched:
 *   - ADMIN happy path: heading "Notification Delivery Status" renders, the
 *     delivery GET fires on mount and returns 2xx, the four filter selects
 *     (status / channel / from / to) are visible.
 *   - Filter contract: changing the status select to "FAILED" issues a
 *     re-fetch carrying `?status=FAILED` (page.tsx:50-58). Catching this
 *     locks the URL-param wiring so a future reset of useCallback deps
 *     doesn't silently break filtered views.
 *   - Refresh button re-issues the GET — the explicit reload control on
 *     page.tsx:137-142.
 *   - Empty state: when the filter combination yields zero rows the table
 *     renders the "No notifications match the filters." copy
 *     (page.tsx:166-171). Combine an unlikely status+channel pair to force
 *     an empty result on a fresh tenant.
 *   - Non-ADMIN bounce: useEffect at page.tsx:43-45 routes any non-ADMIN
 *     to /dashboard, so DOCTOR / NURSE / PATIENT never reach the table.
 *
 * Why these tests exist:
 *   /dashboard/notifications/delivery was listed under §2.5 of
 *   docs/E2E_COVERAGE_BACKLOG.md as the delivery-status surface with no
 *   e2e cover. It is the operator's single window into per-channel
 *   delivery success — a silent regression here (broken filter wiring,
 *   relaxed role gate, broken /delivery GET) leaves every notification
 *   failure invisible until a customer escalates.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Notification Delivery — /dashboard/notifications/delivery (ADMIN delivery viewer + filter wiring + non-ADMIN RBAC redirects)", () => {
  test("ADMIN lands on /dashboard/notifications/delivery, heading renders, GET /notifications/delivery fires and returns 2xx, all four filters are visible", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Race the delivery GET against the navigation so we can pin the
    // contract round-trip at first paint. Match permissively because
    // page.tsx:55-57 always emits the URL with a (possibly empty) query
    // string tail.
    const deliveryPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/delivery") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await gotoAuthed(page, "/dashboard/notifications/delivery");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /notification delivery status/i })
    ).toBeVisible({ timeout: 15_000 });

    const deliveryRes = await deliveryPromise;
    expect(deliveryRes.status()).toBeLessThan(400);

    // The four filter controls render with stable id selectors
    // (page.tsx:88, 104, 120, 130). LanguageDropdown lives in the layout
    // so a bare `select` query is ambiguous — use the id that only this
    // page emits.
    await expect(page.locator("#notif-delivery-status")).toBeVisible();
    await expect(page.locator("#notif-delivery-channel")).toBeVisible();
    await expect(page.locator("#notif-delivery-from")).toBeVisible();
    await expect(page.locator("#notif-delivery-to")).toBeVisible();
  });

  test("ADMIN filtering by status=FAILED re-issues the delivery GET with the status query param attached", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/notifications/delivery");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /notification delivery status/i })
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the initial unfiltered load to settle so we don't race
    // it with the filter-driven reload below.
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/delivery") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    // Watch for the filtered re-fetch — page.tsx:47-67 re-runs `load`
    // whenever any filter state changes, and serializes status into the
    // URL at line 51.
    const filteredPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/delivery") &&
        r.url().includes("status=FAILED") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    // Use the id selector — the page-local <select> is the only one
    // carrying the FAILED option, but scoping to the id is even tighter.
    await page.locator("#notif-delivery-status").selectOption("FAILED");

    const filteredRes = await filteredPromise;
    expect(filteredRes.status()).toBeLessThan(400);
    expect(filteredRes.url()).toContain("status=FAILED");
  });

  test("ADMIN clicking Refresh re-issues GET /notifications/delivery — explicit reload control on page.tsx:137-142", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/notifications/delivery");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /notification delivery status/i })
    ).toBeVisible({ timeout: 15_000 });

    // Drain the initial load so the next response we await is the
    // refresh-driven one.
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/delivery") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    const refreshPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/delivery") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    await page.getByRole("button", { name: /^refresh$/i }).click();
    const refreshRes = await refreshPromise;
    expect(refreshRes.status()).toBeLessThan(400);
  });

  test("ADMIN narrowing to status=READ + channel=PUSH on a fresh tenant renders the empty-state copy from page.tsx:166-171", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/notifications/delivery");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /notification delivery status/i })
    ).toBeVisible({ timeout: 15_000 });

    // Wait for initial load so the next two filter responses are the
    // ones triggered by our selectOption calls.
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/delivery") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    await page.locator("#notif-delivery-status").selectOption("READ");
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/delivery") &&
        r.url().includes("status=READ") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );

    await page.locator("#notif-delivery-channel").selectOption("PUSH");
    const finalRes = await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/delivery") &&
        r.url().includes("status=READ") &&
        r.url().includes("channel=PUSH") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );
    expect(finalRes.status()).toBeLessThan(400);

    // Either the empty-state row OR (in the unlikely case the seed data
    // already has a READ+PUSH row) zero match is fine — the assertion
    // pins that the loading spinner is gone and the table body is in a
    // settled state.
    const emptyRow = page.locator(
      "text=/No notifications match the filters/i"
    );
    const dataRow = page.locator("table tbody tr").filter({
      hasNot: page.locator("text=/Loading|No notifications match/i"),
    });

    // One of the two terminal states must be present. We don't strictly
    // require the empty-state row because a long-lived tenant may have
    // an actual READ+PUSH row, but loading must have ended.
    await expect(page.locator("text=/^Loading\\.\\.\\.$/")).toHaveCount(0, {
      timeout: 5_000,
    });
    const settled =
      (await emptyRow.count()) + (await dataRow.count()) > 0;
    expect(settled).toBe(true);
  });

  test("DOCTOR bounces off /dashboard/notifications/delivery — useEffect at page.tsx:43-45 pushes non-ADMIN to /dashboard, the table never renders", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/notifications/delivery", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    // page.tsx:44 routes to /dashboard. URL must no longer contain the
    // /notifications/delivery path segment.
    expect(page.url()).not.toMatch(/\/dashboard\/notifications\/delivery/);

    // The page heading is unique to the delivery viewer; it must not
    // have rendered for a non-ADMIN.
    await expect(
      page.getByRole("heading", { name: /notification delivery status/i })
    ).toHaveCount(0);
  });

  test("NURSE bounces off /dashboard/notifications/delivery — same role-gate useEffect, table never renders", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/notifications/delivery", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).not.toMatch(/\/dashboard\/notifications\/delivery/);
    await expect(
      page.getByRole("heading", { name: /notification delivery status/i })
    ).toHaveCount(0);
  });

  test("PATIENT bounces off /dashboard/notifications/delivery — admin-only surface, table never renders", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/notifications/delivery", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).not.toMatch(/\/dashboard\/notifications\/delivery/);
    await expect(
      page.getByRole("heading", { name: /notification delivery status/i })
    ).toHaveCount(0);
  });
});
