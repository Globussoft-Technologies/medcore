jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "PATIENT" }, isLoading: false }),
}));
jest.mock("../lib/api", () => ({
  fetchQueue: jest.fn().mockResolvedValue([]),
  fetchAppointments: jest.fn().mockResolvedValue([]),
}));
jest.mock("../lib/socket", () => ({
  useQueueSocket: () => ({ connected: false }),
}));

describe("QueueScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/(tabs)/queue");
    expect(typeof mod.default).toBe("function");
  });
});
