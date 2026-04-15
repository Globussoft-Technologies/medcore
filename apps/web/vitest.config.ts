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
      // Baseline locked 2026-04-15 from `vitest run --config apps/web/vitest.config.ts --coverage`.
      // Raise these as coverage grows; never lower without discussion.
      thresholds: {
        lines: 10,
        branches: 61,
        functions: 28,
        statements: 10,
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
