import { test, expect } from "./fixtures";
import { loginAs } from "./helpers";

test.describe("Cross-cutting UX", () => {
  test("keyboard shortcut ? opens help modal", async ({ adminPage }) => {
    const page = adminPage;
    await page.goto("/dashboard");

    // Press Shift+/ (which produces "?") — some layouts use plain "?" too.
    await page.keyboard.press("Shift+/");

    // The modal should render a heading containing "shortcuts" (matches KeyboardShortcutsModal).
    const modalHeading = page.getByRole("heading", {
      name: /shortcut|help/i,
    });
    await expect(modalHeading.first()).toBeVisible({ timeout: 5_000 });
  });

  test("mobile sidebar drawer opens on narrow viewport", async ({
    browser,
    request,
  }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await loginAs(page, request, "ADMIN");

    await page.goto("/dashboard");

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
