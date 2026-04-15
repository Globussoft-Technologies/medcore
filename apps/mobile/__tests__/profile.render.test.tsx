jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", name: "Test", email: "t@t.com", role: "PATIENT" },
    isLoading: false,
    logout: jest.fn(),
  }),
}));

describe("ProfileScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/(tabs)/profile");
    expect(typeof mod.default).toBe("function");
  });
});
