jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "PATIENT" }, isLoading: false }),
}));
jest.mock("../lib/api", () => ({
  fetchInvoices: jest.fn().mockResolvedValue([]),
  fetchInvoiceDetail: jest.fn().mockResolvedValue({}),
  createPaymentOrder: jest.fn().mockResolvedValue({}),
  verifyPayment: jest.fn().mockResolvedValue({}),
}));

describe("BillingScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/(tabs)/billing");
    expect(typeof mod.default).toBe("function");
  });
});
