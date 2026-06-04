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
import { SkeletonCard, SkeletonText } from "@/components/Skeleton";

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

// Issue #984: render the audience-rule DSL as plain English instead of
// the raw JSON triples (e.g. `{ op: "gte", field: "age", value: 40 }`).
// Mirrors the v1 supported predicates in
// apps/api/src/services/audience-compiler.ts and the UI-side mapping in
// apps/web/src/app/dashboard/campaigns/new/page.tsx::buildRulesPayload.
// Falls back to the JSON pretty-print for any unknown shape so the
// operator still sees SOMETHING for newer DSL fields not yet covered
// here (defensive — keeps the panel useful as the DSL grows).
interface AudienceFilter {
  field?: string;
  op?: string;
  value?: unknown;
}
interface AudienceRulesV1 {
  filters?: AudienceFilter[];
  matchMode?: "ALL" | "ANY";
}

const FIELD_LABELS: Record<string, string> = {
  gender: "Gender",
  age: "Age",
  lastVisitDays: "Days since last visit",
  abhaLinked: "ABHA linked",
  city: "City",
  branchId: "Branch",
  optedOut: "Opted out",
};

function formatFilterValue(field: string, op: string, value: unknown): string {
  if (field === "abhaLinked" || field === "optedOut") {
    return value === true ? "Yes" : value === false ? "No" : String(value);
  }
  if (field === "gender" && typeof value === "string") {
    // Title-case MALE -> Male, FEMALE -> Female, OTHER -> Other.
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  }
  if (op === "in" && Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  return String(value);
}

function describeFilter(f: AudienceFilter): string | null {
  if (!f || typeof f !== "object") return null;
  const field = typeof f.field === "string" ? f.field : null;
  const op = typeof f.op === "string" ? f.op : null;
  if (!field || !op) return null;
  const label = FIELD_LABELS[field] ?? field;
  const v = formatFilterValue(field, op, f.value);
  switch (op) {
    case "eq":
      return `${label} is ${v}`;
    case "neq":
      return `${label} is not ${v}`;
    case "gte":
      return `${label} ≥ ${v}`;
    case "lte":
      return `${label} ≤ ${v}`;
    case "gt":
      return `${label} > ${v}`;
    case "lt":
      return `${label} < ${v}`;
    case "in":
      return `${label} in: ${v}`;
    default:
      return `${label} ${op} ${v}`;
  }
}

// True when the rules object looks like the v1 DSL shape we know how to
// pretty-print. Anything else falls back to JSON so we don't silently
// hide unknown fields.
function isV1Rules(r: unknown): r is AudienceRulesV1 {
  if (!r || typeof r !== "object") return false;
  const x = r as { filters?: unknown };
  return Array.isArray(x.filters);
}

// Issue #987: render a sample-resolved preview of the campaign body so
// operators can verify how their {{first_name}}/{{last_visit}} tokens
// will look to a real recipient. Mirrors the dispatcher's substitution
// surface from the new-campaign page (PERSONALISATION_TOKENS). The
// sample values are illustrative only — the actual dispatcher fills
// them per audience row at send time.
const PREVIEW_SAMPLE: Record<string, string> = {
  first_name: "Anita",
  last_visit: "12 Mar",
};

function renderPreview(template: string | null): string {
  if (!template) return "";
  // {{ token }} with optional whitespace; non-greedy match on token name
  // restricted to lowercase letters + underscore (same shape as the
  // dispatcher's allowlist).
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (raw, key: string) => {
    if (key in PREVIEW_SAMPLE) return PREVIEW_SAMPLE[key];
    // Unknown token — keep the original {{...}} so it's visibly broken
    // in the preview instead of silently disappearing. Helps the
    // operator catch typos.
    return raw;
  });
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
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 h-4 w-32">
          <SkeletonText lines={1} />
        </div>
        <div className="mb-6">
          <SkeletonText lines={2} />
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <SkeletonCard className="h-64" />
          <SkeletonCard className="h-64" />
        </div>
        <SkeletonCard className="mt-6 h-40" />
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

          {/* Issue #987: render a sample-resolved Preview of subject +
              body alongside the raw template. Operators can verify the
              rendered output before scheduling, and still see the
              underlying {{tokens}} via the "Raw template" details. */}
          {campaign.subject && (
            <div className="mt-4 border-t pt-3 text-sm dark:border-gray-700">
              <div className="text-xs uppercase text-gray-500">
                Subject preview
                <span className="ml-1 text-[10px] font-normal normal-case text-gray-400">
                  (sample: first_name="{PREVIEW_SAMPLE.first_name}",
                  last_visit="{PREVIEW_SAMPLE.last_visit}")
                </span>
              </div>
              <p
                data-testid="campaign-subject-preview"
                className="mt-1"
              >
                {renderPreview(campaign.subject)}
              </p>
              {campaign.subject !== renderPreview(campaign.subject) && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                    Show raw template
                  </summary>
                  <pre
                    data-testid="campaign-subject-raw"
                    className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 font-mono text-xs dark:bg-gray-800"
                  >
                    {campaign.subject}
                  </pre>
                </details>
              )}
            </div>
          )}
          {campaign.body && (
            <div className="mt-3 text-sm">
              <div className="text-xs uppercase text-gray-500">
                Body preview
                <span className="ml-1 text-[10px] font-normal normal-case text-gray-400">
                  (sample values shown; dispatcher fills per recipient)
                </span>
              </div>
              <pre
                data-testid="campaign-body-preview"
                className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs dark:bg-gray-800"
              >
                {renderPreview(campaign.body)}
              </pre>
              {campaign.body !== renderPreview(campaign.body) && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                    Show raw template
                  </summary>
                  <pre
                    data-testid="campaign-body-raw"
                    className="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 font-mono text-xs dark:bg-gray-800"
                  >
                    {campaign.body}
                  </pre>
                </details>
              )}
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
              {/* Issue #984: human-readable rule summary instead of raw
                  JSON. Falls back to a collapsible <details> with the
                  JSON pretty-print so power users / debugging can still
                  see the underlying DSL on demand. */}
              <div className="mt-3">
                <div className="text-xs uppercase text-gray-500">Targeting</div>
                {(() => {
                  const rules = campaign.audience.rules;
                  if (isV1Rules(rules) && (rules.filters?.length ?? 0) > 0) {
                    const matchMode = rules.matchMode ?? "ALL";
                    return (
                      <div data-testid="audience-rules-human" className="mt-1">
                        <p className="text-xs text-gray-600 dark:text-gray-400">
                          Patients matching{" "}
                          <strong>
                            {matchMode === "ANY" ? "ANY" : "ALL"}
                          </strong>{" "}
                          of:
                        </p>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-gray-800 dark:text-gray-200">
                          {(rules.filters ?? []).map((f, i) => {
                            const desc = describeFilter(f);
                            if (!desc) return null;
                            return (
                              <li
                                key={i}
                                data-testid="audience-rules-row"
                              >
                                {desc}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  }
                  // Empty filters or unknown shape — keep the JSON view
                  // as the only signal (better than blank), but flag it.
                  return (
                    <p
                      data-testid="audience-rules-empty"
                      className="mt-1 text-xs italic text-gray-500"
                    >
                      No filters — all patients in tenant.
                    </p>
                  );
                })()}
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                    Show raw DSL
                  </summary>
                  <pre
                    data-testid="audience-rules-json"
                    className="mt-1 max-h-64 overflow-auto rounded bg-gray-50 p-2 font-mono text-xs dark:bg-gray-800"
                  >
                    {JSON.stringify(campaign.audience.rules, null, 2)}
                  </pre>
                </details>
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
