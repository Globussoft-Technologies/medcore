"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, MoreHorizontal, Pin, SmilePlus } from "lucide-react";
import { api } from "@/lib/api";
import { getSocket } from "@/lib/socket";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

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

interface PresenceSnapshot {
  onlineUserIds?: string[];
  lastSeenAt?: Record<string, string>;
}

interface PresenceUpdate {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
}

interface TypingEvent {
  roomId: string;
  userId: string;
  isTyping?: boolean;
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

function sanitizeChatPreview(raw: string | undefined | null): string {
  if (!raw) return "";
  const stripped = String(raw).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (!stripped) return "";
  const suspicious =
    /(?:\b(?:alert|eval|prompt|confirm|document\.|window\.|javascript:)\b|on\w+\s*=)/i;
  if (suspicious.test(stripped)) {
    return "[blocked content]";
  }
  return stripped;
}

function groupByDate(messages: Message[]): Array<{ date: string; msgs: Message[] }> {
  const groups: Record<string, Message[]> = {};
  for (const m of messages) {
    const date = new Date(m.createdAt).toDateString();
    if (!groups[date]) groups[date] = [];
    groups[date].push(m);
  }
  return Object.entries(groups).map(([date, msgs]) => ({ date, msgs }));
}

function roomParticipants(room: Room | null | undefined): Participant[] {
  return room?.participants ?? [];
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
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [lastSeenByUser, setLastSeenByUser] = useState<Record<string, string | null>>({});
  const [typingByRoom, setTypingByRoom] = useState<Record<string, string[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTypingRoomRef = useRef<string | null>(null);
  const typingActiveRef = useRef(false);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    void loadRooms();
    void loadUsers();
    const sock = getSocket();
    if (!sock.connected) sock.connect();

    const presenceSnapshotHandler = (payload: PresenceSnapshot) => {
      setOnlineUserIds(new Set(payload.onlineUserIds ?? []));
      setLastSeenByUser(payload.lastSeenAt ?? {});
    };
    const presenceUpdateHandler = (payload: PresenceUpdate) => {
      setOnlineUserIds((prev) => {
        const next = new Set(prev);
        if (payload.online) next.add(payload.userId);
        else next.delete(payload.userId);
        return next;
      });
      if (payload.lastSeenAt) {
        setLastSeenByUser((prev) => ({ ...prev, [payload.userId]: payload.lastSeenAt }));
      }
    };

    sock.on("presence:snapshot", presenceSnapshotHandler);
    sock.on("presence:update", presenceUpdateHandler);

    return () => {
      sock.off("presence:snapshot", presenceSnapshotHandler);
      sock.off("presence:update", presenceUpdateHandler);
    };
  }, []);

  useEffect(() => {
    if (!selectedRoom) return;
    const sock = getSocket();
    sock.emit("chat:join", selectedRoom.id);
    void loadMessages(selectedRoom.id);
    void loadPinned(selectedRoom.id);
    void markRead(selectedRoom.id);

    const messageHandler = (msg: Message) => {
      if (msg.roomId === selectedRoom.id) {
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [msg, ...prev]));
        setTypingByRoom((prev) => ({ ...prev, [msg.roomId]: [] }));
        scrollToBottom();
        void markRead(selectedRoom.id);
      }
      void loadRooms();
    };

