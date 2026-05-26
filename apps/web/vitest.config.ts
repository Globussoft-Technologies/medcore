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
        "src/app/dashboard/ambulance/page.tsx": {
          lines: 98,
          branches: 94,
          functions: 96,
          statements: 98,
        },
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
        "src/app/dashboard/billing/page.tsx": {
          lines: 97,
          branches: 82,
          functions: 81,
          statements: 97,
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
        "src/app/dashboard/patients/page.tsx": {
          lines: 99,
          branches: 90,
          functions: 91,
          statements: 99,
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
        "src/app/dashboard/surgery/[id]/page.tsx": {
          lines: 99,
          branches: 82,
          functions: 83,
          statements: 99,
        },
        "src/app/dashboard/emergency/page.tsx": {
          lines: 95,
          branches: 83,
          functions: 82,
          statements: 95,
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
        "src/app/dashboard/lab/[orderId]/page.tsx": {
          lines: 98,
          branches: 81,
          functions: 81,
          statements: 98,
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
        "src/app/dashboard/antenatal/[id]/page.tsx": {
          lines: 93,
          branches: 83,
          functions: 71,
          statements: 93,
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
        "src/app/dashboard/analytics/page.tsx": {
          lines: 91,
          branches: 65,
          functions: 77,
          statements: 91,
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
        "src/app/dashboard/users/page.tsx": {
          lines: 99,
          branches: 90,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/wards/page.tsx": {
          lines: 100,
          branches: 97,
          functions: 96,
          statements: 100,
        },
        "src/app/dashboard/vitals/page.tsx": {
          lines: 99,
          branches: 97,
          functions: 100,
          statements: 99,
        },
        "src/app/dashboard/telemedicine/page.tsx": {
          lines: 97,
          branches: 85,
          functions: 86,
          statements: 97,
        },
        "src/app/dashboard/payment-plans/page.tsx": {
          lines: 100,
          branches: 98,
          functions: 88,
          statements: 100,
        },
        "src/app/dashboard/agent-console/page.tsx": {
          lines: 97,
          branches: 84,
          functions: 100,
          statements: 97,
        },
        "src/app/dashboard/assets/page.tsx": {
          lines: 98,
          branches: 91,
          functions: 78,
          statements: 98,
        },
        "src/app/dashboard/reports/page.tsx": {
          lines: 98,
          branches: 75,
          functions: 90,
          statements: 98,
        },
        "src/app/dashboard/admin-console/page.tsx": {
          lines: 96,
          branches: 79,
          functions: 98,
          statements: 96,
        },
        "src/app/dashboard/suppliers/page.tsx": {
          lines: 99,
          branches: 88,
          functions: 86,
          statements: 99,
        },
        "src/app/dashboard/surgery/page.tsx": {
          lines: 98,
          branches: 93,
          functions: 88,
          statements: 98,
        },
        "src/app/dashboard/ai-booking/page.tsx": {
          lines: 94,
          branches: 81,
          functions: 87,
          statements: 94,
        },
        "src/app/dashboard/pharmacy/page.tsx": {
          lines: 98,
          branches: 90,
          functions: 88,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): brand-new colocated suite covers the
        // Rx queue + writer surface (44 tests). Uncovered remainder is the
        // SignaturePad canvas component (jsdom lacks getContext) and the
        // RenalDoseModal sub-modal. Floor set 2pp below measured.
        "src/app/dashboard/prescriptions/page.tsx": {
          lines: 76,
          branches: 71,
          functions: 66,
          statements: 76,
        },
        "src/app/dashboard/bloodbank/page.tsx": {
          lines: 93,
          branches: 84,
          functions: 67,
          statements: 93,
        },
        "src/app/dashboard/settings/page.tsx": {
          lines: 94,
          branches: 79,
          functions: 78,
          statements: 94,
        },
        "src/app/dashboard/tenants/[id]/onboarding/page.tsx": {
          lines: 100,
          branches: 88,
          functions: 100,
          statements: 100,
        },
        // 2026-05-26 (test-cron pick): brand-new colocated suite for the
        // super-admin platform-billing invoice detail page (19 tests).
        // Single-file coverage: 98.33% lines / 88.88% branches / 100% funcs.
        // Floors set 2pp below measured.
        "src/app/super-admin/platform-billing/invoices/[id]/page.tsx": {
          lines: 96,
          branches: 86,
          functions: 98,
          statements: 96,
        },
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
