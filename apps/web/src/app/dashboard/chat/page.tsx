"use client";

import { useEffect, useRef, useState } from "react";
import { Pin, SmilePlus, MoreHorizontal } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { getSocket } from "@/lib/socket";

interface UserInfo {
  id: string;
  name: string;
  role: string;
  email?: string;
}

interface Participant {
  id: string;
  userId: string;
  user: UserInfo;
}

interface Message {
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
}

interface Room {
  id: string;
  name: string | null;
  isGroup: boolean;
  lastMessageAt: string | null;
  participants: Participant[];
  lastMessage: Message | null;
  unreadCount: number;
}

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Issue #850 — sanitize a chat last-message preview before rendering.
 *
 * The chat list shows the trailing text of each room's last message as a
 * single-line preview. A staging seed row in `All Staff Announcements`
 * literally read `alert('XSS')` and was rendered verbatim, which both
 * presents an injection-shaped payload as legitimate operational content
 * AND demonstrates the preview slot does nothing to defuse script-like
 * input. This helper:
 *   1. Strips any HTML/script tags so a payload like `<script>alert(1)</script>`
 *      shows as plain text without the surrounding markup.
 *   2. Collapses adjacent whitespace + trims, so single-line previews stay
 *      legible.
 *   3. If the result still matches a JS-call-shape pattern (e.g.
 *      `alert(...)`, `eval(...)`, `<script>`, `onerror=`), masks it to
 *      `[blocked content]` so seed-data injections don't surface as
 *      apparent operational content.
 * The full message body (rendered with `whitespace-pre-wrap` in the chat
 * canvas) is unaffected — we only sanitize the at-a-glance preview slot.
 */
function sanitizeChatPreview(raw: string | undefined | null): string {
  if (!raw) return "";
  // Strip tags (greedy match of `<...>` blocks)
  const stripped = String(raw).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (!stripped) return "";
  // Pattern-match script-shaped seed data and mask it; everything else
  // passes through as plain text.
  const SUSPICIOUS = /(?:\b(?:alert|eval|prompt|confirm|document\.|window\.|javascript:)\b|on\w+\s*=)/i;
  if (SUSPICIOUS.test(stripped)) {
    return "[blocked content]";
  }
  return stripped;
}

function groupByDate(messages: Message[]): Array<{ date: string; msgs: Message[] }> {
  const groups: Record<string, Message[]> = {};
  for (const m of messages) {
    const d = new Date(m.createdAt).toDateString();
    if (!groups[d]) groups[d] = [];
    groups[d].push(m);
  }
  return Object.entries(groups).map(([date, msgs]) => ({ date, msgs }));
}

