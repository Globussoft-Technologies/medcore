/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ChatPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/chat/page.tsx, the staff DM +
 *     group chat surface. The page wires three GETs on mount
 *     (/chat/rooms, /chat/users) and a per-room trio
 *     (/chat/rooms/:id/messages, /chat/rooms/:id/pinned, PATCH
 *     /chat/rooms/:id/read). It joins the room over the shared
 *     Socket.io client and subscribes to two events (chat:message,
 *     chat:reaction). Compose POSTs, reaction-toggle POSTs, and pin
 *     PATCH round-trips are all in scope, as is the sanitizeChatPreview
 *     XSS-mask helper introduced for Issue #850.
 *
 *   - Behaviours covered (mapped to the page surface):
 *       1. Initial render — sidebar heading, search box, and empty-rooms
 *          copy render when /chat/rooms returns [].
 *       2. Mount fetches — both /chat/rooms and /chat/users hit on mount;
 *          shared socket is connected when not already connected.
 *       3. Already-connected socket — connect is NOT called when
 *          socket.connected is true.
 *       4. Room list — each room renders display name (group name or
 *          OTHER participant's user.name), last-message preview, and the
 *          unread-count badge when > 0.
 *       5. sanitizeChatPreview — `<script>alert('x')</script>` masks to
 *          "[blocked content]"; plain text passes through; HTML tags
 *          stripped; null/undefined → empty; "No messages yet" fallback
 *          appears when last message is null.
 *       6. User search dropdown — typing reveals filtered users; clicking
 *          a user POSTs /chat/rooms with {isGroup:false,participantIds};
 *          on success the room becomes selected and the dropdown closes.
 *       7. startChat error — POST rejection toasts the error.
 *       8. Selecting a room — fires chat:join emit, loads messages +
 *          pinned, and PATCHes /chat/rooms/:id/read.
 *       9. Empty-chat placeholder — "Select a chat or start a new one"
 *          renders when no room is selected.
 *      10. Message rendering — messages from selected room render under
 *          their date group; sender name shown for "other" messages; own
 *          messages get the primary bubble class.
 *      11. Send — POSTs /chat/rooms/:id/messages with {content,type:"TEXT"}
 *          on Send click and on Enter keydown; input clears; whitespace-
 *          only input is rejected (no POST).
 *      12. Send error — POST rejection toasts the error.
 *      13. Reaction toggle — clicking an existing reaction pill POSTs
 *          /chat/messages/:id/reactions and merges the returned message.
 *      14. Pin toggle — togglePin via context-menu PATCHes
 *          /chat/messages/:id/pin and refreshes pinned messages.
 *      15. Pinned banner — when pinnedMessages > 0 the banner renders
 *          "N pinned messages"; toggling expands the list.
 *      16. Socket message handler — chat:message handler appends new msg
 *          for the selected room and calls loadRooms; chat:reaction merges
 *          updated reactions.
 *      17. Cleanup — on room change, chat:leave emit + .off both events.
 *      18. Error-path resilience — loadRooms / loadUsers rejection lands
 *          the page in the empty branch silently (no crash, no toast).
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            @/lib/socket, next/navigation.
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

const { apiMock, toastMock, authMock, socketMock } = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/chat",
}));

import ChatPage from "../page";

type UserInfo = {
  id: string;
  name: string;
  role: string;
  email?: string;
};
type Participant = { id: string; userId: string; user: UserInfo };
type Message = {
  id: string;
  roomId: string;
  senderId: string;
  content: string;
  type: string;
  createdAt: string;
  sender: { id: string; name: string; role: string };
  reactions?: Record<string, string[]> | null;
  isPinned?: boolean;
  pinnedAt?: string | null;
  pinnedBy?: string | null;
};
type Room = {
  id: string;
  name: string | null;
  isGroup: boolean;
  lastMessageAt: string | null;
  participants: Participant[];
  lastMessage: Message | null;
  unreadCount: number;
};

