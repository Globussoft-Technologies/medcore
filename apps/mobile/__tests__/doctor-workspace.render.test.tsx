jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "d1", role: "DOCTOR" }, isLoading: false }),
}));
jest.mock("../lib/api", () => ({
  fetchQueue: jest.fn().mockResolvedValue([]),
  fetchAppointments: jest.fn().mockResolvedValue([]),
  updateAppointmentStatus: jest.fn().mockResolvedValue({}),
}));
jest.mock("../lib/socket", () => ({
  useQueueSocket: () => ({ connected: false }),
}));

describe("DoctorWorkspaceScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/(doctor-tabs)/workspace");
    expect(typeof mod.default).toBe("function");
  });
});
