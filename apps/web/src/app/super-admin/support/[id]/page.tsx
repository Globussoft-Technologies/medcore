// Super-admin support ticket thread view — Pearl ERP Stage 1 §8.5
// (gap row 223 closure, 2026-05-23).
//
// Shows the ticket header (subject + tenant + opener + meta), the message
// thread (ASC by createdAt — oldest first, conversation-style), a reply
// composer, and a side panel for super-admin actions (status / priority /
// assign to self).
//
// All mutations use the same `/api/v1/support-tickets` endpoints. The
// page refetches after every successful action so the displayed state
// matches the server.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Send,
  UserCheck,
  Loader2,
  AlertCircle,
} from "lucide-react";

type TicketStatus =
  | "OPEN"
  | "AWAITING_TENANT"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "CLOSED";

type TicketPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

interface MessageRow {
  id: string;
  body: string;
  createdAt: string;
  author: {
    id: string;
    name: string;
    email: string | null;
    role: string;
  };
}

interface TicketDetail {
  id: string;
  tenantId: string | null;
  subject: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignedToUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tenant: { id: string; name: string; subdomain: string } | null;
  openedBy: { id: string; name: string; email: string | null } | null;
  assignedTo: { id: string; name: string; email: string | null } | null;
  messages: MessageRow[];
}

interface DetailResponse {
  success: boolean;
  data: TicketDetail;
  error: string | null;
}

interface MeResponse {
  success: boolean;
  data: { id: string; role: string; tenantId: string | null } | null;
  error: string | null;
}

const STATUS_OPTIONS: TicketStatus[] = [
  "OPEN",
  "AWAITING_TENANT",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
];

const PRIORITY_OPTIONS: TicketPriority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

export default function SuperAdminSupportTicketPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const ticketId = params?.id;

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [posting, setPosting] = useState(false);
  const [patching, setPatching] = useState(false);

  const fetchTicket = useCallback(async (): Promise<void> => {
    if (!ticketId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/support-tickets/${ticketId}`, {
        credentials: "include",
      });
      const body = (await res.json()) as DetailResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setTicket(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  // Fetch the current user id so the "Assign to me" button can target
  // the right userId.
  const fetchMe = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/v1/auth/me", { credentials: "include" });
      if (!res.ok) return;
      const body = (await res.json()) as MeResponse;
      if (body.success && body.data) setMeId(body.data.id);
    } catch {
      /* swallow — assign-to-me will degrade gracefully */
    }
  }, []);

  useEffect(() => {
    void fetchTicket();
    void fetchMe();
  }, [fetchTicket, fetchMe]);

  async function postReply(): Promise<void> {
    if (!ticketId || !reply.trim()) return;
    setPosting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/support-tickets/${ticketId}/messages`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: reply.trim() }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Reply failed (${res.status})`);
      }
      setReply("");
      await fetchTicket();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }

  async function patchTicket(
    patch: Partial<{
      status: TicketStatus;
      priority: TicketPriority;
      assignedToUserId: string | null;
    }>,
  ): Promise<void> {
    if (!ticketId) return;
    setPatching(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/support-tickets/${ticketId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Update failed (${res.status})`);
      }
      await fetchTicket();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPatching(false);
    }
  }

  const isClosedOrResolved = useMemo(
    () => ticket?.status === "RESOLVED" || ticket?.status === "CLOSED",
    [ticket?.status],
  );

  return (
    <section
      data-testid="super-admin-support-detail"
      className="space-y-6 py-4"
    >
      <div>
        <button
          type="button"
          data-testid="support-back"
          onClick={() => router.push("/super-admin/support")}
          className="inline-flex h-11 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to inbox
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          data-testid="support-detail-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      {loading && !ticket ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-slate-500"
          data-testid="support-detail-loading"
        >
          <Loader2 size={14} aria-hidden="true" className="animate-spin" />
          Loading ticket…
        </div>
      ) : null}

      {ticket ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          {/* Thread column */}
          <div className="space-y-4">
            <header
              className="space-y-1 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
              data-testid="support-detail-header"
            >
              <h1
                className="text-xl font-semibold tracking-tight"
                data-testid="support-detail-subject"
              >
                {ticket.subject}
              </h1>
              <p className="text-xs text-slate-500">
                Opened {formatTs(ticket.createdAt)} by{" "}
                <span data-testid="support-detail-opener">
                  {ticket.openedBy?.name ?? "—"}
                </span>{" "}
                ·{" "}
                <span data-testid="support-detail-tenant">
                  {ticket.tenant
                    ? `${ticket.tenant.name} (${ticket.tenant.subdomain})`
                    : "Internal"}
                </span>
              </p>
            </header>

            {/* Original body as the first "message" in the thread */}
            <article
              className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm"
              data-testid="support-detail-body"
            >
              <div className="mb-1 text-xs text-slate-500">
                {ticket.openedBy?.name ?? "Opener"} ·{" "}
                {formatTs(ticket.createdAt)}
              </div>
              <p className="whitespace-pre-wrap text-slate-700">
                {ticket.body}
              </p>
            </article>

            {/* Message thread */}
            <ol
              className="space-y-3"
              data-testid="support-detail-messages"
            >
              {ticket.messages.length === 0 ? (
                <li className="text-xs text-slate-500">
                  No replies yet.
                </li>
              ) : null}
              {ticket.messages.map((m) => (
                <li
                  key={m.id}
                  data-testid={`support-message-${m.id}`}
                  data-author-role={m.author.role}
                  className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm"
                >
                  <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {m.author.name}
                      <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600">
                        {m.author.role}
                      </span>
                    </span>
                    <span>{formatTs(m.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-slate-700">
                    {m.body}
                  </p>
                </li>
              ))}
            </ol>

            {/* Reply composer */}
            <form
              data-testid="support-reply-form"
              onSubmit={(e) => {
                e.preventDefault();
                void postReply();
              }}
              className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
            >
              <label
                htmlFor="support-reply"
                className="block text-xs font-medium text-slate-600"
              >
                Reply
              </label>
              <textarea
                id="support-reply"
                data-testid="support-reply-input"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                disabled={posting || isClosedOrResolved}
                placeholder={
                  isClosedOrResolved
                    ? "Reopen the ticket to reply"
                    : "Type your reply…"
                }
                rows={4}
                className="block w-full rounded-md border border-slate-300 bg-white p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:bg-slate-100"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  data-testid="support-reply-submit"
                  disabled={posting || !reply.trim() || isClosedOrResolved}
                  className="inline-flex h-11 min-w-[100px] items-center justify-center gap-1.5 rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
                >
                  {posting ? (
                    <Loader2
                      size={14}
                      aria-hidden="true"
                      className="animate-spin"
                    />
                  ) : (
                    <Send size={14} aria-hidden="true" />
                  )}
                  {posting ? "Posting…" : "Post reply"}
                </button>
              </div>
            </form>
          </div>

          {/* Side panel: actions */}
          <aside
            data-testid="support-detail-side"
            className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
          >
            <h2 className="text-sm font-semibold text-slate-900">
              Actions
            </h2>

            <div>
              <label
                htmlFor="support-status"
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                Status
              </label>
              <select
                id="support-status"
                data-testid="support-status-select"
                value={ticket.status}
                disabled={patching}
                onChange={(e) =>
                  void patchTicket({
                    status: e.target.value as TicketStatus,
                  })
                }
                className="h-11 w-full rounded-md border border-slate-300 bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="support-priority"
                className="mb-1 block text-xs font-medium text-slate-600"
              >
                Priority
              </label>
              <select
                id="support-priority"
                data-testid="support-priority-select"
                value={ticket.priority}
                disabled={patching}
                onChange={(e) =>
                  void patchTicket({
                    priority: e.target.value as TicketPriority,
                  })
                }
                className="h-11 w-full rounded-md border border-slate-300 bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-1 text-xs font-medium text-slate-600">
                Assignee
              </div>
              <div
                data-testid="support-detail-assignee"
                className="text-sm text-slate-700"
              >
                {ticket.assignedTo?.name ?? "Unassigned"}
              </div>
              {meId && ticket.assignedToUserId !== meId ? (
                <button
                  type="button"
                  data-testid="support-assign-me"
                  disabled={patching}
                  onClick={() =>
                    void patchTicket({ assignedToUserId: meId })
                  }
                  className="mt-2 inline-flex h-11 items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  <UserCheck size={14} aria-hidden="true" />
                  Assign to me
                </button>
              ) : null}
            </div>

            <p className="text-xs text-slate-500">
              Last updated {formatTs(ticket.updatedAt)}.
              {ticket.resolvedAt ? (
                <>
                  {" "}
                  Resolved {formatTs(ticket.resolvedAt)}.
                </>
              ) : null}
            </p>
          </aside>
        </div>
      ) : null}

      <div className="text-xs text-slate-500">
        <Link
          href="/super-admin/support"
          className="inline-flex items-center gap-1 underline"
        >
          <ArrowLeft size={10} aria-hidden="true" />
          All tickets
        </Link>
      </div>
    </section>
  );
}
