// Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-iii of 4).
// /dashboard/whatsapp — reception WhatsApp inbox (conversations list).
//
// What / which modules / why:
//   - Lists WhatsAppConversation rows landed by the inbound webhook
//     (piece 3j-ii). Reads via GET /api/v1/wa/inbox/conversations.
//   - Filter chips: All / Open (default) / Snoozed / Closed.
//   - Per-row card shows patient name (or +91xxx phone if unmatched),
//     unread badge, last-message preview placeholder + status pill +
//     time-ago. Click → /dashboard/whatsapp/[id].
//   - RBAC: ADMIN / RECEPTION / DOCTOR / NURSE. PATIENT role gets the
//     not-allowed surface (matches server-side authorize set in
//     apps/api/src/routes/whatsapp-inbox.ts).
//   - Mobile-first; every CTA is h-11 min-w-[44px] per Pearl §6.2.
//   - Polls every 15s when the window is focused (simple setInterval).
//   - Piece 3j-iv flips the reply CTA on (currently a banner on the
//     thread page).

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MessageCircle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Skeleton } from "@/components/Skeleton";

type ConversationStatus = "OPEN" | "SNOOZED" | "CLOSED";
type FilterValue = ConversationStatus | "ALL";

interface ConversationRow {
  id: string;
  phone: string;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  assignedToUserId: string | null;
  patient: null | {
    id: string;
    mrNumber: string | null;
    user: { id: string; name: string } | null;
  };
  _count?: { messages: number };
}

interface ListResponse {
  data: {
    conversations: ConversationRow[];
    nextCursor: string | null;
  };
}

const ALLOWED_ROLES = new Set(["ADMIN", "RECEPTION", "DOCTOR", "NURSE"]);

