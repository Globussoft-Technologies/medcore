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
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
