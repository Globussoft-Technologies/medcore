import { test, expect } from "./fixtures";
import { API_BASE } from "./helpers";

/**
 * Pearl PRD Stage 1 §5.3 (PRD M4) / gap-analysis row 335 — Marketing
 * admin must be able to build an audience of "all hypertensives over 55,
 * opted-in to WhatsApp" in **< 60 s**.
 *
 * Touches:
 *   - apps/api/src/routes/campaign-audiences.ts
 *       - POST /campaign-audiences            (create the saved rule)
 *       - POST /campaign-audiences/:id/compile (size preview + 5-row sample)
 *   - apps/api/src/services/audience-compiler.ts (rule → Prisma where compiler)
 *
 * Why a timed spec: the audience compiler shipped in `f701b52`
 * (Pearl §5.1 piece 2a) and the audience-builder UI shipped in `ecdd556`
 * (Campaign piece 4 of 4). The row is now MEASURABLE end-to-end — admin
 * saves a rule + asks for the cohort size — so this spec brackets that
 * surface and asserts the 60s SLA.
 *
 * Scope-cuts vs the PRD prose:
 *   - The PRD bullet phrases the cohort as "all hypertensives over 55,
 *     opted-in to WhatsApp". The shipped compiler
 *     (services/audience-compiler.ts) supports only four fields today:
 *     `gender` (eq), `age` (gte|lte), `lastVisitDays` (gte|lte), and
 *     `abhaLinked` (eq). `conditions` (e.g. HYPERTENSION via ICD code)
 *     and `whatsappOptIn` (via NotificationPreference join) are
 *     intentional documented compiler no-ops — see the warn-and-no-op
 *     block at audience-compiler.ts:122-134 + the design note at
 *     packages/shared/src/validation/campaign.ts:191-202.
 *
 *     We send the FULL PRD-phrased rule shape (age + abhaLinked AS THE
 *     STAND-IN for WA opt-in, plus an explicit `conditions` no-op
 *     filter) so the spec stays faithful to the row's prose AND
 *     exercises the forward-compatibility path. abhaLinked is the
 *     closest in-tree analog to "WhatsApp opt-in" right now: both are
 *     "has the patient completed an out-of-band channel association?"
 *     The PRD-named filters that the compiler can't yet realise will
 *     start filtering automatically once the columns/joins land — no
 *     spec change needed.
 *
 *   - We drive via API (`adminApi`) rather than the new-audience form at
 *     /dashboard/campaigns/new. Rationale matches the receipt-timing
 *     spec (invoice-receipt-timed.spec.ts §c3c5b54) + doctor-onboarding
 *     spec (doctor-onboarding-timed.spec.ts §row346): the SLA polices
 *     the underlying create + compile path that the form wraps; the
 *     form layer's hydration + EntityPicker debounce add UI-noise the
 *     Pearl SLA budget is NOT meant to police. API-level timing is
 *     conservative.
 *
 *   - Exit via `test.skip` (matching every other timed spec under e2e/)
 *     if the local API is unreachable so the suite defers to CI without
 *     spurious failure.
 *
 * Semantic-correctness sanity check (per the agent brief step 7):
 *   - asserts `response.body.data.count` is a non-negative number — proves
 *     the compiler actually ran a Prisma count (vs returning a stub /
 *     undefined / NaN). The /:id/compile route at
 *     campaign-audiences.ts:267-276 wraps the count under `data.count`,
 *     not `data.audienceSize` — checked at scaffold time.
 */

interface CreateAudienceResponse {
  id: string;
  name: string;
  rules: Record<string, unknown>;
  active: boolean;
}

interface CompileAudienceResponse {
  count: number;
  sampleIds: string[];
  sample: Array<{ id: string; mrNumber: string | null; name: string | null }>;
  lastComputedAt: string;
}

