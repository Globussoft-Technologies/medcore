import { defineConfig, devices } from "@playwright/test";

/**
 * MedCore E2E Playwright config.
 * - Runs against local dev servers by default (web :3000, api :4000).
 * - Override the base URL with E2E_BASE_URL (e.g. production smoke).
 * - Override the API URL with E2E_API_URL.
 */
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // CI bumps: 1 retry to absorb transient login/redirect flake without
  // hiding real failures (a real bug fails twice in a row on the retry);
  // 2 workers because the full suite is otherwise too slow on the
  // release-validation gate. Local runs stay single-worker, no retries
  // so flake is visible during dev.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
