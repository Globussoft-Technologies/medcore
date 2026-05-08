// Flat ESLint config for the apps/web Next.js workspace (ESLint 10).
//
// Architecture notes:
//
//   eslint-plugin-react@7.x (shipped by eslint-config-next's base export) calls
//   context.getFilename() which was removed in ESLint 10.  To avoid this breakage
//   we build the config from constituent parts, bypassing the React plugin's rules:
//
//     eslint-config-next/typescript   — TypeScript rules via typescript-eslint
//     @next/eslint-plugin-next        — Next.js-specific rules
//     eslint-plugin-react-hooks       — React hooks rules
//     eslint-plugin-jsx-a11y          — A11y plugin (registered to resolve
//                                       existing disable comments in source)
//     eslint-plugin-react             — React plugin registered WITHOUT rules
//                                       (enables existing disable-next-line
//                                       comments to resolve without errors)
//
//   eslint@^10 must be declared at the workspace root (package.json) so that
//   hoisted plugins can resolve `require('eslint')` from root node_modules.
//
//   React Compiler rules added in eslint-plugin-react-hooks@7 (static-components,
//   use-memo, purity, etc.) are downgraded to 'warn' to maintain parity with
//   the eslint-config-next@15 / react-hooks@5 baseline we are migrating from.
//   They can be escalated to 'error' after a dedicated sweep PR.
//
// Scope:
//   - Lints apps/web sources only.
//   - Replaces the former `next lint` invocation (deprecated in ESLint 10).
//
// To run locally:   npm --prefix apps/web run lint
// To autofix:       npm --prefix apps/web run lint -- --fix

import nextTypescript from "eslint-config-next/typescript";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import a11yPlugin from "eslint-plugin-jsx-a11y";
import reactPlugin from "eslint-plugin-react";
import tseslint from "typescript-eslint";

const eslintConfig = [
  // TypeScript rules (typescript-eslint, no React plugin).
  ...nextTypescript,
  {
    // Next.js-specific rules.
    plugins: { "@next/next": nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules },
  },
  {
    // React hooks rules.  All React Compiler rules (react-hooks@7 additions)
    // are overridden to 'warn' in the overrides block below to match the
    // pre-migration baseline.
    plugins: { "react-hooks": reactHooksPlugin },
    rules: { ...reactHooksPlugin.configs.recommended.rules },
  },
  {
    // Register jsx-a11y plugin so that existing
    // `// eslint-disable-next-line jsx-a11y/*` comments resolve correctly.
    // Rules are configured in the overrides block below.
    plugins: { "jsx-a11y": a11yPlugin },
  },
  {
    // Register react plugin WITHOUT enabling any rules.
    // This ensures `// eslint-disable-next-line react/*` comments already
    // present in source files resolve without "Definition not found" errors.
    // Rules are not enabled because eslint-plugin-react@7.x uses
    // context.getFilename() which was removed in ESLint 10.
    plugins: { react: reactPlugin },
  },
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
    //
    // Plugins are re-declared here because ESLint 10 requires the plugin to
    // be present in the same config object as the rules using it.
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooksPlugin,
      "jsx-a11y": a11yPlugin,
    },
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
      // --- React Compiler rules (new in react-hooks@7, not in @5 baseline) ---
      // Downgrade from 'error' to 'warn' to maintain parity with the
      // eslint-config-next@15 / react-hooks@5 baseline.  Escalate after a
      // dedicated sweep PR that addresses the codebase violations.
      "react-hooks/static-components": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/globals": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/error-boundaries": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-render": "warn",
      "react-hooks/config": "warn",
      "react-hooks/gating": "warn",
      // -----------------------------------------------------------------------
      // A2 regression guard: every <label> must be programmatically tied to
      // its control (htmlFor+id, or wrapping the control). The 2026-05-05
      // sweep closed ~352 label-input pairs across 76 dashboard pages; this
      // rule keeps new code from re-introducing the bare-text pattern.
      //
      // Severity: 'warn' (not 'error') because the rule's static analysis
      // cannot see through our custom form components (EntityPicker,
      // PasswordInput, etc.) — labels pointing to those produce false
      // positives. 'warn' still surfaces every new violation in CI logs
      // and PR reviews so genuine A2 regressions are caught early.
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
