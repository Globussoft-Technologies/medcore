import { expect, test } from "@playwright/test";

/**
 * Public marketing pages — smoke + SEO health.
 *
 * Coverage protected here:
 *   1. Each of the 6 marketing routes returns HTTP 200 (no 5xx blow-ups
 *      from a missing env var or a rendering crash).
 *   2. The rendered body contains the literal "MedCore" — every page in
 *      this section ships the marketing nav and footer, both of which
 *      embed the brand string. A missing match means the layout itself
 *      failed to render, which bypasses the 200-status check.
 *   3. Zero browser console errors (network 4xx/5xx are tolerated because
 *      a marketing page may legitimately point at signed-out images, but
 *      a JS error will fail the test).
 *   4. A non-empty <title> tag is present — minimum SEO floor for the
 *      marketing site. Each page sets its own metadata.title in the
 *      Next.js segment so Google's crawler renders a useful SERP snippet.
 *
 * No auth fixtures here — these are public pages and we use the bare
 * Playwright `test` so a single browser context covers the lot.
 */

const MARKETING_PAGES: Array<{ path: string; label: string }> = [
  { path: "/", label: "home" },
  { path: "/about", label: "about" },
  { path: "/contact", label: "contact" },
  { path: "/features", label: "features" },
  { path: "/pricing", label: "pricing" },
  { path: "/solutions", label: "solutions" },
];

test.describe("Marketing pages don't 500", () => {
  for (const { path, label } of MARKETING_PAGES) {
    test(`${label} (${path}) returns 200, embeds MedCore, has a title, no console errors`, async ({
      page,
    }) => {
      // Collect JS console errors. Network errors and CSP warnings get
      // surfaced as `pageerror` and `console error` respectively — we treat
      // only true `error` console calls as fatal.
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          // Filter out third-party noise that's known to be harmless on
          // Next.js marketing pages (favicon 404, hydration warning under
          // dev). The list is intentionally short — anything else is a
          // genuine regression we want to catch.
          const text = msg.text();
          if (/favicon|net::ERR_FAILED.*favicon/i.test(text)) return;
          consoleErrors.push(text);
        }
      });
      page.on("pageerror", (err) => {
        consoleErrors.push(`pageerror: ${err.message}`);
      });

      const response = await page.goto(path, {
        waitUntil: "domcontentloaded",
      });
      expect(
        response?.status(),
        `${path} HTTP status`
      ).toBe(200);

      // "MedCore" must appear somewhere on the rendered body — every
      // marketing page reuses the shared navbar and footer that embed
      // the brand. A missing match means the layout crashed and the
      // 200 was a static error fallback.
      await expect(page.locator("body")).toContainText(/MedCore/i, {
        timeout: 15_000,
      });

      // Title tag must be non-empty for SEO. Next.js merges
      // segment-level `metadata.title` into the document <title>.
      const title = await page.title();
      expect(title.trim().length, `${path} <title> length`).toBeGreaterThan(0);

      // Give the page a tick to fire any async hydration errors before
      // we assert the console is clean.
      await page.waitForTimeout(500);
      expect(
        consoleErrors,
        `${path} console errors:\n${consoleErrors.join("\n")}`
      ).toHaveLength(0);
    });
  }
});