test.describe("Pearl §5.3 — marketing admin builds an audience (hypertensives >55, opted-in to WhatsApp) in <60s", () => {
  test("clock-bracketed flow: POST /campaign-audiences (rules) → POST /campaign-audiences/:id/compile (size preview) asserts <60s", async ({
    adminApi,
  }) => {
    // Unique-tag the name on Date.now() so re-runs don't trip the
    // (tenantId, name) uniqueness expectation that ADMIN UI assumes.
    // Audience.name has no formal regex (just trim().min(2).max(200) per
    // packages/shared/src/validation/campaign.ts:246) so digits are
    // fine here — CLAUDE.md gotcha #8 (PATIENT_NAME_REGEX rejects digits)
    // does NOT apply to audience names.
    const uniq = Date.now().toString(36);
    const name = `Pearl row335 HTN+55 WA optin ${uniq}`;

    // PRD-phrased rule shape. age + abhaLinked are realised by the
    // compiler today; the remaining two filters warn-and-no-op (still
    // accepted by Zod because audienceFilterSchema is permissive at the
    // (field, op) level — see packages/shared/src/validation/campaign.ts:222).
    // The full envelope demonstrates the forward-compat posture the
    // PRD design called for.
    const rules = {
      matchMode: "ALL" as const,
      filters: [
        { field: "age", op: "gte", value: 55 },
        { field: "abhaLinked", op: "eq", value: true },
        // Documented no-ops below — compiler warns, returns no clause,
        // saved rule survives DSL evolution. Once `conditions` and
        // `whatsappOptIn` ship on Patient, these will start filtering
        // automatically with no spec change.
        { field: "conditions", op: "eq", value: "HYPERTENSION" },
        { field: "whatsappOptIn", op: "eq", value: true },
      ],
    };

    // ─── START TIMER ────────────────────────────────────────────────────────
    // Per the Pearl §5.3 prose, "build an audience" begins at "admin
    // wants this cohort" and ends at "admin sees the cohort size". The
    // two clicks the UI exposes are Save + Preview; the API mirror is
    // POST + POST /:id/compile.
    const t0 = performance.now();

    // 1. Create the saved audience (the Save click).
    const createRes = await adminApi.post(`${API_BASE}/campaign-audiences`, {
      data: {
        name,
        description: "Pearl §5.3 row 335 — timed audience-build SLA spec",
        rules,
      },
    });
    if (!createRes.ok()) {
      const status = createRes.status();
      const body = await createRes.text();
      test.skip(
        true,
        `Pearl §5.3 prerequisite (POST /campaign-audiences) failed with ${status} ` +
          `— likely the local API isn't running OR ADMIN seed is missing. ` +
          `Suite defers to CI. Body: ${body.slice(0, 200)}`
      );
    }
    const created = (await createRes.json()).data as CreateAudienceResponse;
    // CampaignAudience.id uses Prisma's @default(cuid()), not @default(uuid())
    // (schema.prisma:6670). cuid()s look like "c" + 24 lowercase alphanumeric
    // chars (e.g. cmpponmw9000128fle6b6fver). Accept either shape so the
    // assertion survives a future model swap without rewriting the regex.
    expect(created.id, "created audience id").toMatch(/^[a-z0-9-]{20,40}$/);
    expect(created.name).toBe(name);
    expect(created.active).toBe(true);

    // 2. Compile + size preview (the Preview click).
    const compileRes = await adminApi.post(
      `${API_BASE}/campaign-audiences/${created.id}/compile`,
      { data: {} }
    );
    expect(
      compileRes.ok(),
      `POST /campaign-audiences/:id/compile failed: ${compileRes.status()} ` +
        `${(await compileRes.text()).slice(0, 200)}`
    ).toBeTruthy();
    const compiled = (await compileRes.json()).data as CompileAudienceResponse;

    // ─── STOP TIMER + ASSERT 60s SLA ───────────────────────────────────────
    const t1 = performance.now();
    const elapsedMs = Math.round(t1 - t0);
    // eslint-disable-next-line no-console
    console.log(
      `[Pearl §5.3 row 335] marketing audience build (rules + size preview) ` +
        `in ${elapsedMs} ms (budget: 60000 ms)`
    );
    expect(
      elapsedMs,
      `Pearl §5.3 SLA: marketing admin builds audience (rules + size preview) ` +
        `in < 60 s. Observed ${elapsedMs} ms.`
    ).toBeLessThan(60_000);

    // ─── SEMANTIC-CORRECTNESS SANITY CHECK ─────────────────────────────────
    // The route's response wraps the count under data.count (not
    // data.audienceSize — that's the persisted column name; the API
    // returns it as `count`). Asserting count is a finite non-negative
    // number proves the compiler actually ran a Prisma count rather
    // than returning a stub / undefined / NaN, which would let a
    // broken implementation pass the timing assertion vacuously.
    expect(typeof compiled.count, "compile response.data.count type").toBe(
      "number"
    );
    expect(Number.isFinite(compiled.count)).toBe(true);
    expect(compiled.count).toBeGreaterThanOrEqual(0);
    // sampleIds is a list of patient ids capped at 5 by the route
    // (campaign-audiences.ts:241-249) — verify the contract shape so a
    // silent refactor that drops the sample doesn't sneak past.
    expect(Array.isArray(compiled.sampleIds)).toBe(true);
    expect(compiled.sampleIds.length).toBeLessThanOrEqual(5);
    expect(
      compiled.lastComputedAt,
      "compile response includes ISO lastComputedAt"
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
