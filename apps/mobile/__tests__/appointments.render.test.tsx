jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "PATIENT" }, isLoading: false }),
}));
jest.mock("../lib/api", () => ({
  fetchAppointments: jest.fn().mockResolvedValue([]),
  updateAppointmentStatus: jest.fn().mockResolvedValue({}),
}));

describe("AppointmentsScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/(tabs)/appointments");
    expect(typeof mod.default).toBe("function");
  });
});
