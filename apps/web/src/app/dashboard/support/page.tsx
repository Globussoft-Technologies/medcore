// Tenant-side support inbox — Pearl ERP Stage 1 §8.5 (2026-05-28).
//
// What / which modules / why:
//   - Tenant ADMINs raise + track tickets with the Onviqa operator
//     team from inside their own dashboard. The super-admin half of
//     this flow has shipped at /super-admin/support; this is the
//     tenant-facing counterpart.
//   - Endpoints consumed (all gated tenant-scoped by the API):
//       GET    /api/v1/support-tickets           (own-tenant rows)
//       POST   /api/v1/support-tickets           (open new)
//       GET    /api/v1/support-tickets/:id       (detail + thread)
//       POST   /api/v1/support-tickets/:id/messages  (reply)
//   - The SLA badge mirrors the super-admin one — operator and
//     tenant see the same plan-tier commitment so there's no
//     ambiguity about response expectations.
//
// Visibility: gated by the dashboard layout's normal ADMIN role
// check. The API enforces tenant scoping so any user role that
// reaches this page sees only their own tenant's tickets.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Ticket,
  Loader2,
  MessageSquare,
  Plus,
  X,
} from "lucide-react";
import { csrfFetch } from "@/lib/csrf-fetch";
import { toast } from "@/lib/toast";
import { SkeletonRow } from "@/components/Skeleton";

type TicketStatus =
  | "OPEN"
  | "AWAITING_TENANT"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "CLOSED";
type TicketPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
type SlaPlan = "STARTER" | "GROWTH" | "ENTERPRISE";

interface SupportTicketRow {
  id: string;
  subject: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  slaDueAt: string | null;
  slaPlan: SlaPlan | null;
  createdAt: string;
  updatedAt: string;
  openedBy: { id: string; name: string; email: string | null } | null;
  assignedTo: { id: string; name: string; email: string | null } | null;
}

interface TicketMessage {
  id: string;
  authorUserId: string;
  body: string;
  createdAt: string;
  author?: {
    id: string;
    name: string;
    email: string | null;
    role: string;
  };
}

interface TicketDetail extends SupportTicketRow {
  messages: TicketMessage[];
}

interface ListResponse {
  success: boolean;
  data: { tickets: SupportTicketRow[]; nextCursor: string | null };
  error: string | null;
}
interface DetailResponse {
  success: boolean;
  data: TicketDetail;
  error: string | null;
}
interface CreateResponse {
  success: boolean;
  data: { id: string };
  error: string | null;
}

const PRIORITIES: Array<{ key: TicketPriority; label: string }> = [
  { key: "LOW", label: "Low" },
  { key: "NORMAL", label: "Normal" },
  { key: "HIGH", label: "High" },
  { key: "URGENT", label: "Urgent" },
];

const STATUS_BADGE: Record<
  TicketStatus,
  { label: string; cls: string; Icon: typeof Clock }
> = {
  OPEN: {
    label: "New",
    cls: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300",
    Icon: AlertCircle,
  },
  AWAITING_TENANT: {
    label: "Awaiting your reply",
    cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
    Icon: MessageSquare,
  },
  IN_PROGRESS: {
    label: "In progress",
    cls: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300",
    Icon: Loader2,
  },
  RESOLVED: {
    label: "Resolved",
    cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
    Icon: CheckCircle2,
  },
  CLOSED: {
    label: "Closed",
    cls: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
    Icon: CheckCircle2,
  },
};

function formatRelativeDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}
function formatTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function TenantSupportPage() {
  const [tickets, setTickets] = useState<SupportTicketRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [openNew, setOpenNew] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newPriority, setNewPriority] = useState<TicketPriority>("NORMAL");
  const [newBusy, setNewBusy] = useState(false);

  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [openTicket, setOpenTicket] = useState<TicketDetail | null>(null);
  const [openTicketLoading, setOpenTicketLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/support-tickets", {
        credentials: "include",
      });
      const body = (await res.json()) as ListResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setTickets(body.data.tickets);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTickets();
  }, [fetchTickets]);

  const fetchDetail = useCallback(async (id: string) => {
    setOpenTicketLoading(true);
    setOpenTicket(null);
    try {
      const res = await fetch(`/api/v1/support-tickets/${id}`, {
        credentials: "include",
      });
      const body = (await res.json()) as DetailResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setOpenTicket(body.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setOpenTicketLoading(false);
    }
  }, []);

  useEffect(() => {
    if (openTicketId) void fetchDetail(openTicketId);
  }, [openTicketId, fetchDetail]);

  async function submitNewTicket(): Promise<void> {
    const subject = newSubject.trim();
    const body = newBody.trim();
    if (subject.length < 3) {
      toast.error("Subject must be at least 3 characters.");
      return;
    }
    if (body.length < 3) {
      toast.error("Describe the issue (3+ characters).");
      return;
    }
    setNewBusy(true);
    try {
      const res = await csrfFetch("/api/v1/support-tickets", {
        method: "POST",
        body: JSON.stringify({ subject, body, priority: newPriority }),
      });
      const payload = (await res.json().catch(() => ({}))) as CreateResponse;
      if (!res.ok || !payload.success) {
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      toast.success("Ticket created. Our team will respond shortly.");
      setOpenNew(false);
      setNewSubject("");
      setNewBody("");
      setNewPriority("NORMAL");
      await fetchTickets();
      setOpenTicketId(payload.data.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setNewBusy(false);
    }
  }

  async function submitReply(): Promise<void> {
    if (!openTicket) return;
    const body = reply.trim();
    if (body.length < 1) {
      toast.error("Type a reply first.");
      return;
    }
    setReplyBusy(true);
    try {
      const res = await csrfFetch(
        `/api/v1/support-tickets/${openTicket.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as {
        success: boolean;
        error: string | null;
      };
      if (!res.ok || !payload.success) {
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      setReply("");
      await fetchDetail(openTicket.id);
      await fetchTickets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setReplyBusy(false);
    }
  }

  const openCount = useMemo(
    () =>
      tickets.filter(
        (t) =>
          t.status === "OPEN" ||
          t.status === "AWAITING_TENANT" ||
          t.status === "IN_PROGRESS",
      ).length,
    [tickets],
  );

  return (
    <section className="space-y-6 py-4" data-testid="tenant-support-page">
      {/* Hero */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-primary/5 via-white to-white p-5 shadow-sm dark:border-gray-700 dark:from-primary/10 dark:via-gray-800 dark:to-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary dark:bg-primary/20">
              <Ticket size={20} />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                Support
              </h1>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                Raise a ticket with the Onviqa team. Response times match
                your plan&rsquo;s SLA.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpenNew(true)}
            data-testid="tenant-support-new"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={14} /> New ticket
          </button>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          {error}
        </div>
      ) : null}

      {/* List */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-gray-700 dark:text-slate-200">
          Your tickets {openCount > 0 ? `(${openCount} open)` : ""}
        </div>
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2 font-medium">Subject</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Priority</th>
              <th className="px-4 py-2 font-medium">SLA</th>
              <th className="px-4 py-2 font-medium">Updated</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-gray-700">
            {loading && tickets.length === 0
              ? Array.from({ length: 6 }).map((_, i) => (
                  <SkeletonRow key={`skeleton-${i}`} columns={6} />
                ))
              : null}
            {tickets.length === 0 && !loading ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400"
                >
                  No support tickets yet. Click <strong>New ticket</strong>{" "}
                  to reach the Onviqa team.
                </td>
              </tr>
            ) : null}
            {tickets.map((t) => {
              const badge = STATUS_BADGE[t.status];
              const Icon = badge.Icon;
              return (
                <tr
                  key={t.id}
                  data-testid={`tenant-support-row-${t.id}`}
                  className="cursor-pointer hover:bg-slate-50 dark:hover:bg-gray-700/50"
                  onClick={() => setOpenTicketId(t.id)}
                >
                  <td className="px-4 py-2 font-medium text-slate-900 dark:text-slate-100">
                    {t.subject}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                    >
                      <Icon size={11} />
                      {badge.label}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-700 dark:text-slate-300">
                    {t.priority}
                  </td>
                  <td className="px-4 py-2">
                    <SlaBadgeInline
                      slaDueAt={t.slaDueAt}
                      slaPlan={t.slaPlan}
                      status={t.status}
                    />
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400">
                    {formatTs(t.updatedAt)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenTicketId(t.id);
                      }}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Open
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* New ticket modal */}
      {openNew ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => !newBusy && setOpenNew(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                New support ticket
              </h2>
              <button
                type="button"
                onClick={() => setOpenNew(false)}
                className="text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Subject
                </label>
                <input
                  type="text"
                  value={newSubject}
                  onChange={(e) => setNewSubject(e.target.value)}
                  maxLength={200}
                  placeholder="What's the issue in one line?"
                  className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Details
                </label>
                <textarea
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  rows={6}
                  maxLength={8000}
                  placeholder="Steps to reproduce, what you expected, what happened…"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Priority
                </label>
                <select
                  value={newPriority}
                  onChange={(e) =>
                    setNewPriority(e.target.value as TicketPriority)
                  }
                  className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Higher priority = faster SLA, but please reserve URGENT for
                  outages affecting patient care.
                </p>
              </div>
            </div>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpenNew(false)}
                disabled={newBusy}
                className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitNewTicket()}
                disabled={newBusy}
                className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {newBusy ? "Sending…" : "Create ticket"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Detail drawer */}
      {openTicketId ? (
        <div
          className="fixed inset-0 z-50 flex bg-slate-900/40"
          role="dialog"
          aria-modal="true"
          onClick={() => setOpenTicketId(null)}
        >
          <div className="ml-auto h-full w-full max-w-2xl overflow-y-auto bg-white shadow-xl dark:bg-gray-900 dark:text-slate-100">
            <div
              onClick={(e) => e.stopPropagation()}
              className="flex h-full flex-col"
            >
              <div className="flex items-start justify-between border-b border-slate-200 p-5 dark:border-gray-700">
                <div>
                  <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                    {openTicket?.subject ?? "Loading…"}
                  </h3>
                  {openTicket ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {(() => {
                        const badge = STATUS_BADGE[openTicket.status];
                        const Icon = badge.Icon;
                        return (
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                          >
                            <Icon size={11} />
                            {badge.label}
                          </span>
                        );
                      })()}
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        Priority: {openTicket.priority}
                      </span>
                      <SlaBadgeInline
                        slaDueAt={openTicket.slaDueAt}
                        slaPlan={openTicket.slaPlan}
                        status={openTicket.status}
                      />
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setOpenTicketId(null)}
                  className="text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto p-5">
                {openTicketLoading ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <Loader2 size={14} className="animate-spin" />
                    Loading…
                  </div>
                ) : openTicket ? (
                  <>
                    {/* Original body */}
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-gray-700 dark:bg-gray-800">
                      <div className="mb-1 text-xs text-slate-500 dark:text-slate-400">
                        {openTicket.openedBy?.name ?? "You"} ·{" "}
                        {formatTs(openTicket.createdAt)}
                      </div>
                      <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-200">
                        {openTicket.body}
                      </p>
                    </div>
                    {/* Thread */}
                    {openTicket.messages.map((m) => {
                      const isOnviqa = m.author?.role === "ADMIN";
                      return (
                        <div
                          key={m.id}
                          className={`rounded-lg border p-3 ${
                            isOnviqa
                              ? "border-primary/30 bg-primary/5 dark:bg-primary/10"
                              : "border-slate-200 bg-white dark:border-gray-700 dark:bg-gray-800"
                          }`}
                        >
                          <div className="mb-1 text-xs text-slate-500 dark:text-slate-400">
                            {isOnviqa ? "Onviqa team" : "You"}
                            {m.author?.name ? ` (${m.author.name})` : ""} ·{" "}
                            {formatTs(m.createdAt)}
                          </div>
                          <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-200">
                            {m.body}
                          </p>
                        </div>
                      );
                    })}
                  </>
                ) : null}
              </div>

              {/* Reply composer — hidden once resolved/closed */}
              {openTicket &&
              openTicket.status !== "RESOLVED" &&
              openTicket.status !== "CLOSED" ? (
                <div className="border-t border-slate-200 p-5 dark:border-gray-700">
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    rows={3}
                    placeholder="Reply to the Onviqa team…"
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                  />
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => void submitReply()}
                      disabled={replyBusy || reply.trim().length === 0}
                      className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
                    >
                      {replyBusy ? "Sending…" : "Send reply"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SlaBadgeInline({
  slaDueAt,
  slaPlan,
  status,
}: {
  slaDueAt: string | null;
  slaPlan: SlaPlan | null;
  status: TicketStatus;
}) {
  if (!slaDueAt)
    return <span className="text-xs text-slate-400 dark:text-slate-500">—</span>;
  const ms = new Date(slaDueAt).getTime() - Date.now();
  const closed = status === "RESOLVED" || status === "CLOSED";
  let label = "";
  let tone = "bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  if (closed) {
    if (ms < 0) {
      label = "Missed SLA";
      tone = "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300";
    } else {
      label = "SLA met";
      tone = "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
    }
  } else if (ms <= 0) {
    label = `Breached ${formatRelativeDuration(-ms)} ago`;
    tone = "bg-rose-100 text-rose-700 font-semibold dark:bg-rose-950/40 dark:text-rose-300";
  } else if (ms < 60 * 60 * 1000) {
    label = `Due in ${formatRelativeDuration(ms)}`;
    tone = "bg-amber-100 text-amber-800 font-semibold dark:bg-amber-950/40 dark:text-amber-300";
  } else {
    label = `Due in ${formatRelativeDuration(ms)}`;
    tone = "bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  }
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] ${tone}`}
      title={`${slaPlan ?? "STARTER"} plan · ${new Date(slaDueAt).toLocaleString("en-IN")}`}
    >
      {label}
    </span>
  );
}
