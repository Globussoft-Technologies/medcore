# MedCore AI Architecture

One-page reference for the AI substrate that backs every AI feature listed
in the [README Feature Catalog](../README.md#ai-features). Feature-specific
behaviour (triage red-flags, SOAP generation, drug alerts, etc.) is
documented in the README and the individual route files — this doc is
about the **shared plumbing** underneath.

---

## Layers at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  Route handlers   (ai-triage, ai-scribe, ai-chart-search, …)        │
│       │                                                             │
│       ▼                                                             │
│  Feature services (services/ai/sarvam.ts, rag.ts, red-flag.ts, …)   │
│       │                                                             │
│       ├─► withRetry  ──► Sarvam AI   (sarvam-105b, api.sarvam.ai)   │
│       │                  ASR: saaras:v3                             │
│       │                                                             │
│       ├─► retrieveContext ──► rag.ts ──► Postgres FTS (KnowledgeChunk) │
│       │                                                             │
│       ├─► logAICall ──► stdout JSON ──► log shipper / Sentry        │
│       │                                                             │
│       └─► HITL queue ──► doctor approval ──► patient-facing output  │
│                                                                     │
│  Ingest (fire-and-forget) hooks in: prescriptions, ai-scribe, lab   │
│       │                                                             │
│       ▼                                                             │
│  rag-ingest.ts ──► splitIntoChunks ──► indexChunk (upsert by sourceId)│
│                                                                     │
│  Eval harness  (test/ai-eval/eval.test.ts + fixtures/)              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Sarvam AI — the only LLM vendor

All LLM calls route to **Sarvam AI**, an India-region provider. This is a
DPDP Act choice, not a cost one: no patient data, transcript, or SOAP
draft ever leaves Indian infrastructure.

- **Chat model.** `sarvam-105b`, OpenAI-compatible (function calling,
  tool choice forced, multi-turn messages). Accessed via the `openai`
  SDK with `baseURL: "https://api.sarvam.ai/v1"`.
- **ASR.** `saaras:v3` for ambient speech-to-text in the Scribe and
  Triage workflows.
- **Single entry point.** `apps/api/src/services/ai/sarvam.ts` wraps
  every call. Feature code calls `runTriageTurn`, `extractSymptomSummary`,
  `generateSOAPNote`, or `generateText` — nothing calls the raw SDK.
- **API key.** `SARVAM_API_KEY` env var. A missing key is a startup
  hard-fail in production; in test environments the test harness stubs
  the module.

---

## Observability: `logAICall`

Every LLM call emits a single structured JSON line to stdout:

```json
{
  "level": "info",
  "event": "ai_call",
  "feature": "scribe",
  "model": "sarvam-105b",
  "promptTokens": 1834,
  "completionTokens": 412,
  "latencyMs": 2417,
  "toolUsed": "generate_soap_note",
  "ts": "2026-04-23T07:12:44.021Z"
}
```

Failures emit the same shape with `error` populated and zero tokens.
Log-shipping infrastructure (PM2 log rotation + tail-based forwarder)
picks these up; Sentry captures the ones that throw.

Five `feature` values are in use today: `triage`, `scribe`,
`drug-safety`, `hallucination-check`, and the generic `scribe` bucket
used by chart-search synthesis via `generateText`.

---

## Retry: `withRetry` and `AIServiceUnavailableError`

LLM calls are wrapped in `withRetry(fn)`:

- **3 attempts** (1 initial + 2 retries) with a 1-second pause between.
- **Retries only on genuinely transient errors.** `ECONNRESET`,
  `ENOTFOUND`, `ETIMEDOUT`, `"socket hang up"`, `"fetch failed"`, and
  any HTTP status `>= 500` are retryable. A 400, 401, 422, or any other
  4xx is **non-retryable** and the original error is re-thrown with
  its status intact so the Express error handler can map it.
- **Exhaustion degrades to 503.** When the retry budget is exhausted
  on a retryable error, `withRetry` throws
  `AIServiceUnavailableError` (HTTP 503, `"AI service temporarily
  unavailable"`). Route handlers either surface this directly or
  downgrade to a graceful fallback — e.g. the triage turn returns a
  plain-text "the AI assistant is temporarily unavailable, please call
  our helpline" reply instead of a 503.

Non-LLM call sites (`generateText` used by chart-search synthesis) swallow
the 503 and return an empty string so the caller can still surface raw FTS
chunks to the user.

---

## RAG: Postgres FTS, no pgvector

MedCore's retrieval layer is `apps/api/src/services/ai/rag.ts`. The goals
were:

1. No new Postgres extensions (pgvector is not installed in prod).
2. Grounding for every LLM prompt, so model answers cite hospital data.
3. Per-patient scoping for chart search.

### `KnowledgeChunk` table

Defined in `schema.prisma`:

- `id`, `sourceType` (`ICD10` / `MEDICINE` / `PROTOCOL` / `SOAP` / `LAB` /
  `PRESCRIPTION` / `DOCUMENT`), `sourceId` (unique with sourceType for
  idempotent upsert), `text`, `tags String[]` (e.g. `patient:<uuid>`,
  `doctor:<uuid>`, `date:2026-04-23`), and a generated
  `to_tsvector('english', text)` column with a GIN index.

### Query shape

```sql
SELECT id, text, ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
FROM "KnowledgeChunk"
WHERE search_vector @@ plainto_tsquery('english', $1)
  AND sourceType = ANY($2)
  AND tags && $3         -- optional per-patient / per-date filter
ORDER BY rank DESC
LIMIT $4;
```

`retrieveContext(query, k, sourceTypes?)` returns the top-k chunks as a
prompt-ready string. Every LLM call that benefits from grounding
(`runTriageTurn`, `generateSOAPNote`, chart search) invokes it before
building the system prompt.

---

## Ingest pipeline: fire-and-forget

New clinical data lands in `KnowledgeChunk` automatically. The pipeline
lives in `apps/api/src/services/ai/rag-ingest.ts`; it is called from:

- `routes/ai-scribe.ts` — on SOAP sign-off.
- `routes/prescriptions.ts` — on prescription create.
- `routes/lab.ts` — on lab result entry.
- `routes/uploads.ts` — on patient document upload (OCR via
  `tesseract.js`, PDF text via `pdf-parse`).

### Rules

- **Fire-and-forget.** Ingest runs on the request's event loop with
  `void ingest(...)` — errors are caught and logged, never thrown into
  the HTTP response. A slow or failed ingest never affects the clinical
  write path.
- **Idempotent.** Every chunk carries a deterministic `sourceId`
  (`soap:<consultationId>:<section>`, `rx:<prescriptionId>:<line>`,
  `doc:<documentId>:<chunkIndex>`, etc.). `indexChunk` upserts by
  `(sourceType, sourceId)` so re-ingest is safe.
- **Chunked.** `splitIntoChunks(text, targetLen = 800)` splits on
  paragraph, then sentence boundaries to keep FTS ranking well-behaved.
- **Tagged.** Patient, doctor, and date tags live in the `tags` array
  column so the chart-search query can filter to a single patient
  cheaply.

A proposed `IngestLog` table to add per-ingest observability is already
in `schema.prisma` (`model IngestLog`) but observability wiring is not
yet complete.

---

## Eval harness

`apps/api/src/test/ai-eval/` is a Vitest-based regression harness:

- `fixtures/` — gold-standard inputs and expected outputs for triage
  red-flags, SOAP sections, and drug-safety alerts.
- `eval-runner.ts` — iterates fixtures, calls the feature service, and
  compares against expected outputs using feature-specific metrics
  (red-flag recall, section-level ROUGE-L, alert severity match).
- `eval.test.ts` — the Vitest entry point. Runs locally against live
  Sarvam (or a recorded-response mock) and is skipped in CI unless
  `AI_EVAL=1` is set, so the main test suite stays hermetic.

The harness is the tripwire for silent model regressions — when Sarvam
ships a new `sarvam-105b` snapshot, the eval run flags any drop in
red-flag recall below its floor.

---

## HITL (human-in-the-loop) approval

Every AI output that reaches a **patient** (not a clinician) flows through
a doctor-approval queue first. Today this covers:

- **Lab report explanations** (`ai-report-explainer`) — the LLM draft is
  saved to `LabReportExplanation` with `status = PENDING`. A doctor sees
  it in `/dashboard/lab-explainer`, edits if needed, and approves. Only
  then does the patient see it in their portal / mobile app.
- **Adherence reminder personalisation** — the reminder text is drafted
  by the LLM for each send, but the adherence *schedule* and the
  medication list require clinician enrolment before any reminder fires.
- **Drug CONTRAINDICATED alerts** — blocking the Scribe sign-off until
  the clinician explicitly acknowledges is a HITL variant: the patient
  never sees the alert, but the system refuses to commit the note
  without a human decision.

Clinician-facing output (SOAP drafts, triage specialty suggestions, ER
triage rationale, no-show risk scores, pharmacy forecast insights) does
**not** go through the approval queue — the clinician is already the
human-in-the-loop, and blocking them on a second clinician's approval
would defeat the purpose of the tool.

---

## Further reading

- [`README.md#ai-features`](../README.md#ai-features) — user-facing
  catalogue of every AI feature and where it appears in the UI.
- [`README.md#intelligence-layer`](../README.md#intelligence-layer) —
  short list of the plumbing described above.
- [`docs/MIGRATIONS.md`](MIGRATIONS.md) — rules for adding AI-related
  tables (`KnowledgeChunk`, `IngestLog`, `AdherenceDoseLog`, etc.).
- `apps/api/src/services/ai/` — the code.
