import { test, expect } from "./fixtures";
import { dismissTourIfPresent, loginAs } from "./helpers";

test.describe("Cross-cutting UX", () => {
  test("keyboard shortcut ? opens help modal", async ({ adminPage }) => {
    const page = adminPage;
    await page.goto("/dashboard");
    await dismissTourIfPresent(page);

    // Wait for the dashboard shell to be hydrated (MedCore sidebar heading)
    // before firing keyboard shortcuts.
    await expect(
      page.getByRole("heading", { name: /MedCore/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    // Ensure focus is on the document body (not inside an input) so the
    // global keydown listener catches the ? shortcut.
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);

    // Press Shift+/ (which produces "?") — some layouts use plain "?" too.
    await page.keyboard.press("Shift+/");

    // The modal should render a heading containing "shortcuts" (matches KeyboardShortcutsModal).
    const modalHeading = page.getByRole("heading", {
      name: /shortcut|help/i,
    });
    await expect(modalHeading.first()).toBeVisible({ timeout: 8_000 });
  });

  test("mobile sidebar drawer opens on narrow viewport", async ({
    browser,
    request,
  }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await loginAs(page, request, "ADMIN");

    await page.goto("/dashboard");
    await dismissTourIfPresent(page);

    // The "Open menu" button is only visible on narrow viewports.
    const menuBtn = page.getByRole("button", { name: /open menu/i });
    await expect(menuBtn).toBeVisible({ timeout: 10_000 });
    await menuBtn.click();

    // After opening, the sidebar nav becomes visible with its "Primary navigation" aria-label.
    await expect(
      page.locator('[aria-label="Primary navigation"]')
    ).toBeVisible();

    await ctx.close();
  });
});
