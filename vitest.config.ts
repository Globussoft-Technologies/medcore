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
      // Baseline locked 2026-04-15 from `vitest run apps/api/src/services packages/shared --coverage`
      // (unit + contract, no DB). Raise these as coverage grows; never lower without discussion.
      thresholds: {
        lines: 11,
        branches: 57,
        functions: 55,
        statements: 11,
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
