/**
 * Unit tests for lib/api.ts — BASE_URL resolution order, refresh interceptor,
 * and the auth-failure handler registration.
 */

describe("lib/api module", () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.EXPO_PUBLIC_API_URL;
  });

  it("falls back to the production URL when env + constants are missing", () => {
    jest.doMock("expo-constants", () => ({
      __esModule: true,
      default: { expoConfig: { extra: {} } },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("../lib/api");
    expect(api.API_BASE_URL).toBe("https://medcore.globusdemos.com/api/v1");
  });

  it("prefers expoConfig.extra.apiUrl over the fallback", () => {
    jest.doMock("expo-constants", () => ({
      __esModule: true,
      default: { expoConfig: { extra: { apiUrl: "https://from-constants.test/api/v1" } } },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("../lib/api");
    expect(api.API_BASE_URL).toBe("https://from-constants.test/api/v1");
  });

  it("prefers EXPO_PUBLIC_API_URL over expoConfig", () => {
    process.env.EXPO_PUBLIC_API_URL = "https://from-env.test/api/v1";
    jest.doMock("expo-constants", () => ({
      __esModule: true,
      default: { expoConfig: { extra: { apiUrl: "https://from-constants.test/api/v1" } } },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("../lib/api");
    expect(api.API_BASE_URL).toBe("https://from-env.test/api/v1");
  });

  it("exposes registerAuthFailureHandler and ApiError", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require("../lib/api");
    expect(typeof api.registerAuthFailureHandler).toBe("function");
    expect(typeof api.ApiError).toBe("function");
    // Register + unregister should not throw.
    const fn = jest.fn();
    api.registerAuthFailureHandler(fn);
    api.registerAuthFailureHandler(null);
  });

  it("ApiError preserves status, message and body", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ApiError } = require("../lib/api");
    const err = new ApiError(418, "teapot", { foo: "bar" });
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(418);
    expect(err.message).toBe("teapot");
    expect(err.body).toEqual({ foo: "bar" });
  });

  it("source wires the 401 refresh interceptor around /auth/refresh", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "lib", "api.ts"),
      "utf8"
    );
    expect(src).toContain("refreshAccessToken");
    expect(src).toContain("/auth/refresh");
    expect(src).toMatch(/res\.status\s*===\s*401/);
    expect(src).toContain("onAuthFailure");
  });
});
