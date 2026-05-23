"use client";

/**
 * Campaign detail page — Pearl PRD §5.1 gap #4 piece 4 of 4.
 *
 * What / which modules / why:
 *   - Read-mostly detail view for one Campaign:
 *       - Header meta (name / kind / status / channels / scheduled at)
 *       - Resolved audience: name, last computed size + pretty-printed
 *         JSON of the rules DSL (so the operator can verify what was
 *         actually saved before triggering a dispatch).
 *       - Recent CampaignSend rows (id / channel / status / patient /
 *         delivered/read timestamps) via the aggregate stats endpoint —
 *         falls back gracefully if no sends have been written yet.
 *   - "Will dispatch on next worker tick" hint when status === SCHEDULED;
 *     no in-line trigger button (dispatcher worker = separate piece).
 *   - "Edit" CTA visible only on DRAFT status; opens an inline rename +
 *     status-toggle (DRAFT ↔ SCHEDULED) form that PATCHes the campaign.
 *
 *   RBAC: ADMIN only (mirrors the API).
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import {
  Megaphone,
  ArrowLeft,
  Loader2,
  Edit3,
  Clock,
  Save,
  X,
} from "lucide-react";

type CampaignKind = "BROADCAST" | "DRIP" | "TRIGGER" | "COHORT_REMINDER";
type CampaignStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED";
type CampaignChannel = "WHATSAPP" | "SMS" | "EMAIL" | "PUSH";

interface AudienceRow {
  id: string;
  name: string;
  description: string | null;
  estimatedSize: number | null;
  lastComputedAt: string | null;
  rules: unknown;
}

interface CampaignDetail {
  id: string;
  name: string;
  description: string | null;
  kind: CampaignKind;
  status: CampaignStatus;
  channels: CampaignChannel[];
  subject: string | null;
  body: string | null;
  audienceId: string | null;
  audience: AudienceRow | null;
  scheduledAt: string | null;
  sendWindowStart: number | null;
  sendWindowEnd: number | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  _count?: { sends: number };
}

interface StatsResponse {
  campaignId: string;
  campaignName: string;
  status: string;
  total: number;
  byStatus: Record<string, number>;
  byChannel: Record<string, Record<string, number>>;
  clicked: number;
  converted: number;
}

function statusClass(status: CampaignStatus): string {
  switch (status) {
    case "DRAFT":
      return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
    case "SCHEDULED":
      return "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
    case "RUNNING":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
    case "PAUSED":
      return "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300";
    case "COMPLETED":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
    case "CANCELLED":
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
  }
}

function fmtMinutes(m: number | null): string {
  if (m === null || m === undefined) return "—";
  const hh = Math.floor(m / 60)
    .toString()
    .padStart(2, "0");
  const mm = (m % 60).toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

export default function CampaignDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { user, isLoading } = useAuthStore();

  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editStatus, setEditStatus] = useState<"DRAFT" | "SCHEDULED">("DRAFT");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isLoading && user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, isLoading, router]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ data: CampaignDetail }>(`/campaigns/${id}`);
      setCampaign(res.data);
      setEditName(res.data.name);
      setEditStatus(
        res.data.status === "SCHEDULED" ? "SCHEDULED" : "DRAFT",
      );
      // Stats endpoint is read-only + always-OK; ignore individual failures.
      try {
        const statsRes = await api.get<{ data: StatsResponse }>(
          `/campaigns/${id}/stats`,
        );
        setStats(statsRes.data);
      } catch {
        setStats(null);
      }
    } catch (err) {
      setError((err as Error).message || "Failed to load campaign");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!isLoading && user?.role === "ADMIN") {
      load();
    }
  }, [load, isLoading, user]);

  async function saveEdit() {
    if (!campaign) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      if (editName.trim() && editName.trim() !== campaign.name) {
        patch.name = editName.trim();
      }
      if (editStatus !== campaign.status) {
        patch.status = editStatus;
      }
      if (Object.keys(patch).length === 0) {
        setEditing(false);
        return;
      }
      await api.patch(`/campaigns/${campaign.id}`, patch);
      toast.success("Campaign updated");
      setEditing(false);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to update campaign");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }
  if (user && user.role !== "ADMIN") return null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="mx-auto max-w-3xl">
        <Link
          href="/dashboard/campaigns"
          className="mb-4 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Back to campaigns
        </Link>
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          {error ?? "Campaign not found"}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/dashboard/campaigns"
        className="mb-4 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> Back to campaigns
      </Link>

      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Megaphone className="h-6 w-6 text-indigo-600" />
          <div>
            {editing ? (
              <input
                aria-label="Campaign name"
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-2xl font-semibold dark:border-gray-700 dark:bg-gray-800"
              />
            ) : (
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {campaign.name}
              </h1>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                {campaign.kind}
              </span>
              <span
                className={
                  "rounded px-2 py-0.5 font-medium " +
                  statusClass(campaign.status)
                }
              >
                {campaign.status}
              </span>
              <span className="text-gray-500">
                {campaign.channels.join(", ")}
              </span>
            </div>
          </div>
        </div>

        {campaign.status === "DRAFT" && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex h-9 items-center gap-1 rounded-lg border border-gray-300 px-3 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
          >
            <Edit3 className="h-4 w-4" /> Edit
          </button>
        )}
      </div>

      {editing && (
        <section className="mb-6 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-900 dark:bg-indigo-950/20">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label
                htmlFor="edit-status"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300"
              >
                Status
              </label>
              <select
                id="edit-status"
                value={editStatus}
                onChange={(e) =>
                  setEditStatus(e.target.value as "DRAFT" | "SCHEDULED")
                }
                className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              >
                <option value="DRAFT">DRAFT</option>
                <option value="SCHEDULED">SCHEDULED</option>
              </select>
            </div>
            <button
              type="button"
              onClick={saveEdit}
              disabled={saving}
              className="flex h-10 items-center gap-1 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setEditName(campaign.name);
                setEditStatus(
                  campaign.status === "SCHEDULED" ? "SCHEDULED" : "DRAFT",
                );
              }}
              className="flex h-10 items-center gap-1 rounded-lg border border-gray-300 px-3 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              <X className="h-4 w-4" /> Cancel
            </button>
          </div>
        </section>
      )}

      {campaign.status === "SCHEDULED" && (
        <p
          className="mb-4 flex items-center gap-2 rounded-lg bg-blue-50 p-3 text-sm text-blue-800 dark:bg-blue-950/40 dark:text-blue-200"
          data-testid="scheduled-hint"
        >
          <Clock className="h-4 w-4" />
          Will dispatch on next worker tick.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* ── Meta panel ───────────────────────────────────────── */}
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-3 text-lg font-semibold">Details</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Send window</dt>
              <dd className="font-mono">
                {fmtMinutes(campaign.sendWindowStart)} →{" "}
                {fmtMinutes(campaign.sendWindowEnd)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Scheduled</dt>
              <dd>
                {campaign.scheduledAt
                  ? new Date(campaign.scheduledAt).toLocaleString()
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Started</dt>
              <dd>
                {campaign.startedAt
                  ? new Date(campaign.startedAt).toLocaleString()
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Completed</dt>
              <dd>
                {campaign.completedAt
                  ? new Date(campaign.completedAt).toLocaleString()
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Created</dt>
              <dd>{new Date(campaign.createdAt).toLocaleString()}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Sends</dt>
              <dd className="tabular-nums">{campaign._count?.sends ?? 0}</dd>
            </div>
          </dl>

          {campaign.subject && (
            <div className="mt-4 border-t pt-3 text-sm dark:border-gray-700">
              <div className="text-xs uppercase text-gray-500">Subject</div>
              <p className="mt-1">{campaign.subject}</p>
            </div>
          )}
          {campaign.body && (
            <div className="mt-3 text-sm">
              <div className="text-xs uppercase text-gray-500">Body</div>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 font-mono text-xs dark:bg-gray-800">
                {campaign.body}
              </pre>
            </div>
          )}
        </section>

        {/* ── Audience panel ───────────────────────────────────── */}
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-3 text-lg font-semibold">Audience</h2>

          {!campaign.audience && (
            <p className="text-sm text-gray-500">
              No audience attached to this campaign.
            </p>
          )}

          {campaign.audience && (
            <>
              <p className="text-sm font-medium">{campaign.audience.name}</p>
              {campaign.audience.description && (
                <p className="mt-1 text-xs text-gray-500">
                  {campaign.audience.description}
                </p>
              )}
              <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                Last computed size:{" "}
                <span className="font-medium" data-testid="audience-size">
                  {campaign.audience.estimatedSize ?? "—"}
                </span>{" "}
                patients{" "}
                {campaign.audience.lastComputedAt && (
                  <span className="text-gray-400">
                    ({new Date(campaign.audience.lastComputedAt).toLocaleString()}
                    )
                  </span>
                )}
              </p>
              <div className="mt-3">
                <div className="text-xs uppercase text-gray-500">
                  Rules (DSL)
                </div>
                <pre
                  data-testid="audience-rules-json"
                  className="mt-1 max-h-64 overflow-auto rounded bg-gray-50 p-2 font-mono text-xs dark:bg-gray-800"
                >
                  {JSON.stringify(campaign.audience.rules, null, 2)}
                </pre>
              </div>
            </>
          )}
        </section>
      </div>

      {/* ── Recent sends (aggregate rollup) ───────────────────── */}
      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 text-lg font-semibold">Send rollup</h2>
        {!stats || stats.total === 0 ? (
          <p className="text-sm text-gray-500">
            No CampaignSend rows yet. They appear once the dispatcher worker
            runs.
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <span className="rounded bg-gray-100 px-2 py-1 text-xs dark:bg-gray-800">
                Total: <strong>{stats.total}</strong>
              </span>
              {Object.entries(stats.byStatus).map(([k, v]) => (
                <span
                  key={k}
                  className="rounded bg-gray-100 px-2 py-1 text-xs dark:bg-gray-800"
                >
                  {k}: <strong>{v}</strong>
                </span>
              ))}
              <span className="rounded bg-emerald-100 px-2 py-1 text-xs dark:bg-emerald-950/40 dark:text-emerald-300">
                Clicked: <strong>{stats.clicked}</strong>
              </span>
              <span className="rounded bg-emerald-100 px-2 py-1 text-xs dark:bg-emerald-950/40 dark:text-emerald-300">
                Converted: <strong>{stats.converted}</strong>
              </span>
            </div>

            {Object.keys(stats.byChannel).length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-gray-500">
                  <tr>
                    <th className="text-left">Channel</th>
                    <th className="text-right">Sent</th>
                    <th className="text-right">Delivered</th>
                    <th className="text-right">Read</th>
                    <th className="text-right">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(stats.byChannel).map(([ch, row]) => (
                    <tr key={ch} className="border-t dark:border-gray-700">
                      <td className="py-1">{ch}</td>
                      <td className="text-right">{row.SENT ?? 0}</td>
                      <td className="text-right">{row.DELIVERED ?? 0}</td>
                      <td className="text-right">{row.READ ?? 0}</td>
                      <td className="text-right">{row.FAILED ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
