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
import { SkeletonRow, SkeletonText } from "@/components/Skeleton";
import { formatDate } from "@/lib/format";

// Issue #733: the API returns `readAt: string | null` (the timestamp at
// which the row was marked read, or null while unread). Earlier this
// component carried `read: boolean` which was never actually populated by
// the server, so every row rendered with the unread border-and-blue-dot
// style on every refresh — even after Mark-all-read had successfully
// PATCHed read-all and the optimistic update ran. We now read the source-
// of-truth `readAt` directly and derive `isRead = !!readAt` everywhere
// the UI used `n.read`. The optimistic markAsRead/markAllAsRead handlers
// stamp `readAt` with the current ISO time so the next refresh reads the
// same value the server will hand back.
interface Notification {
  id: string;
  title: string;
  message: string;
  channel: "WHATSAPP" | "SMS" | "EMAIL" | "PUSH";
  readAt: string | null;
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

// NB: the preferences-row icon chip reads .split(" ")[0]/[1] off these
// strings, so the bg/text classes must stay at indices 0/1 — append any
// dark: variants after them.
const channelColor: Record<string, string> = {
  WHATSAPP: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  SMS: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  EMAIL: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  PUSH: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
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

  const unreadCount = notifications.filter((n) => !n.readAt).length;

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
      // Issue #733: stamp `readAt` with an ISO timestamp so the optimistic
      // update matches the shape the server hands back on the next GET.
      // Previously we set `read: true` which was never actually rendered
      // (the row keyed off the wrong field) — the row stayed visually
      // unread until we re-derived `isRead` from `readAt` below.
      const now = new Date().toISOString();
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, readAt: now } : n))
      );
    } catch {
      // empty
    }
  }

  async function markAllAsRead() {
    try {
      await api.patch("/notifications/read-all");
      // Issue #733: stamp every row's `readAt` so the unread border + blue
      // dot disappear immediately. Then re-fetch from the server so we
      // trust the server's truth on the next render — the bug was that
      // the badge updated but the row styling didn't, because the row
      // styling read a non-existent `read` boolean.
      const now = new Date().toISOString();
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, readAt: n.readAt ?? now }))
      );
      // Issue #733: also re-fetch so we don't drift from the server's view
      // (e.g. another tab marking new rows since this list was loaded).
      loadNotifications(1);
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
    return formatDate(dateStr);
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
      <div className="mb-6 rounded-xl bg-white shadow-sm dark:bg-gray-800">
        {loading && notifications.length === 0 ? (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]"><tbody>
              {Array.from({ length: 5 }).map((_, i) => (<SkeletonRow key={i} columns={3} />))}
            </tbody></table>
            </div>
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-gray-400">
            <Bell size={40} />
            <p>No notifications yet</p>
          </div>
        ) : (
          <div>
            {notifications.map((notification) => {
              const ChannelIcon = channelIcon[notification.channel] || Bell;
              // Issue #733: derive `isRead` from `readAt` (the server's
              // source of truth) instead of the previous `read` boolean
              // which was never populated by the API.
              const isRead = !!notification.readAt;
              return (
                <div
                  key={notification.id}
                  onClick={() => {
                    if (!isRead) markAsRead(notification.id);
                  }}
                  data-testid={`notification-row-${notification.id}`}
                  data-read={isRead ? "true" : "false"}
                  className={`flex cursor-pointer items-start gap-4 border-b border-gray-100 px-5 py-4 transition last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40 ${
                    !isRead
                      ? "border-l-4 border-l-blue-500 bg-blue-50/40 dark:bg-blue-900/20"
                      : ""
                  }`}
                >
                  <div className="mt-0.5 flex-shrink-0">
                    <div
                      className={`flex h-9 w-9 items-center justify-center rounded-full ${
                        !isRead
                          ? "bg-blue-100 dark:bg-blue-900/40"
                          : "bg-gray-100 dark:bg-gray-700"
                      }`}
                    >
                      <Bell
                        size={16}
                        className={
                          !isRead ? "text-blue-600" : "text-gray-400"
                        }
                      />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p
                        className={`text-sm ${
                          !isRead
                            ? "font-semibold text-gray-900 dark:text-gray-100"
                            : "font-medium text-gray-700 dark:text-gray-300"
                        }`}
                      >
                        {notification.title}
                      </p>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                          channelColor[notification.channel] ||
                          "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                        }`}
                      >
                        <ChannelIcon size={10} />
                        {notification.channel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                      {notification.message}
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                      {formatTime(notification.createdAt)}
                    </p>
                  </div>
                  {!isRead && (
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
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/40"
                >
                  {loading ? "Loading..." : "Load More"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Preferences Section */}
      <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
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
          <div className="border-t border-gray-200 px-5 pb-5 dark:border-gray-700">
            {prefsLoading ? (
              // Pearl §7.2 skeleton sweep (wave 13, 2026-05-23): replaced the
              // "Loading preferences..." text with a `SkeletonText lines=3`
              // block under a stable `notifications-prefs-loading` testid +
              // `aria-busy="true"`. Same pattern as wave-12 `<slug>-loading`.
              <div
                data-testid="notifications-prefs-loading"
                aria-busy="true"
                className="py-4"
              >
                <SkeletonText lines={3} />
              </div>
            ) : preferences.length === 0 ? (
              <div className="py-6 text-center text-gray-500 dark:text-gray-400">
                No preference settings available
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                {preferences.map((pref) => {
                  const Icon = channelIcon[pref.channel] || Bell;
                  return (
                    <div
                      key={pref.channel}
                      className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700"
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
                          pref.enabled ? "bg-primary" : "bg-gray-300 dark:bg-gray-600"
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