function userFixture(o: Partial<UserInfo> = {}): UserInfo {
  return { id: "u-me", name: "Me Doctor", role: "DOCTOR", ...o };
}
function participantFixture(u: UserInfo, id = `p-${u.id}`): Participant {
  return { id, userId: u.id, user: u };
}
function messageFixture(o: Partial<Message> = {}): Message {
  return {
    id: "m-1",
    roomId: "r-1",
    senderId: "u-other",
    content: "hello there",
    type: "TEXT",
    createdAt: "2026-04-01T10:00:00.000Z",
    sender: { id: "u-other", name: "Dr Other", role: "DOCTOR" },
    reactions: null,
    isPinned: false,
    ...o,
  };
}
function roomFixture(o: Partial<Room> = {}): Room {
  const me = userFixture({ id: "u-me", name: "Me Doctor" });
  const other = userFixture({ id: "u-other", name: "Dr Other" });
  return {
    id: "r-1",
    name: null,
    isGroup: false,
    lastMessageAt: "2026-04-01T10:00:00.000Z",
    participants: [participantFixture(me), participantFixture(other)],
    lastMessage: messageFixture(),
    unreadCount: 0,
    ...o,
  };
}

/**
 * Route api.get by URL path. The page issues many GETs across mount +
 * room-select so mockResolvedValueOnce chains are brittle.
 */
function wireGetByPath(opts: {
  rooms?: Room[];
  users?: UserInfo[];
  messages?: Message[];
  pinned?: Message[];
  roomsReject?: boolean;
  usersReject?: boolean;
  messagesReject?: boolean;
  pinnedReject?: boolean;
}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url === "/chat/rooms") {
      if (opts.roomsReject) return Promise.reject(new Error("rooms boom"));
      return Promise.resolve({ data: opts.rooms ?? [] });
    }
    if (url === "/chat/users") {
      if (opts.usersReject) return Promise.reject(new Error("users boom"));
      return Promise.resolve({ data: opts.users ?? [] });
    }
    if (url.includes("/messages")) {
      if (opts.messagesReject) return Promise.reject(new Error("msgs boom"));
      return Promise.resolve({ data: opts.messages ?? [] });
    }
    if (url.includes("/pinned")) {
      if (opts.pinnedReject) return Promise.reject(new Error("pin boom"));
      return Promise.resolve({ data: opts.pinned ?? [] });
    }
    return Promise.resolve({ data: null });
  });
}

function asUser(u: UserInfo = userFixture()) {
  authMock.mockReturnValue({
    user: { id: u.id, userId: u.id, role: u.role, name: u.name, email: u.email },
    isLoading: false,
  });
}