const FILTERS: Array<{ value: FilterValue; label: string }> = [
  { value: "OPEN", label: "Open" },
  { value: "ALL", label: "All" },
  { value: "SNOOZED", label: "Snoozed" },
  { value: "CLOSED", label: "Closed" },
];

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(1, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function conversationLabel(c: ConversationRow): string {
  if (c.patient?.user?.name) return c.patient.user.name;
  // Unmatched conversation — show the masked phone so the receptionist
  // can copy it. Mask all but the last 4 digits — matches the audit-row
  // PHI convention from piece 3j-ii.
  if (!c.phone) return "Unknown";
  if (c.phone.length <= 4) return c.phone;
  return `${c.phone.slice(0, c.phone.length - 4).replace(/\d/g, "•")}${c.phone.slice(-4)}`;
}

export default function WhatsAppInboxPage() {
  const role = useAuthStore((s) => s.user?.role);
  const isAllowed = !!role && ALLOWED_ROLES.has(role);

  const [filter, setFilter] = useState<FilterValue>("OPEN");
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauth, setUnauth] = useState(false);
  const mountedRef = useRef(true);

  const fetchRows = useCallback(
    async (opts: { isRefresh?: boolean } = {}) => {
      if (!isAllowed) return;
      if (opts.isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = (await api.get<ListResponse>(
          `/wa/inbox/conversations?status=${filter}&limit=50`,
        )) as ListResponse;
        if (!mountedRef.current) return;
        setRows(res.data?.conversations ?? []);
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (/401/.test(msg)) setUnauth(true);
        else setError(msg);
      } finally {
        if (mountedRef.current) {
          if (opts.isRefresh) setRefreshing(false);
          else setLoading(false);
        }
      }
    },
    [filter, isAllowed],
  );

  useEffect(() => {
    mountedRef.current = true;
    void fetchRows();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchRows]);

  // Poll every 15s when the tab is visible. No websocket this piece —
  // the inbox is low-volume Stage 1 (clinic-scale) and the spec asks
  // for "simple setInterval" explicitly.
  useEffect(() => {
    if (!isAllowed || unauth) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void fetchRows({ isRefresh: true });
    };
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, [isAllowed, unauth, fetchRows]);

  const unreadTotal = useMemo(
    () => rows.reduce((sum, r) => sum + (r.unreadCount || 0), 0),
    [rows],
  );
  const openCount = useMemo(
    () => rows.filter((r) => r.status === "OPEN").length,
    [rows],
  );

  if (!isAllowed) {
    return (
      <section data-testid="wa-inbox-not-allowed" className="space-y-3 py-8">
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
      <section data-testid="wa-inbox-unauth" className="space-y-3 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in required</h1>
        <p className="text-sm text-slate-600">
          Your session has expired. Please sign in again to view the WhatsApp
          inbox.
        </p>
        <a
          href="/login"
          data-testid="wa-inbox-signin-cta"
          className="inline-flex h-11 min-w-[120px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          Go to sign-in
        </a>
      </section>
    );
  }

  return (
    <section data-testid="wa-inbox" className="space-y-5 py-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <MessageCircle aria-hidden className="h-6 w-6 text-emerald-600" />
            <h1 className="text-2xl font-semibold tracking-tight">WhatsApp inbox</h1>
            {unreadTotal > 0 ? (
              <span
                data-testid="wa-inbox-unread-badge"
                className="ml-1 inline-flex min-w-[20px] items-center justify-center rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white"
              >
                {unreadTotal}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-slate-600">
            {openCount} open conversation{openCount === 1 ? "" : "s"}
            {unreadTotal > 0 ? ` · ${unreadTotal} unread` : ""}
          </p>
        </div>
        <button
          type="button"
          data-testid="wa-inbox-refresh"
          onClick={() => void fetchRows({ isRefresh: true })}
          disabled={refreshing}
          className="inline-flex h-11 min-w-[44px] items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw aria-hidden className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      <div
        role="tablist"
        aria-label="Filter conversations"
        data-testid="wa-inbox-filters"
        className="flex flex-wrap gap-2"
      >
        {FILTERS.map((f) => {
          const active = filter === f.value;
          return (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`wa-inbox-filter-${f.value.toLowerCase()}`}
              onClick={() => setFilter(f.value)}
              className={`inline-flex h-11 min-w-[44px] items-center justify-center rounded-full px-4 text-sm font-medium ${
                active
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div
          role="alert"
          data-testid="wa-inbox-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <ul
          data-testid="wa-inbox-loading"
          aria-busy="true"
          className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton variant="text" width="40%" />
                <Skeleton variant="text" width="60%" />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Skeleton variant="rect" width={64} height={20} className="rounded-full" />
                <Skeleton variant="text" width={48} />
              </div>
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <div
          data-testid="wa-inbox-empty"
          className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-700"
        >
          <p className="font-medium">No conversations yet</p>
          <p className="mt-1 text-slate-600">
            Inbound WhatsApp messages will appear here once a patient writes
            in to your configured number.
          </p>
        </div>
      ) : (
        <ul
          data-testid="wa-inbox-list"
          className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
        >
          {rows.map((c) => {
            const label = conversationLabel(c);
            return (
              <li key={c.id} data-testid="wa-inbox-row" data-convo-id={c.id}>
                <Link
                  href={`/dashboard/whatsapp/${c.id}`}
                  className="flex h-11 min-h-[64px] items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-slate-900">
                        {label}
                      </span>
                      {c.unreadCount > 0 ? (
                        <span
                          data-testid="wa-inbox-row-unread"
                          className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-xs font-semibold text-white"
                        >
                          {c.unreadCount}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-500">
                      {c.patient?.mrNumber ? `MR ${c.patient.mrNumber} · ` : ""}
                      {c._count?.messages ?? 0} message{(c._count?.messages ?? 0) === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      data-testid={`wa-inbox-row-status-${c.status.toLowerCase()}`}
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        c.status === "OPEN"
                          ? "bg-emerald-100 text-emerald-700"
                          : c.status === "SNOOZED"
                            ? "bg-amber-100 text-amber-700"
                            : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {c.status}
                    </span>
                    <span className="text-xs text-slate-500">
                      {timeAgo(c.lastMessageAt)}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
