"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Megaphone, Send, Mail, MessageSquare, Smartphone, Bell } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";

interface Broadcast {
  id: string;
  title: string;
  message: string;
  audience: string;
  sentCount: number;
  failedCount: number;
  createdBy: string;
  createdAt: string;
}

interface Staff {
  id: string;
  name: string;
  role: string;
}

type AudienceType =
  | "ALL_STAFF"
  | "ALL_PATIENTS"
  | "ROLE_ADMIN"
  | "ROLE_DOCTOR"
  | "ROLE_NURSE"
  | "ROLE_RECEPTION"
  | "SPECIFIC_USERS";

const AUDIENCES: Array<{ value: AudienceType; label: string }> = [
  { value: "ALL_STAFF", label: "All Staff" },
  { value: "ALL_PATIENTS", label: "All Patients" },
  { value: "ROLE_DOCTOR", label: "All Doctors" },
  { value: "ROLE_NURSE", label: "All Nurses" },
  { value: "ROLE_RECEPTION", label: "All Reception" },
  { value: "ROLE_ADMIN", label: "All Admins" },
  { value: "SPECIFIC_USERS", label: "Specific Users" },
];

const CHANNELS = [
  { value: "PUSH", label: "Push", icon: Bell },
  { value: "SMS", label: "SMS", icon: Smartphone },
  { value: "EMAIL", label: "Email", icon: Mail },
  { value: "WHATSAPP", label: "WhatsApp", icon: MessageSquare },
];

function audienceToRoles(a: AudienceType): string[] {
  switch (a) {
    case "ALL_STAFF":
      return ["ADMIN", "DOCTOR", "NURSE", "RECEPTION"];
    case "ALL_PATIENTS":
      return ["PATIENT"];
    case "ROLE_ADMIN":
      return ["ADMIN"];
    case "ROLE_DOCTOR":
      return ["DOCTOR"];
    case "ROLE_NURSE":
      return ["NURSE"];
    case "ROLE_RECEPTION":
      return ["RECEPTION"];
    default:
      return [];
  }
}

