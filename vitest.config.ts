import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "apps/api/src/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "apps/web/**",
      "apps/mobile/**",
    ],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: {
        // Integration tests must run sequentially since they share a DB.
        singleFork: true,
      },
    },
    setupFiles: ["apps/api/src/test/setup-env.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [
        "apps/api/src/**/*.ts",
        "packages/shared/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/test/**",
        "**/dist/**",
        "**/.next/**",
        "apps/api/src/server.ts",
      ],
      // Bumped 2026-05-02 from prior baseline. Source: per-push run 25257723834 lcov
      // (api actual: lines 26.71%, branches 70.21%, functions 70.04%). Floors set to
      // Math.floor(actual - 2pp). Raise these as coverage grows; never lower without discussion.
      thresholds: {
        lines: 24,
        branches: 68,
        functions: 68,
        statements: 24,
      },
    },
  },
  resolve: {
    alias: {
      "@medcore/shared": path.resolve(__dirname, "packages/shared/src"),
      "@medcore/db": path.resolve(__dirname, "packages/db/src"),
    },
  },
});
