jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "PATIENT" }, isLoading: false }),
}));
jest.mock("../lib/ai", () => ({
  fetchAdherenceSchedules: jest.fn().mockResolvedValue([]),
  enrollAdherence: jest.fn().mockResolvedValue({}),
  unenrollAdherence: jest.fn().mockResolvedValue(undefined),
}));

describe("AdherenceScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/ai/adherence");
    expect(typeof mod.default).toBe("function");
  });
});
