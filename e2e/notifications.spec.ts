/**
 * Notifications inbox e2e coverage — fully-accessible page across all roles.
 *
 * What this exercises:
 *   /dashboard/notifications (apps/web/src/app/dashboard/notifications/page.tsx)
 *   GET   /api/v1/notifications           — paged inbox load
 *   PATCH /api/v1/notifications/:id/read  — single-row mark-as-read
 *   GET   /api/v1/notifications/preferences + PUT preferences
 *   (apps/api/src/routes/notifications.ts)
 *
 * Surfaces touched:
 *   - Page chrome (heading, preferences accordion) for the five roles that
 *     have the Notifications entry in their sidebar nav (ADMIN / DOCTOR /
 *     NURSE / RECEPTION / PATIENT — see dashboard/layout.tsx 197/242/282/
 *     309/318). One happy path per representative role-class (staff vs.
 *     patient) plus a deep-render assertion for ADMIN.
 *   - Inbox load contract: the GET /notifications XHR fires on mount and
 *     returns { data, meta } (page.tsx:67-89). Catching a regression here
 *     means catching a future shape drift before it silently empties every
 *     user's inbox UI.
 *   - Preferences accordion toggle — page.tsx:281-291. Locks the
 *     accessible-name selector for the chevron header.
 *   - Direct-URL reachability for LAB_TECH and PHARMACIST: notifications
 *     is intentionally NOT in their sidebar (no menu entry) but the route
 *     has no client-side role gate (page.tsx has no VIEW_ALLOWED block —
 *     only the dashboard layout's auth guard runs). So the page should
 *     render the heading rather than bouncing to /not-authorized. Pinning
 *     this distinguishes "menu omission" from "RBAC denial" — the two
 *     have very different security implications.
 *
 * Why these tests exist:
 *   /dashboard/notifications was listed under §2.5 of
 *   docs/E2E_COVERAGE_BACKLOG.md as the inbox surface with no e2e cover.
 *   The page is the read-side of every async channel (WhatsApp / SMS /
 *   email / push) so a silent break — empty list, busted preferences
 *   toggle, accidental RBAC bounce — would land users in a broken state
 *   without any operator-visible signal. The page has zero data-testid
 *   attributes, so this spec uses accessible-name selectors throughout
 *   (per the suppliers.spec / assets.spec / payroll.spec precedent).
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Notifications — /dashboard/notifications (inbox load + preferences toggle + cross-role accessibility)", () => {
  test("ADMIN lands on /dashboard/notifications, the Notifications heading and Preferences accordion render, and the inbox GET fires", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Race the navigation against the inbox XHR so we can assert the
    // contract round-trip on the first paint instead of waiting for
    // arbitrary timeouts. Uses a permissive matcher because the URL has
    // a `?page=1&limit=20` querystring tail that varies (page.tsx:71).
    const inboxPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications") &&
        !r.url().includes("/preferences") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await gotoAuthed(page, "/dashboard/notifications");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^notifications$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Inbox round-trip should be a 2xx — a 4xx here means either the
    // route mounted under a different prefix or auth header dropped.
    const inboxRes = await inboxPromise;
    expect(inboxRes.status()).toBeLessThan(400);

    // Preferences accordion header — page.tsx:285. The button is the
    // only one whose accessible name contains "Notification Preferences"
    // so this selector is unambiguous even with the chevron icon.
    await expect(
      page.getByRole("heading", { name: /notification preferences/i })
    ).toBeVisible();
  });

  test("PATIENT can open /dashboard/notifications — patient-facing inbox is the read-side of every reminder channel", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/notifications");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^notifications$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The Preferences accordion is rendered for every role (no role
    // gate inside page.tsx). Confirming visibility here means a future
    // accidental hide-from-PATIENT regression surfaces.
    await expect(
      page.getByRole("heading", { name: /notification preferences/i })
    ).toBeVisible();
  });

  test("PATIENT can toggle the Preferences accordion open and the channel preferences GET fires", async ({
    patientPage,
  }) => {
    const page = patientPage;

    // page.tsx:91-102 — opening the panel reveals one row per channel,
    // backed by /notifications/preferences (which always returns at
    // least the four defaults if no rows exist for the user yet).
    const prefsPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/notifications/preferences") &&
        r.request().method() === "GET",
      { timeout: 15_000 }
    );
    await gotoAuthed(page, "/dashboard/notifications");
    await expectNotForbidden(page);

    const prefsRes = await prefsPromise;
    expect(prefsRes.status()).toBeLessThan(400);

    // The accordion header is the only top-level button on the page
    // (besides Mark-all-as-read, which is conditional on unreadCount>0).
    // page.tsx:281 binds the click handler to the entire header strip.
    const header = page.getByRole("heading", {
      name: /notification preferences/i,
    });
    await header.click();

    // Scope the channel/empty-state assertion to the preferences panel
    // container — the bare regex matches 16 elements page-wide (channel
    // names recur in inbox-row labels, sidebar items, etc.) and trips
    // Playwright's strict-mode multi-match guard. The panel wrapper is
    // the closest div ancestor of the accordion heading (page.tsx:280-
    // 357 — the rounded-xl bg-white shadow-sm card). Once it's visible,
    // .first() on the inner regex pins the assertion to a single match.
    const prefsPanel = page
      .getByRole("heading", { name: /notification preferences/i })
      .locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]");
    await expect(prefsPanel).toBeVisible({ timeout: 10_000 });

    // Either the four channel rows render, OR the empty-state copy
    // shows. Both code paths confirm the panel opened.
    await expect(
      prefsPanel
        .locator(
          "text=/WHATSAPP|SMS|EMAIL|PUSH|No preference settings|Loading preferences/i"
        )
        .first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("NURSE lands on /dashboard/notifications without bouncing — staff inbox is part of the standard sidebar (layout.tsx:309)", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await gotoAuthed(page, "/dashboard/notifications");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^notifications$/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("LAB_TECH lands on /dashboard/notifications — page has no client-side role gate, so direct-URL access works even without a sidebar entry", async ({
    labTechPage,
  }) => {
    const page = labTechPage;
    await gotoAuthed(page, "/dashboard/notifications");

    // Notifications is intentionally absent from the LAB_TECH sidebar
    // (layout.tsx ~136-178, no notifications href in that block). But
    // the page itself has no VIEW_ALLOWED guard, so direct-URL access
    // should NOT bounce to /not-authorized. This pins the security-vs-
    // discoverability distinction: missing-from-menu is not the same
    // as RBAC-denied.
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /^notifications$/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("PHARMACIST lands on /dashboard/notifications — same fully-accessible contract; no inbox-only RBAC denial", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await gotoAuthed(page, "/dashboard/notifications");

    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /^notifications$/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });
});
