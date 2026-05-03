/**
 * Broadcasts admin-flow + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/broadcasts (apps/web/src/app/dashboard/broadcasts/page.tsx)
 *   POST /api/v1/notifications/broadcast, GET /api/v1/notifications/broadcasts
 *   (apps/api/src/routes/notifications.ts:262-363, both gated authorize(Role.ADMIN))
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome renders, composer is visible, Send button
 *     is initially disabled (title/message/channels gate at page.tsx:301-302)
 *     and a fully-filled compose POSTs to /notifications/broadcast and lands
 *     a row in the history table.
 *   - Audience selector switches to SPECIFIC_USERS and reveals the staff
 *     picker (page.tsx:233-255) — locks the conditional render so a
 *     regression there doesn't silently hide the user list.
 *   - Validation: empty title+message keeps the Send button disabled and
 *     no POST is sent (client gate at page.tsx:120-123 + disabled attr).
 *   - DOCTOR / NURSE / PATIENT bounce off the page — the route's role gate
 *     pushes non-ADMIN to /dashboard (page.tsx:96-99) and the composer
 *     never renders.
 *
 * Why these tests exist:
 *   /dashboard/broadcasts was previously listed under §2.5 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "bulk announcement — no e2e coverage".
 *   The endpoint creates real Notification rows for every audience-targeted
 *   user, so a broken composer or a relaxed role gate would either spam
 *   tenants or leak admin-only messaging to staff.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Broadcasts — /dashboard/broadcasts (ADMIN compose + audience targeting + non-ADMIN RBAC redirects)", () => {
  test("ADMIN lands on /dashboard/broadcasts, page chrome renders, composer + history are visible, Send button is disabled until form is filled", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/broadcasts", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /broadcasts/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Composer card heading and the history table testid both render.
    await expect(
      page.getByRole("heading", { name: /compose broadcast/i })
    ).toBeVisible();
    // History container ALWAYS renders (loading / empty / data) — but the
    // table-with-testid only renders when there is at least one row. Asserting
    // the heading instead keeps this resilient for fresh tenants.
    await expect(
      page.getByRole("heading", { name: /broadcast history/i })
    ).toBeVisible();

    // Send button is disabled before any input — page.tsx:301-302 gates on
    // title && message && channels.length > 0. PUSH is preselected so
    // title+message are the missing pieces.
    const sendBtn = page.getByRole("button", { name: /send now|schedule/i });
    await expect(sendBtn).toBeDisabled();
  });

  test("ADMIN can compose and send a broadcast: fills title + message, clicks Send, server returns 201, history table picks up the new row", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/broadcasts", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /compose broadcast/i })
    ).toBeVisible({ timeout: 15_000 });

    // Use a unique tag so the assertion at the bottom is resilient to
    // other broadcasts the shared admin tenant accumulates across runs.
    const uniqueTag = `e2e-${Date.now()}`;
    const title = `E2E Broadcast ${uniqueTag}`;
    const message = `Automated test broadcast body — please ignore. Tag: ${uniqueTag}`;

    await page.getByPlaceholder("Announcement title").fill(title);
    await page.getByPlaceholder(/message body/i).fill(message);

    // Default audience is ALL_STAFF and PUSH is preselected. Choose
    // ROLE_ADMIN so we narrow the audience to the single seeded admin
    // user — keeps side-effects (Notification rows) bounded.
    //
    // The page renders a native <select> at page.tsx:219 with the
    // AUDIENCES options. Disambiguate from the dashboard layout's
    // LanguageDropdown <select> (LanguageDropdown.tsx:58, en/hi options)
    // by scoping to the select that contains the ROLE_ADMIN option —
    // the audience select is the only one carrying that value. Without
    // this scope, `locator("select").first()` matches the language
    // switcher (rendered earlier in the sidebar) and selectOption times
    // out because no "ROLE_ADMIN" option exists there.
    const audienceSelect = page.locator(
      'select:has(option[value="ROLE_ADMIN"])'
    );
    await expect(audienceSelect).toBeVisible({ timeout: 10_000 });
    await expect(audienceSelect).toBeEnabled({ timeout: 5_000 });
    await audienceSelect.selectOption("ROLE_ADMIN");

    // Send-button gate: page.tsx:301-302 requires title && message &&
    // channels.length > 0. Title + message were filled above and PUSH is
    // preselected, so wait for the disabled prop to flip before clicking.
    const sendBtn = page.getByRole("button", { name: /send now/i });
    await expect(sendBtn).toBeEnabled({ timeout: 5_000 });

    const sendPromise = page.waitForResponse((r) =>
      r.url().includes("/api/v1/notifications/broadcast") &&
      r.request().method() === "POST"
    );
    await sendBtn.click();
    const sendRes = await sendPromise;

    // Server contract: 201 + { success: true, data: { id, ... } }.
    // 4xx here = client/server payload drift; 5xx = quiet-hours math
    // or schema regression — both worth catching loudly.
    expect(sendRes.status()).toBeLessThan(400);

    // The history list reload runs after the POST resolves
    // (page.tsx:145-148). The unique tag should land in the table.
    await expect(
      page.locator(`text=${uniqueTag}`).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("ADMIN switching the audience selector to Specific Users reveals the staff picker; switching back hides it", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/broadcasts", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /compose broadcast/i })
    ).toBeVisible({ timeout: 15_000 });

    // Audience defaults to ALL_STAFF — the per-user checkbox panel
    // (page.tsx:233-255) is gated on audience === "SPECIFIC_USERS".
    //
    // Disambiguate the audience <select> from the layout-level
    // LanguageDropdown <select> by scoping to the select that contains
    // the SPECIFIC_USERS option (only the audience picker carries that
    // value — see AUDIENCES at page.tsx:41-49).
    const audienceSelect = page.locator(
      'select:has(option[value="SPECIFIC_USERS"])'
    );
    await expect(audienceSelect).toBeVisible({ timeout: 10_000 });
    await expect(audienceSelect).toBeEnabled({ timeout: 5_000 });
    await expect(
      page.locator("text=/Select users \\(/")
    ).toHaveCount(0);

    await audienceSelect.selectOption("SPECIFIC_USERS");
    await expect(
      page.locator("text=/Select users \\(/")
    ).toBeVisible({ timeout: 5_000 });

    // Flip back to a role-targeted audience and confirm the picker hides.
    await audienceSelect.selectOption("ROLE_DOCTOR");
    await expect(
      page.locator("text=/Select users \\(/")
    ).toHaveCount(0);
  });

  test("ADMIN cannot send a broadcast with empty title and message: Send button stays disabled and no POST is fired", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/broadcasts", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /compose broadcast/i })
    ).toBeVisible({ timeout: 15_000 });

    // Watch for any outbound POST to /notifications/broadcast — the
    // disabled-button gate at page.tsx:301-302 should mean we never
    // see one fire while the form is empty.
    let postFired = false;
    await page.route("**/api/v1/notifications/broadcast", (route) => {
      if (route.request().method() === "POST") postFired = true;
      route.continue();
    });

    const sendBtn = page.getByRole("button", { name: /send now|schedule/i });
    await expect(sendBtn).toBeDisabled();

    // Force a click anyway — Playwright respects `disabled`, but force:true
    // simulates a user who somehow bypasses the visual disable. The client
    // guard at page.tsx:120-123 should still short-circuit before the
    // network call.
    await sendBtn.click({ force: true }).catch(() => undefined);

    // Give any in-flight (non-)request a moment to surface before we
    // assert it never went out.
    await page.waitForTimeout(500);
    expect(postFired).toBe(false);
  });

  test("DOCTOR bounces off /dashboard/broadcasts — useEffect at page.tsx:96-99 pushes non-ADMIN to /dashboard, composer never renders", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/broadcasts", {
      waitUntil: "domcontentloaded",
    });
    // Allow the role-gate useEffect a tick to fire.
    await page.waitForTimeout(800);

    // page.tsx:97 routes to /dashboard (not /dashboard/not-authorized).
    // Either landed back on the dashboard root or never moved off the
    // composer's null-render branch (page.tsx:178). Both are acceptable
    // per the issue-#179 pattern.
    expect(page.url()).toMatch(/\/dashboard(\/(?!broadcasts).*|\?|$)/);

    // The composer must NOT have rendered for non-ADMIN.
    await expect(
      page.getByRole("heading", { name: /compose broadcast/i })
    ).toHaveCount(0);
  });

  test("NURSE bounces off /dashboard/broadcasts — same role-gate useEffect, composer never renders", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/broadcasts", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard(\/(?!broadcasts).*|\?|$)/);
    await expect(
      page.getByRole("heading", { name: /compose broadcast/i })
    ).toHaveCount(0);
  });

  test("PATIENT bounces off /dashboard/broadcasts — admin-only surface, composer never renders", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/broadcasts", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard(\/(?!broadcasts).*|\?|$)/);
    await expect(
      page.getByRole("heading", { name: /compose broadcast/i })
    ).toHaveCount(0);
  });
});
