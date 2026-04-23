jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "PATIENT" }, isLoading: false }),
}));
jest.mock("../lib/ai", () => ({
  startTriageSession: jest.fn().mockResolvedValue({
    sessionId: "s1",
    message: "Hi, how are you feeling?",
    language: "en",
    disclaimer: "Routing assistant",
  }),
  sendTriageMessage: jest.fn().mockResolvedValue({ message: "Got it." }),
  getTriageSummary: jest.fn().mockResolvedValue({
    session: { id: "s1", status: "ACTIVE", language: "en", messages: [], redFlagDetected: false, redFlagReason: null, confidence: null },
    doctorSuggestions: [],
  }),
  bookTriageAppointment: jest.fn().mockResolvedValue({}),
}));

describe("AITriageChatScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/ai/triage");
    expect(typeof mod.default).toBe("function");
  });
});
