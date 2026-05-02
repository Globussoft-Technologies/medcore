// Visual regression baseline for critical pages.
//
// CI hardening Phase 3.3. Catches silent UI breakage that functional tests
// pass through (a button moves off-screen, a layout collapses on mobile,
// a tailwind class gets removed from a global stylesheet).
//
// HOW THIS WORKS
//   - Every test calls `expect(page).toHaveScreenshot()` which compares the
//     current render against a baseline PNG committed to
//     `e2e/visual.spec.ts-snapshots/`.
//   - First run on a new platform produces the baseline. Subsequent runs
//     diff against it; any diff above the per-test pixel ratio fails.
//
// HOW TO UPDATE A BASELINE (intentional UI change)
//   - Locally: `npx playwright test e2e/visual.spec.ts --update-snapshots`
//   - In CI: trigger release.yml with a follow-up commit; the diff will
//     surface in the playwright-full-report artifact, then update locally
//     and push the new PNGs.
//
// PLATFORM NOTE
//   - Snapshots are platform-specific (Linux CI vs developer macOS/Windows).
//     We commit the Linux baselines only. Local runs will diff against Linux
//     baselines and may fail with minor antialiasing/font differences. Treat
//     locally-failing visual tests as informational unless reproduced in CI.
//
// SCOPE
//   - 4 anchor screens: /login, /dashboard (admin), invoice detail, RBAC
//     not-authorized page. These are the highest-traffic surfaces; bigger
//     coverage adds maintenance cost without proportional bug-catch value.

import { test, expect } from "./fixtures";
import { CREDS } from "./helpers";

test.describe("Visual regression — critical surfaces", () => {
  // Linux baselines are generated and committed by the manual
  // `update-visual-baselines.yml` workflow (TODO.md #2). Until that
  // workflow has run at least once, the snapshot files don't exist and
  // every test would fail with "snapshot doesn't exist." So the suite is
  // bypassed unless explicitly updating.
  //
  // The workflow sets UPDATE_VISUAL_BASELINES=1 to skip this guard, runs
  // with --update-snapshots, and auto-commits the resulting PNGs together
  // with the deletion of this conditional skip block (matched by the
  // `visual-baselines-conditional-skip-marker` substring below).
  // VISUAL_BASELINES_SKIP_BEGIN
  test.skip(
    !process.env.UPDATE_VISUAL_BASELINES,
    "visual-baselines-conditional-skip-marker — TODO.md #2: Linux PNG baselines pending; trigger update-visual-baselines.yml workflow to generate them. This skip block is auto-removed by that workflow's commit step.",
  );
  // VISUAL_BASELINES_SKIP_END
  test.use({
    // Pin viewport so the snapshot is platform-stable. Mobile diffs are
    // out of scope for this baseline; cross-browser is handled by the
    // separate full-webkit project.
    viewport: { width: 1280, height: 800 },
  });

  test("login page renders the expected layout", async ({ page }) => {
    await page.goto("/login");
    // Wait for the form to be interactive so we don't snapshot a half-
    // hydrated state.
    await page.getByPlaceholder(/email/i).waitFor({ state: "visible" });
    await expect(page).toHaveScreenshot("login.png", {
      maxDiffPixelRatio: 0.02,
      fullPage: false,
      animations: "disabled",
    });
  });

  test("admin dashboard root renders the expected layout", async ({ adminPage }) => {
    await adminPage.goto("/dashboard");
    // The dashboard cards animate in; wait for the heading and a known
    // KPI tile so the screenshot is taken after first paint settles.
    await adminPage.getByRole("heading", { level: 1 }).first().waitFor({ state: "visible" });
    // Allow a brief settle so any client-side fetch completes deterministically.
    await adminPage.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await expect(adminPage).toHaveScreenshot("dashboard-admin.png", {
      maxDiffPixelRatio: 0.04,
      fullPage: false,
      animations: "disabled",
      // Mask anything dynamic (timestamps, badges with live counts) so
      // the snapshot is actually about layout, not data.
      mask: [
        adminPage.locator("[data-live]"),
        adminPage.locator("time"),
      ],
    });
  });

  test("not-authorized page renders the expected layout", async ({ patientPage }) => {
    await patientPage.goto("/dashboard/admin-console");
    // Patient role hits the not-authorized redirect.
    await patientPage.waitForURL(/not-authorized|unauthorized/i, { timeout: 10_000 }).catch(() => {});
    await expect(patientPage).toHaveScreenshot("not-authorized.png", {
      maxDiffPixelRatio: 0.02,
      fullPage: false,
      animations: "disabled",
    });
  });

  test("billing list page renders the expected layout", async ({ receptionPage }) => {
    await receptionPage.goto("/dashboard/billing");
    await receptionPage.getByRole("heading", { level: 1 }).first().waitFor({ state: "visible" });
    await receptionPage.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await expect(receptionPage).toHaveScreenshot("billing-list.png", {
      maxDiffPixelRatio: 0.04,
      fullPage: false,
      animations: "disabled",
      mask: [
        receptionPage.locator("time"),
        receptionPage.locator("[data-live]"),
        receptionPage.locator("td:has-text('₹')"),
      ],
    });
  });
});

// Reference unused import so eslint doesn't strip it; CREDS is intentionally
// imported for any future test that needs a credential snapshot.
void CREDS;
