"use client";

/**
 * Campaigns list page — Pearl PRD §5.1 gap item #4 piece 4 of 4.
 *
 * What / which modules / why:
 *   - Lists all Campaign rows for the caller's tenant via
 *     `GET /api/v1/campaigns` (ADMIN-gated by the API). Filter by `kind`
 *     and `status`. Each row shows name, channels, kind, status, send
 *     count (from `_count.sends`), createdAt.
 *   - Pearl §5.1 backend pieces 1+2 shipped earlier; this page is the
 *     operator-facing surface that lets a marketing admin browse + open
 *     campaigns. "New Campaign" CTA navigates to `/dashboard/campaigns/new`.
 *   - RBAC mirrors the API: ADMIN only; everyone else bounces to
 *     `/dashboard`. Non-MARKETING (no such enum exists today — Role.MARKETING
 *     was scope-cut at the backend) — only ADMIN can manage campaigns.
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Megaphone, Plus, Loader2 } from "lucide-react";
import { SkeletonTable } from "@/components/Skeleton";

type CampaignKind = "BROADCAST" | "DRIP" | "TRIGGER" | "COHORT_REMINDER";
type CampaignStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED";
type CampaignChannel = "WHATSAPP" | "SMS" | "EMAIL" | "PUSH";

interface CampaignRow {
  id: string;
  name: string;
  kind: CampaignKind;
  status: CampaignStatus;
  channels: CampaignChannel[];
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  _count?: { sends: number };
}

const KIND_OPTIONS: ReadonlyArray<CampaignKind> = [
  "BROADCAST",
  "DRIP",
  "TRIGGER",
  "COHORT_REMINDER",
];
const STATUS_OPTIONS: ReadonlyArray<CampaignStatus> = [
  "DRAFT",
  "SCHEDULED",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
];

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

export default function CampaignsPage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();

  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [kindFilter, setKindFilter] = useState<"" | CampaignKind>("");
  const [statusFilter, setStatusFilter] = useState<"" | CampaignStatus>("");

  useEffect(() => {
    if (!isLoading && user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, isLoading, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter
        ? `?status=${encodeURIComponent(statusFilter)}`
        : "";
      const res = await api.get<{ data: CampaignRow[] }>(`/campaigns${qs}`);
      setCampaigns(res.data ?? []);
    } catch (err) {
      setError((err as Error).message || "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    if (!isLoading && user?.role === "ADMIN") {
      load();
    }
  }, [load, isLoading, user]);

  // Kind filter is client-side (API only supports status query param).
  const visible = kindFilter
    ? campaigns.filter((c) => c.kind === kindFilter)
    : campaigns;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (user && user.role !== "ADMIN") return null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Megaphone className="h-6 w-6 text-indigo-600" />
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              Campaigns
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Broadcast / drip / trigger / cohort-reminder campaigns. Pearl
              §5.1.
            </p>
          </div>
        </div>
        <Link
          href="/dashboard/campaigns/new"
          className="flex h-11 items-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" /> New Campaign
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div>
          <label
            htmlFor="campaigns-kind-filter"
            className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
          >
            Kind
          </label>
          <select
            id="campaigns-kind-filter"
            value={kindFilter}
            onChange={(e) =>
              setKindFilter(e.target.value as "" | CampaignKind)
            }
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="">All kinds</option>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="campaigns-status-filter"
            className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
          >
            Status
          </label>
          <select
            id="campaigns-status-filter"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "" | CampaignStatus)
            }
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <SkeletonTable rows={6} columns={6} />
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {!loading && !error && visible.length === 0 && (
        <p className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700">
          No campaigns yet. Start with{" "}
          <Link
            href="/dashboard/campaigns/new"
            className="text-indigo-600 hover:underline"
          >
            New Campaign
          </Link>
          .
        </p>
      )}

      {!loading && visible.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Kind</th>
                <th className="px-4 py-3">Channels</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Sends</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {visible.map((c) => (
                <tr
                  key={c.id}
                  data-testid="campaign-row"
                  className="hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/campaigns/${c.id}`}
                      className="font-medium text-indigo-600 hover:underline"
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                    {c.kind}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                    {c.channels.join(", ")}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        "rounded px-2 py-0.5 text-xs font-medium " +
                        statusClass(c.status)
                      }
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-gray-700 dark:text-gray-300">
                    {c._count?.sends ?? 0}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {new Date(c.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
