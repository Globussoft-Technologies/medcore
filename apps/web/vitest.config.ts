import { defineConfig } from "vitest/config";
import path from "path";

const here = __dirname.replace(/\\/g, "/");

export default defineConfig({
  root: here,
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    setupFiles: [here + "/src/test/setup.ts"],
    globals: true,
    include: [here + "/src/**/*.test.ts", here + "/src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/test/**",
        "**/.next/**",
        "**/dist/**",
      ],
      // Bumped 2026-05-02 from prior baseline. Source: per-push run 25257723834 lcov
      // (web actual: lines 53.78%, branches 67.00%, functions 33.43%). Floors set to
      // Math.floor(actual - 2pp). Raise these as coverage grows; never lower without discussion.
      thresholds: {
        lines: 51,
        branches: 65,
        functions: 31,
        statements: 51,
        // Per-file ratchets — lock in well-covered files so future refactors
        // can't silently regress them. Source: single-file --coverage runs.
        // Format: glob path → {lines, branches, functions, statements}.
        "src/app/dashboard/audit/page.tsx": {
          lines: 99,
          branches: 95,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/ot/page.tsx": {
          lines: 99,
          branches: 90,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/budgets/page.tsx": {
          lines: 99,
          branches: 96,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/billing/patient/[patientId]/page.tsx": {
          lines: 99,
          branches: 95,
          functions: 94,
          statements: 99,
        },
        "src/app/dashboard/purchase-orders/[id]/page.tsx": {
          lines: 99,
          branches: 93,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/purchase-orders/page.tsx": {
          lines: 99,
          branches: 97,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/sentiment/page.tsx": {
          lines: 97,
          branches: 90,
          functions: 100,
          statements: 97,
        },
        "src/app/dashboard/ai-kpis/page.tsx": {
          lines: 99,
          branches: 97,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/profile/page.tsx": {
          lines: 98,
          branches: 87,
          functions: 100,
          statements: 98,
        },
        "src/app/dashboard/er-triage/page.tsx": {
          lines: 99,
          branches: 98,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/expenses/page.tsx": {
          lines: 99,
          branches: 91,
          functions: 95,
          statements: 99,
        },
        "src/app/dashboard/medicines/page.tsx": {
          lines: 99,
          branches: 84,
          functions: 90,
          statements: 99,
        },
        "src/app/dashboard/packages/page.tsx": {
          lines: 100,
          branches: 98,
          functions: 100,
          statements: 100,
        },
        "src/app/dashboard/payroll/page.tsx": {
          lines: 99,
          branches: 80,
          functions: 79,
          statements: 99,
        },
        "src/app/dashboard/walk-in/page.tsx": {
          lines: 98,
          branches: 94,
          functions: 100,
          statements: 98,
        },
        "src/app/dashboard/scheduled-reports/page.tsx": {
          lines: 100,
          branches: 95,
          functions: 95,
          statements: 100,
        },
        "src/app/dashboard/emergency/[id]/page.tsx": {
          lines: 99,
          branches: 95,
          functions: 92,
          statements: 99,
        },
        "src/app/dashboard/lab-intel/page.tsx": {
          lines: 97,
          branches: 90,
          functions: 100,
          statements: 97,
        },
        "src/app/dashboard/workspace/page.tsx": {
          lines: 100,
          branches: 92,
          functions: 100,
          statements: 100,
        },
        "src/app/dashboard/ai-letters/page.tsx": {
          lines: 100,
          branches: 100,
          functions: 93,
          statements: 100,
        },
        "src/app/dashboard/lab-explainer/page.tsx": {
          lines: 98,
          branches: 93,
          functions: 100,
          statements: 98,
        },
        "src/app/dashboard/notifications/page.tsx": {
          lines: 99,
          branches: 93,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/holidays/page.tsx": {
          lines: 100,
          branches: 93,
          functions: 100,
          statements: 100,
        },
        "src/app/dashboard/adherence/page.tsx": {
          lines: 100,
          branches: 95,
          functions: 93,
          statements: 100,
        },
        "src/app/dashboard/ai-analytics/page.tsx": {
          lines: 100,
          branches: 98,
          functions: 100,
          statements: 100,
        },
        "src/app/dashboard/lab/qc/page.tsx": {
          lines: 100,
          branches: 95,
          functions: 100,
          statements: 100,
        },
        "src/app/dashboard/ai/chart-search/page.tsx": {
          lines: 99,
          branches: 89,
          functions: 93,
          statements: 99,
        },
        "src/app/dashboard/schedule/page.tsx": {
          lines: 99,
          branches: 90,
          functions: 95,
          statements: 99,
        },
        "src/app/dashboard/chat/page.tsx": {
          lines: 98,
          branches: 86,
          functions: 94,
          statements: 98,
        },
        "src/app/dashboard/preauth/page.tsx": {
          lines: 100,
          branches: 99,
          functions: 96,
          statements: 100,
        },
        "src/app/dashboard/ai-fraud/page.tsx": {
          lines: 98,
          branches: 87,
          functions: 100,
          statements: 98,
        },
        "src/app/dashboard/antenatal/page.tsx": {
          lines: 100,
          branches: 98,
          functions: 96,
          statements: 100,
        },
        "src/app/dashboard/admissions/page.tsx": {
          lines: 97,
          branches: 91,
          functions: 90,
          statements: 97,
        },
        "src/app/dashboard/analytics/reports/page.tsx": {
          lines: 100,
          branches: 76,
          functions: 100,
          statements: 100,
        },
        "src/app/dashboard/duty-roster/page.tsx": {
          lines: 99,
          branches: 97,
          functions: 87,
          statements: 99,
        },
        "src/app/dashboard/symptom-diary/page.tsx": {
          lines: 99,
          branches: 91,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/referrals/page.tsx": {
          lines: 98,
          branches: 96,
          functions: 80,
          statements: 98,
        },
        "src/app/dashboard/doctors/[id]/page.tsx": {
          lines: 99,
          branches: 90,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/insurance/page.tsx": {
          lines: 99,
          branches: 96,
          functions: 88,
          statements: 99,
        },
        "src/app/dashboard/visitors/page.tsx": {
          lines: 89,
          branches: 87,
          functions: 74,
          statements: 89,
        },
        "src/app/dashboard/complaints/page.tsx": {
          lines: 99,
          branches: 88,
          functions: 100,
          statements: 99,
        },
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
