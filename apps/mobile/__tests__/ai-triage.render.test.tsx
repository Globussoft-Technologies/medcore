/**
 * Tests for the mobile AI Triage chat screen.
 *
 * After the @testing-library/react-native upgrade these are real render +
 * fireEvent tests: we mount the screen, type into the composer, press send,
 * and assert the API client was called with the live session id.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "PATIENT" }, isLoading: false }),
}));
jest.mock("../lib/ai", () => ({
  startTriageSession: jest.fn(),
  sendTriageMessage: jest.fn(),
  getTriageSummary: jest.fn().mockResolvedValue({
    session: {
      id: "s1",
      status: "ACTIVE",
      language: "en",
      messages: [],
      redFlagDetected: false,
      redFlagReason: null,
      confidence: null,
    },
    doctorSuggestions: [],
  }),
  bookTriageAppointment: jest.fn().mockResolvedValue({}),
}));

import AITriageChatScreen from "../app/ai/triage";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ai = require("../lib/ai");

describe("AITriageChatScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/ai/triage");
    expect(typeof mod.default).toBe("function");
  });
});

describe("AITriageChatScreen render + send flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ai.startTriageSession.mockResolvedValue({
      sessionId: "s1",
      message: "Hi, how are you feeling?",
      language: "en",
      disclaimer: "Routing assistant",
    });
    ai.sendTriageMessage.mockResolvedValue({ message: "Got it." });
  });

  it("renders the initial assistant greeting after startTriageSession resolves", async () => {
    const { findByText } = render(<AITriageChatScreen />);
    expect(await findByText("Hi, how are you feeling?")).toBeTruthy();
    expect(ai.startTriageSession).toHaveBeenCalledTimes(1);
  });

  it("typing into composer and pressing send invokes sendTriageMessage(sessionId, text)", async () => {
    const { findByPlaceholderText, getByLabelText, findByText } = render(
      <AITriageChatScreen />
    );

    // Wait for the session to start so the composer becomes editable.
    await findByText("Hi, how are you feeling?");

    const input = await findByPlaceholderText("Describe your symptoms...");
    await act(async () => {
      fireEvent.changeText(input, "I have a sore throat");
    });

    const sendButton = getByLabelText("Send message");
    await act(async () => {
      fireEvent.press(sendButton);
    });

    await waitFor(() => expect(ai.sendTriageMessage).toHaveBeenCalledTimes(1));
    expect(ai.sendTriageMessage).toHaveBeenCalledWith("s1", "I have a sore throat");

    // And the assistant's reply bubble renders.
    expect(await findByText("Got it.")).toBeTruthy();
  });

  it("does not call sendTriageMessage when the composer is empty", async () => {
    const { getByLabelText, findByText } = render(<AITriageChatScreen />);
    await findByText("Hi, how are you feeling?");

    const sendButton = getByLabelText("Send message");
    await act(async () => {
      fireEvent.press(sendButton);
    });

    // Button is disabled while draft is empty — no API call should fire.
    expect(ai.sendTriageMessage).not.toHaveBeenCalled();
  });

  // Richer interaction: verify the in-flight "Thinking..." indicator is
  // rendered WHILE sendTriageMessage is pending. Exercises the `sending`
  // state transition on the composer (button disabled, ListFooterComponent
  // shows the indicator). This is exactly the kind of mid-flight assertion
  // the client-wiring pattern can't express — it needs a real mount.
  it("shows the 'Thinking...' indicator while sendTriageMessage is pending, then clears it", async () => {
    // Keep sendTriageMessage pending until we resolve it by hand, so we can
    // observe the in-flight UI state deterministically without racing the
    // microtask queue.
    let resolveSend!: (v: { message: string }) => void;
    ai.sendTriageMessage.mockImplementation(
      () => new Promise((res) => {
        resolveSend = res;
      })
    );

    const { findByPlaceholderText, getByLabelText, findByText, queryByText } =
      render(<AITriageChatScreen />);

    // Wait for session start so the composer is editable.
    await findByText("Hi, how are you feeling?");

    const input = await findByPlaceholderText("Describe your symptoms...");
    await act(async () => {
      fireEvent.changeText(input, "cough for 2 days");
    });

    await act(async () => {
      fireEvent.press(getByLabelText("Send message"));
    });

    // While the request is pending the user bubble is already rendered and
    // the assistant shows "Thinking..." in the list footer.
    expect(await findByText("cough for 2 days")).toBeTruthy();
    expect(await findByText("Thinking...")).toBeTruthy();

    // Now resolve the request — the indicator should unmount and the
    // assistant's reply should render.
    await act(async () => {
      resolveSend({ message: "Got it, thanks." });
    });

    expect(await findByText("Got it, thanks.")).toBeTruthy();
    expect(queryByText("Thinking...")).toBeNull();
    expect(ai.sendTriageMessage).toHaveBeenCalledWith("s1", "cough for 2 days");
  });
});
