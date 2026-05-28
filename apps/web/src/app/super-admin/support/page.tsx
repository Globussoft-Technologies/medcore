// Super-admin Pearl-operator support inbox — Pearl ERP Stage 1 §8.5
// (gap row 223 closure, 2026-05-23).
//
// Lists SupportTicket rows across all tenants (newest first). Each row is
// clickable through to the thread view (/super-admin/support/[id]) where
// the super-admin can reply, change status / priority, and assign.
//
// Filters: status, priority, tenantId (tenant subdomain text-match against
// the loaded list, since super-admins know tenants by subdomain rather than
// raw id). RBAC enforced at the layout (Role.ADMIN + tenantId == null OR
// "default" tenant) and the API.
//
// Mobile-first: h-11 (44px) touch targets across filter chips + row CTAs.

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Inbox,
  Loader2,
  XCircle,
} from "lucide-react";

type TicketStatus =
  | "OPEN"
  | "AWAITING_TENANT"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "CLOSED";

type TicketPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

interface SupportTicketRow {
  id: string;
  tenantId: string | null;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  updatedAt: string;
  createdAt: string;
  // Pearl §8.5 — plan-aware SLA stamps set on create (and recomputed
  // on priority change). `slaDueAt` is the operator's response
  // deadline; `slaPlan` is the plan that resolved it.
  slaDueAt?: string | null;
  slaPlan?: "STARTER" | "GROWTH" | "ENTERPRISE" | null;
  tenant: { id: string; name: string; subdomain: string } | null;
  openedBy: { id: string; name: string; email: string | null } | null;
  assignedTo: { id: string; name: string; email: string | null } | null;
}

interface ListResponse {
  success: boolean;
  data: {
    tickets: SupportTicketRow[];
    nextCursor: string | null;
  };
  error: string | null;
}

type StatusFilter = "ALL" | TicketStatus;
type PriorityFilter = "ALL" | TicketPriority;

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "AWAITING_TENANT", label: "Awaiting tenant" },
  { key: "IN_PROGRESS", label: "In progress" },
  { key: "RESOLVED", label: "Resolved" },
  { key: "CLOSED", label: "Closed" },
];

const PRIORITY_CHIPS: Array<{ key: PriorityFilter; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "URGENT", label: "Urgent" },
  { key: "HIGH", label: "High" },
  { key: "NORMAL", label: "Normal" },
  { key: "LOW", label: "Low" },
];

function statusPill(status: TicketStatus): {
  cls: string;
  Icon: typeof Clock;
} {
  switch (status) {
    case "OPEN":
      return {
        cls: "bg-amber-50 text-amber-700 border-amber-200",
        Icon: Inbox,
      };
    case "AWAITING_TENANT":
      return {
        cls: "bg-slate-100 text-slate-700 border-slate-200",
        Icon: Clock,
      };
    case "IN_PROGRESS":
      return {
        cls: "bg-blue-50 text-blue-700 border-blue-200",
        Icon: Loader2,
      };
    case "RESOLVED":
      return {
        cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
        Icon: CheckCircle2,
      };
    case "CLOSED":
      return {
        cls: "bg-slate-100 text-slate-500 border-slate-200",
        Icon: XCircle,
      };
  }
}

function priorityPill(priority: TicketPriority): string {
  switch (priority) {
    case "URGENT":
      return "bg-rose-50 text-rose-700 border-rose-200";
    case "HIGH":
      return "bg-orange-50 text-orange-700 border-orange-200";
    case "NORMAL":
      return "bg-slate-50 text-slate-700 border-slate-200";
    case "LOW":
      return "bg-slate-50 text-slate-500 border-slate-200";
  }
}

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

