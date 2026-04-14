"use client";

import { useEffect, useRef, useState } from "react";
import { Pin, SmilePlus, MoreHorizontal } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
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
      alert(err instanceof Error ? err.message : "Failed");
    }
  }

  async function send() {
    if (!input.trim() || !selectedRoom) return;
    try {
      await api.post(`/chat/rooms/${selectedRoom.id}/messages`, {
        content: input,
        type: "TEXT",
      });
      setInput("");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed");
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
      alert(err instanceof Error ? err.message : "Reaction failed");
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
      alert(err instanceof Error ? err.message : "Pin failed");
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
    <div className="flex h-[calc(100vh-3rem)] overflow-hidden rounded-xl bg-white shadow-sm">
      {/* Sidebar */}
      <div className="flex w-80 flex-col border-r">
        <div className="border-b p-3">
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
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
          {showUsers && userSearch && (
            <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border bg-white shadow">
              {filteredUsers.length === 0 ? (
                <p className="p-3 text-sm text-gray-500">No users found</p>
              ) : (
                filteredUsers.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => startChat(u.id)}
                    className="flex w-full items-center gap-2 border-b p-2 text-left text-sm last:border-0 hover:bg-gray-50"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
                      {initials(u.name)}
                    </div>
                    <div>
                      <p className="font-medium">{u.name}</p>
                      <p className="text-xs text-gray-500">{u.role}</p>
                    </div>
                  </button>
                ))
              )}
              <button
                onClick={() => {
                  setShowUsers(false);
                  setUserSearch("");
                }}
                className="w-full border-t p-2 text-xs text-gray-500 hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {rooms.length === 0 ? (
            <p className="p-4 text-center text-sm text-gray-500">
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
                  className={`flex w-full items-center gap-3 border-b p-3 text-left transition last:border-0 ${
                    isActive ? "bg-blue-50" : "hover:bg-gray-50"
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
                      <p className="truncate text-xs text-gray-500">
                        {room.lastMessage?.content || "No messages yet"}
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
            <div className="flex items-center gap-3 border-b p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">
                {initials(roomDisplayName(selectedRoom))}
              </div>
              <div className="flex-1">
                <p className="font-semibold">{roomDisplayName(selectedRoom)}</p>
                <p className="text-xs text-gray-500">
                  {selectedRoom.participants.length} participant
                  {selectedRoom.participants.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>

            {/* Pinned banner */}
            {pinnedMessages.length > 0 && (
              <div className="border-b bg-amber-50 px-4 py-2 text-xs">
                <button
                  onClick={() => setShowPinned(!showPinned)}
                  className="flex items-center gap-2 font-medium text-amber-900 hover:text-amber-700"
                >
                  <Pin size={12} />
                  {pinnedMessages.length} pinned message
                  {pinnedMessages.length !== 1 ? "s" : ""}
                  <span className="text-amber-700 underline">
                    {showPinned ? "Hide" : "View all pinned"}
                  </span>
                </button>
                {showPinned && (
                  <div className="mt-2 space-y-2">
                    {pinnedMessages.map((p) => (
                      <div
                        key={p.id}
                        className="rounded bg-white px-3 py-2 text-xs shadow-sm"
                      >
                        <p className="mb-0.5 font-semibold text-gray-700">
                          {p.sender?.name || "User"}
                        </p>
                        <p className="text-gray-600">{p.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div
              ref={scrollRef}
              className="flex-1 space-y-4 overflow-y-auto bg-gray-50 p-4"
              onClick={() => {
                setMenuFor(null);
                setPickerFor(null);
              }}
            >
              {groups.map((g) => (
                <div key={g.date}>
                  <div className="mb-2 text-center">
                    <span className="rounded-full bg-gray-200 px-3 py-0.5 text-xs text-gray-600">
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
                                : "bg-white text-gray-800 shadow-sm"
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
                                        : "border-gray-200 bg-white hover:bg-gray-50"
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
                              className="rounded-full bg-white p-1 shadow hover:bg-gray-50"
                              title="Add reaction"
                            >
                              <SmilePlus size={14} />
                            </button>
                            <button
                              onClick={() =>
                                setMenuFor(menuFor === m.id ? null : m.id)
                              }
                              className="rounded-full bg-white p-1 shadow hover:bg-gray-50"
                              title="More"
                            >
                              <MoreHorizontal size={14} />
                            </button>
                          </div>

                          {/* Reaction picker */}
                          {pickerFor === m.id && (
                            <div
                              className={`absolute ${mine ? "right-0" : "left-0"} -top-10 z-10 flex gap-1 rounded-full bg-white p-1 shadow-lg`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {REACTION_EMOJIS.map((emoji) => (
                                <button
                                  key={emoji}
                                  onClick={() => toggleReaction(m.id, emoji)}
                                  className="rounded-full p-1 text-lg transition hover:scale-125 hover:bg-gray-100"
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          )}

                          {/* Context menu */}
                          {menuFor === m.id && (
                            <div
                              className={`absolute ${mine ? "right-0" : "left-0"} top-8 z-10 w-40 rounded-lg bg-white py-1 shadow-lg`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                onClick={() => togglePin(m)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50"
                              >
                                <Pin size={12} />
                                {m.isPinned ? "Unpin" : "Pin message"}
                              </button>
                              <button
                                onClick={() => {
                                  setPickerFor(m.id);
                                  setMenuFor(null);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50"
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

            <div className="flex gap-2 border-t p-3">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") send();
                }}
                placeholder="Type a message..."
                className="flex-1 rounded-lg border px-3 py-2 text-sm"
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