    const reactionHandler = (msg: Message) => {
      if (msg.roomId === selectedRoom.id) {
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)));
      }
      void loadRooms();
    };

    const typingHandler = (payload: TypingEvent) => {
      if (!payload.roomId || !payload.userId || payload.userId === user?.id) return;
      setTypingByRoom((prev) => {
        const current = prev[payload.roomId] ?? [];
        if (payload.isTyping === false) {
          return { ...prev, [payload.roomId]: current.filter((id) => id !== payload.userId) };
        }
        if (current.includes(payload.userId)) return prev;
        return { ...prev, [payload.roomId]: [...current, payload.userId] };
      });
    };

    sock.on("chat:message", messageHandler);
    sock.on("chat:reaction", reactionHandler);
    sock.on("chat:typing", typingHandler);

    return () => {
      stopTyping(selectedRoom.id);
      sock.emit("chat:leave", selectedRoom.id);
      sock.off("chat:message", messageHandler);
      sock.off("chat:reaction", reactionHandler);
      sock.off("chat:typing", typingHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoom?.id, user?.id]);

  async function loadRooms() {
    try {
      const res = await api.get<{ data: Room[] }>("/chat/rooms");
      setRooms(res.data);
      setSelectedRoom((current) => {
        if (!current) return current;
        return res.data.find((room) => room.id === current.id) ?? null;
      });
    } catch {
      // no-op
    }
  }

  async function loadUsers() {
    try {
      const res = await api.get<{ data: UserInfo[] }>("/chat/users");
      setUsers(res.data);
    } catch {
      // no-op
    }
  }

  async function loadMessages(roomId: string) {
    try {
      const res = await api.get<{ data: Message[] }>(`/chat/rooms/${roomId}/messages?limit=100`);
      setMessages(res.data);
      setTimeout(scrollToBottom, 50);
    } catch {
      setMessages([]);
    }
  }

  async function loadPinned(roomId: string) {
    try {
      const res = await api.get<{ data: Message[] }>(`/chat/rooms/${roomId}/pinned`);
      setPinnedMessages(res.data);
    } catch {
      setPinnedMessages([]);
    }
  }

  async function markRead(roomId: string) {
    try {
      await api.patch(`/chat/rooms/${roomId}/read`, {});
      void loadRooms();
    } catch {
      // no-op
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
      setRooms((prev) => [res.data, ...prev.filter((room) => room.id !== res.data.id)]);
      setSelectedRoom(res.data);
      void loadRooms();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function send() {
    if (!input.trim() || !selectedRoom) return;
    try {
      stopTyping(selectedRoom.id);
      const sock = getSocket();
      const messageContent = input;
      const res = await new Promise<{ success: boolean; data?: Message; error?: string }>((resolve) => {
        sock.emit("chat:message:send", {
          roomId: selectedRoom.id,
          content: messageContent,
          type: "TEXT",
        }, resolve);
      });
      if (!res.success || !res.data) {
        throw new Error(res.error || "Failed");
      }
      setInput("");
      setMessages((prev) => (prev.some((m) => m.id === res.data!.id) ? prev : [res.data!, ...prev]));
      setTypingByRoom((prev) => ({ ...prev, [selectedRoom.id]: [] }));
      setTimeout(scrollToBottom, 50);
      void loadRooms();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function toggleReaction(messageId: string, emoji: string) {
    try {
      const res = await api.post<{ data: Message }>(`/chat/messages/${messageId}/reactions`, {
        emoji,
      });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...res.data } : m)));
      setPickerFor(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reaction failed");
    }
  }

  async function togglePin(msg: Message) {
    try {
      const res = await api.patch<{ data: Message }>(`/chat/messages/${msg.id}/pin`, {
        pinned: !msg.isPinned,
      });
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...res.data } : m)));
      if (selectedRoom) void loadPinned(selectedRoom.id);
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
    const other = roomParticipants(room).find((p) => p.userId !== user?.id);
    return other ? other.user.name : "Unknown";
  }

  function otherParticipant(room: Room): Participant | null {
    return roomParticipants(room).find((p) => p.userId !== user?.id) ?? null;
  }

  function resolveParticipantName(room: Room | null, userId: string): string {
    return roomParticipants(room).find((p) => p.userId === userId)?.user.name ?? "Someone";
  }

  function typingLabel(room: Room | null): string | null {
    if (!room) return null;
    const typingIds = (typingByRoom[room.id] ?? []).filter((id) => id !== user?.id);
    if (typingIds.length === 0) return null;
    const names = typingIds.map((id) => resolveParticipantName(room, id));
    return names.length === 1 ? `${names[0]} is typing...` : `${names.join(", ")} are typing...`;
  }

  function roomIsOnline(room: Room): boolean {
    if (room.isGroup) {
      return roomParticipants(room).some(
        (p) => p.userId !== user?.id && onlineUserIds.has(p.userId)
      );
    }
    const other = otherParticipant(room);
    return other ? onlineUserIds.has(other.userId) : false;
  }

  function roomLastSeen(room: Room): string | null {
    const other = otherParticipant(room);
    return other ? lastSeenByUser[other.userId] ?? null : null;
  }

  function selectedRoomStatus(room: Room): string {
    const typing = typingLabel(room);
    if (typing) return typing;
    if (room.isGroup) {
      const participantCount = roomParticipants(room).length;
      const onlineCount = roomParticipants(room).filter(
        (p) => p.userId !== user?.id && onlineUserIds.has(p.userId)
      ).length;
      if (onlineCount > 0) return `${onlineCount} online`;
      return `${participantCount} participant${participantCount === 1 ? "" : "s"}`;
    }
    if (roomIsOnline(room)) return "Online";
    const lastSeen = roomLastSeen(room);
    return lastSeen ? `Last seen ${new Date(lastSeen).toLocaleString()}` : "Offline";
  }

  function scheduleTypingStop(roomId: string) {
    if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = setTimeout(() => {
      stopTyping(roomId);
    }, 1200);
  }

  function startTyping(roomId: string) {
    const sock = getSocket();
    if (!typingActiveRef.current || activeTypingRoomRef.current !== roomId) {
      sock.emit("chat:typing:start", roomId);
      typingActiveRef.current = true;
      activeTypingRoomRef.current = roomId;
    }
    scheduleTypingStop(roomId);
  }

  function stopTyping(roomId?: string | null) {
    const activeRoomId = roomId ?? activeTypingRoomRef.current;
    if (typingStopTimerRef.current) {
      clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
    }
    if (!typingActiveRef.current || !activeRoomId) return;
    getSocket().emit("chat:typing:stop", activeRoomId);
    typingActiveRef.current = false;
    if (activeTypingRoomRef.current === activeRoomId) activeTypingRoomRef.current = null;
  }

  const filteredUsers = users.filter((u) =>
    u.name.toLowerCase().includes(userSearch.toLowerCase())
  );
  const filteredRooms = rooms.filter((room) =>
    roomDisplayName(room).toLowerCase().includes(userSearch.toLowerCase())
  );

  const orderedMessages = [...messages].reverse();
  const groups = groupByDate(orderedMessages);

  return (
    <div className="flex h-[calc(100vh-3rem)] overflow-hidden rounded-xl bg-white shadow-sm dark:bg-gray-800">
      <div
        className={`${
          selectedRoom ? "hidden md:flex" : "flex"
        } w-full flex-col border-r border-gray-200 dark:border-gray-700 md:w-72 xl:w-80`}
      >
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
          <div className="border-b border-gray-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-700">
            Recent chats
          </div>
          {rooms.length === 0 ? (
            <p className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">
              No chats yet. Search for a user above and click a user to start chat.
            </p>
          ) : filteredRooms.length === 0 ? (
            <p className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">
              No matching chats.
            </p>
          ) : (
            filteredRooms.map((room) => {
              const displayName = roomDisplayName(room);
              const isActive = selectedRoom?.id === room.id;
              const typing = typingLabel(room);
              const isOnline = roomIsOnline(room);
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
                  <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">
                    {initials(displayName)}
                    <span
                      className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-white dark:border-gray-800 ${
                        isOnline ? "bg-emerald-500" : "bg-gray-400"
                      }`}
                    />
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <div className="flex items-center justify-between">
                      <p className="truncate font-medium">{displayName}</p>
                      {room.lastMessageAt && (
                        <span className="text-xs text-gray-400">
                          {new Date(room.lastMessageAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                        {typing || sanitizeChatPreview(room.lastMessage?.content) || "No messages yet"}
                      </p>
                      {room.unreadCount > 0 && (
                        <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs text-white">
                          {room.unreadCount}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      {isOnline
                        ? "Online"
                        : roomLastSeen(room)
                          ? `Last seen ${new Date(roomLastSeen(room) as string).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}`
                          : "Offline"}
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className={`${selectedRoom ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {!selectedRoom ? (
          <div className="flex flex-1 items-center justify-center text-gray-400">
            Select a chat or start a new one
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-gray-200 p-3 sm:p-4 dark:border-gray-700">
              <button
                type="button"
                onClick={() => setSelectedRoom(null)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 text-gray-600 hover:bg-gray-100 md:hidden dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700"
                aria-label="Back to chats"
              >
                <ArrowLeft size={18} />
              </button>
              <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white">
                {initials(roomDisplayName(selectedRoom))}
                {!selectedRoom.isGroup && (
                  <span
                    className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-white dark:border-gray-800 ${
                      roomIsOnline(selectedRoom) ? "bg-emerald-500" : "bg-gray-400"
                    }`}
                  />
                )}
              </div>
              <div className="flex-1">
                <p className="font-semibold">{roomDisplayName(selectedRoom)}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {selectedRoomStatus(selectedRoom)}
                </p>
              </div>
            </div>

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
              className="flex-1 space-y-4 overflow-x-hidden overflow-y-auto bg-gray-50 p-3 sm:p-4 dark:bg-gray-900"
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
                        <div className="relative flex max-w-[85%] min-w-0 flex-col gap-1 sm:max-w-md">
                          <div
                            className={`max-w-full rounded-2xl px-4 py-2 text-sm ${
                              mine
                                ? "bg-primary text-white"
                                : "bg-white text-gray-800 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                            }`}
                          >
                            {!mine && (
                              <p className="mb-1 text-xs font-semibold">{m.sender.name}</p>
                            )}
                            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                              {m.content}
                            </p>
                            <div className="mt-1 flex items-center gap-2">
                              {m.isPinned && (
                                <Pin
                                  size={10}
                                  className={mine ? "text-white/70" : "text-amber-500"}
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

                          {reactionEntries.length > 0 && (
                            <div className={`flex flex-wrap gap-1 ${mine ? "justify-end" : ""}`}>
                              {reactionEntries.map(([emoji, userIds]) => {
                                const reacted = user ? userIds.includes(user.id) : false;
                                return (
                                  <button
                                    key={emoji}
                                    onClick={() => toggleReaction(m.id, emoji)}
                                    className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
                                      reacted
                                        ? "border-primary bg-primary/10"
                                        : "border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600"
                                    }`}
                                  >
                                    <span>{emoji}</span>
                                    <span className="font-semibold">{userIds.length}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          <div
                            className={`absolute ${mine ? "left-0 -translate-x-full" : "right-0 translate-x-full"} top-0 hidden gap-1 pl-2 pr-2 group-hover:flex`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={() => setPickerFor(pickerFor === m.id ? null : m.id)}
                              className="rounded-full bg-white p-1 shadow hover:bg-gray-50 dark:bg-gray-700 dark:hover:bg-gray-600"
                              title="Add reaction"
                            >
                              <SmilePlus size={14} />
                            </button>
                            <button
                              onClick={() => setMenuFor(menuFor === m.id ? null : m.id)}
                              className="rounded-full bg-white p-1 shadow hover:bg-gray-50 dark:bg-gray-700 dark:hover:bg-gray-600"
                              title="More"
                            >
                              <MoreHorizontal size={14} />
                            </button>
                          </div>

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

            <div className="flex items-end gap-2 border-t border-gray-200 p-2 sm:p-3 dark:border-gray-700">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  const value = e.target.value;
                  setInput(value);
                  if (!selectedRoom) return;
                  if (value.trim()) startTyping(selectedRoom.id);
                  else stopTyping(selectedRoom.id);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (e.shiftKey || e.ctrlKey) return;
                  e.preventDefault();
                  send();
                }}
                placeholder="Type a message..."
                rows={1}
                className="min-h-[44px] flex-1 resize-none overflow-y-auto rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm leading-6 text-gray-900 placeholder:text-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
                style={{ maxHeight: "160px" }}
              />
              <button
                onClick={send}
                disabled={!input.trim()}
                className="min-h-[44px] shrink-0 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50 sm:px-4"
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
