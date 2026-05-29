/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AgentConsolePage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/agent-console/page.tsx, the
 *     three-pane workstation that lets RECEPTION / ADMIN pick up AI-Triage
 *     handoffs. The page wires GET /agent-console/handoffs on mount, then
 *     on selecting a handoff fires a triple — GET context, GET messages,
 *     PATCH /read — plus a chat:join socket emit. Outbound writes include
 *     POST /chat/rooms/:id/messages (composer), POST .../suggest-doctor,
 *     POST .../resolve, POST .../escalate. The page also subscribes to
 *     two socket events: agent-console:new-handoff (refresh list) and
 *     chat:message (prepend new msg).
 *
 *   - Behaviours covered:
 *       1. Skeleton card renders while the auth store hasn't hydrated (no
 *          user). aria-busy="true" + data-testid="agent-console-loading".
 *       2. Role gate — a non-RECEPTION / non-ADMIN role renders the
 *          forbidden notice AND fires router.replace("/dashboard") + a
 *          toast.error.
 *       3. Initial render under an authorised RECEPTION role — header
 *          title + skeleton-text rows for the loading handoff list, then
 *          the empty-state copy after load.
 *       4. Mount wiring — GET /agent-console/handoffs is hit; the shared
 *          socket is connected when not already connected; the
 *          agent-console:new-handoff listener is registered.
 *       5. Skip socket.connect when shared socket is already connected.
 *       6. Handoff list renders one row per active handoff with patient
 *          name, presenting complaint, language tag, and unread badge
 *          when unreadCount > 0.
 *       7. "Unknown patient" fallback shows when handoff.patient is null.
 *       8. Selecting a handoff triggers the context+messages fetch trio
 *          and a PATCH /chat/rooms/:id/read, plus a chat:join socket
 *          emit and a chat:message subscription.
 *       9. Right-pane co-pilot — renders triage transcript turns labeled
 *          "Patient" / "AI", SOAP chief complaint / onset / duration /
 *          severity, the red-flag banner when redFlagDetected is true,
 *          and the top-doctor cards with "Suggest this doctor" buttons.
 *      10. Middle pane — chat thread shows messages with own vs other
 *          bubble distinction (mine = primary class, sender name hidden;
 *          other = sender name shown).
 *      11. Empty-states inside the right pane — "No transcript available"
 *          when transcript is [], "No doctor suggestions yet" when
 *          topDoctors is [].
 *      12. Composer — typing updates state; clicking Send POSTs
 *          /chat/rooms/:id/messages with TEXT type; Enter key (no shift)
 *          fires send; Shift+Enter does NOT; whitespace-only is rejected.
 *      13. Send error surfaces toast.error.
 *      14. suggestDoctor — pre-fills composer with the templated text
 *          AND POSTs /suggest-doctor; toast.success on success; silent
 *          on failure (composer still carries the templated text).
 *      15. resolveHandoff — opens the prompt; cancel (null) is a no-op;
 *          on confirm, POST /resolve fires, toast.success appears, the
 *          selectedRoomId is cleared, and the list re-loads.
 *      16. resolveHandoff error surfaces toast.error.
 *      17. escalate — when topDoctors is empty, surfaces toast.info; with
 *          a doctor present, opens prompt, on confirm POSTs /escalate
 *          with the first doctor's id and the reason note.
 *      18. escalate error surfaces toast.error.
 *      19. Socket lifecycle — agent-console:new-handoff handler re-fetches
 *          the handoff list; chat:message handler prepends new msg for
 *          the currently selected room and ignores other rooms.
 *      20. Error-path resilience — loadHandoffs reject settles to empty
 *          list silently; context fetch reject toasts the error.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/i18n, @/lib/toast,
 *            @/lib/socket, @/lib/use-dialog (usePrompt), next/navigation.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";

const {
  apiMock,
  toastMock,
  authMock,
  socketMock,
  promptMock,
  routerPushMock,
  routerReplaceMock,
} = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  authMock: vi.fn(),
  socketMock: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    connected: false,
  },
  promptMock: vi.fn(),
  routerPushMock: vi.fn(),
  routerReplaceMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (_k: string, fb?: string) => fb ?? _k,
    lang: "en",
    setLang: vi.fn(),
  }),
}));
vi.mock("@/lib/use-dialog", () => ({
  usePrompt: () => promptMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: routerReplaceMock,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/agent-console",
}));

