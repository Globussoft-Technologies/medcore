/**
 * usePushRegistration smoke — loads the hook and verifies wiring against
 * the mocked expo-notifications module.
 */

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: "ExponentPushToken[test]" }),
  AndroidImportance: { DEFAULT: 3 },
  IosAuthorizationStatus: { PROVISIONAL: 2 },
}));
jest.mock("expo-device", () => ({ isDevice: true }));
jest.mock("../lib/api", () => ({
  registerPushToken: jest.fn().mockResolvedValue({}),
}));

describe("usePushRegistration", () => {
  it("exports a hook function", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../lib/hooks/usePushRegistration");
    expect(typeof mod.usePushRegistration).toBe("function");
  });

  it("source references expo-notifications + registerPushToken", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "lib", "hooks", "usePushRegistration.ts"),
      "utf8"
    );
    expect(src).toContain("expo-notifications");
    expect(src).toContain("registerPushToken");
    expect(src).toContain("getExpoPushTokenAsync");
  });
});
