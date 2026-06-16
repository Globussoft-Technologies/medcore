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

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { CAMPAIGN_SEND_WINDOW_POLICY } from "@medcore/shared";
import {
  Megaphone,
  Save,
  Users,
  Loader2,
  Plus,
  Trash2,
  FlaskConical,
  ChevronDown,
  ChevronRight,
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
  | "abhaLinked"
  | "condition" // diagnosis (ICD-10 / name) — searchable
  | "allergy"; // allergen name — searchable

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
      case "condition":
        // Diagnosis match — name or ICD-10 contains. Compiled across the
        // chronic-condition / prescription / admission surfaces server-side.
        out.push({ field: "condition", op: "eq", value: f.value.trim() });
        break;
      case "allergy":
        // Allergen contains (case-insensitive) — PatientAllergy.allergen.
        out.push({ field: "allergy", op: "eq", value: f.value.trim() });
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

// Issue #985 — quiet-hour policy: campaigns must dispatch within
// 09:00..21:00 IST. Mirror the server schema's
// CAMPAIGN_SEND_WINDOW_POLICY so the client surfaces the error before
// the round-trip. Returns null when valid; otherwise the message to
// show under the offending input.
function checkSendWindowPolicy(
  start: string,
  end: string,
): string | null {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s == null || e == null) return null;
  if (s >= e) {
    return "Start must be before end.";
  }
  if (s < CAMPAIGN_SEND_WINDOW_POLICY.minStart) {
    return CAMPAIGN_SEND_WINDOW_POLICY.label;
  }
  if (e > CAMPAIGN_SEND_WINDOW_POLICY.maxEnd) {
    return CAMPAIGN_SEND_WINDOW_POLICY.label;
  }
  return null;
}

// SOW row M4 closure (piece 5) — A/B variant UI.
//
// Backend contract (parseAbVariants + pickVariant in campaign-dispatcher.ts):
//   abVariants: [{ id, weight, subjectOverride?, bodyOverride? }]
//   - id must be non-empty (1..40 chars). Used as the attribution key
//     on CampaignSend.variantId.
//   - weight is a positive int. The dispatcher does weighted-random over
//     the absolute weights; the schema caps each at 100 but doesn't
//     require them to sum to 100. We enforce sum=100 in the UI anyway
//     because "split %" is the mental model operators expect.
//   - Both override fields are optional. The dispatcher falls back to
//     campaign.subject/body when an override is absent — so two-variant
//     campaigns can vary only the body, only the subject, or both.
//
// At most 10 variants (schema cap). Minimum 2 when the A/B mode is on
// (otherwise it's just a single message — turn the mode off).

interface UIVariant {
  // Stable React key so reordering / editing the id field doesn't
  // remount the row.
  rid: string;
  id: string; // attribution label (A / B / "v1" / etc.)
  weight: number; // split percentage, 0..100; sum across variants = 100
  subjectOverride: string;
  bodyOverride: string;
  expanded: boolean; // whether the per-variant subject/body block is open
}

function makeVariant(label: string, weight: number): UIVariant {
  return {
    rid:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
    id: label,
    weight,
    subjectOverride: "",
    bodyOverride: "",
    expanded: false,
  };
}

// Rebalance weights so they sum to 100 after one row is edited or a row
// is added/removed. Strategy: keep the just-edited row at its target,
// distribute the remaining (100 - target) across the OTHER rows
// proportional to their current weights. If the others all sum to 0,
// split the remainder evenly.
function rebalanceAfterEdit(
  variants: UIVariant[],
  editedIdx: number,
  targetWeight: number,
): UIVariant[] {
  const clamped = Math.max(0, Math.min(100, Math.round(targetWeight)));
  if (variants.length <= 1) {
    return variants.map((v, i) =>
      i === editedIdx ? { ...v, weight: 100 } : v,
    );
  }
  const remainder = 100 - clamped;
  const others = variants.filter((_, i) => i !== editedIdx);
  const othersSum = others.reduce((s, v) => s + v.weight, 0);

  let allocated = 0;
  const next = variants.map((v, i) => {
    if (i === editedIdx) return { ...v, weight: clamped };
    let w: number;
    if (othersSum === 0) {
      w = Math.floor(remainder / others.length);
    } else {
      w = Math.round((v.weight / othersSum) * remainder);
    }
    allocated += w;
    return { ...v, weight: w };
  });

  // Drift correction — push the rounding error onto the LAST non-edited
  // row so the table always sums to exactly 100.
  const drift = remainder - allocated;
  if (drift !== 0) {
    for (let i = next.length - 1; i >= 0; i--) {
      if (i !== editedIdx) {
        next[i] = { ...next[i], weight: Math.max(0, next[i].weight + drift) };
        break;
      }
    }
  }
  return next;
}