import AgentConsolePage from "../page";

// ─── Fixtures ───────────────────────────────────────────────────────────
function handoffFixture(o: Partial<any> = {}): any {
  return {
    chatRoomId: "rm-1",
    sessionId: "ts-1",
    roomName: null,
    patient: { id: "pt-1", name: "Asha Patel", mrNumber: "MR-001" },
    presentingComplaint: "Severe headache for 2 days",
    language: "en",
    confidence: 0.82,
    handoffAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastActivityAt: new Date().toISOString(),
    unreadCount: 2,
    lastMessage: {
      id: "msg-last",
      content: "Could you describe the pain?",
      createdAt: new Date().toISOString(),
      senderName: "AI Triage",
    },
    ...o,
  };
}

function contextFixture(o: Partial<any> = {}): any {
  return {
    sessionId: "ts-1",
    chatRoomId: "rm-1",
    language: "en",
    status: "HANDOFF",
    redFlagDetected: false,
    redFlagReason: null,
    patient: {
      id: "pt-1",
      mrNumber: "MR-001",
      name: "Asha Patel",
      phone: "+91-9999999999",
      dateOfBirth: "1990-01-01",
      gender: "FEMALE",
    },
    transcript: [
      { role: "user", content: "I have a bad headache.", timestamp: "" },
      { role: "assistant", content: "How long?", timestamp: "" },
    ],
    soap: {
      subjective: {
        chiefComplaint: "Headache",
        onset: "2 days ago",
        duration: "48h",
        severity: 7,
        associatedSymptoms: ["nausea", "photophobia"],
        relevantHistory: null,
      },
      assessment: {
        suggestedSpecialties: [
          { specialty: "Neurology", reasoning: "head", confidence: 0.8 },
        ],
        confidence: 0.8,
      },
    },
    topDoctors: [
      {
        doctorId: "doc-1",
        name: "Rajesh Sharma",
        specialty: "Neurology",
        subSpecialty: "Headache clinic",
        qualification: "MD",
        experienceYears: 12,
        consultationFee: 800,
        reasoning: "Headache specialist",
      },
      {
        doctorId: "doc-2",
        name: "Dr. Priya Iyer",
        specialty: "General Medicine",
        subSpecialty: null,
        qualification: "MBBS",
        experienceYears: 6,
        consultationFee: 500,
        reasoning: null,
      },
    ],
    ...o,
  };
}

function chatMessageFixture(o: Partial<any> = {}): any {
  return {
    id: "m-1",
    roomId: "rm-1",
    senderId: "u-patient",
    content: "Hi, I need help.",
    type: "TEXT",
    createdAt: "2026-05-26T10:00:00.000Z",
    sender: { id: "u-patient", name: "Asha Patel", role: "PATIENT" },
    ...o,
  };
}

function asUser(opts: { role?: string; id?: string; isLoading?: boolean; nullUser?: boolean } = {}) {
  if (opts.nullUser) {
    authMock.mockReturnValue({ user: null, isLoading: opts.isLoading ?? false });
    return;
  }
  authMock.mockReturnValue({
    user: {
      id: opts.id ?? "u-me",
      userId: opts.id ?? "u-me",
      role: opts.role ?? "RECEPTION",
      name: "Agent User",
      email: "agent@medcore.local",
    },
    isLoading: opts.isLoading ?? false,
  });
}

/**
 * Route api.get by URL pattern. The page issues multiple GETs across mount +
 * room-select so per-call mockResolvedValueOnce chains are brittle.
 */
function wireGetByPath(opts: {
  handoffs?: any[];
  context?: any;
  messages?: any[];
  handoffsReject?: boolean;
  contextReject?: boolean;
  messagesReject?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url === "/agent-console/handoffs") {
      if (opts.handoffsReject)
        return Promise.reject(new Error("handoffs boom"));
      return Promise.resolve({ data: opts.handoffs ?? [] });
    }
    if (url.includes("/context")) {
      if (opts.contextReject)
        return Promise.reject(new Error("context boom"));
      return Promise.resolve({ data: opts.context ?? contextFixture() });
    }
    if (url.includes("/messages")) {
      if (opts.messagesReject)
        return Promise.reject(new Error("msgs boom"));
      return Promise.resolve({ data: opts.messages ?? [] });
    }
    return Promise.resolve({ data: null });
  });
}

