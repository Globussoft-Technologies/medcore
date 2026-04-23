jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "PATIENT" }, isLoading: false }),
}));
jest.mock("../lib/ai", () => ({
  fetchLabExplanation: jest.fn().mockResolvedValue({
    id: "e1",
    labOrderId: "lab1",
    patientId: "p1",
    explanation: "",
    flaggedValues: [],
    language: "en",
    status: "SENT",
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
}));

describe("LabExplanationScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/ai/lab-explanation");
    expect(typeof mod.default).toBe("function");
  });
});