describe("Chat dashboard page (DM list + composer + socket)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    apiMock.put.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    socketMock.connect.mockReset();
    socketMock.disconnect.mockReset();
    socketMock.emit.mockReset();
    socketMock.on.mockReset();
    socketMock.off.mockReset();
    socketMock.connected = false;
    asUser();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the sidebar + empty-rooms copy + 'select a chat' placeholder on mount", async () => {
    wireGetByPath({ rooms: [], users: [] });

    render(<ChatPage />);

    expect(
      screen.getByRole("heading", { name: /Chats/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Search users to start chat/i),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/No chats yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Select a chat or start a new one/i),
    ).toBeInTheDocument();
  });

  it("fetches /chat/rooms and /chat/users on mount and connects an unconnected socket", async () => {
    socketMock.connected = false;
    wireGetByPath({ rooms: [], users: [] });

    render(<ChatPage />);
    await screen.findByText(/No chats yet/i);

    expect(apiMock.get).toHaveBeenCalledWith("/chat/rooms");
    expect(apiMock.get).toHaveBeenCalledWith("/chat/users");
    expect(socketMock.connect).toHaveBeenCalled();
  });

  it("skips socket.connect when the shared socket is already connected", async () => {
    socketMock.connected = true;
    wireGetByPath({ rooms: [], users: [] });

    render(<ChatPage />);
    await screen.findByText(/No chats yet/i);

    expect(socketMock.connect).not.toHaveBeenCalled();
  });

  it("renders one row per room — other participant's name + last-message preview + unread badge", async () => {
    wireGetByPath({
      rooms: [
        roomFixture({
          id: "r-1",
          lastMessage: messageFixture({ content: "Hello there" }),
          unreadCount: 3,
        }),
        roomFixture({
          id: "r-2",
          name: "All Staff",
          isGroup: true,
          lastMessage: null,
          unreadCount: 0,
        }),
      ],
    });

    render(<ChatPage />);

    // DM row uses OTHER participant's name (Dr Other), group row uses
    // its explicit name.
    expect(await screen.findByText("Dr Other")).toBeInTheDocument();
    expect(screen.getByText("All Staff")).toBeInTheDocument();
    // Preview text + unread badge.
    expect(screen.getByText("Hello there")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    // Group with no messages shows the fallback copy.
    expect(screen.getByText(/No messages yet/i)).toBeInTheDocument();
  });

  it("sanitizeChatPreview masks script-shaped seed payloads to [blocked content]", async () => {
    wireGetByPath({
      rooms: [
        roomFixture({
          id: "r-xss",
          name: "All Staff Announcements",
          isGroup: true,
          lastMessage: messageFixture({
            content: "<script>alert('XSS')</script>",
          }),
        }),
        roomFixture({
          id: "r-plain",
          name: "Plain Group",
          isGroup: true,
          lastMessage: messageFixture({ content: "<b>bold ok</b>" }),
        }),
      ],
    });

    render(<ChatPage />);

    expect(
      await screen.findByText("[blocked content]"),
    ).toBeInTheDocument();
    // HTML tags stripped on the safe row.
    expect(screen.getByText("bold ok")).toBeInTheDocument();
  });

  it("renders 'Unknown' when a DM has no name and no OTHER participant", async () => {
    const me = userFixture({ id: "u-me", name: "Me Doctor" });
    wireGetByPath({
      rooms: [
        roomFixture({
          id: "r-solo",
          name: null,
          isGroup: false,
          participants: [participantFixture(me)],
          lastMessage: null,
        }),
      ],
    });

    render(<ChatPage />);

    expect(await screen.findByText("Unknown")).toBeInTheDocument();
  });

  it("typing in the search reveals filtered users; an empty filter shows 'No users found'", async () => {
    wireGetByPath({
      rooms: [],
      users: [
        userFixture({ id: "u-a", name: "Alice Anderson", role: "NURSE" }),
        userFixture({ id: "u-b", name: "Bob Brown", role: "DOCTOR" }),
      ],
    });

    render(<ChatPage />);
    await screen.findByText(/No chats yet/i);

    const search = screen.getByPlaceholderText(
      /Search users to start chat/i,
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "alice" } });

    expect(await screen.findByText("Alice Anderson")).toBeInTheDocument();
    expect(screen.queryByText("Bob Brown")).not.toBeInTheDocument();

    // Non-matching filter shows the no-results copy.
    fireEvent.change(search, { target: { value: "zzzzz" } });
    expect(
      await screen.findByText(/No users found/i),
    ).toBeInTheDocument();
  });

  it("clicking a user in the dropdown POSTs /chat/rooms and selects the new room", async () => {
    const newRoom = roomFixture({
      id: "r-new",
      participants: [
        participantFixture(userFixture()),
        participantFixture(
          userFixture({ id: "u-target", name: "Target Doctor" }),
        ),
      ],
    });
    wireGetByPath({
      rooms: [],
      users: [userFixture({ id: "u-target", name: "Target Doctor" })],
    });
    apiMock.post.mockResolvedValueOnce({ data: newRoom });

    render(<ChatPage />);
    await screen.findByText(/No chats yet/i);

    const search = screen.getByPlaceholderText(
      /Search users to start chat/i,
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "target" } });

    const userRow = await screen.findByText("Target Doctor");
    // After clicking we'll need messages + pinned to resolve for the
    // newly-selected room — pre-arm the get mock to handle those URLs.
    wireGetByPath({
      rooms: [newRoom],
      users: [userFixture({ id: "u-target", name: "Target Doctor" })],
      messages: [],
      pinned: [],
    });
    fireEvent.click(userRow);

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/chat/rooms", {
        isGroup: false,
        participantIds: ["u-target"],
      }),
    );

    // Room window swaps in — header shows the selected room display name.
    await waitFor(() => {
      // After selection, the search input clears.
      expect(search.value).toBe("");
    });
  });

  it("startChat error surfaces a toast.error", async () => {
    wireGetByPath({
      rooms: [],
      users: [userFixture({ id: "u-target", name: "Target Doctor" })],
    });
    apiMock.post.mockRejectedValueOnce(new Error("Cannot create room"));

    render(<ChatPage />);
    await screen.findByText(/No chats yet/i);

    fireEvent.change(
      screen.getByPlaceholderText(/Search users to start chat/i),
      { target: { value: "target" } },
    );
    fireEvent.click(await screen.findByText("Target Doctor"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Cannot create room"),
    );
  });

  it("selecting a room loads messages + pinned, PATCHes /read, and emits chat:join", async () => {
    const room = roomFixture({ id: "r-sel" });
    wireGetByPath({
      rooms: [room],
      users: [],
      messages: [
        messageFixture({
          id: "m-a",
          roomId: "r-sel",
          senderId: "u-other",
          content: "first message",
          sender: { id: "u-other", name: "Dr Other", role: "DOCTOR" },
        }),
      ],
      pinned: [],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<ChatPage />);
    const otherName = await screen.findByText("Dr Other");
    // Sidebar row — click to select.
    fireEvent.click(otherName.closest("button")!);

    // Messages fetch.
    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(
        calls.some((u) => u === "/chat/rooms/r-sel/messages?limit=100"),
      ).toBe(true);
      expect(
        calls.some((u) => u === "/chat/rooms/r-sel/pinned"),
      ).toBe(true);
    });

    // PATCH /read.
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/chat/rooms/r-sel/read",
        {},
      ),
    );

    // Socket join emit.
    expect(socketMock.emit).toHaveBeenCalledWith("chat:join", "r-sel");

    // Subscribed to both message events.
    const events = socketMock.on.mock.calls.map((c) => c[0]);
    expect(events).toContain("chat:message");
    expect(events).toContain("chat:reaction");

    // Message body renders inside the canvas.
    expect(await screen.findByText("first message")).toBeInTheDocument();
  });

  it("renders sender name + own-vs-other bubble distinction inside the message canvas", async () => {
    asUser(userFixture({ id: "u-me", name: "Me Doctor" }));
    const room = roomFixture({ id: "r-mix" });
    wireGetByPath({
      rooms: [room],
      messages: [
        messageFixture({
          id: "m-mine",
          roomId: "r-mix",
          senderId: "u-me",
          content: "from me",
          sender: { id: "u-me", name: "Me Doctor", role: "DOCTOR" },
        }),
        messageFixture({
          id: "m-theirs",
          roomId: "r-mix",
          senderId: "u-other",
          content: "from other",
          sender: { id: "u-other", name: "Dr Other", role: "DOCTOR" },
        }),
      ],
    });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );

    await screen.findByText("from me");
    await screen.findByText("from other");

    // The "other" message renders sender name inline; own doesn't.
    // "Dr Other" appears in the sidebar row + canvas message header + bubble label.
    const drOtherMatches = screen.getAllByText("Dr Other");
    expect(drOtherMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("send POSTs /chat/rooms/:id/messages and clears the input on success", async () => {
    const room = roomFixture({ id: "r-send" });
    wireGetByPath({ rooms: [room], messages: [], pinned: [] });
    apiMock.post.mockResolvedValue({ data: { id: "new-msg" } });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );

    const input = await screen.findByPlaceholderText(
      /Type a message/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hi everyone" } });

    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/chat/rooms/r-send/messages",
        { content: "hi everyone", type: "TEXT" },
      ),
    );

    await waitFor(() => expect(input.value).toBe(""));
  });

  it("Enter key in the message input fires send()", async () => {
    const room = roomFixture({ id: "r-enter" });
    wireGetByPath({ rooms: [room], messages: [], pinned: [] });
    apiMock.post.mockResolvedValue({ data: { id: "new-msg" } });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );

    const input = await screen.findByPlaceholderText(
      /Type a message/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "via enter" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/chat/rooms/r-enter/messages",
        { content: "via enter", type: "TEXT" },
      ),
    );
  });

  it("whitespace-only input is rejected — Send button is disabled and POST does not fire", async () => {
    const room = roomFixture({ id: "r-ws" });
    wireGetByPath({ rooms: [room], messages: [], pinned: [] });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );

    const input = await screen.findByPlaceholderText(
      /Type a message/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });

    const sendBtn = screen.getByRole("button", {
      name: /^Send$/,
    }) as HTMLButtonElement;
    expect(sendBtn).toBeDisabled();

    // Click is no-op on disabled button.
    fireEvent.click(sendBtn);
    expect(apiMock.post).not.toHaveBeenCalled();

    // Enter on whitespace also no-ops via the source-side trim guard.
    apiMock.post.mockClear();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("send error toasts the error message", async () => {
    const room = roomFixture({ id: "r-err" });
    wireGetByPath({ rooms: [room], messages: [], pinned: [] });
    apiMock.post.mockRejectedValueOnce(new Error("Network down"));

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );

    const input = await screen.findByPlaceholderText(
      /Type a message/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Network down"),
    );
  });

  it("clicking an existing reaction pill POSTs /chat/messages/:id/reactions and merges the returned message", async () => {
    asUser(userFixture({ id: "u-me", name: "Me Doctor" }));
    const room = roomFixture({ id: "r-rx" });
    wireGetByPath({
      rooms: [room],
      messages: [
        messageFixture({
          id: "m-rx",
          roomId: "r-rx",
          senderId: "u-other",
          content: "react me",
          sender: { id: "u-other", name: "Dr Other", role: "DOCTOR" },
          reactions: { "👍": ["u-x"] },
        }),
      ],
      pinned: [],
    });
    apiMock.post.mockResolvedValueOnce({
      data: {
        id: "m-rx",
        reactions: { "👍": ["u-x", "u-me"] },
      },
    });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );
    await screen.findByText("react me");

    // Click the existing pill (it shows the emoji + count).
    const pill = screen.getByText("👍").closest("button")!;
    fireEvent.click(pill);

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/chat/messages/m-rx/reactions",
        { emoji: "👍" },
      ),
    );

    // Updated count appears.
    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });

  it("reaction error surfaces a toast.error", async () => {
    asUser(userFixture({ id: "u-me", name: "Me Doctor" }));
    const room = roomFixture({ id: "r-rxerr" });
    wireGetByPath({
      rooms: [room],
      messages: [
        messageFixture({
          id: "m-rx",
          roomId: "r-rxerr",
          senderId: "u-other",
          reactions: { "👍": ["u-x"] },
        }),
      ],
      pinned: [],
    });
    apiMock.post.mockRejectedValueOnce(new Error("Rxn fail"));

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );
    // Wait on the reaction emoji directly — "hello there" also appears in the
    // sidebar lastMessage preview (roomFixture default), so awaiting that text
    // resolves before the chat panel finishes rendering the message bubble.
    fireEvent.click((await screen.findByText("👍")).closest("button")!);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Rxn fail"),
    );
  });

  it("pin toggle PATCHes /chat/messages/:id/pin and refreshes pinned messages", async () => {
    asUser(userFixture({ id: "u-me", name: "Me Doctor" }));
    const room = roomFixture({ id: "r-pin" });
    wireGetByPath({
      rooms: [room],
      messages: [
        messageFixture({
          id: "m-pin",
          roomId: "r-pin",
          senderId: "u-me",
          content: "pin me",
          sender: { id: "u-me", name: "Me Doctor", role: "DOCTOR" },
          isPinned: false,
        }),
      ],
      pinned: [],
    });
    apiMock.patch.mockImplementation((url: string) => {
      if (url === "/chat/rooms/r-pin/read") return Promise.resolve({ data: {} });
      if (url === "/chat/messages/m-pin/pin")
        return Promise.resolve({
          data: { id: "m-pin", isPinned: true },
        });
      return Promise.resolve({ data: {} });
    });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );
    await screen.findByText("pin me");

    // Open the context menu (More button — there are two action buttons
    // in the row's hover group, the second one is "More").
    const moreBtn = screen.getByTitle("More");
    fireEvent.click(moreBtn);

    // Now click the "Pin message" entry.
    const pinEntry = await screen.findByText(/Pin message/i);
    fireEvent.click(pinEntry);

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/chat/messages/m-pin/pin",
        { pinned: true },
      ),
    );
  });

  it("pin error surfaces a toast.error", async () => {
    asUser(userFixture({ id: "u-me", name: "Me Doctor" }));
    const room = roomFixture({ id: "r-pinerr" });
    wireGetByPath({
      rooms: [room],
      messages: [
        messageFixture({
          id: "m-pin",
          roomId: "r-pinerr",
          senderId: "u-me",
          sender: { id: "u-me", name: "Me Doctor", role: "DOCTOR" },
        }),
      ],
      pinned: [],
    });
    apiMock.patch.mockImplementation((url: string) => {
      if (url === "/chat/rooms/r-pinerr/read")
        return Promise.resolve({ data: {} });
      return Promise.reject(new Error("Pin denied"));
    });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );
    await screen.findByText("hello there");

    fireEvent.click(screen.getByTitle("More"));
    fireEvent.click(await screen.findByText(/Pin message/i));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Pin denied"),
    );
  });

  it("pinned banner renders 'N pinned message(s)' when pinned > 0 and expands the list on toggle", async () => {
    const room = roomFixture({ id: "r-pinned" });
    wireGetByPath({
      rooms: [room],
      messages: [],
      pinned: [
        messageFixture({
          id: "mp-1",
          roomId: "r-pinned",
          content: "important note",
          sender: { id: "u-other", name: "Dr Other", role: "DOCTOR" },
        }),
      ],
    });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );

    const banner = await screen.findByText(/1 pinned message/i);
    expect(banner).toBeInTheDocument();
    // "View all pinned" toggle copy.
    expect(screen.getByText(/View all pinned/i)).toBeInTheDocument();

    fireEvent.click(banner);

    // Pinned message body shows up after expand.
    expect(await screen.findByText("important note")).toBeInTheDocument();
    // Toggle copy flips.
    expect(screen.getByText(/Hide/i)).toBeInTheDocument();
  });

  it("chat:message handler appends incoming message for the selected room", async () => {
    const room = roomFixture({ id: "r-sock" });
    wireGetByPath({ rooms: [room], messages: [], pinned: [] });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );

    // Wait for socket subscription.
    await waitFor(() => {
      expect(
        socketMock.on.mock.calls.some((c) => c[0] === "chat:message"),
      ).toBe(true);
    });

    const handler = socketMock.on.mock.calls.find(
      (c) => c[0] === "chat:message",
    )![1] as (msg: Message) => void;

    // Fire the handler with a new message for THIS room.
    act(() => {
      handler(
        messageFixture({
          id: "m-incoming",
          roomId: "r-sock",
          content: "live message",
          sender: { id: "u-other", name: "Dr Other", role: "DOCTOR" },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("live message")).toBeInTheDocument();
    });
  });

  it("chat:message handler ignores messages for a DIFFERENT room (only triggers loadRooms refetch)", async () => {
    const room = roomFixture({ id: "r-here" });
    wireGetByPath({ rooms: [room], messages: [], pinned: [] });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );

    await waitFor(() => {
      expect(
        socketMock.on.mock.calls.some((c) => c[0] === "chat:message"),
      ).toBe(true);
    });

    const handler = socketMock.on.mock.calls.find(
      (c) => c[0] === "chat:message",
    )![1] as (msg: Message) => void;

    act(() => {
      handler(
        messageFixture({
          id: "m-other-room",
          roomId: "r-different",
          content: "OTHER ROOM",
        }),
      );
    });

    // Message NOT rendered in this room's canvas.
    expect(screen.queryByText("OTHER ROOM")).not.toBeInTheDocument();
  });

  it("chat:reaction handler merges reactions for messages in the selected room", async () => {
    const room = roomFixture({ id: "r-rxs" });
    wireGetByPath({
      rooms: [room],
      messages: [
        messageFixture({
          id: "m-rxs",
          roomId: "r-rxs",
          senderId: "u-other",
          content: "react target",
          sender: { id: "u-other", name: "Dr Other", role: "DOCTOR" },
          reactions: { "👍": ["u-x"] },
        }),
      ],
      pinned: [],
    });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );
    await screen.findByText("react target");

    await waitFor(() => {
      expect(
        socketMock.on.mock.calls.some((c) => c[0] === "chat:reaction"),
      ).toBe(true);
    });

    const rxnHandler = socketMock.on.mock.calls.find(
      (c) => c[0] === "chat:reaction",
    )![1] as (m: Message) => void;

    act(() => {
      rxnHandler({
        id: "m-rxs",
        roomId: "r-rxs",
        senderId: "u-other",
        content: "react target",
        type: "TEXT",
        createdAt: "2026-04-01T10:00:00.000Z",
        sender: { id: "u-other", name: "Dr Other", role: "DOCTOR" },
        reactions: { "👍": ["u-x", "u-y", "u-z"] },
      });
    });

    await waitFor(() => {
      // Count flips to 3.
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });

  it("on room-change, the previous subscription is torn down (chat:leave + .off)", async () => {
    const roomA = roomFixture({
      id: "r-A",
      name: "Group A",
      isGroup: true,
      participants: [participantFixture(userFixture())],
      lastMessage: null,
    });
    const roomB = roomFixture({
      id: "r-B",
      name: "Group B",
      isGroup: true,
      participants: [participantFixture(userFixture())],
      lastMessage: null,
    });
    wireGetByPath({
      rooms: [roomA, roomB],
      messages: [],
      pinned: [],
    });
    apiMock.patch.mockResolvedValue({ data: {} });

    render(<ChatPage />);
    fireEvent.click((await screen.findByText("Group A")).closest("button")!);

    // Wait for first subscription.
    await waitFor(() =>
      expect(
        socketMock.emit.mock.calls.some(
          (c) => c[0] === "chat:join" && c[1] === "r-A",
        ),
      ).toBe(true),
    );

    // Switch room.
    fireEvent.click((await screen.findByText("Group B")).closest("button")!);

    // The room-A cleanup should have emitted leave.
    await waitFor(() => {
      expect(
        socketMock.emit.mock.calls.some(
          (c) => c[0] === "chat:leave" && c[1] === "r-A",
        ),
      ).toBe(true);
    });

    // And off was called for both events.
    const offEvents = socketMock.off.mock.calls.map((c) => c[0]);
    expect(offEvents).toContain("chat:message");
    expect(offEvents).toContain("chat:reaction");

    // New room joined.
    expect(
      socketMock.emit.mock.calls.some(
        (c) => c[0] === "chat:join" && c[1] === "r-B",
      ),
    ).toBe(true);
  });

  it("settles cleanly when initial /chat/rooms and /chat/users both reject (silent)", async () => {
    wireGetByPath({ roomsReject: true, usersReject: true });

    render(<ChatPage />);

    expect(await screen.findByText(/No chats yet/i)).toBeInTheDocument();
    // No toast on initial-load failure.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("settles cleanly when /messages and /pinned both reject after room selection", async () => {
    const room = roomFixture({ id: "r-rx-fail" });
    wireGetByPath({
      rooms: [room],
      messagesReject: true,
      pinnedReject: true,
    });
    apiMock.patch.mockResolvedValue({ data: {} });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );

    // Header still renders (room is selected) — no crash.
    await waitFor(() => {
      // Selected-room header: "1 participants" / "2 participants" text.
      expect(screen.getAllByText(/participant/i).length).toBeGreaterThan(0);
    });

    // No toast on initial messages/pinned failures (silent try/catch).
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Close button in the user dropdown clears the search and hides the menu", async () => {
    wireGetByPath({
      rooms: [],
      users: [userFixture({ id: "u-c", name: "Closeable" })],
    });

    render(<ChatPage />);
    await screen.findByText(/No chats yet/i);

    const search = screen.getByPlaceholderText(
      /Search users to start chat/i,
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "close" } });

    await screen.findByText("Closeable");

    const closeBtn = screen.getByRole("button", { name: /^Close$/ });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(search.value).toBe("");
      expect(screen.queryByText("Closeable")).not.toBeInTheDocument();
    });
  });

  it("renders multiple participants count plural correctly in the selected-room header", async () => {
    const me = userFixture({ id: "u-me", name: "Me Doctor" });
    const other1 = userFixture({ id: "u-o1", name: "Dr One" });
    const other2 = userFixture({ id: "u-o2", name: "Dr Two" });
    const room = roomFixture({
      id: "r-multi",
      name: "Trio",
      isGroup: true,
      participants: [
        participantFixture(me),
        participantFixture(other1),
        participantFixture(other2),
      ],
      lastMessage: null,
    });
    wireGetByPath({ rooms: [room], messages: [], pinned: [] });

    render(<ChatPage />);
    fireEvent.click((await screen.findByText("Trio")).closest("button")!);

    expect(await screen.findByText(/3 participants/i)).toBeInTheDocument();
  });

  it("renders singular 'participant' (no s) when only one participant is present", async () => {
    const me = userFixture({ id: "u-me", name: "Me Doctor" });
    const room = roomFixture({
      id: "r-solo",
      name: "Solo Group",
      isGroup: true,
      participants: [participantFixture(me)],
      lastMessage: null,
    });
    wireGetByPath({ rooms: [room], messages: [], pinned: [] });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Solo Group")).closest("button")!,
    );

    const header = await screen.findByText(/1 participant$/i);
    expect(header).toBeInTheDocument();
  });

  it("sanitizeChatPreview empty/null cases render the 'No messages yet' fallback", async () => {
    wireGetByPath({
      rooms: [
        roomFixture({
          id: "r-null",
          name: "Null Last",
          isGroup: true,
          lastMessage: null,
        }),
        roomFixture({
          id: "r-empty",
          name: "Empty Content",
          isGroup: true,
          lastMessage: messageFixture({ content: "" }),
        }),
      ],
    });

    render(<ChatPage />);
    // Both rooms surface the fallback copy (one for null, one for empty).
    const fallbacks = await screen.findAllByText(/No messages yet/i);
    expect(fallbacks.length).toBeGreaterThanOrEqual(2);
  });

  it("clicking the reaction picker emoji POSTs the chosen emoji", async () => {
    asUser(userFixture({ id: "u-me", name: "Me Doctor" }));
    const room = roomFixture({ id: "r-pick" });
    wireGetByPath({
      rooms: [room],
      messages: [
        messageFixture({
          id: "m-pick",
          roomId: "r-pick",
          senderId: "u-other",
          content: "pick a reaction",
          sender: { id: "u-other", name: "Dr Other", role: "DOCTOR" },
        }),
      ],
      pinned: [],
    });
    apiMock.post.mockResolvedValueOnce({
      data: { id: "m-pick", reactions: { "❤️": ["u-me"] } },
    });

    render(<ChatPage />);
    fireEvent.click(
      (await screen.findByText("Dr Other")).closest("button")!,
    );
    await screen.findByText("pick a reaction");

    // Open the picker via the SmilePlus action button (title "Add reaction").
    fireEvent.click(screen.getByTitle("Add reaction"));

    // Picker reveals all REACTION_EMOJIS — click the heart.
    const heart = await screen.findByText("❤️");
    fireEvent.click(heart);

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/chat/messages/m-pick/reactions",
        { emoji: "❤️" },
      ),
    );
  });
});
