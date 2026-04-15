jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "PATIENT" }, isLoading: false }),
}));
jest.mock("../lib/api", () => ({
  fetchPrescriptions: jest.fn().mockResolvedValue([]),
  fetchPrescriptionDetail: jest.fn().mockResolvedValue({}),
}));

describe("PrescriptionsScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/(tabs)/prescriptions");
    expect(typeof mod.default).toBe("function");
  });
});