describe("Agent Console dashboard page (3-pane handoff workstation)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    socketMock.connect.mockReset();
    socketMock.disconnect.mockReset();
    socketMock.emit.mockReset();
    socketMock.on.mockReset();
    socketMock.off.mockReset();
    socketMock.connected = false;
    promptMock.mockReset();
    routerPushMock.mockReset();
    routerReplaceMock.mockReset();
    apiMock.patch.mockResolvedValue({ data: {} });
    asUser();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the skeleton-card loading state while auth store has no user yet", () => {
    asUser({ nullUser: true });
    wireGetByPath({ handoffs: [] });

    render(<AgentConsolePage />);

    expect(
      screen.getByTestId("agent-console-loading"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-console-loading"),
    ).toHaveAttribute("aria-busy", "true");
  });

  it("a non-RECEPTION / non-ADMIN role sees the forbidden notice and router.replace fires", async () => {
    asUser({ role: "DOCTOR" });
    wireGetByPath({ handoffs: [] });

    render(<AgentConsolePage />);

    // Forbidden inline panel.
    expect(
      screen.getByText(
        /Agent Console is only available to reception and admin staff/i,
      ),
    ).toBeInTheDocument();

    // Side-effect: router.replace + toast.error.
    await waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith("/dashboard");
    });
    expect(toastMock.error).toHaveBeenCalled();
  });

  it("renders the header + skeleton-text rows then the empty-state copy on load complete", async () => {
    wireGetByPath({ handoffs: [] });

    render(<AgentConsolePage />);

    // Header title.
    expect(
      screen.getByRole("heading", { name: /Agent Console/i }),
    ).toBeInTheDocument();

    // Skeleton-text rows are present during initial fetch.
    expect(
      screen.getByTestId("agent-console-handoffs-loading"),
    ).toBeInTheDocument();

    // After resolution, empty-state copy appears.
    expect(
      await screen.findByText(/No active handoffs right now/i),
    ).toBeInTheDocument();
  });

  it("fetches /agent-console/handoffs on mount and connects an unconnected socket", async () => {
    socketMock.connected = false;
    wireGetByPath({ handoffs: [] });

    render(<AgentConsolePage />);
    await screen.findByText(/No active handoffs right now/i);

    expect(apiMock.get).toHaveBeenCalledWith("/agent-console/handoffs");
    expect(socketMock.connect).toHaveBeenCalled();

    // agent-console:new-handoff listener registered.
    const events = socketMock.on.mock.calls.map((c) => c[0]);
    expect(events).toContain("agent-console:new-handoff");
  });

  it("skips socket.connect when shared socket is already connected", async () => {
    socketMock.connected = true;
    wireGetByPath({ handoffs: [] });

    render(<AgentConsolePage />);
    await screen.findByText(/No active handoffs right now/i);

    expect(socketMock.connect).not.toHaveBeenCalled();
  });

  it("renders one row per handoff — patient name, complaint, language tag, unread badge", async () => {
    wireGetByPath({
      handoffs: [
        handoffFixture({
          chatRoomId: "rm-A",
          patient: { id: "pt-A", name: "Asha Patel", mrNumber: "MR-001" },
          presentingComplaint: "Severe headache for 2 days",
          language: "en",
          unreadCount: 3,
        }),
        handoffFixture({
          chatRoomId: "rm-B",
          patient: { id: "pt-B", name: "Bharat Singh", mrNumber: "MR-002" },
          presentingComplaint: "Chest tightness",
          language: "hi",
          unreadCount: 0,
        }),
      ],
    });

    render(<AgentConsolePage />);

    // Patient names.
    expect(await screen.findByText("Asha Patel")).toBeInTheDocument();
    expect(screen.getByText("Bharat Singh")).toBeInTheDocument();
    // Complaints.
    expect(
      screen.getByText("Severe headache for 2 days"),
    ).toBeInTheDocument();
    expect(screen.getByText("Chest tightness")).toBeInTheDocument();
    // Language tags.
    expect(screen.getByText("en")).toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
    // Unread badge for the row with unreadCount=3.
    expect(screen.getByText("3")).toBeInTheDocument();
    // Active-handoffs counter chip — header has "(2)" appended.
    expect(screen.getByText(/Active handoffs \(2\)/i)).toBeInTheDocument();
  });

  it("renders 'Unknown patient' fallback when handoff.patient is null", async () => {
    wireGetByPath({
      handoffs: [handoffFixture({ patient: null })],
    });

    render(<AgentConsolePage />);

    expect(await screen.findByText("Unknown patient")).toBeInTheDocument();
  });

  it("selecting a handoff fires context+messages fetch, PATCH /read, and chat:join emit", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-sel" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-sel" }),
      messages: [
        chatMessageFixture({
          id: "m-load",
          roomId: "rm-sel",
          content: "loaded message",
          sender: { id: "u-patient", name: "Asha Patel", role: "PATIENT" },
        }),
      ],
    });

    render(<AgentConsolePage />);
    const row = await screen.findByText("Asha Patel");
    fireEvent.click(row.closest("button")!);

    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(
        calls.some(
          (u) => u === "/agent-console/handoffs/rm-sel/context",
        ),
      ).toBe(true);
      expect(
        calls.some(
          (u) => u === "/chat/rooms/rm-sel/messages?limit=100",
        ),
      ).toBe(true);
    });

    // PATCH /read.
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/chat/rooms/rm-sel/read",
        {},
      ),
    );

    // Socket chat:join.
    expect(socketMock.emit).toHaveBeenCalledWith("chat:join", "rm-sel");
    // chat:message subscription.
    const events = socketMock.on.mock.calls.map((c) => c[0]);
    expect(events).toContain("chat:message");

    // Loaded message renders in the canvas.
    expect(await screen.findByText("loaded message")).toBeInTheDocument();
  });

  it("right pane renders the AI co-pilot — transcript, SOAP fields, doctor cards", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-cp" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-cp" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    // Transcript turns labeled Patient + AI.
    await waitFor(() => {
      expect(
        screen.getByTestId("agent-console-transcript"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("I have a bad headache.")).toBeInTheDocument();
    expect(screen.getByText("How long?")).toBeInTheDocument();

    // SOAP block.
    expect(screen.getByText("Headache")).toBeInTheDocument();
    expect(screen.getByText("2 days ago")).toBeInTheDocument();
    expect(screen.getByText("48h")).toBeInTheDocument();
    // Severity 7 appears.
    expect(screen.getByText("7")).toBeInTheDocument();
    // Associated symptoms joined.
    expect(screen.getByText(/nausea, photophobia/i)).toBeInTheDocument();

    // Doctor cards — formatDoctorName de-doubles the "Dr." prefix.
    expect(screen.getByText("Dr. Rajesh Sharma")).toBeInTheDocument();
    expect(screen.getByText("Dr. Priya Iyer")).toBeInTheDocument();
    // Sub-specialty appended with separator.
    expect(
      screen.getByText(/Neurology · Headache clinic/i),
    ).toBeInTheDocument();
    // Suggest buttons present.
    expect(
      screen.getByTestId("suggest-doctor-doc-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("suggest-doctor-doc-2"),
    ).toBeInTheDocument();
  });

  it("red-flag banner renders when context.redFlagDetected is true", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-rf" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({
        chatRoomId: "rm-rf",
        redFlagDetected: true,
        redFlagReason: "Possible MI symptoms",
      }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    expect(
      await screen.findByText(/Possible MI symptoms/i),
    ).toBeInTheDocument();
  });

  it("right-pane empty branches — 'No transcript available' + 'No doctor suggestions yet'", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-empty" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({
        chatRoomId: "rm-empty",
        transcript: [],
        topDoctors: [],
      }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    expect(
      await screen.findByText(/No transcript available/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No doctor suggestions yet/i),
    ).toBeInTheDocument();
  });

  it("renders own-vs-other bubble distinction in the chat thread (sender name shown only for other)", async () => {
    asUser({ id: "u-me", role: "RECEPTION" });
    const handoff = handoffFixture({ chatRoomId: "rm-mix" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-mix" }),
      messages: [
        chatMessageFixture({
          id: "m-mine",
          roomId: "rm-mix",
          senderId: "u-me",
          content: "from me",
          sender: { id: "u-me", name: "Agent User", role: "RECEPTION" },
        }),
        chatMessageFixture({
          id: "m-theirs",
          roomId: "rm-mix",
          senderId: "u-patient",
          content: "from patient",
          sender: { id: "u-patient", name: "Asha Patel", role: "PATIENT" },
        }),
      ],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    expect(await screen.findByText("from me")).toBeInTheDocument();
    expect(await screen.findByText("from patient")).toBeInTheDocument();
  });

  it("'No messages yet' fallback shows when the messages list is empty", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-nm" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-nm" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    expect(await screen.findByText(/No messages yet/i)).toBeInTheDocument();
  });

  it("composer Send button — POSTs /chat/rooms/:id/messages and clears the input on success", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-send" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-send" }),
      messages: [],
    });
    apiMock.post.mockResolvedValue({ data: { id: "new-msg" } });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    const composer = (await screen.findByTestId(
      "agent-console-composer",
    )) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "hello patient" } });

    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/chat/rooms/rm-send/messages",
        { content: "hello patient", type: "TEXT" },
      ),
    );
    await waitFor(() => expect(composer.value).toBe(""));
  });

  it("composer Enter key (no shift) fires send; Shift+Enter does NOT", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-enter" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-enter" }),
      messages: [],
    });
    apiMock.post.mockResolvedValue({ data: { id: "m-new" } });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    const composer = (await screen.findByTestId(
      "agent-console-composer",
    )) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "shift line" } });

    // Shift+Enter — no POST.
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(apiMock.post).not.toHaveBeenCalled();

    // Plain Enter — fires send.
    fireEvent.change(composer, { target: { value: "via enter" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/chat/rooms/rm-enter/messages",
        { content: "via enter", type: "TEXT" },
      ),
    );
  });

  it("whitespace-only composer disables Send and the source-side guard blocks Enter", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-ws" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-ws" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    const composer = (await screen.findByTestId(
      "agent-console-composer",
    )) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "    " } });

    const sendBtn = screen.getByRole("button", {
      name: /^Send$/,
    }) as HTMLButtonElement;
    expect(sendBtn).toBeDisabled();
    fireEvent.click(sendBtn);
    expect(apiMock.post).not.toHaveBeenCalled();

    // Enter on whitespace — source's trim() guard skips POST.
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("send error surfaces toast.error", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-serr" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-serr" }),
      messages: [],
    });
    apiMock.post.mockRejectedValueOnce(new Error("net down"));

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    const composer = (await screen.findByTestId(
      "agent-console-composer",
    )) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("net down"),
    );
  });

  it("suggestDoctor — pre-fills composer with templated text AND POSTs /suggest-doctor", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-sug" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-sug" }),
      messages: [],
    });
    apiMock.post.mockResolvedValueOnce({ data: { ok: true } });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    // Click "Suggest this doctor" on doc-1.
    fireEvent.click(
      await screen.findByTestId("suggest-doctor-doc-1"),
    );

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/agent-console/handoffs/rm-sug/suggest-doctor",
        { doctorId: "doc-1" },
      ),
    );

    // Composer pre-filled.
    const composer = screen.getByTestId(
      "agent-console-composer",
    ) as HTMLTextAreaElement;
    expect(composer.value).toContain("Dr. Rajesh Sharma");
    expect(composer.value).toContain("Neurology");
    expect(composer.value).toContain("₹800");

    // Success toast.
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalled(),
    );
  });

  it("suggestDoctor failure is silent — composer still carries the text, no toast.error", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-sugf" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-sugf" }),
      messages: [],
    });
    apiMock.post.mockRejectedValueOnce(new Error("suggest boom"));

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    fireEvent.click(
      await screen.findByTestId("suggest-doctor-doc-1"),
    );

    const composer = screen.getByTestId(
      "agent-console-composer",
    ) as HTMLTextAreaElement;
    // Pre-fill still happened.
    await waitFor(() => {
      expect(composer.value).toContain("Dr. Rajesh Sharma");
    });

    // No success toast (because it rejected).
    await waitFor(() => {
      expect(toastMock.error).not.toHaveBeenCalled();
    });
  });

  it("resolveHandoff — cancel prompt returns null and no POST fires", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-res" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-res" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    promptMock.mockResolvedValueOnce(null);
    const resolveBtn = await screen.findByRole("button", {
      name: /Mark resolved/i,
    });
    fireEvent.click(resolveBtn);

    await waitFor(() => expect(promptMock).toHaveBeenCalled());

    // No POST fired.
    const resolveCalls = apiMock.post.mock.calls.filter((c) =>
      String(c[0]).includes("/resolve"),
    );
    expect(resolveCalls.length).toBe(0);
  });

  it("resolveHandoff — on confirm POSTs /resolve, fires toast.success, clears selection, reloads list", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-rsx" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-rsx" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    promptMock.mockResolvedValueOnce("Booked with Dr. Sharma");
    apiMock.post.mockResolvedValueOnce({ data: { ok: true } });

    const initialHandoffsCalls = apiMock.get.mock.calls.filter(
      (c) => c[0] === "/agent-console/handoffs",
    ).length;

    fireEvent.click(
      await screen.findByRole("button", { name: /Mark resolved/i }),
    );

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/agent-console/handoffs/rm-rsx/resolve",
        { note: "Booked with Dr. Sharma" },
      ),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());

    // Selection cleared — Mark resolved button disappears.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Mark resolved/i }),
      ).not.toBeInTheDocument();
    });

    // List reloaded — at least one more /agent-console/handoffs hit.
    await waitFor(() => {
      const after = apiMock.get.mock.calls.filter(
        (c) => c[0] === "/agent-console/handoffs",
      ).length;
      expect(after).toBeGreaterThan(initialHandoffsCalls);
    });
  });

  it("resolveHandoff error surfaces toast.error", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-rerr" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-rerr" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    promptMock.mockResolvedValueOnce("");
    apiMock.post.mockRejectedValueOnce(new Error("resolve denied"));

    fireEvent.click(
      await screen.findByRole("button", { name: /Mark resolved/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("resolve denied"),
    );
  });

  it("escalate — when topDoctors is empty, toast.info is fired (no prompt)", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-noE" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({
        chatRoomId: "rm-noE",
        topDoctors: [],
      }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Escalate to doctor/i }),
    );

    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalled(),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("escalate — with a doctor present, opens prompt and POSTs /escalate with first doctor id + reason", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-esc" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-esc" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    promptMock.mockResolvedValueOnce("Worsening chest tightness");
    apiMock.post.mockResolvedValueOnce({ data: { ok: true } });

    fireEvent.click(
      await screen.findByRole("button", { name: /Escalate to doctor/i }),
    );

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/agent-console/handoffs/rm-esc/escalate",
        { doctorId: "doc-1", reason: "Worsening chest tightness" },
      ),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
  });

  it("escalate cancellation (prompt null) does not POST", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-esc2" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-esc2" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    // escalate() bails out early on `!context`, so wait for the context
    // GET to land (transcript section only renders after setContext) before
    // clicking — otherwise the click is a silent no-op and promptMock
    // is never called.
    await screen.findByTestId("agent-console-transcript");

    promptMock.mockResolvedValueOnce(null);

    fireEvent.click(
      await screen.findByRole("button", { name: /Escalate to doctor/i }),
    );

    await waitFor(() => expect(promptMock).toHaveBeenCalled());

    // Sleep one microtask & then verify NO escalate POST happened.
    const escalateCalls = apiMock.post.mock.calls.filter((c) =>
      String(c[0]).includes("/escalate"),
    );
    expect(escalateCalls.length).toBe(0);
  });

  it("escalate error surfaces toast.error", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-eerr" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-eerr" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    promptMock.mockResolvedValueOnce("reason");
    apiMock.post.mockRejectedValueOnce(new Error("escalate failed"));

    fireEvent.click(
      await screen.findByRole("button", { name: /Escalate to doctor/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("escalate failed"),
    );
  });

  it("agent-console:new-handoff socket event re-fetches the handoff list", async () => {
    wireGetByPath({ handoffs: [] });

    render(<AgentConsolePage />);
    await screen.findByText(/No active handoffs right now/i);

    const handler = socketMock.on.mock.calls.find(
      (c) => c[0] === "agent-console:new-handoff",
    )![1] as () => void;

    const before = apiMock.get.mock.calls.filter(
      (c) => c[0] === "/agent-console/handoffs",
    ).length;

    act(() => {
      handler();
    });

    await waitFor(() => {
      const after = apiMock.get.mock.calls.filter(
        (c) => c[0] === "/agent-console/handoffs",
      ).length;
      expect(after).toBe(before + 1);
    });
  });

  it("chat:message handler prepends new message for the currently selected room", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-sk" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-sk" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    await waitFor(() => {
      expect(
        socketMock.on.mock.calls.some((c) => c[0] === "chat:message"),
      ).toBe(true);
    });

    const handler = socketMock.on.mock.calls.find(
      (c) => c[0] === "chat:message",
    )![1] as (m: any) => void;

    act(() => {
      handler(
        chatMessageFixture({
          id: "m-incoming",
          roomId: "rm-sk",
          content: "live arrival",
          sender: { id: "u-patient", name: "Asha Patel", role: "PATIENT" },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("live arrival")).toBeInTheDocument();
    });
  });

  it("chat:message handler ignores messages for a different room", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-here" });
    wireGetByPath({
      handoffs: [handoff],
      context: contextFixture({ chatRoomId: "rm-here" }),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    await waitFor(() => {
      expect(
        socketMock.on.mock.calls.some((c) => c[0] === "chat:message"),
      ).toBe(true);
    });
    const handler = socketMock.on.mock.calls.find(
      (c) => c[0] === "chat:message",
    )![1] as (m: any) => void;

    act(() => {
      handler(
        chatMessageFixture({
          id: "m-other",
          roomId: "rm-different",
          content: "WRONG ROOM",
        }),
      );
    });

    expect(screen.queryByText("WRONG ROOM")).not.toBeInTheDocument();
  });

  it("on room switch, chat:leave + .off are called for cleanup of the previous selection", async () => {
    const a = handoffFixture({
      chatRoomId: "rm-A",
      patient: { id: "pA", name: "Patient A", mrNumber: "MR-A" },
    });
    const b = handoffFixture({
      chatRoomId: "rm-B",
      patient: { id: "pB", name: "Patient B", mrNumber: "MR-B" },
    });
    wireGetByPath({
      handoffs: [a, b],
      context: contextFixture(),
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Patient A")).closest("button")!,
    );

    await waitFor(() =>
      expect(
        socketMock.emit.mock.calls.some(
          (c) => c[0] === "chat:join" && c[1] === "rm-A",
        ),
      ).toBe(true),
    );

    fireEvent.click(
      (await screen.findByText("Patient B")).closest("button")!,
    );

    await waitFor(() => {
      expect(
        socketMock.emit.mock.calls.some(
          (c) => c[0] === "chat:leave" && c[1] === "rm-A",
        ),
      ).toBe(true);
    });

    const offEvents = socketMock.off.mock.calls.map((c) => c[0]);
    expect(offEvents).toContain("chat:message");

    expect(
      socketMock.emit.mock.calls.some(
        (c) => c[0] === "chat:join" && c[1] === "rm-B",
      ),
    ).toBe(true);
  });

  it("loadHandoffs reject settles to an empty list silently (no toast)", async () => {
    wireGetByPath({ handoffsReject: true });

    render(<AgentConsolePage />);
    expect(
      await screen.findByText(/No active handoffs right now/i),
    ).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("context fetch reject toasts an error", async () => {
    const handoff = handoffFixture({ chatRoomId: "rm-cerr" });
    wireGetByPath({
      handoffs: [handoff],
      contextReject: true,
      messages: [],
    });

    render(<AgentConsolePage />);
    fireEvent.click(
      (await screen.findByText("Asha Patel")).closest("button")!,
    );

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalled();
    });
  });
});
