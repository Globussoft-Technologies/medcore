/**
 * Patient home tab smoke.
 */
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", name: "Test", role: "PATIENT" }, isLoading: false }),
}));
jest.mock("../lib/api", () => ({
  fetchAppointments: jest.fn().mockResolvedValue([]),
}));

describe("HomeScreen (patient tabs/index) smoke", () => {
  it("exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/(tabs)/index");
    expect(typeof mod.default).toBe("function");
  });
});