export default function SuperAdminSupportPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("OPEN");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("ALL");
  const [tenantFilter, setTenantFilter] = useState("");
  const [tickets, setTickets] = useState<SupportTicketRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    if (priorityFilter !== "ALL") params.set("priority", priorityFilter);
    params.set("limit", "100");
    return params.toString();
  }, [statusFilter, priorityFilter]);

  async function fetchTickets(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/support-tickets?${queryString}`,
        { credentials: "include" },
      );
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
  }

  useEffect(() => {
    void fetchTickets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  // Client-side tenant filter — search across tenant name + subdomain so
  // operators can type whatever they remember.
  const filteredTickets = useMemo(() => {
    const q = tenantFilter.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter((t) => {
      const name = t.tenant?.name?.toLowerCase() ?? "";
      const sub = t.tenant?.subdomain?.toLowerCase() ?? "";
      return name.includes(q) || sub.includes(q);
    });
  }, [tickets, tenantFilter]);

  return (
    <section data-testid="super-admin-support" className="space-y-6 py-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Pearl Support Inbox
        </h1>
        <p className="text-sm text-slate-600">
          Tickets raised by tenant ADMINs against the Pearl operator team.
          Distinct from patient → hospital complaints (those live inside
          each tenant&apos;s dashboard).
        </p>
      </header>

      {/* Filter chips: status */}
      <div
        className="flex flex-wrap gap-2"
        data-testid="support-status-filters"
      >
        {STATUS_CHIPS.map((chip) => {
          const active = statusFilter === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              data-testid={`support-filter-status-${chip.key.toLowerCase()}`}
              aria-pressed={active}
              onClick={() => setStatusFilter(chip.key)}
              className={`inline-flex h-11 min-w-[80px] items-center justify-center rounded-full border px-4 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-slate-900 ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* Filter chips: priority */}
      <div
        className="flex flex-wrap gap-2"
        data-testid="support-priority-filters"
      >
        {PRIORITY_CHIPS.map((chip) => {
          const active = priorityFilter === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              data-testid={`support-filter-priority-${chip.key.toLowerCase()}`}
              aria-pressed={active}
              onClick={() => setPriorityFilter(chip.key)}
              className={`inline-flex h-11 min-w-[80px] items-center justify-center rounded-full border px-4 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-slate-900 ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* Tenant text filter */}
      <div>
        <label
          htmlFor="support-tenant-filter"
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          Filter by tenant (name or subdomain)
        </label>
        <input
          id="support-tenant-filter"
          data-testid="support-tenant-filter"
          type="text"
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          placeholder="e.g. pearl-hosp or Pearl Hospital"
          className="h-11 w-full max-w-md rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
      </div>

      {error ? (
        <div
          role="alert"
          data-testid="support-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      <div
        className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm"
        data-testid="support-table-wrapper"
      >
        <table
          className="min-w-full text-left text-sm"
          data-testid="support-table"
        >
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Subject
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Tenant
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Opened by
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Priority
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                SLA
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Updated
              </th>
              <th
                scope="col"
                className="px-4 py-3 font-medium text-right"
              >
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredTickets.length === 0 && !loading ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  data-testid="support-empty"
                >
                  No tickets match the current filters.
                </td>
              </tr>
            ) : null}
            {filteredTickets.map((ticket) => {
              const pill = statusPill(ticket.status);
              const Icon = pill.Icon;
              return (
                <tr
                  key={ticket.id}
                  data-testid={`support-row-${ticket.id}`}
                  data-status={ticket.status}
                  data-priority={ticket.priority}
                >
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {ticket.subject}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {ticket.tenant ? (
                      <span title={ticket.tenant.subdomain}>
                        {ticket.tenant.name}
                      </span>
                    ) : (
                      <span className="text-slate-400">Internal</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {ticket.openedBy?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${priorityPill(
                        ticket.priority,
                      )}`}
                    >
                      {ticket.priority}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${pill.cls}`}
                      data-testid={`support-status-pill-${ticket.id}`}
                    >
                      <Icon
                        size={12}
                        aria-hidden="true"
                        className={
                          ticket.status === "IN_PROGRESS"
                            ? "animate-spin"
                            : ""
                        }
                      />
                      {ticket.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <SlaBadge
                      slaDueAt={ticket.slaDueAt ?? null}
                      slaPlan={ticket.slaPlan ?? null}
                      status={ticket.status}
                    />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {formatTs(ticket.updatedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/super-admin/support/${ticket.id}`}
                      data-testid={`support-open-${ticket.id}`}
                      className="inline-flex h-11 min-w-[80px] items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
                    >
                      Open
                      <ArrowRight size={12} aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span
          className="text-xs text-slate-500"
          data-testid="support-count-summary"
        >
          {filteredTickets.length} ticket
          {filteredTickets.length === 1 ? "" : "s"} shown
        </span>
        {loading ? (
          <span
            className="inline-flex items-center gap-1.5 text-xs text-slate-500"
            data-testid="support-loading"
          >
            <Loader2 size={12} aria-hidden="true" className="animate-spin" />
            Loading…
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="text-xs text-slate-500">
          <AlertCircle size={12} className="mr-1 inline" aria-hidden="true" />
          If this persists, check /super-admin/jobs for stuck background tasks.
        </div>
      ) : null}
    </section>
  );
}

// Pearl §8.5 — SLA badge. Renders "On track" / "Due in 2h" / "Breached
// 3h ago" with a plan-coloured strip so operators see plan-tier
// commitments at a glance.
//
// Resolved tickets show a muted "Met" / "Missed" past-tense badge — no
// urgency once a ticket is done.
function SlaBadge({
  slaDueAt,
  slaPlan,
  status,
}: {
  slaDueAt: string | null;
  slaPlan: "STARTER" | "GROWTH" | "ENTERPRISE" | null;
  status: TicketStatus;
}): React.ReactNode {
  if (!slaDueAt) {
    return <span className="text-xs text-slate-400">—</span>;
  }
  const due = new Date(slaDueAt);
  const ms = due.getTime() - Date.now();
  const closed = status === "RESOLVED" || status === "CLOSED";

  // Plan strip — colour the left edge by tier so an operator scanning
  // the list spots ENTERPRISE rows fast (those carry the tightest
  // commitments and the biggest revenue at stake).
  const planCls =
    slaPlan === "ENTERPRISE"
      ? "border-l-4 border-violet-500"
      : slaPlan === "GROWTH"
        ? "border-l-4 border-sky-500"
        : "border-l-4 border-slate-300";

  let label: string;
  let tone: string;
  if (closed) {
    if (ms < 0) {
      label = "Missed";
      tone = "bg-rose-50 text-rose-700";
    } else {
      label = "Met";
      tone = "bg-emerald-50 text-emerald-700";
    }
  } else if (ms <= 0) {
    label = `Breached ${formatRelativeDuration(-ms)} ago`;
    tone = "bg-rose-100 text-rose-700 font-semibold";
  } else if (ms < 60 * 60 * 1000) {
    label = `Due in ${formatRelativeDuration(ms)}`;
    tone = "bg-amber-100 text-amber-800 font-semibold";
  } else {
    label = `Due in ${formatRelativeDuration(ms)}`;
    tone = "bg-slate-50 text-slate-700";
  }

  return (
    <div className={`inline-flex flex-col rounded-md ${planCls} pl-2`}>
      <span
        className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] ${tone}`}
        title={`${slaPlan ?? "STARTER"} plan · due ${due.toLocaleString("en-IN")}`}
      >
        {label}
      </span>
      {slaPlan ? (
        <span className="px-2 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
          {slaPlan}
        </span>
      ) : null}
    </div>
  );
}

function formatRelativeDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}
