jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "d1", role: "DOCTOR" }, isLoading: false }),
}));
jest.mock("../lib/api", () => ({
  fetchAppointments: jest.fn().mockResolvedValue([]),
  fetchPatientDetail: jest.fn().mockResolvedValue({}),
}));

describe("DoctorPatientsScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/(doctor-tabs)/patients");
    expect(typeof mod.default).toBe("function");
  });
});