// Even-split helper used on add/remove. Pure: caller passes `variants`
// already mutated (added or removed), this normalises the weights.
function rebalanceEvenly(variants: UIVariant[]): UIVariant[] {
  if (variants.length === 0) return variants;
  const base = Math.floor(100 / variants.length);
  const drift = 100 - base * variants.length;
  return variants.map((v, i) => ({
    ...v,
    weight: i === 0 ? base + drift : base,
  }));
}

function nextVariantLabel(existing: UIVariant[]): string {
  // A, B, C, … Z, then AA, AB, … — but we cap at 10 in the UI so this
  // realistically only emits A..J.
  const used = new Set(existing.map((v) => v.id.trim().toUpperCase()));
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const ch of letters) {
    if (!used.has(ch)) return ch;
  }
  return `V${existing.length + 1}`;
}

// Validate the UI variant set against the server contract. Returns the
// first user-facing error string, or null when valid.
function validateVariants(variants: UIVariant[]): string | null {
  if (variants.length < 2) return "A/B testing needs at least 2 variants.";
  if (variants.length > 10) return "At most 10 variants allowed.";
  const ids = new Set<string>();
  for (const v of variants) {
    const id = v.id.trim();
    if (!id) return "Every variant needs a non-empty label.";
    if (id.length > 40) return `Variant "${id}" label is too long (max 40).`;
    const key = id.toUpperCase();
    if (ids.has(key)) return `Duplicate variant label "${id}".`;
    ids.add(key);
    if (!Number.isFinite(v.weight) || v.weight < 1)
      return `Variant "${id}" needs a split weight of at least 1%.`;
    if (v.weight > 100)
      return `Variant "${id}" split can't exceed 100%.`;
    if (v.subjectOverride.length > 255)
      return `Variant "${id}" subject is too long (max 255).`;
    if (v.bodyOverride.length > 8000)
      return `Variant "${id}" body is too long (max 8000).`;
  }
  const sum = variants.reduce((s, v) => s + v.weight, 0);
  if (sum !== 100)
    return `Splits must add up to 100% (currently ${sum}%).`;
  return null;
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

  // Issue #983: render personalisation tokens as clickable chips instead
  // of exposing raw {{handlebars}} syntax in helper text + textarea
  // placeholder. The dispatcher resolves these at send time; the chip's
  // `insert` value is what the dispatcher actually expects, but operators
  // never need to know that — they just click a chip to insert at the
  // textarea's caret. Each chip also carries an `example` value that
  // powers the resolved-sample placeholder.
  const PERSONALISATION_TOKENS = [
    { label: "First name", insert: "{{first_name}}", example: "Anita" },
    {
      label: "Last visit",
      insert: "{{last_visit}}",
      example: "12 Mar",
    },
  ] as const;
  const bodyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  function insertToken(token: string) {
    const ta = bodyTextareaRef.current;
    if (!ta) {
      setBody((prev) => prev + token);
      return;
    }
    const start = ta.selectionStart ?? body.length;
    const end = ta.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    // Restore caret to just-after-inserted token on the next paint.
    requestAnimationFrame(() => {
      if (!bodyTextareaRef.current) return;
      const pos = start + token.length;
      bodyTextareaRef.current.focus();
      bodyTextareaRef.current.setSelectionRange(pos, pos);
    });
  }
  // Resolved-example placeholder for the body textarea. Same copy as
  // the previous raw-token placeholder, but with `{{...}}` swapped for
  // example values so operators see what the patient will receive.
  const bodyPlaceholderResolved = `Hi ${PERSONALISATION_TOKENS[0].example}, it's been a while since ${PERSONALISATION_TOKENS[1].example}…`;

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

  // Issue #985 — derived send-window-policy error, recomputed on every
  // input change. Pushes the inline message and gates `canSubmit`.
  const sendWindowError = useMemo(
    () => checkSendWindowPolicy(sendWindowStart, sendWindowEnd),
    [sendWindowStart, sendWindowEnd],
  );

  // ── A/B variants state ─────────────────────────────────────────────
  // Default off — backwards-compatible with the single-message UX. When
  // an operator enables it, we seed two variants (A / B) at 50/50 so the
  // first state the user sees is already valid.
  const [abEnabled, setAbEnabled] = useState(false);
  const [variants, setVariants] = useState<UIVariant[]>([]);

  function enableAb() {
    setAbEnabled(true);
    setVariants([makeVariant("A", 50), makeVariant("B", 50)]);
  }
  function disableAb() {
    setAbEnabled(false);
    setVariants([]);
  }

  function addVariant() {
    setVariants((prev) => {
      if (prev.length >= 10) return prev;
      const next = [...prev, makeVariant(nextVariantLabel(prev), 0)];
      return rebalanceEvenly(next);
    });
  }
  function removeVariant(rid: string) {
    setVariants((prev) => {
      if (prev.length <= 2) return prev; // enforce min when A/B is on
      const next = prev.filter((v) => v.rid !== rid);
      return rebalanceEvenly(next);
    });
  }
  function updateVariantLabel(rid: string, label: string) {
    setVariants((prev) =>
      prev.map((v) => (v.rid === rid ? { ...v, id: label } : v)),
    );
  }
  function updateVariantWeight(rid: string, weight: number) {
    setVariants((prev) => {
      const idx = prev.findIndex((v) => v.rid === rid);
      if (idx < 0) return prev;
      return rebalanceAfterEdit(prev, idx, weight);
    });
  }
  function updateVariantField(
    rid: string,
    field: "subjectOverride" | "bodyOverride",
    value: string,
  ) {
    setVariants((prev) =>
      prev.map((v) => (v.rid === rid ? { ...v, [field]: value } : v)),
    );
  }
  function toggleVariantExpanded(rid: string) {
    setVariants((prev) =>
      prev.map((v) =>
        v.rid === rid ? { ...v, expanded: !v.expanded } : v,
      ),
    );
  }

  const variantsError = useMemo(
    () => (abEnabled ? validateVariants(variants) : null),
    [abEnabled, variants],
  );

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
    !submitting &&
    // Issue #985 — block submit when the send window violates the
    // quiet-hour policy. The server schema also rejects this, but
    // catching it client-side prevents a confusing round-trip + toast.
    !sendWindowError &&
    // SOW M4 piece 5 — A/B variants must be self-consistent (≥2,
    // unique labels, splits sum to 100). Disabling A/B clears the
    // error since `variantsError` is null when abEnabled is false.
    !variantsError;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const swStart = timeToMinutes(sendWindowStart);
      const swEnd = timeToMinutes(sendWindowEnd);

      // SOW M4 piece 5 — collapse the UI variants into the wire shape
      // the dispatcher's parseAbVariants() expects. Strip empty
      // override strings so the dispatcher's fallback-to-campaign.body
      // path kicks in cleanly rather than overriding with "".
      const abVariantsPayload =
        abEnabled && variants.length > 0
          ? variants.map((v) => ({
              id: v.id.trim(),
              weight: v.weight,
              ...(v.subjectOverride.trim()
                ? { subjectOverride: v.subjectOverride.trim() }
                : {}),
              ...(v.bodyOverride.trim()
                ? { bodyOverride: v.bodyOverride.trim() }
                : {}),
            }))
          : null;

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
        abVariants: abVariantsPayload,
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
          {/* Issue #983: replace raw {{handlebars}} helper text with
              labelled chips. Clicking a chip inserts the underlying
              token at the body textarea's caret, so operators never
              need to learn the dispatcher's templating syntax. */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span>Personalisation:</span>
            {PERSONALISATION_TOKENS.map((tk) => (
              <button
                key={tk.insert}
                type="button"
                onClick={() => insertToken(tk.insert)}
                data-testid={`campaign-token-${tk.insert.replace(/[^a-z_]/gi, "")}`}
                className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-medium text-indigo-700 hover:border-indigo-400 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
                title={`Inserts the patient's ${tk.label.toLowerCase()} at send time (e.g. "${tk.example}")`}
              >
                + {tk.label}
              </button>
            ))}
            <span className="text-[11px] italic text-gray-400">
              Click a chip to insert at the cursor; the dispatcher fills it in
              per patient.
            </span>
          </div>

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
                ref={bodyTextareaRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={8000}
                rows={4}
                // Issue #983: placeholder shows the message as the
                // patient will receive it (with example values) instead
                // of the raw {{...}} templating syntax. The actual
                // tokens are inserted via the chips above.
                placeholder={bodyPlaceholderResolved}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-800"
              />
              <p className="mt-1 text-xs text-gray-500">
                {body.length} / 8000
              </p>
            </div>
          </div>

          {/* Issue #985: enforce 09:00..21:00 quiet-hour policy on
              both inputs + show an inline error when violated. The
              type=time pickers respect the min/max hint on most
              browsers, but we ALSO compute checkSendWindowPolicy()
              and block submit because (a) Safari ignores the time-
              input clamp on mobile and (b) typed-in values can
              bypass the spinner. The server-side schema refinement
              in packages/shared/src/validation/campaign.ts is the
              defence-in-depth check. */}
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
                min="09:00"
                max="21:00"
                value={sendWindowStart}
                onChange={(e) => setSendWindowStart(e.target.value)}
                aria-invalid={!!sendWindowError}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm dark:bg-gray-800 ${
                  sendWindowError
                    ? "border-red-400 dark:border-red-500"
                    : "border-gray-300 dark:border-gray-700"
                }`}
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
                min="09:00"
                max="21:00"
                value={sendWindowEnd}
                onChange={(e) => setSendWindowEnd(e.target.value)}
                aria-invalid={!!sendWindowError}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm dark:bg-gray-800 ${
                  sendWindowError
                    ? "border-red-400 dark:border-red-500"
                    : "border-gray-300 dark:border-gray-700"
                }`}
              />
            </div>
            {sendWindowError && (
              <p
                role="alert"
                data-testid="campaign-window-error"
                className="text-xs text-red-600 dark:text-red-400 md:col-span-2"
              >
                {sendWindowError}
              </p>
            )}
            <p className="text-[11px] text-gray-500 md:col-span-2">
              Send window must be within 09:00–21:00 IST (quiet hours after 21:00).
            </p>
          </div>
        </section>

        {/* ── A/B variants (optional) ─────────────────────────── */}
        {/* SOW M4 piece 5 — variant body / subject overrides + split
            percentages. Backend (parseAbVariants in
            campaign-dispatcher.ts) does weighted-random per recipient
            and stamps CampaignSend.variantId for attribution. */}
        <section
          className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
          data-testid="campaign-ab-section"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-5 w-5 text-purple-600 dark:text-purple-400" />
              <h2 className="text-lg font-semibold">
                A/B variants{" "}
                <span className="text-xs font-normal text-gray-400">
                  (optional)
                </span>
              </h2>
            </div>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={abEnabled}
                onChange={(e) =>
                  e.target.checked ? enableAb() : disableAb()
                }
                data-testid="campaign-ab-toggle"
                className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-gray-700 dark:text-gray-300">
                Enable A/B testing
              </span>
            </label>
          </div>

          {!abEnabled ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Test variations of the message — different subject lines, body
              copy, or both. The dispatcher will weighted-randomly pick a
              variant per patient and tag it on the delivery row so you can
              measure conversion per variant later.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Splits must add up to 100%. Empty subject / body overrides
                fall back to the campaign&apos;s defaults from the section
                above.
              </p>

              <ul
                className="space-y-2"
                data-testid="campaign-ab-variant-list"
              >
                {variants.map((v, idx) => (
                  <li
                    key={v.rid}
                    data-testid="campaign-ab-variant-row"
                    className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Expand / collapse */}
                      <button
                        type="button"
                        onClick={() => toggleVariantExpanded(v.rid)}
                        aria-label={
                          v.expanded
                            ? "Collapse variant overrides"
                            : "Expand variant overrides"
                        }
                        className="rounded p-1 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
                        data-testid={`campaign-ab-expand-${idx}`}
                      >
                        {v.expanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>

                      {/* Label */}
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-500">Label</span>
                        <input
                          type="text"
                          value={v.id}
                          maxLength={40}
                          onChange={(e) =>
                            updateVariantLabel(v.rid, e.target.value)
                          }
                          aria-label={`Variant ${idx + 1} label`}
                          className="w-16 rounded border border-gray-300 px-2 py-1 text-center text-sm font-semibold uppercase dark:border-gray-600 dark:bg-gray-900"
                          data-testid={`campaign-ab-label-${idx}`}
                        />
                      </div>

                      {/* Split slider + number */}
                      <div className="flex flex-1 items-center gap-2 min-w-[200px]">
                        <span className="text-xs text-gray-500">Split</span>
                        <input
                          type="range"
                          min={1}
                          max={99}
                          value={v.weight}
                          onChange={(e) =>
                            updateVariantWeight(v.rid, Number(e.target.value))
                          }
                          aria-label={`Variant ${idx + 1} split percentage`}
                          className="flex-1 accent-indigo-600"
                          data-testid={`campaign-ab-slider-${idx}`}
                        />
                        <div className="relative">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={v.weight}
                            onChange={(e) =>
                              updateVariantWeight(
                                v.rid,
                                Number(e.target.value),
                              )
                            }
                            aria-label={`Variant ${idx + 1} split percentage`}
                            className="w-16 rounded border border-gray-300 px-2 py-1 pr-5 text-right text-sm dark:border-gray-600 dark:bg-gray-900"
                            data-testid={`campaign-ab-weight-${idx}`}
                          />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                            %
                          </span>
                        </div>
                      </div>

                      {/* Remove */}
                      <button
                        type="button"
                        onClick={() => removeVariant(v.rid)}
                        disabled={variants.length <= 2}
                        aria-label={`Remove variant ${v.id}`}
                        title={
                          variants.length <= 2
                            ? "Need at least 2 variants for A/B"
                            : "Remove this variant"
                        }
                        className="rounded p-1 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-950/30"
                        data-testid={`campaign-ab-remove-${idx}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    {/* Per-variant overrides */}
                    {v.expanded ? (
                      <div className="mt-3 grid gap-3 border-t border-gray-200 pt-3 dark:border-gray-700">
                        <div>
                          <label
                            htmlFor={`ab-subject-${v.rid}`}
                            className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                          >
                            Subject override{" "}
                            <span className="text-gray-400">(Email only)</span>
                          </label>
                          <input
                            id={`ab-subject-${v.rid}`}
                            type="text"
                            value={v.subjectOverride}
                            maxLength={255}
                            onChange={(e) =>
                              updateVariantField(
                                v.rid,
                                "subjectOverride",
                                e.target.value,
                              )
                            }
                            placeholder={
                              subject ||
                              "Leave blank to use the campaign subject above"
                            }
                            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                            data-testid={`campaign-ab-subject-${idx}`}
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`ab-body-${v.rid}`}
                            className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                          >
                            Body override
                          </label>
                          <textarea
                            id={`ab-body-${v.rid}`}
                            value={v.bodyOverride}
                            maxLength={8000}
                            rows={3}
                            onChange={(e) =>
                              updateVariantField(
                                v.rid,
                                "bodyOverride",
                                e.target.value,
                              )
                            }
                            placeholder={
                              body ||
                              "Leave blank to use the campaign body above"
                            }
                            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-900"
                            data-testid={`campaign-ab-body-${idx}`}
                          />
                          <p className="mt-1 text-[11px] text-gray-500">
                            {v.bodyOverride.length} / 8000
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={addVariant}
                  disabled={variants.length >= 10}
                  className="flex h-9 items-center gap-1 rounded-lg border border-gray-300 px-3 text-xs hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                  data-testid="campaign-ab-add"
                >
                  <Plus className="h-3 w-3" /> Add variant
                  {variants.length >= 10 ? " (max 10)" : ""}
                </button>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    variants.reduce((s, v) => s + v.weight, 0) === 100
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                  }`}
                  data-testid="campaign-ab-sum"
                >
                  Total split: {variants.reduce((s, v) => s + v.weight, 0)}%
                </span>
              </div>

              {variantsError ? (
                <p
                  role="alert"
                  data-testid="campaign-ab-error"
                  className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
                >
                  {variantsError}
                </p>
              ) : null}
            </div>
          )}
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
                  <option value="condition">Diagnosis</option>
                  <option value="allergy">Allergy</option>
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

                {f.field === "condition" && (
                  <DiagnosisFilterInput
                    value={f.value}
                    onChange={(v) => updateFilter(idx, { value: v })}
                  />
                )}

                {f.field === "allergy" && (
                  <input
                    type="text"
                    value={f.value}
                    onChange={(e) =>
                      updateFilter(idx, { value: e.target.value })
                    }
                    placeholder="e.g. penicillin"
                    aria-label="Allergen"
                    className="w-56 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900"
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

// Searchable ICD-10 diagnosis input for the audience builder. Type to search
// the icd10 master (GET /icd10?q=); picking a row stores its description as the
// filter term (the server-side `condition` compiler matches name OR ICD code
// across the chronic-condition / prescription / admission surfaces).
function DiagnosisFilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const [options, setOptions] = useState<Array<{ code: string; description: string }>>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ data: Array<{ code: string; description: string }> }>(
          `/icd10?q=${encodeURIComponent(query)}`,
        );
        if (!cancelled) setOptions(r.data ?? []);
      } catch {
        if (!cancelled) setOptions([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search diagnosis (e.g. diabetes / E11)"
        aria-label="Diagnosis"
        className="w-64 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900"
      />
      {open && options.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-48 w-72 overflow-y-auto rounded-lg border border-gray-200 bg-white text-sm shadow-lg dark:border-gray-700 dark:bg-gray-800">
          {options.map((o) => (
            <li key={o.code}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  // Store the description as the match term (human-readable +
                  // the compiler also matches the ICD code text).
                  onChange(o.description);
                  setQuery(o.description);
                  setOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                <span className="font-mono text-xs text-indigo-600 dark:text-indigo-400">{o.code}</span>{" "}
                {o.description}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
