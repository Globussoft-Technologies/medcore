// Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-iii of 4).
// /dashboard/whatsapp/[id] — single conversation thread + actions.
//
// What / which modules / why:
//   - Renders chat bubbles for one WhatsAppConversation: INBOUND on the
//     left (slate), OUTBOUND on the right (emerald). The reply input is
//     intentionally absent — piece 3j-iv ships outbound. A banner makes
//     this explicit so the receptionist knows what's coming.
//   - Actions: Mark all read (POST /:id/read), Snooze / Reopen / Close
//     (PATCH /:id status), Assign to me (PATCH /:id assignedToUserId).
//   - On mount we POST /:id/read exactly once per session per
//     conversation (sessionStorage key) so revisits don't spam the
//     audit log.
//   - RBAC matches the list page (ADMIN/RECEPTION/DOCTOR/NURSE). Server
//     enforcement is in apps/api/src/routes/whatsapp-inbox.ts.
//   - Mobile-first; every CTA is h-11 min-w-[44px] per Pearl §6.2.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Check, Pause, RotateCcw, XCircle, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

type ConversationStatus = "OPEN" | "SNOOZED" | "CLOSED";
type MessageDirection = "INBOUND" | "OUTBOUND";

interface ThreadMessage {
  id: string;
  direction: MessageDirection;
  body: string;
  mediaUrl: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  status: string;
  createdAt: string;
}

interface ThreadConversation {
  id: string;
  phone: string;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt: string | null;
  assignedToUserId: string | null;
  patient: null | {
    id: string;
    mrNumber: string | null;
    user: { id: string; name: string } | null;
  };
}

interface ThreadResponse {
  data: {
    conversation: ThreadConversation;
    messages: ThreadMessage[];
    olderCursor: string | null;
  };
}

const ALLOWED_ROLES = new Set(["ADMIN", "RECEPTION", "DOCTOR", "NURSE"]);

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function conversationLabel(c: ThreadConversation | null): string {
  if (!c) return "Conversation";
  if (c.patient?.user?.name) return c.patient.user.name;
  if (!c.phone) return "Unknown";
  if (c.phone.length <= 4) return c.phone;
  return `${c.phone.slice(0, c.phone.length - 4).replace(/\d/g, "•")}${c.phone.slice(-4)}`;
}

