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
        "apps/api/src/server.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "@medcore/shared": path.resolve(__dirname, "packages/shared/src"),
      "@medcore/db": path.resolve(__dirname, "packages/db/src"),
    },
  },
});
