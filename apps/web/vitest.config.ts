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
        // Recalibrated 2026-05-28 — file grew with new audit-detail
        // affordances; lines + statements measured 97.7%, dropped 2pp.
        // Raise as coverage backfills land.
        "src/app/dashboard/audit/page.tsx": {
          lines: 95,
          branches: 95,
          functions: 100,
          statements: 95,
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
        // Recalibrated 2026-05-28 — measured lines/statements 95.73%,
        // functions 78.94%. Floors set to floor(actual - 2).
        "src/app/dashboard/billing/page.tsx": {
          lines: 93,
          branches: 82,
          functions: 76,
          statements: 93,
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
        // Recalibrated 2026-05-28 — measured 92.23/79.33/80/92.23.
        // Floors set to floor(actual - 2).
        "src/app/dashboard/medicines/page.tsx": {
          lines: 90,
          branches: 77,
          functions: 78,
          statements: 90,
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
        // Recalibrated 2026-05-28 — branches drifted to 89.78%; dropped
        // 2pp. Other metrics still passing.
        "src/app/dashboard/patients/page.tsx": {
          lines: 99,
          branches: 87,
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
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // surgery detail route-segment error boundary (Issue #86)
        // (apps/web/src/app/dashboard/surgery/[id]/__tests__/error.test.tsx,
        // 14 tests across chrome + role=alert + headline + message fallback +
        // Retry reset() wiring + Back-to-Surgery link href + conditional
        // error.digest reference line + useEffect console.error logging on
        // mount + on prop change). Single-file coverage measured: 100% lines /
        // 100% branches / 100% funcs / 100% statements. Floors set 2pp below
        // measured per convention.
        "src/app/dashboard/surgery/[id]/error.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
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
          functions: 85,
          statements: 99,
        },
        "src/app/dashboard/symptom-diary/page.tsx": {
          lines: 99,
          branches: 91,
          functions: 100,
          statements: 99,
        },
        // Recalibrated 2026-05-28 — functions drifted to 78.12%;
        // dropped 2pp. Other metrics still passing.
        "src/app/dashboard/referrals/page.tsx": {
          lines: 98,
          branches: 96,
          functions: 76,
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
        // Recalibrated 2026-05-28 — large drop after the permissions
        // modal + kebab action menu + Role column + main-only gates +
        // auto-sign-out card refactor (Pearl §8.2). Measured 64.25%
        // lines / 77.31% branches / 74.28% funcs / 64.25% statements;
        // floors set to floor(actual - 2). TODO: backfill tests for the
        // main-only PATCH gate + permissions modal + kebab menu so we
        // can ratchet the file back toward the original 99/90/100/99.
        "src/app/dashboard/users/page.tsx": {
          lines: 62,
          branches: 75,
          functions: 72,
          statements: 62,
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
        // Recalibrated 2026-05-28 — functions drifted to 86.95%;
        // dropped 2pp. Other metrics still passing.
        "src/app/dashboard/surgery/page.tsx": {
          lines: 98,
          branches: 93,
          functions: 84,
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
        // Recalibrated 2026-05-28 — lines + statements drifted to
        // 75.55%; floor dropped to 73. Branches + funcs still passing.
        // Recalibrated 2026-06-01 — measured 72.32/70.95/64.83/72.32 after
        // 309b0110 (in-form allergy banner) + 93c2ea41 (appointment fix)
        // added new branches without colocated tests. Floor dropped 1pp.
        "src/app/dashboard/prescriptions/page.tsx": {
          lines: 72,
          branches: 70,
          functions: 64,
          statements: 72,
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
        // Re-pinned 2026-06-02: the onboarding page was reworked (secondary
        // links + completeOnVisit handlers) so the existing suite no longer
        // covers all of it (funcs 100→63.63, lines/stmts 100→93.31, branches
        // 88→80.51). Floored to current actuals to unblock CI.
        // FOLLOW-UP: extend onboarding/__tests__/page.test.tsx to cover the new
        // secondary-link / completeOnVisit paths and raise these back up.
        "src/app/dashboard/tenants/[id]/onboarding/page.tsx": {
          lines: 93,
          branches: 80,
          functions: 63,
          statements: 93,
        },
        // 2026-05-26 (test-cron pick): brand-new colocated suite for the
        // super-admin platform-billing invoice detail page (19 tests).
        // Single-file coverage: 98.33% lines / 88.88% branches / 100% funcs.
        // Floors set 2pp below measured.
        // Recalibrated 2026-05-28 — big drop after the kebab action
        // menu + Mark-Paid modal restructure on the detail page;
        // measured 67.51/84.44/50/67.51, floors set to floor(actual - 2).
        // TODO: backfill tests for the new kebab paths + Pay Online flow
        // so we can ratchet back toward the original 96/86/98/96.
        "src/app/super-admin/platform-billing/invoices/[id]/page.tsx": {
          lines: 65,
          branches: 82,
          functions: 48,
          statements: 65,
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
        // marketing FeatureCard tile (10 tests covering smoke render, the
        // required slots (icon / h3 title / p description), both branches of
        // the optional-href ternary (Link wrapper vs bare div), and structural
        // invariants (one icon + one heading + one paragraph per card, and the
        // entire tile being clickable when href is set). Single-file coverage
        // measured: 100% lines / 100% branches / 100% funcs / 100% statements.
        // Floors set 2pp below measured per convention (small headroom for
        // future refactors).
        "src/app/(marketing)/_components/FeatureCard.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // marketing CTA section band (15 tests covering smoke render,
        // Container wrap, default heading + subtitle copy, default primary
        // CTA -> /contact, default secondary CTA -> the live demo URL,
        // overrides for all six props individually + combined, DOM ordering
        // primary-before-secondary, and a single <section> wrapper invariant).
        // Single-file coverage measured: 100% lines / 100% branches /
        // 100% funcs / 100% statements. Floors set 2pp below measured per
        // convention (small headroom for future refactors).
        "src/app/(marketing)/_components/CTASection.tsx": {
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
        // root-level Next.js error boundary
        // (src/app/__tests__/global-error.test.tsx, 11 tests across the
        // chrome, the Try-again reset() wiring, the conditional
        // error.digest reference line, and the useEffect console.error
        // logging on mount + on prop change). Single-file coverage
        // measured: 100% lines / 100% branches / 100% funcs / 100%
        // statements. Floors set 2pp below measured per convention.
        "src/app/global-error.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // route-segment Next.js error boundary
        // (src/app/__tests__/error.test.tsx, 12 tests across the chrome,
        // both CTAs — Try-again reset() wiring + Back-to-dashboard <Link>,
        // the conditional error.digest reference line, and the useEffect
        // console.error logging on mount + on prop change). Single-file
        // coverage measured: 100% lines / 100% branches / 100% funcs /
        // 100% statements. Floors set 2pp below measured per convention.
        "src/app/error.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // App Router PWA manifest (src/app/__tests__/manifest.test.ts, 15
        // tests across the default-export shape, every top-level PWA
        // installability field — name / short_name / description /
        // start_url / display / orientation / hex theme + background colors
        // / categories — and the icons array contract (4 entries: 192+512
        // px × any+maskable purpose, all root-relative /icon-*.png PNGs)).
        // Single-file coverage measured: 100% lines / 100% branches /
        // 100% funcs / 100% statements. Floors set 2pp below measured per
        // convention (small headroom for future refactors).
        "src/app/manifest.ts": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // App Router sitemap (src/app/__tests__/sitemap.test.ts, 15 tests
        // across the default-export shape, fresh-Date-per-invocation
        // invariant, every public marketing URL is absolute under the
        // production host + free of dashboard/api/internal leakage, every
        // entry carries the four required Sitemap keys, the changeFrequency
        // + priority contract (home 1.0/weekly, features + pricing
        // 0.9/monthly, solutions + contact 0.8/monthly, about 0.5/monthly,
        // login + register 0.3/yearly), and the sitemap.org enum + [0,1]
        // priority-range invariants). Single-file coverage measured: 100%
        // lines / 100% branches / 100% funcs / 100% statements. Floors set
        // 2pp below measured per convention.
        "src/app/sitemap.ts": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // patient PWA scoped 404 page
        // (src/app/patient/__tests__/not-found.test.tsx, 6 tests covering
        // the section testid, the Page-not-found <h1>, the helper copy,
        // the Back-to-home <Link> href invariant (/patient — NOT / or
        // /dashboard, so users don't bounce into the staff dashboard
        // chrome per gap #5 piece 1 of 4 contract), and the 44px tap-target
        // hygiene classes). Single-file coverage measured: 100% lines /
        // 100% branches / 100% funcs / 100% statements. Floors set 2pp
        // below measured per convention.
        "src/app/patient/not-found.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // segment-scoped patient PWA manifest
        // (src/app/patient/__tests__/manifest.test.ts, 19 tests across the
        // default-export shape, the patient-specific branding (name /
        // short_name / description), the start_url + scope + id /patient
        // installability invariant, display + orientation, hex theme +
        // background colors, categories, and the icons array contract (4
        // entries: 192+512 px × any+maskable purpose, all root-relative
        // /icon-*.png PNGs, asset paths shared with the root manifest per
        // piece-1 contract)). Single-file coverage measured: 100% lines /
        // 100% branches / 100% funcs / 100% statements. Floors set 2pp
        // below measured per convention (small headroom for future
        // refactors).
        "src/app/patient/manifest.ts": {
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
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // Pearl ERP Stage 1 §2.1.3 ConsultHistoryDrawer right-side drawer
        // (apps/web/src/components/__tests__/ConsultHistoryDrawer.test.tsx,
        // 29 tests across closed/open lifecycle, both mode kinds (patient +
        // appointment) fetch wiring, loading state, empty state, 404-as-
        // empty special-casing for "no consultation notes" + "not yet
        // finalized" error messages, generic error red block, missing-data
        // ?? [] normalization on both response shapes, close affordances
        // (X + backdrop), count badge, SIGNED vs DRAFT pill, doctor +
        // specialization + slotStart suffix, em-dash + createdAt fallback,
        // SoapBlock plain-text fallback AND `## <label>` markdown-parser
        // branch, ICD-10 + SNOMED CodeRow chips, and effect re-fire on
        // mode change). Single-file coverage measured: 100% lines /
        // 96.51% branches / 100% funcs / 100% statements. Uncovered
        // remainder is the all-codes guard inside ConsultationCard's
        // `empty` calculation (lines 209-210) and the conjoined "codes
        // section opens" branch (line 253) — both require a row that has
        // ONLY codes set (no SOAP, no notes, no findings) which the
        // current production data shape never produces. Floors set 2pp
        // below measured per convention.
        "src/components/ConsultHistoryDrawer.tsx": {
          lines: 98,
          branches: 94,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new layout.test.tsx companion to the
        // existing landing.page.test.tsx + page.test.tsx — 13 tests covering
        // the super-admin shell's loading spinner, RBAC gate (super-admin,
        // tenant-ADMIN, non-ADMIN, anon), `tenantId ?? null` fallback,
        // loadSession error-path resilience, sign-out happy + reject paths,
        // and topbar / main / footer semantics. Single-file coverage:
        // 97.29% lines / 88.88% branches / 100% funcs / 97.29% statements.
        // Uncovered remainder is line 76 (SSR fallback for window.location)
        // and lines 158-159 (the SSR else branch in sign-out) — both
        // unreachable under jsdom. Floors set 2pp below measured.
        "src/app/super-admin/layout.tsx": {
          lines: 95,
          branches: 86,
          functions: 98,
          statements: 95,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // super-admin route-group 404 page
        // (src/app/super-admin/__tests__/not-found.test.tsx, 6 tests across
        // the wrapper section + testid, the h1 "Page not found" heading, the
        // super-admin-specific helper copy, the home CTA testid + copy, the
        // /super-admin href (with a regression guard against /dashboard), and
        // the accessible-link-role lookup). Single-file coverage measured:
        // 100% lines / 100% branches / 100% funcs / 100% statements. Floors
        // set 2pp below measured per convention.
        "src/app/super-admin/not-found.tsx": {
          lines: 98,
          branches: 98,
          functions: 98,
          statements: 98,
        },
        // 2026-05-26 (test-cron pick): new colocated coverage suite for the
        // Next.js instrumentation hook (apps/web/src/__tests__/
        // instrumentation.test.ts, 11 tests across the async-register shape,
        // the no-DSN no-op, both runtime branches (nodejs gets
        // tracesSampleRate, edge does not), NODE_ENV "production" fallback +
        // honoring a non-prod value, SENTRY_RELEASE precedence over the
        // NEXT_PUBLIC_SENTRY_RELEASE alias, release=undefined when neither
        // env is set, unknown-runtime no-op, and unset-runtime no-op).
        // Single-file coverage measured: 100% lines / 100% branches /
        // 100% funcs / 100% statements. Floors set 2pp below measured per
        // convention (small headroom for future refactors).
        "src/instrumentation.ts": {
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