export default function WhatsAppThreadPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const role = useAuthStore((s) => s.user?.role);
  const userId = useAuthStore((s) => s.user?.id);
  const isAllowed = !!role && ALLOWED_ROLES.has(role);

  const [convo, setConvo] = useState<ThreadConversation | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauth, setUnauth] = useState(false);
  const readMarkedRef = useRef(false);

  const fetchThread = useCallback(async () => {
    if (!isAllowed || !id) return;
    setLoading(true);
    setError(null);
    try {
      const res = (await api.get<ThreadResponse>(
        `/wa/inbox/conversations/${encodeURIComponent(id)}?limit=50`,
      )) as ThreadResponse;
      setConvo(res.data.conversation);
      setMessages(res.data.messages ?? []);
      setOlderCursor(res.data.olderCursor ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/401/.test(msg)) setUnauth(true);
      else if (/404/.test(msg)) setError("Conversation not found");
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, [id, isAllowed]);

  useEffect(() => {
    void fetchThread();
  }, [fetchThread]);

  // Mark-read once per session per conversation so re-visits during the
  // same browser tab don't spam the audit log. Window-scoped (not user-
  // scoped) because the user can only ever have one identity per tab.
  useEffect(() => {
    if (!convo || readMarkedRef.current) return;
    if (typeof window === "undefined") return;
    const key = `wa-inbox-marked-read:${convo.id}`;
    try {
      if (window.sessionStorage.getItem(key)) {
        readMarkedRef.current = true;
        return;
      }
    } catch {
      // sessionStorage may be unavailable in private mode — best-effort.
    }
    if (convo.unreadCount > 0) {
      readMarkedRef.current = true;
      (async () => {
        try {
          await api.post(`/wa/inbox/conversations/${encodeURIComponent(convo.id)}/read`);
          try {
            window.sessionStorage.setItem(key, "1");
          } catch {
            // best-effort
          }
          setConvo((c) => (c ? { ...c, unreadCount: 0 } : c));
        } catch {
          // mark-read is best-effort; the audit row failure shouldn't
          // surface to the receptionist.
        }
      })();
    } else {
      try {
        window.sessionStorage.setItem(key, "1");
      } catch {
        // best-effort
      }
      readMarkedRef.current = true;
    }
  }, [convo]);

  const loadOlder = useCallback(async () => {
    if (!olderCursor || !id) return;
    setLoadingOlder(true);
    try {
      const res = (await api.get<ThreadResponse>(
        `/wa/inbox/conversations/${encodeURIComponent(id)}?limit=50&before=${encodeURIComponent(olderCursor)}`,
      )) as ThreadResponse;
      setMessages((prev) => [...(res.data.messages ?? []), ...prev]);
      setOlderCursor(res.data.olderCursor ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load older messages");
    } finally {
      setLoadingOlder(false);
    }
  }, [id, olderCursor]);

  const updateStatus = useCallback(
    async (status: ConversationStatus) => {
      if (!convo) return;
      setActing(true);
      try {
        await api.patch(`/wa/inbox/conversations/${encodeURIComponent(convo.id)}`, {
          status,
        });
        setConvo({ ...convo, status });
        toast.success(`Conversation ${status.toLowerCase()}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Status update failed");
      } finally {
        setActing(false);
      }
    },
    [convo],
  );

  const assignToMe = useCallback(async () => {
    if (!convo || !userId) return;
    setActing(true);
    try {
      await api.patch(`/wa/inbox/conversations/${encodeURIComponent(convo.id)}`, {
        assignedToUserId: userId,
      });
      setConvo({ ...convo, assignedToUserId: userId });
      toast.success("Conversation assigned to you");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Assign failed");
    } finally {
      setActing(false);
    }
  }, [convo, userId]);

  const markRead = useCallback(async () => {
    if (!convo) return;
    setActing(true);
    try {
      await api.post(`/wa/inbox/conversations/${encodeURIComponent(convo.id)}/read`);
      setConvo({ ...convo, unreadCount: 0 });
      toast.success("Marked all read");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Mark-read failed");
    } finally {
      setActing(false);
    }
  }, [convo]);

  const label = useMemo(() => conversationLabel(convo), [convo]);

  if (!isAllowed) {
    return (
      <section data-testid="wa-thread-not-allowed" className="space-y-3 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">WhatsApp inbox</h1>
        <p className="text-sm text-slate-600">
          You do not have access to the WhatsApp inbox. This surface is
          available to reception, doctors, nurses, and tenant admins.
        </p>
      </section>
    );
  }

  if (unauth) {
    return (
      <section data-testid="wa-thread-unauth" className="space-y-3 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in required</h1>
        <a
          href="/login"
          data-testid="wa-thread-signin-cta"
          className="inline-flex h-11 min-w-[120px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          Go to sign-in
        </a>
      </section>
    );
  }

  return (
    <section data-testid="wa-thread" className="space-y-4 py-4">
      <div>
        <Link
          href="/dashboard/whatsapp"
          data-testid="wa-thread-back"
          className="inline-flex h-11 min-w-[44px] items-center gap-1 rounded-md px-2 text-sm text-slate-700 hover:bg-slate-100"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" /> Back to inbox
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="min-w-0">
          <h1
            data-testid="wa-thread-title"
            className="truncate text-2xl font-semibold tracking-tight"
          >
            {label}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {convo?.patient?.mrNumber ? `MR ${convo.patient.mrNumber} · ` : ""}
            <span data-testid="wa-thread-phone" className="font-mono text-xs">
              {convo?.phone ?? ""}
            </span>
          </p>
          {convo ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span
                data-testid={`wa-thread-status-${convo.status.toLowerCase()}`}
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  convo.status === "OPEN"
                    ? "bg-emerald-100 text-emerald-700"
                    : convo.status === "SNOOZED"
                      ? "bg-amber-100 text-amber-700"
                      : "bg-slate-100 text-slate-600"
                }`}
              >
                {convo.status}
              </span>
              <span
                data-testid="wa-thread-assignee"
                className="text-xs text-slate-500"
              >
                Assigned: {convo.assignedToUserId ? convo.assignedToUserId : "unassigned"}
              </span>
            </div>
          ) : null}
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          data-testid="wa-thread-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      {convo ? (
        <div
          data-testid="wa-thread-actions"
          className="flex flex-wrap gap-2 rounded-md border border-slate-200 bg-white p-3 shadow-sm"
        >
          <button
            type="button"
            data-testid="wa-thread-mark-read"
            onClick={() => void markRead()}
            disabled={acting}
            className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Check aria-hidden className="h-4 w-4" /> Mark all read
          </button>
          {convo.status === "OPEN" ? (
            <button
              type="button"
              data-testid="wa-thread-snooze"
              onClick={() => void updateStatus("SNOOZED")}
              disabled={acting}
              className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Pause aria-hidden className="h-4 w-4" /> Snooze
            </button>
          ) : (
            <button
              type="button"
              data-testid="wa-thread-reopen"
              onClick={() => void updateStatus("OPEN")}
              disabled={acting}
              className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RotateCcw aria-hidden className="h-4 w-4" /> Reopen
            </button>
          )}
          {convo.status !== "CLOSED" ? (
            <button
              type="button"
              data-testid="wa-thread-close"
              onClick={() => void updateStatus("CLOSED")}
              disabled={acting}
              className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <XCircle aria-hidden className="h-4 w-4" /> Close
            </button>
          ) : null}
          <button
            type="button"
            data-testid="wa-thread-assign-me"
            onClick={() => void assignToMe()}
            disabled={acting || !userId}
            className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <UserPlus aria-hidden className="h-4 w-4" /> Assign to me
          </button>
        </div>
      ) : null}

      <div
        role="note"
        data-testid="wa-thread-reply-banner"
        className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      >
        Reply support coming in the next piece. For now, copy the patient
        phone above and respond from WhatsApp Web.
      </div>

      {loading ? (
        <div
          data-testid="wa-thread-loading"
          aria-busy="true"
          className="h-44 animate-pulse rounded-md border border-slate-200 bg-slate-50"
        />
      ) : (
        <div data-testid="wa-thread-messages" className="space-y-3">
          {olderCursor ? (
            <div className="flex justify-center">
              <button
                type="button"
                data-testid="wa-thread-load-older"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loadingOlder ? "Loading…" : "Load older messages"}
              </button>
            </div>
          ) : null}

          {messages.length === 0 ? (
            <div
              data-testid="wa-thread-empty"
              className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-700"
            >
              No messages in this conversation yet.
            </div>
          ) : (
            <ul className="space-y-2">
              {messages.map((m) => {
                const outbound = m.direction === "OUTBOUND";
                return (
                  <li
                    key={m.id}
                    data-testid="wa-thread-message"
                    data-direction={m.direction}
                    className={`flex ${outbound ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                        outbound
                          ? "bg-emerald-100 text-emerald-900"
                          : "bg-slate-100 text-slate-900"
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      {m.mediaUrl ? (
                        <a
                          href={m.mediaUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="wa-thread-message-media"
                          className="mt-1 inline-block text-xs underline"
                        >
                          View media
                        </a>
                      ) : null}
                      <div className="mt-1 text-[10px] text-slate-500">
                        {formatTime(m.sentAt ?? m.createdAt)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
