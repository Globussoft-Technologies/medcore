/**
 * Login screen render-path smoke. Module load + source-grep only;
 * full RNTL rendering is blocked by RN host-component detection on SDK 53.
 */
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ login: jest.fn(), user: null, isLoading: false }),
}));

describe("LoginScreen render smoke", () => {
  it("loads the module and exports a component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/login");
    expect(typeof mod.default).toBe("function");
  });

  it("wires the useAuth login handler", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "app", "login.tsx"),
      "utf8"
    );
    expect(src).toContain("useAuth()");
    expect(src).toMatch(/login\s*\(/);
  });
});
