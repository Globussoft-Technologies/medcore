import { defineConfig, devices } from "@playwright/test";

/**
 * MedCore E2E Playwright config.
 * - Runs against local dev servers by default (web :3000, api :4000).
 * - Override the base URL with E2E_BASE_URL (e.g. production smoke).
 * - Override the API URL with E2E_API_URL.
 *
 * Test tiers (Playwright projects):
 *   - `smoke`           — fast canary (auth + cross-cutting +
 *                         quick-actions).
 *                         Run: `npx playwright test --project=smoke`.
 *   - `regression`      — smoke + the seven role flows.
 *                         Run: `npx playwright test --project=regression`.
 *   - `full`            — every spec in `e2e/`, on Chromium. This is
 *                         what `release.yml` runs.
 *                         Run: `npx playwright test --project=full`.
 *   - `full-webkit`     — same testMatch as `full` but executed on
 *                         WebKit (Safari engine). Catches Safari-only
 *                         bugs that Chromium misses (date parsing,
 *                         IndexedDB quirks, CSS rendering). Slower
 *                         than Chromium on Linux; release.yml runs
 *                         it in parallel with `full` so the wall-clock
 *                         hit is bounded.
 *                         Run: `npx playwright test --project=full-webkit`.
 *                         CI hardening Phase 3.4.
 *
 * IMPORTANT: every CI job MUST pass an explicit `--project=` flag.
 * Running `npx playwright test` with no flag would otherwise execute
 * every project, re-running shared specs once per project.
 *
 * Per-spec invocations (`npx playwright test e2e/rbac-matrix.spec.ts`)
 * still work because the explicit file path narrows the run before
 * Playwright applies the project's `testMatch`.
 */
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

const SMOKE_FILES = [
  "auth.spec.ts",
  "cross-cutting.spec.ts",
  "quick-actions.spec.ts",
];

const REGRESSION_FILES = [
  ...SMOKE_FILES,
  "doctor.spec.ts",
  "nurse.spec.ts",
  "reception.spec.ts",
  "patient.spec.ts",
  // Lab-tech / pharmacist specs land in a follow-up PR; the matcher
  // tolerates their absence today and picks them up automatically once
  // they exist.
  "lab-tech.spec.ts",
  "pharmacist.spec.ts",
];

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
      name: "smoke",
      use: { ...devices["Desktop Chrome"] },
      testMatch: SMOKE_FILES.map((f) => `**/${f}`),
    },
    {
      name: "regression",
      use: { ...devices["Desktop Chrome"] },
      testMatch: REGRESSION_FILES.map((f) => `**/${f}`),
    },
    {
      name: "full",
      use: { ...devices["Desktop Chrome"] },
      // Everything in e2e/ — this is what release.yml runs.
      testMatch: "**/*.spec.ts",
    },
    {
      name: "full-webkit",
      use: { ...devices["Desktop Safari"] },
      // Same set as `full`, on WebKit. Cross-browser coverage for the
      // release-validation gate.
      testMatch: "**/*.spec.ts",
    },
  ],
});
