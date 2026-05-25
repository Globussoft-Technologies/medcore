"use client";

/**
 * New Campaign page (audience builder + create) — Pearl PRD §5.1 gap #4
 * piece 4 of 4.
 *
 * What / which modules / why:
 *   - Operator-facing UI to craft a Campaign: meta (name/kind/channels),
 *     personalised subject + body (with token hints), an audience-rule
 *     builder targeting Patient demographics + clinical signals (matches
 *     v1 of the DSL in `services/audience-compiler.ts`: gender / age /
 *     lastVisitDays / abhaLinked; `city / branchId / optedOut` reserved
 *     no-op fields hidden until the schema supports them).
 *   - Live "Audience size: N patients" preview by POSTing to
 *     `/api/v1/campaign-audiences` (creates a draft audience), then
 *     `/api/v1/campaign-audiences/:id/compile` (returns count + sample).
 *     The audience is persisted (no preview-without-save endpoint exists)
 *     and reused as the campaign's `audienceId` on submit.
 *   - Submit POSTs `/api/v1/campaigns` and redirects to the detail page.
 *
 *   RBAC: ADMIN only (mirrors the API).
 */

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import {
  Megaphone,
  Save,
  Users,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

type CampaignKind = "BROADCAST" | "DRIP" | "TRIGGER" | "COHORT_REMINDER";
type CampaignChannel = "WHATSAPP" | "SMS" | "EMAIL" | "PUSH";

const KINDS: ReadonlyArray<CampaignKind> = [
  "BROADCAST",
  "DRIP",
  "TRIGGER",
  "COHORT_REMINDER",
];
const CHANNELS: ReadonlyArray<CampaignChannel> = [
  "WHATSAPP",
  "SMS",
  "EMAIL",
  "PUSH",
];

// Audience-filter DSL — mirrors the v1 supported predicates in
// `apps/api/src/services/audience-compiler.ts`. The compiler treats
// unknown (field, op) pairs as no-ops + warns, so we keep the UI tightly
// scoped to what actually filters today.
type FilterField =
  | "gender"
  | "ageMin"
  | "ageMax"
  | "lastVisitDaysMin"
  | "lastVisitDaysMax"
  | "abhaLinked";

interface UIFilter {
  field: FilterField;
  value: string; // input is a string; mapped to typed value on submit
}

// Map UI filter rows → DSL filter triples.
function buildRulesPayload(filters: UIFilter[]): {
  filters: Array<{ field: string; op: string; value: unknown }>;
  matchMode: "ALL";
} {
  const out: Array<{ field: string; op: string; value: unknown }> = [];
  for (const f of filters) {
    if (f.value === "" || f.value === undefined || f.value === null) continue;
    switch (f.field) {
      case "gender":
        out.push({ field: "gender", op: "eq", value: f.value.toUpperCase() });
        break;
      case "ageMin":
        out.push({ field: "age", op: "gte", value: Number(f.value) });
        break;
      case "ageMax":
        out.push({ field: "age", op: "lte", value: Number(f.value) });
        break;
      case "lastVisitDaysMin":
        out.push({ field: "lastVisitDays", op: "gte", value: Number(f.value) });
        break;
      case "lastVisitDaysMax":
        out.push({ field: "lastVisitDays", op: "lte", value: Number(f.value) });
        break;
      case "abhaLinked":
        out.push({
          field: "abhaLinked",
          op: "eq",
          value: f.value === "true",
        });
        break;
    }
  }
  return { filters: out, matchMode: "ALL" };
}

// Convert HH:MM time string → minute-of-day (0..1439).
function timeToMinutes(t: string): number | null {
  if (!t) return null;
  const [hh, mm] = t.split(":").map((x) => Number(x));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
}

export default function NewCampaignPage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();

  useEffect(() => {
    if (!isLoading && user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, isLoading, router]);

  // Campaign meta
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CampaignKind>("BROADCAST");
  const [channels, setChannels] = useState<CampaignChannel[]>(["WHATSAPP"]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendWindowStart, setSendWindowStart] = useState("09:00");
  const [sendWindowEnd, setSendWindowEnd] = useState("21:00");

  // Audience
  const [audienceName, setAudienceName] = useState("");
  const [filters, setFilters] = useState<UIFilter[]>([
    { field: "ageMin", value: "" },
  ]);
  const [audienceId, setAudienceId] = useState<string | null>(null);
  const [audienceSize, setAudienceSize] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function toggleChannel(c: CampaignChannel) {
    setChannels((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  }

  function addFilter() {
    setFilters((prev) => [...prev, { field: "gender", value: "" }]);
    // Mutating the audience invalidates the saved/preview state.
    setAudienceId(null);
    setAudienceSize(null);
  }

  function removeFilter(idx: number) {
    setFilters((prev) => prev.filter((_, i) => i !== idx));
    setAudienceId(null);
    setAudienceSize(null);
  }

  function updateFilter(idx: number, patch: Partial<UIFilter>) {
    setFilters((prev) =>
      prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    );
    setAudienceId(null);
    setAudienceSize(null);
  }

  const canPreview = useMemo(
    () =>
      audienceName.trim().length >= 2 &&
      filters.some((f) => f.value !== ""),
    [audienceName, filters],
  );

  // "Save audience & preview size" — creates the CampaignAudience then
  // calls the compile endpoint. The persisted audience id is reused as
  // the campaign's audienceId on submit. No standalone preview-without-
  // save endpoint exists.
  const handlePreview = useCallback(async () => {
    if (!canPreview) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const rules = buildRulesPayload(filters);
      const created = await api.post<{
        data: { id: string; name: string };
      }>("/campaign-audiences", {
        name: audienceName.trim(),
        rules,
        active: true,
      });
      const id = created.data.id;
      setAudienceId(id);

      const compiled = await api.post<{
        data: { count: number };
      }>(`/campaign-audiences/${id}/compile`);
      setAudienceSize(compiled.data.count);
    } catch (err) {
      setPreviewError(
        (err as Error).message || "Failed to preview audience size",
      );
    } finally {
      setPreviewing(false);
    }
  }, [audienceName, filters, canPreview]);

  const canSubmit =
    name.trim().length >= 2 &&
    channels.length > 0 &&
    !!audienceId &&
    !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const swStart = timeToMinutes(sendWindowStart);
      const swEnd = timeToMinutes(sendWindowEnd);

      const created = await api.post<{
        data: { id: string };
      }>("/campaigns", {
        name: name.trim(),
        kind,
        channels,
        subject: subject || null,
        body: body || null,
        audienceId,
        sendWindowStart: swStart,
        sendWindowEnd: swEnd,
      });
      toast.success("Campaign created");
      router.push(`/dashboard/campaigns/${created.data.id}`);
    } catch (err) {
      setSubmitError((err as Error).message || "Failed to create campaign");
      setSubmitting(false);
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

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center gap-3">
        <Megaphone className="h-6 w-6 text-indigo-600" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            New Campaign
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Define audience, channels and message. Pearl §5.1.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* ── Meta ────────────────────────────────────────────── */}
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-3 text-lg font-semibold">Campaign meta</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label
                htmlFor="campaign-name"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Name <span className="text-red-500">*</span>
              </label>
              <input
                id="campaign-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Diwali outreach 2026"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                required
              />
            </div>
            <div>
              <label
                htmlFor="campaign-kind"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Kind
              </label>
              <select
                id="campaign-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as CampaignKind)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Channels <span className="text-red-500">*</span>
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {CHANNELS.map((c) => {
                const on = channels.includes(c);
                return (
                  <label
                    key={c}
                    className={
                      "cursor-pointer rounded-full border px-3 py-1 text-xs " +
                      (on
                        ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40"
                        : "border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-400")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleChannel(c)}
                      className="sr-only"
                      data-testid={`channel-${c}`}
                    />
                    {c}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </section>

        {/* ── Message ─────────────────────────────────────────── */}
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-1 text-lg font-semibold">Message</h2>
          <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
            Tokens supported by the dispatcher:{" "}
            <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">
              {"{{first_name}}"}
            </code>{" "}
            <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">
              {"{{last_visit}}"}
            </code>
          </p>

          <div className="grid gap-3">
            <div>
              <label
                htmlFor="campaign-subject"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Subject{" "}
                <span className="text-xs text-gray-400">
                  (Email only — ignored on other channels)
                </span>
              </label>
              <input
                id="campaign-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={255}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
            </div>
            <div>
              <label
                htmlFor="campaign-body"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Body
              </label>
              <textarea
                id="campaign-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={8000}
                rows={4}
                placeholder="Hi {{first_name}}, it's been a while since {{last_visit}}…"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-800"
              />
              <p className="mt-1 text-xs text-gray-500">
                {body.length} / 8000
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div>
              <label
                htmlFor="campaign-window-start"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Send window start
              </label>
              <input
                id="campaign-window-start"
                type="time"
                value={sendWindowStart}
                onChange={(e) => setSendWindowStart(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
            </div>
            <div>
              <label
                htmlFor="campaign-window-end"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Send window end
              </label>
              <input
                id="campaign-window-end"
                type="time"
                value={sendWindowEnd}
                onChange={(e) => setSendWindowEnd(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
            </div>
          </div>
        </section>

        {/* ── Audience builder ────────────────────────────────── */}
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="mb-3 flex items-center gap-2">
            <Users className="h-5 w-5 text-indigo-600" />
            <h2 className="text-lg font-semibold">Audience</h2>
          </div>

          <div className="mb-3">
            <label
              htmlFor="audience-name"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Audience name <span className="text-red-500">*</span>
            </label>
            <input
              id="audience-name"
              type="text"
              value={audienceName}
              onChange={(e) => setAudienceName(e.target.value)}
              placeholder="Lapsed hypertensives over 55"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>

          <ul className="space-y-2">
            {filters.map((f, idx) => (
              <li
                key={idx}
                data-testid="audience-filter-row"
                className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800"
              >
                <select
                  value={f.field}
                  onChange={(e) =>
                    updateFilter(idx, {
                      field: e.target.value as FilterField,
                      value: "",
                    })
                  }
                  aria-label="Filter field"
                  className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900"
                >
                  <option value="gender">Gender</option>
                  <option value="ageMin">Age &ge;</option>
                  <option value="ageMax">Age &le;</option>
                  <option value="lastVisitDaysMin">
                    Days since last visit &ge;
                  </option>
                  <option value="lastVisitDaysMax">
                    Days since last visit &le;
                  </option>
                  <option value="abhaLinked">ABHA linked</option>
                </select>

                {f.field === "gender" && (
                  <select
                    value={f.value}
                    onChange={(e) =>
                      updateFilter(idx, { value: e.target.value })
                    }
                    aria-label="Gender value"
                    className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900"
                  >
                    <option value="">—</option>
                    <option value="MALE">Male</option>
                    <option value="FEMALE">Female</option>
                    <option value="OTHER">Other</option>
                  </select>
                )}

                {f.field === "abhaLinked" && (
                  <select
                    value={f.value}
                    onChange={(e) =>
                      updateFilter(idx, { value: e.target.value })
                    }
                    aria-label="ABHA linked value"
                    className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900"
                  >
                    <option value="">—</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                )}

                {(f.field === "ageMin" ||
                  f.field === "ageMax" ||
                  f.field === "lastVisitDaysMin" ||
                  f.field === "lastVisitDaysMax") && (
                  <input
                    type="number"
                    min={0}
                    max={f.field.startsWith("age") ? 130 : 3650}
                    value={f.value}
                    onChange={(e) =>
                      updateFilter(idx, { value: e.target.value })
                    }
                    placeholder="0"
                    aria-label="Filter numeric value"
                    className="w-24 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900"
                  />
                )}

                <button
                  type="button"
                  onClick={() => removeFilter(idx)}
                  aria-label="Remove filter"
                  className="ml-auto rounded p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={addFilter}
              className="flex h-9 items-center gap-1 rounded-lg border border-gray-300 px-3 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              <Plus className="h-3 w-3" /> Add filter
            </button>

            <button
              type="button"
              onClick={handlePreview}
              disabled={!canPreview || previewing}
              className="flex h-9 items-center gap-1 rounded-lg bg-gray-900 px-3 text-xs font-medium text-white hover:bg-black disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
            >
              {previewing && <Loader2 className="h-3 w-3 animate-spin" />}
              Save audience &amp; preview size
            </button>

            {audienceSize !== null && (
              <span
                data-testid="audience-size"
                className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              >
                Audience size: {audienceSize} patients
              </span>
            )}
          </div>

          {previewError && (
            <p
              role="alert"
              className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
            >
              {previewError}
            </p>
          )}
        </section>

        {/* ── Submit ──────────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex h-11 items-center gap-2 rounded-lg bg-indigo-600 px-5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Create campaign
          </button>
          {!audienceId && (
            <p className="text-xs text-gray-500">
              Save the audience first to enable Create.
            </p>
          )}
        </div>

        {submitError && (
          <p
            role="alert"
            className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
          >
            {submitError}
          </p>
        )}
      </form>
    </div>
  );
}