export default function ChatPage() {
  const { user } = useAuthStore();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pinnedMessages, setPinnedMessages] = useState<Message[]>([]);
  const [showPinned, setShowPinned] = useState(false);
  const [input, setInput] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [showUsers, setShowUsers] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadRooms();
    loadUsers();
    const sock = getSocket();
    if (!sock.connected) sock.connect();
    return () => {
      // don't disconnect — shared socket
    };
  }, []);

  useEffect(() => {
    if (!selectedRoom) return;
    const sock = getSocket();
    sock.emit("chat:join", selectedRoom.id);
    loadMessages(selectedRoom.id);
    loadPinned(selectedRoom.id);
    markRead(selectedRoom.id);

    const handler = (msg: Message) => {
      if (msg.roomId === selectedRoom.id) {
        setMessages((prev) => [msg, ...prev]);
        scrollToBottom();
      }
      loadRooms();
    };
    const reactionHandler = (msg: Message) => {
      if (msg.roomId === selectedRoom.id) {
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m))
        );
      }
    };
    sock.on("chat:message", handler);
    sock.on("chat:reaction", reactionHandler);

    return () => {
      sock.emit("chat:leave", selectedRoom.id);
      sock.off("chat:message", handler);
      sock.off("chat:reaction", reactionHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoom?.id]);

  async function loadRooms() {
    try {
      const res = await api.get<{ data: Room[] }>("/chat/rooms");
      setRooms(res.data);
      setSelectedRoom((current) => {
        if (!current) return current;
        return res.data.find((room) => room.id === current.id) ?? current;
      });
    } catch {
      // empty
    }
  }

  async function loadUsers() {
    try {
      const res = await api.get<{ data: UserInfo[] }>("/chat/users");
      setUsers(res.data);
    } catch {
      // empty
    }
  }

  async function loadMessages(roomId: string) {
    try {
      const res = await api.get<{ data: Message[] }>(
        `/chat/rooms/${roomId}/messages?limit=100`
      );
      setMessages(res.data);
      setTimeout(scrollToBottom, 50);
    } catch {
      setMessages([]);
    }
  }

  async function loadPinned(roomId: string) {
    try {
      const res = await api.get<{ data: Message[] }>(
        `/chat/rooms/${roomId}/pinned`
      );
      setPinnedMessages(res.data);
    } catch {
      setPinnedMessages([]);
    }
  }

  async function markRead(roomId: string) {
    try {
      await api.patch(`/chat/rooms/${roomId}/read`, {});
      loadRooms();
    } catch {
      // empty
    }
  }

  async function startChat(otherUserId: string) {
    try {
      const res = await api.post<{ data: Room }>("/chat/rooms", {
        isGroup: false,
        participantIds: [otherUserId],
      });
      setShowUsers(false);
      setUserSearch("");
      await loadRooms();
      setSelectedRoom(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function send() {
    if (!input.trim() || !selectedRoom) return;
    try {
      const res = await api.post<{ data: Message }>(
        `/chat/rooms/${selectedRoom.id}/messages`,
        {
          content: input,
          type: "TEXT",
        },
      );
      setInput("");
      if (res.data) {
        setMessages((prev) =>
          prev.some((m) => m.id === res.data.id) ? prev : [res.data, ...prev],
        );
        setTimeout(scrollToBottom, 50);
      }
      void loadRooms();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function toggleReaction(messageId: string, emoji: string) {
    try {
      const res = await api.post<{ data: Message }>(
        `/chat/messages/${messageId}/reactions`,
        { emoji }
      );
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, ...res.data } : m))
      );
      setPickerFor(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reaction failed");
    }
  }

  async function togglePin(msg: Message) {
    try {
      const res = await api.patch<{ data: Message }>(
        `/chat/messages/${msg.id}/pin`,
        { pinned: !msg.isPinned }
      );
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, ...res.data } : m))
      );
      if (selectedRoom) loadPinned(selectedRoom.id);
      setMenuFor(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Pin failed");
    }
  }

  function scrollToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }

  function roomDisplayName(room: Room): string {
    if (room.name) return room.name;
    const other = room.participants.find((p) => p.userId !== user?.id);
    return other ? other.user.name : "Unknown";
  }

  const filteredUsers = users.filter((u) =>
    u.name.toLowerCase().includes(userSearch.toLowerCase())
  );

  const orderedMessages = [...messages].reverse();
  const groups = groupByDate(orderedMessages);

  return (
    <div className="flex h-[calc(100vh-3rem)] overflow-hidden rounded-xl bg-white shadow-sm dark:bg-gray-800">
      {/* Sidebar */}
      <div className="flex w-80 flex-col border-r border-gray-200 dark:border-gray-700">
        <div className="border-b border-gray-200 p-3 dark:border-gray-700">
          <h2 className="mb-2 font-semibold">Chats</h2>
          <input
            type="text"
            value={userSearch}
            onChange={(e) => {
              setUserSearch(e.target.value);
              setShowUsers(true);
            }}
            onFocus={() => setShowUsers(true)}
            placeholder="Search users to start chat..."
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          {showUsers && userSearch && (
            <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow dark:border-gray-700 dark:bg-gray-800">
              {filteredUsers.length === 0 ? (
                <p className="p-3 text-sm text-gray-500 dark:text-gray-400">No users found</p>
              ) : (
                filteredUsers.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => startChat(u.id)}
                    className="flex w-full items-center gap-2 border-b border-gray-100 p-2 text-left text-sm last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
                      {initials(u.name)}
                    </div>
                    <div>
                      <p className="font-medium">{u.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{u.role}</p>
                    </div>
                  </button>
                ))
              )}
              <button
                onClick={() => {
                  setShowUsers(false);
                  setUserSearch("");
                }}
                className="w-full border-t border-gray-200 p-2 text-xs text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700/50"
              >
                Close
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {rooms.length === 0 ? (
            <p className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">
              No chats yet. Search for a user above to start.
            </p>
          ) : (
            rooms.map((room) => {
              const displayName = roomDisplayName(room);
              const isActive = selectedRoom?.id === room.id;
              return (
                <button
                  key={room.id}
                  onClick={() => setSelectedRoom(room)}
                  className={`flex w-full items-center gap-3 border-b border-gray-100 p-3 text-left transition last:border-0 dark:border-gray-700 ${
                    isActive
                      ? "bg-blue-50 dark:bg-blue-900/30"
                      : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  }`}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">
                    {initials(displayName)}
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <div className="flex items-center justify-between">
                      <p className="truncate font-medium">{displayName}</p>
                      {room.lastMessageAt && (
                        <span className="text-xs text-gray-400">
                          {new Date(room.lastMessageAt).toLocaleTimeString(
                            [],
                            { hour: "2-digit", minute: "2-digit" }
                          )}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                        {sanitizeChatPreview(room.lastMessage?.content) || "No messages yet"}
                      </p>
                      {room.unreadCount > 0 && (
                        <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs text-white">
                          {room.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Chat window */}
      <div className="flex flex-1 flex-col">
        {!selectedRoom ? (
          <div className="flex flex-1 items-center justify-center text-gray-400">
            Select a chat or start a new one
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">
                {initials(roomDisplayName(selectedRoom))}
              </div>
              <div className="flex-1">
                <p className="font-semibold">{roomDisplayName(selectedRoom)}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {selectedRoom.participants.length} participant
                  {selectedRoom.participants.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>

            {/* Pinned banner */}
            {pinnedMessages.length > 0 && (
              <div className="border-b border-gray-200 bg-amber-50 px-4 py-2 text-xs dark:border-gray-700 dark:bg-amber-900/20">
                <button
                  onClick={() => setShowPinned(!showPinned)}
                  className="flex items-center gap-2 font-medium text-amber-900 hover:text-amber-700 dark:text-amber-200 dark:hover:text-amber-300"
                >
                  <Pin size={12} />
                  {pinnedMessages.length} pinned message
                  {pinnedMessages.length !== 1 ? "s" : ""}
                  <span className="text-amber-700 underline dark:text-amber-300">
                    {showPinned ? "Hide" : "View all pinned"}
                  </span>
                </button>
                {showPinned && (
                  <div className="mt-2 space-y-2">
                    {pinnedMessages.map((p) => (
                      <div
                        key={p.id}
                        className="rounded bg-white px-3 py-2 text-xs shadow-sm dark:bg-gray-700"
                      >
                        <p className="mb-0.5 font-semibold text-gray-700 dark:text-gray-200">
                          {p.sender?.name || "User"}
                        </p>
                        <p className="text-gray-600 dark:text-gray-300">{p.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div
              ref={scrollRef}
              className="flex-1 space-y-4 overflow-y-auto bg-gray-50 p-4 dark:bg-gray-900"
              onClick={() => {
                setMenuFor(null);
                setPickerFor(null);
              }}
            >
              {groups.map((g) => (
                <div key={g.date}>
                  <div className="mb-2 text-center">
                    <span className="rounded-full bg-gray-200 px-3 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                      {g.date}
                    </span>
                  </div>
                  {g.msgs.map((m) => {
                    const mine = m.senderId === user?.id;
                    const reactions = (m.reactions || {}) as Record<string, string[]>;
                    const reactionEntries = Object.entries(reactions).filter(
                      ([, arr]) => arr && arr.length > 0
                    );
                    return (
                      <div
                        key={m.id}
                        className={`group mb-2 flex gap-2 ${mine ? "flex-row-reverse" : ""}`}
                      >
                        <div
                          className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white ${
                            mine ? "bg-primary" : "bg-gray-400"
                          }`}
                        >
                          {initials(m.sender.name)}
                        </div>
                        <div className="relative flex max-w-md flex-col gap-1">
                          <div
                            className={`rounded-2xl px-4 py-2 text-sm ${
                              mine
                                ? "bg-primary text-white"
                                : "bg-white text-gray-800 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                            }`}
                          >
                            {!mine && (
                              <p className="mb-1 text-xs font-semibold">
                                {m.sender.name}
                              </p>
                            )}
                            <p className="whitespace-pre-wrap">{m.content}</p>
                            <div className="mt-1 flex items-center gap-2">
                              {m.isPinned && (
                                <Pin
                                  size={10}
                                  className={
                                    mine ? "text-white/70" : "text-amber-500"
                                  }
                                />
                              )}
                              <p
                                className={`text-xs ${mine ? "text-white/70" : "text-gray-400"}`}
                              >
                                {new Date(m.createdAt).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </p>
                            </div>
                          </div>

                          {/* Reaction pills */}
                          {reactionEntries.length > 0 && (
                            <div
                              className={`flex flex-wrap gap-1 ${mine ? "justify-end" : ""}`}
                            >
                              {reactionEntries.map(([emoji, userIds]) => {
                                const reacted = user
                                  ? userIds.includes(user.id)
                                  : false;
                                return (
                                  <button
                                    key={emoji}
                                    onClick={() =>
                                      toggleReaction(m.id, emoji)
                                    }
                                    className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
                                      reacted
                                        ? "border-primary bg-primary/10"
                                        : "border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600"
                                    }`}
                                  >
                                    <span>{emoji}</span>
                                    <span className="font-semibold">
                                      {userIds.length}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          {/* Action buttons (visible on hover) */}
                          <div
                            className={`absolute ${mine ? "left-0 -translate-x-full" : "right-0 translate-x-full"} top-0 hidden gap-1 pr-2 pl-2 group-hover:flex`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={() =>
                                setPickerFor(
                                  pickerFor === m.id ? null : m.id
                                )
                              }
                              className="rounded-full bg-white p-1 shadow hover:bg-gray-50 dark:bg-gray-700 dark:hover:bg-gray-600"
                              title="Add reaction"
                            >
                              <SmilePlus size={14} />
                            </button>
                            <button
                              onClick={() =>
                                setMenuFor(menuFor === m.id ? null : m.id)
                              }
                              className="rounded-full bg-white p-1 shadow hover:bg-gray-50 dark:bg-gray-700 dark:hover:bg-gray-600"
                              title="More"
                            >
                              <MoreHorizontal size={14} />
                            </button>
                          </div>

                          {/* Reaction picker */}
                          {pickerFor === m.id && (
                            <div
                              className={`absolute ${mine ? "right-0" : "left-0"} -top-10 z-10 flex gap-1 rounded-full bg-white p-1 shadow-lg dark:bg-gray-800`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {REACTION_EMOJIS.map((emoji) => (
                                <button
                                  key={emoji}
                                  onClick={() => toggleReaction(m.id, emoji)}
                                  className="rounded-full p-1 text-lg transition hover:scale-125 hover:bg-gray-100 dark:hover:bg-gray-700"
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          )}

                          {/* Context menu */}
                          {menuFor === m.id && (
                            <div
                              className={`absolute ${mine ? "right-0" : "left-0"} top-8 z-10 w-40 rounded-lg bg-white py-1 shadow-lg dark:bg-gray-800`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                onClick={() => togglePin(m)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-700"
                              >
                                <Pin size={12} />
                                {m.isPinned ? "Unpin" : "Pin message"}
                              </button>
                              <button
                                onClick={() => {
                                  setPickerFor(m.id);
                                  setMenuFor(null);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-700"
                              >
                                <SmilePlus size={12} />
                                Add reaction
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="flex gap-2 border-t border-gray-200 p-3 dark:border-gray-700">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") send();
                }}
                placeholder="Type a message..."
                className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
              />
              <button
                onClick={send}
                disabled={!input.trim()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
