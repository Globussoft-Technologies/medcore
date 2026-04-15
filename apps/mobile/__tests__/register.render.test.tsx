/**
 * Register screen smoke — module load + required-field grep.
 */
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("../lib/api", () => ({
  registerApi: jest.fn().mockResolvedValue({}),
}));

describe("RegisterScreen smoke", () => {
  it("exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/register");
    expect(typeof mod.default).toBe("function");
  });

  it("references the fields the e2e suite relies on", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "app", "register.tsx"),
      "utf8"
    );
    expect(src).toContain("registerApi");
    expect(src).toMatch(/name|email|phone|password/);
  });
});