export default function BroadcastsPage() {
  const { user } = useAuthStore();
  const router = useRouter();

  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [audience, setAudience] = useState<AudienceType>("ALL_STAFF");
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>(["PUSH"]);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, router]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [bRes, uRes] = await Promise.all([
          api.get<{ data: Broadcast[] }>("/notifications/broadcasts"),
          api.get<{ data: Staff[] }>("/chat/users"),
        ]);
        setBroadcasts(bRes.data);
        setStaff(uRes.data);
      } catch {
        // empty
      }
      setLoading(false);
    }
    if (user?.role === "ADMIN") load();
  }, [user]);

  async function send() {
    if (!title || !message || channels.length === 0) {
      toast.error("Title, message, and at least one channel required");
      return;
    }
    setSending(true);
    try {
      const payload: Record<string, unknown> = {
        title,
        message,
        channels,
        audience:
          audience === "SPECIFIC_USERS"
            ? { userIds: selectedUsers }
            : { roles: audienceToRoles(audience) },
      };
      if (scheduleLater && scheduledFor) {
        payload.scheduledFor = new Date(scheduledFor).toISOString();
      }
      await api.post("/notifications/broadcast", payload);
      setTitle("");
      setMessage("");
      setSelectedUsers([]);
      setScheduleLater(false);
      setScheduledFor("");
      // reload
      const bRes = await api.get<{ data: Broadcast[] }>(
        "/notifications/broadcasts"
      );
      setBroadcasts(bRes.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    }
    setSending(false);
  }

  function toggleChannel(c: string) {
    setChannels((ch) =>
      ch.includes(c) ? ch.filter((x) => x !== c) : [...ch, c]
    );
  }

  function toggleUser(id: string) {
    setSelectedUsers((u) =>
      u.includes(id) ? u.filter((x) => x !== id) : [...u, id]
    );
  }

  function parseAudience(raw: string): string {
    try {
      const a = JSON.parse(raw);
      if (a.userIds) return `${a.userIds.length} users`;
      if (a.roles) return a.roles.join(", ");
      return "—";
    } catch {
      return raw;
    }
  }

  if (user && user.role !== "ADMIN") return null;

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Megaphone size={24} className="text-primary" />
        <h1 className="text-2xl font-bold">Broadcasts</h1>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Composer */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <h2 className="mb-4 font-semibold">Compose Broadcast</h2>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Title
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Announcement title"
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Message
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                placeholder="Message body..."
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Audience
              </label>
              <select
                value={audience}
                onChange={(e) =>
                  setAudience(e.target.value as AudienceType)
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
              >
                {AUDIENCES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            {audience === "SPECIFIC_USERS" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Select users ({selectedUsers.length} selected)
                </label>
                <div className="max-h-40 overflow-y-auto rounded-lg border">
                  {staff.map((s) => (
                    <label
                      key={s.id}
                      className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm last:border-0 hover:bg-gray-50"
                    >
                      <input
                        type="checkbox"
                        checked={selectedUsers.includes(s.id)}
                        onChange={() => toggleUser(s.id)}
                      />
                      <span className="flex-1">{s.name}</span>
                      <span className="text-xs text-gray-500">{s.role}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Channels
              </label>
              <div className="flex flex-wrap gap-2">
                {CHANNELS.map((c) => {
                  const Icon = c.icon;
                  const active = channels.includes(c.value);
                  return (
                    <button
                      key={c.value}
                      onClick={() => toggleChannel(c.value)}
                      className={`flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm transition ${
                        active
                          ? "border-primary bg-primary text-white"
                          : "bg-white text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      <Icon size={14} />
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={scheduleLater}
                  onChange={(e) => setScheduleLater(e.target.checked)}
                />
                Schedule for later
              </label>
              {scheduleLater && (
                <input
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  className="mt-2 w-full rounded-lg border px-3 py-2 text-sm"
                />
              )}
            </div>
            <button
              onClick={send}
              disabled={sending || !title || !message || channels.length === 0}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              <Send size={16} />
              {sending ? "Sending..." : scheduleLater ? "Schedule" : "Send Now"}
            </button>
          </div>
        </div>

        {/* Preview */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <h2 className="mb-4 font-semibold">Channel Preview</h2>
          <div className="space-y-4">
            {channels.length === 0 ? (
              <p className="text-sm text-gray-500">
                Select channels to see previews.
              </p>
            ) : (
              channels.map((c) => {
                const meta = CHANNELS.find((x) => x.value === c);
                if (!meta) return null;
                const Icon = meta.icon;
                return (
                  <div
                    key={c}
                    className="rounded-lg border border-gray-200 bg-gray-50 p-4"
                  >
                    <div className="mb-2 flex items-center gap-2 text-xs text-gray-500">
                      <Icon size={14} />
                      {meta.label} preview
                    </div>
                    {c === "SMS" && (
                      <div className="rounded-lg bg-white p-3 text-sm">
                        <p className="font-medium">{title || "(title)"}</p>
                        <p className="mt-1 text-gray-600">
                          {message.slice(0, 160) || "(message)"}
                          {message.length > 160 && "..."}
                        </p>
                      </div>
                    )}
                    {c === "EMAIL" && (
                      <div className="rounded-lg bg-white p-3 text-sm">
                        <p className="mb-2 border-b pb-1 font-semibold">
                          Subject: {title || "(title)"}
                        </p>
                        <p className="whitespace-pre-wrap text-gray-700">
                          {message || "(message body)"}
                        </p>
                      </div>
                    )}
                    {c === "WHATSAPP" && (
                      <div className="max-w-xs rounded-lg bg-green-50 p-3 text-sm shadow-sm">
                        <p className="font-medium text-green-900">
                          {title || "(title)"}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-gray-700">
                          {message || "(message)"}
                        </p>
                      </div>
                    )}
                    {c === "PUSH" && (
                      <div className="flex items-start gap-3 rounded-lg bg-white p-3 text-sm shadow-sm">
                        <Bell size={18} className="mt-0.5 text-primary" />
                        <div>
                          <p className="font-semibold">
                            {title || "(title)"}
                          </p>
                          <p className="text-xs text-gray-600">
                            {message.slice(0, 120) || "(message)"}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* History */}
      <div className="mt-6 rounded-xl bg-white shadow-sm">
        <div className="border-b p-5">
          <h2 className="font-semibold">Broadcast History</h2>
        </div>
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : broadcasts.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No broadcasts sent yet.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="px-4 py-3">Sent</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Audience</th>
                <th className="px-4 py-3">Delivered</th>
                <th className="px-4 py-3">Failed</th>
              </tr>
            </thead>
            <tbody>
              {broadcasts.map((b) => (
                <tr key={b.id} className="border-b last:border-0 text-sm">
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {new Date(b.createdAt).toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{b.title}</p>
                    <p className="truncate text-xs text-gray-500">
                      {b.message}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {parseAudience(b.audience)}
                  </td>
                  <td className="px-4 py-3 text-xs font-semibold text-green-600">
                    {b.sentCount}
                  </td>
                  <td className="px-4 py-3 text-xs font-semibold text-red-600">
                    {b.failedCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
