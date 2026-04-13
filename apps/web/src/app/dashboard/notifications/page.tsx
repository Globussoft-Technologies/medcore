"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import {
  Bell,
  Mail,
  MessageSquare,
  Phone,
  Smartphone,
  CheckCheck,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface Notification {
  id: string;
  title: string;
  message: string;
  channel: "WHATSAPP" | "SMS" | "EMAIL" | "PUSH";
  read: boolean;
  createdAt: string;
}

interface NotificationsResponse {
  data: Notification[];
  meta?: { total: number; page: number; totalPages: number };
}

interface Preference {
  channel: string;
  enabled: boolean;
}

interface PreferencesResponse {
  data: Preference[];
}

const channelIcon: Record<string, React.ElementType> = {
  WHATSAPP: MessageSquare,
  SMS: Phone,
  EMAIL: Mail,
  PUSH: Smartphone,
};

const channelColor: Record<string, string> = {
  WHATSAPP: "bg-green-100 text-green-700",
  SMS: "bg-orange-100 text-orange-700",
  EMAIL: "bg-blue-100 text-blue-700",
  PUSH: "bg-purple-100 text-purple-700",
};

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalPages, setTotalPages] = useState(1);

  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefsLoading, setPrefsLoading] = useState(false);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const loadNotifications = useCallback(
    async (pageNum: number, append = false) => {
      setLoading(true);
      try {
        const res = await api.get<NotificationsResponse>(
          `/notifications?page=${pageNum}&limit=20`
        );
        if (append) {
          setNotifications((prev) => [...prev, ...res.data]);
        } else {
          setNotifications(res.data);
        }
        if (res.meta) {
          setTotalPages(res.meta.totalPages);
          setHasMore(pageNum < res.meta.totalPages);
        }
      } catch {
        // empty
      }
      setLoading(false);
    },
    []
  );

  const loadPreferences = useCallback(async () => {
    setPrefsLoading(true);
    try {
      const res = await api.get<PreferencesResponse>(
        "/notifications/preferences"
      );
      setPreferences(res.data);
    } catch {
      // empty
    }
    setPrefsLoading(false);
  }, []);

  useEffect(() => {
    loadNotifications(1);
    loadPreferences();
  }, [loadNotifications, loadPreferences]);

  async function markAsRead(id: string) {
    try {
      await api.patch(`/notifications/${id}/read`);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n))
      );
    } catch {
      // empty
    }
  }

  async function markAllAsRead() {
    try {
      await api.patch("/notifications/read-all");
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {
      // empty
    }
  }

  async function togglePreference(channel: string, enabled: boolean) {
    const updated = preferences.map((p) =>
      p.channel === channel ? { ...p, enabled } : p
    );
    setPreferences(updated);
    try {
      await api.put("/notifications/preferences", {
        preferences: updated.map((p) => ({ channel: p.channel, enabled: p.enabled })),
      });
    } catch {
      // revert on failure
      setPreferences(preferences);
    }
  }

  function loadMore() {
    const next = page + 1;
    setPage(next);
    loadNotifications(next, true);
  }

  function formatTime(dateStr: string) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Notifications</h1>
          {unreadCount > 0 && (
            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500 px-2 text-xs font-bold text-white">
              {unreadCount}
            </span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            onClick={markAllAsRead}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <CheckCheck size={16} />
            Mark all as read
          </button>
        )}
      </div>

      {/* Notification List */}
      <div className="mb-6 rounded-xl bg-white shadow-sm">
        {loading && notifications.length === 0 ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-gray-400">
            <Bell size={40} />
            <p>No notifications yet</p>
          </div>
        ) : (
          <div>
            {notifications.map((notification) => {
              const ChannelIcon = channelIcon[notification.channel] || Bell;
              return (
                <div
                  key={notification.id}
                  onClick={() => {
                    if (!notification.read) markAsRead(notification.id);
                  }}
                  className={`flex cursor-pointer items-start gap-4 border-b px-5 py-4 transition last:border-0 hover:bg-gray-50 ${
                    !notification.read
                      ? "border-l-4 border-l-blue-500 bg-blue-50/40"
                      : ""
                  }`}
                >
                  <div className="mt-0.5 flex-shrink-0">
                    <div
                      className={`flex h-9 w-9 items-center justify-center rounded-full ${
                        !notification.read ? "bg-blue-100" : "bg-gray-100"
                      }`}
                    >
                      <Bell
                        size={16}
                        className={
                          !notification.read ? "text-blue-600" : "text-gray-400"
                        }
                      />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p
                        className={`text-sm ${
                          !notification.read
                            ? "font-semibold text-gray-900"
                            : "font-medium text-gray-700"
                        }`}
                      >
                        {notification.title}
                      </p>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                          channelColor[notification.channel] || "bg-gray-100 text-gray-600"
                        }`}
                      >
                        <ChannelIcon size={10} />
                        {notification.channel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-gray-500">
                      {notification.message}
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                      {formatTime(notification.createdAt)}
                    </p>
                  </div>
                  {!notification.read && (
                    <div className="mt-2 h-2.5 w-2.5 flex-shrink-0 rounded-full bg-blue-500" />
                  )}
                </div>
              );
            })}

            {hasMore && (
              <div className="p-4 text-center">
                <button
                  onClick={loadMore}
                  disabled={loading}
                  className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  {loading ? "Loading..." : "Load More"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Preferences Section */}
      <div className="rounded-xl bg-white shadow-sm">
        <button
          onClick={() => setPrefsOpen(!prefsOpen)}
          className="flex w-full items-center justify-between px-5 py-4 text-left"
        >
          <h2 className="text-lg font-semibold">Notification Preferences</h2>
          {prefsOpen ? (
            <ChevronUp size={20} className="text-gray-400" />
          ) : (
            <ChevronDown size={20} className="text-gray-400" />
          )}
        </button>

        {prefsOpen && (
          <div className="border-t px-5 pb-5">
            {prefsLoading ? (
              <div className="py-6 text-center text-gray-500">Loading preferences...</div>
            ) : preferences.length === 0 ? (
              <div className="py-6 text-center text-gray-500">
                No preference settings available
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                {preferences.map((pref) => {
                  const Icon = channelIcon[pref.channel] || Bell;
                  return (
                    <div
                      key={pref.channel}
                      className="flex items-center justify-between rounded-lg border px-4 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`flex h-9 w-9 items-center justify-center rounded-full ${
                            channelColor[pref.channel]?.split(" ")[0] || "bg-gray-100"
                          }`}
                        >
                          <Icon
                            size={16}
                            className={
                              channelColor[pref.channel]?.split(" ")[1] || "text-gray-600"
                            }
                          />
                        </div>
                        <div>
                          <p className="text-sm font-medium">
                            {pref.channel.charAt(0) +
                              pref.channel.slice(1).toLowerCase()}{" "}
                            Notifications
                          </p>
                          <p className="text-xs text-gray-400">
                            {pref.enabled
                              ? "You will receive notifications via this channel"
                              : "Notifications for this channel are disabled"}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() =>
                          togglePreference(pref.channel, !pref.enabled)
                        }
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          pref.enabled ? "bg-primary" : "bg-gray-300"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            pref.enabled ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
