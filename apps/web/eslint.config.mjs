// Flat ESLint config for the apps/web Next.js workspace.
//
// Why FlatCompat: ESLint 9 dropped legacy `.eslintrc.*` support; the
// canonical Next-shipped configs (`next/core-web-vitals`, `next/typescript`)
// are still authored in legacy "extends:" form, so we wrap them via
// FlatCompat to use them under flat config.
//
// Scope:
//   - Lints apps/web sources only.
//   - Mirrors what `next lint` resolved before this file existed (which was
//     "interactive setup wizard, exits 1 in CI" — see TODO.md priority #3).
//
// To run locally:   npm --prefix apps/web run lint
// To autofix:       npm --prefix apps/web run lint -- --fix

import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Don't lint generated / vendored output.
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  {
    // Pragmatic per-rule overrides for this codebase. Each has a comment
    // explaining the carve-out. Tighten these as the codebase modernizes.
    rules: {
      // The codebase uses `any` in a handful of well-trodden adapter spots
      // (Prisma 6 generated types' edges, third-party libs without types).
      // Surface as warnings during the cleanup; don't gate deploys on them
      // until the lint job is durably green and we've had a sweep PR.
      "@typescript-eslint/no-explicit-any": "warn",
      // We pass mock data through tests where unused-vars false-fire on
      // destructured-but-needed-for-shape shapes. Warn for now; tighten
      // post-cleanup.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // React 19 + Next 15 sometimes triggers this on intentional refresh
      // patterns (e.g. router.refresh() inside useEffect on tab change).
      // Surface as warning so genuine misuse still shows in PR reviews.
      "react-hooks/exhaustive-deps": "warn",
      // A2 regression guard: every <label> must be programmatically tied to
      // its control (htmlFor+id, or wrapping the control). The 2026-05-05
      // sweep closed ~352 label-input pairs across 76 dashboard pages; this
      // rule keeps new code from re-introducing the bare-text pattern.
      // Plugin ships via eslint-config-next -> eslint-plugin-jsx-a11y.
      //
      // Severity: 'warn' (not 'error') because the rule's static analysis
      // cannot see through our custom form components (EntityPicker,
      // PasswordInput, etc.) — labels pointing to those produce false
      // positives. It also flags labels that visually caption a button
      // group "pseudo-select" (which is intentional UX, not a bare-text
      // a11y bug). 'warn' still surfaces every new violation in CI logs
      // and PR reviews so genuine A2 regressions are caught early; the
      // pre-existing FP set can be retired by either (a) wiring those
      // custom components into `controlComponents` once their public API
      // exposes a stable inner input id, or (b) refactoring button-group
      // pseudo-controls to use `<fieldset><legend>` semantics. Until then,
      // escalating to 'error' would block the build on legitimate cases.
      "jsx-a11y/label-has-associated-control": [
        "warn",
        {
          assert: "either",
          depth: 3,
        },
      ],
    },
  },
];

export default eslintConfig;
