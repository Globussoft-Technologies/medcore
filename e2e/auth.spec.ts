import { test, expect } from "./fixtures";
import { CREDS } from "./helpers";

test.describe("Auth + public surface", () => {
  test("unauthenticated user gets redirected to login", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto("/dashboard");

    // Dashboard layout redirects to /login when no auth token is found.
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole("button", { name: /sign in|login/i })
    ).toBeVisible();

    await ctx.close();
  });

  test("login with admin credentials succeeds and lands on dashboard", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/login");

    await page.locator("#login-email").fill(CREDS.ADMIN.email);
    await page.locator("#login-password").fill(CREDS.ADMIN.password);
    await page.getByRole("button", { name: /sign in|login/i }).click();

    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    await expect(page.locator("text=MedCore").first()).toBeVisible();
    await expect(page.locator("text=ADMIN").first()).toBeVisible();

    await ctx.close();
  });

  test("invalid credentials show error toast", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/login");

    await page.locator("#login-email").fill("nobody@medcore.local");
    await page.locator("#login-password").fill("totallywrongpw");
    await page.getByRole("button", { name: /sign in|login/i }).click();

    // Either the inline alert role or a toast appears with error text.
    // Exclude Next.js's __next-route-announcer__ (also role=alert) which is
    // injected on every page and would match unconditionally.
    const alert = page
      .locator('[role="alert"]:not(#__next-route-announcer__)')
      .first();
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);

    await ctx.close();
  });
});
