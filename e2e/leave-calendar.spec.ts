/**
 * Leave-Calendar admin-only calendar-surface e2e coverage.
 *
 * What this exercises:
 *   /dashboard/leave-calendar (apps/web/src/app/dashboard/leave-calendar/page.tsx)
 *   GET /api/v1/leaves?status=APPROVED|PENDING&from=&to=
 *   (apps/api/src/routes/leaves.ts:91-118 — ADMIN-only filter for `userId=`,
 *   non-admin path scoped to caller; the calendar page itself is ADMIN-gated
 *   in page.tsx:58-62 so we only assert the ADMIN render here)
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome (heading, month label, prev/next + Today
 *     buttons), the legend swatches for the six leave types + the issue-#69
 *     PENDING swatch, and the calendar grid renders without "Application
 *     error" / "Something went wrong".
 *   - Calendar interaction: clicking the "next month" chevron advances the
 *     month label (locks the prevMonth/nextMonth state machine at
 *     page.tsx:125-130 + the load() useEffect refetch on `anchor` change).
 *   - Today button resets the anchor (page.tsx:159-163) — covers the
 *     reset-to-current-month case the next-month nav doesn't.
 *   - RBAC bounces for DOCTOR / NURSE / PATIENT: page.tsx:58-62 hard-redirects
 *     every non-ADMIN role to /dashboard, and `return null` at page.tsx:132
 *     guarantees neither the Today button nor the legend ever render.
 *
 * Why this spec exists:
 *   /dashboard/leave-calendar was listed under §2.4 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "calendar view (approval side covered)".
 *   The approval workflow (approve/reject + my-leaves submission) is locked
 *   elsewhere; this file is the calendar SURFACE only — month navigation,
 *   legend, and the ADMIN-only gate. A silent regression in the role gate or
 *   the prev/next state machine would leave HR with a blank/broken board and
 *   no signal until a user reports it. This adds the first positive-path
 *   assertion plus the standard issue-#179 RBAC redirect coverage.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Leave Calendar — /dashboard/leave-calendar (ADMIN calendar surface + non-ADMIN bounces)", () => {
  test("ADMIN lands on /dashboard/leave-calendar, page chrome renders, month label + prev/next/Today controls are visible", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/leave-calendar", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /leave calendar/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The "Today" button only renders inside the calendar header (page.tsx:159);
    // its visibility proves the ADMIN-side render path completed and we're not
    // staring at a blank role-gated null.
    await expect(
      page.getByRole("button", { name: /^today$/i })
    ).toBeVisible();

    // The current month label uses `toLocaleString("en-IN", { month: "long",
    // year: "numeric" })` — match on a four-digit year regardless of which
    // month the test happens to run in.
    await expect(
      page.locator("p", { hasText: /\b(19|20)\d{2}\b/ }).first()
    ).toBeVisible();

    // Crash-regression: the page must not have rendered the global error
    // boundary even if the /leaves fetch itself failed (page.tsx:92-94 swallows
    // errors and falls back to []), so we still expect a clean chrome.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("ADMIN sees the legend with all six leave-type swatches plus the issue-#69 PENDING swatch", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/leave-calendar", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // Legend block at page.tsx:169-181 enumerates the six TYPE_COLORS keys
    // (CASUAL/SICK/EARNED/MATERNITY/PATERNITY/UNPAID) plus the PENDING swatch.
    // The labels are rendered as plain `<span>{k}</span>`, so a text match is
    // sufficient — and resilient to swatch-color tweaks.
    for (const label of [
      "CASUAL",
      "SICK",
      "EARNED",
      "MATERNITY",
      "PATERNITY",
      "UNPAID",
    ]) {
      await expect(
        page.locator(`text=${label}`).first()
      ).toBeVisible();
    }
    // Issue-#69 swatch label is the only one with a parenthetical — keeping
    // it as a separate assertion so a regression that drops just this swatch
    // is distinguishable from one that drops the whole legend.
    await expect(
      page.locator("text=/PENDING \\(awaiting approval\\)/i")
    ).toBeVisible();
  });

  test("ADMIN can navigate to next month via the chevron and back to current via Today — locks the anchor state machine in page.tsx:125-163", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/leave-calendar", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    const monthLabel = page.locator("p", {
      hasText: /\b(19|20)\d{2}\b/,
    }).first();
    await expect(monthLabel).toBeVisible({ timeout: 15_000 });
    const initialLabel = (await monthLabel.textContent())?.trim() ?? "";
    expect(initialLabel.length).toBeGreaterThan(0);

    // The prev/next buttons render only the lucide chevron icons (no text),
    // so locate them by their position relative to the month label. There
    // are exactly two chevron-bearing buttons in the header: index 0 = prev,
    // index 1 = next (page.tsx:141-158).
    const navButtons = page.locator(
      "div.flex.items-center.gap-3 > button.rounded-lg.border"
    );
    // First two are prev/next chevrons; the third is the Today button.
    await navButtons.nth(1).click();

    // Wait for the anchor-driven re-render. The month label is the canonical
    // signal — it MUST differ from the initial label after a single advance.
    await expect
      .poll(async () => (await monthLabel.textContent())?.trim() ?? "", {
        timeout: 5_000,
      })
      .not.toBe(initialLabel);

    // Hit Today — anchor resets to startOfMonth(new Date()) (page.tsx:160).
    await page.getByRole("button", { name: /^today$/i }).click();
    await expect
      .poll(async () => (await monthLabel.textContent())?.trim() ?? "", {
        timeout: 5_000,
      })
      .toBe(initialLabel);
  });

  test("DOCTOR bounces — page.tsx:58-62 redirects every non-ADMIN to /dashboard and the early `return null` at :132 hides the Today button", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/leave-calendar", {
      waitUntil: "domcontentloaded",
    });
    // Allow the role-gate useEffect a tick to fire.
    await page.waitForTimeout(800);

    // Either the redirect already settled to /dashboard OR we're still on the
    // null-render of /dashboard/leave-calendar — both are acceptable per the
    // issue-#179 pattern. The load-bearing assertion is that the ADMIN-only
    // Today button is NOT visible.
    expect(page.url()).toMatch(
      /\/dashboard(\/leave-calendar)?(\?|$|\/)/
    );
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^today$/i })
    ).toHaveCount(0);
  });

  test("NURSE bounces — same gate as DOCTOR, also asserts the legend never rendered", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/leave-calendar", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(
      /\/dashboard(\/leave-calendar)?(\?|$|\/)/
    );
    // The PENDING legend swatch is unique to this page — its absence is a
    // strong negative signal that the role-gated null kicked in.
    await expect(
      page.locator("text=/PENDING \\(awaiting approval\\)/i")
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^today$/i })
    ).toHaveCount(0);
  });

  test("PATIENT bounces — same gate. Patients have no business knowing staff leave schedules", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/leave-calendar", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(
      /\/dashboard(\/leave-calendar)?(\?|$|\/)/
    );
    await expect(
      page.getByRole("button", { name: /^today$/i })
    ).toHaveCount(0);
    await expect(
      page.locator("text=/PENDING \\(awaiting approval\\)/i")
    ).toHaveCount(0);
  });
});
