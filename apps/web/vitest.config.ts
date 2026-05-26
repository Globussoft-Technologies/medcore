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
        // Ratcheted 2026-05-26 by the test-cron after colocated coverage spec
        // landed (apps/web/src/app/dashboard/appointments/__tests__/page.test.tsx).
        // Combined with the older suite at apps/web/src/app/dashboard/__tests__/
        // appointments.page.test.tsx the file now sits at lines 83.33%, branches
        // 78.96%, functions 65%, statements 83.33%. Floors set to
        // Math.floor(actual - 2pp). Raise as coverage grows; never lower.
        "src/app/dashboard/appointments/page.tsx": {
          lines: 81,
          branches: 76,
          functions: 63,
          statements: 81,
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
        // 2026-05-26 (test-cron pick): brand-new colocated suite covers the
        // IPD admission detail surface (40 tests across 7 sub-tabs + modals).
        // Single-file --coverage measured 88.27/73.03/69.29 (lines/branches/
        // funcs). Floors set 2pp below the measured numbers per convention.
        // Uncovered remainder is the discharge-readiness "blocked + force"
        // branch, the MedReconciliation full save flow, the trauma-shaped
        // Discharged status pill, and a handful of transitional toasts.
        "src/app/dashboard/admissions/[id]/page.tsx": {
          lines: 86,
          branches: 71,
          functions: 67,
          statements: 86,
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
        // 2026-05-26 (test-cron pick): new __tests__/use-dialog.test.tsx
        // exercises the DialogProvider + useConfirm/usePrompt imperative
        // hook surface (10 tests). Single-file coverage measured:
        // 100% lines / 90.69% branches / 100% funcs / 100% statements.
        // Floors set 2pp below measured (branches floored to 88).
        "src/lib/use-dialog.tsx": {
          lines: 98,
          branches: 88,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): companion test file
        // (OnboardingTour.test.tsx) lands navigation / Esc / click-outside /
        // open-close lifecycle / role fallback coverage on top of the
        // existing OnboardingTour.skip.test.tsx (Issue #122 + #502 flags).
        // Combined single-file coverage measures 100% lines / 83.63%
        // branches / 100% funcs / 100% statements. Floors set 2pp below.
        "src/components/OnboardingTour.tsx": {
          lines: 98,
          branches: 81,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // marketing About page (24 tests) complements the sibling
        // src/app/(marketing)/__tests__/about.page.test.tsx suite. Combined
        // single-file coverage: 93.36% lines / 80% branches / 50% funcs /
        // 93.36% statements. Uncovered remainder is the getInitials() helper
        // + the fallback-avatar branch (no-image team member) — both
        // unreachable via the production team data (all 3 members have
        // images). Floors set 2pp below measured.
        "src/app/(marketing)/about/page.tsx": {
          lines: 91,
          branches: 78,
          functions: 48,
          statements: 91,
        },
        // 2026-05-26 (test-cron pick): companion suite
        // (BulkEditDoctorsModal.test.tsx, 30 tests) joins the existing
        // sibling bulk-edit-modal.test.tsx (4 tests) to cover the Pearl
        // ERP §3.1 bulk-edit modal. Combined single-file coverage measures
        // 100% lines / 100% branches / 100% funcs / 100% statements.
        // Floors set 2pp below measured (branches floored to 98 to leave
        // a smidge of headroom for future refactors).
        "src/app/dashboard/doctors/BulkEditDoctorsModal.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // marketing "Request a Demo" EnquiryForm (11 tests covering render,
        // client-side schema rejection per field, happy POST, NEXT_PUBLIC_API_URL
        // override, structured 400 server errors, generic-error fallback,
        // network failure, and in-flight submitting state). Single-file
        // coverage: 100% lines / 94.82% branches / 100% funcs / 100% statements.
        // Floors set 2pp below measured.
        "src/app/(marketing)/contact/EnquiryForm.tsx": {
          lines: 98,
          branches: 92,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // marketing footer (15 tests covering smoke render, both brand logos,
        // all four nav-column headings + every link href, social aria-labels +
        // svg structure, and the dynamic copyright year via a pinned Date
        // spy). Single-file coverage measured: 100% lines / 100% branches /
        // 100% funcs / 100% statements. Floors set 2pp below measured per
        // convention (small headroom for future refactors).
        "src/app/(marketing)/_components/MarketingFooter.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // marketing top nav (20 tests covering smoke render, brand-logo home
        // link wiring, all five desktop nav-link hrefs, login + demo CTAs,
        // mobile-menu toggle open/close lifecycle, drawer-link close-on-click
        // wiring, and a11y aria-label). Single-file coverage measured:
        // 100% lines / 100% branches / 100% funcs / 100% statements. Floors
        // set 2pp below measured per convention (small headroom for future
        // refactors).
        "src/app/(marketing)/_components/MarketingNav.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // global 404 page (src/app/__tests__/not-found.test.tsx, 8 tests
        // across anon + authed branches + the router.back/push fallback for
        // empty history). Single-file coverage measured: 100% lines /
        // 100% branches / 100% funcs / 100% statements. Floors set 2pp
        // below measured per convention.
        "src/app/not-found.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // global Cmd+K search palette
        // (apps/web/src/app/dashboard/_components/__tests__/search-palette.test.tsx,
        // 23 tests). Single-file coverage measured: 98.46% lines / 93.25%
        // branches / 90.90% funcs / 98.46% statements. Uncovered remainder
        // is the localStorage try/catch fallback branches (lines 78, 85-86,
        // 99) which only fire when the browser quota is exhausted or
        // private-browsing flips the API off — would require monkey-patching
        // the localStorage prototype in jsdom to exercise. Floors set 2pp
        // below measured.
        "src/app/dashboard/_components/search-palette.tsx": {
          lines: 96,
          branches: 91,
          functions: 88,
          statements: 96,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // shared TablePagination footer (apps/web/src/components/__tests__/
        // TablePagination.test.tsx, 22 tests). Single-file coverage measured:
        // 100% lines / 100% branches / 100% funcs / 100% statements. Floors
        // set 2pp below measured (branches floored to 98 to leave a smidge
        // of headroom for future refactors).
        "src/components/TablePagination.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
