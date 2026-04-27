# AI Evaluation Harness

Held-out clinical evaluation corpus + runner used to track AI-feature quality
against the PRD §3.9 / §4.9 / §6 thresholds. The harness MUST run on every
prompt or model change, and BLOCKS the release if the red-flag false-negative
rate regresses.

## What it measures

| Eval                    | What                                                                                                                      | Threshold (PRD)                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `runRedFlagEval`        | TP / FP / TN / FN counts on triage red-flag detection. Reports `falseNegativeRate` and `falsePositiveRate`.               | FN rate < 1% (§3.9) — **release gate** |
| `runSpecialtyRoutingEval` | Top-1 / top-3 specialty-routing accuracy on the routine cases.                                                           | Tracked, not gated yet                |
| `runSoapSimilarityEval` | Per-field Jaccard similarity (chief complaint / key findings / primary Dx / key meds) and a count of cases below threshold. | Default threshold 0.4 per case        |
| `runDrugSafetyEval`     | For each case, hit-rate of expected alert keywords + severity (CONTRAINDICATED/SEVERE) check.                             | Tracked, not gated yet                |

## Fixtures

All fixtures live in `apps/api/src/test/ai-eval/fixtures/` and contain only
synthetic, generic-named patients (no PII).

- `triage-cases.ts` — 30 red-flag positive + 30 routine cases. Mix of English,
  Hindi (Devanagari + Latin transliteration), Hindi-English code-mix, and 2
  each of Tamil, Telugu, Bengali. Every case carries a `clinicalRationale`
  for human review.
- `soap-cases.ts` — 20 doctor-patient transcripts (8–15 turns each) with
  golden expected SOAP fields. The runner does NOT compare strings; it tokenises
  and Jaccard-scores against the model's output. Each case may set its own
  `similarityThreshold` (defaults to `SOAP_SIMILARITY_THRESHOLD = 0.4`).
- `drug-safety-cases.ts` — 15 cases across DDI, ALLERGY, CONDITION, PAEDIATRIC,
  RENAL, HEPATIC. Each defines `expectedAlerts: string[]` keywords and may
  set `expectContraindicated` / `expectSevere`.

### Adding a new fixture

1. Pick the right file. For triage, decide red-flag vs routine and append to
   the matching block.
2. Use generic names (`Patient A`). No PII.
3. Hindi/regional-language cases: include both Devanagari/native script AND a
   Latin transliteration in the `description` or inline so non-language reviewers
   can sanity-check. See `rf-stroke-bengali` for the format.
4. Cite a short `clinicalRationale` justifying the expected label. If you are
   not sure of the medicine, drop the case rather than guess (PRD §3.9 demands
   defensible references — Harrison's, IAP STG, MEPA, BNF, Goodman & Gilman's,
   Stockley's).

## Running

```sh
# CHEAP — pure-function unit tests with mocked Sarvam, runs on every push
npm run test:ai-eval:unit

# LIVE — full release gate, requires SARVAM_API_KEY and RUN_AI_EVAL=1.
# Hard-fails if FN rate exceeds 1%.
npm run test:ai-eval
```

Local development WITHOUT a Sarvam key transparently skips the live suite
(unchanged behaviour from 2026-04-26).

## Regression-block thresholds

`determineReleaseBlock()` in `eval-runner.ts` is the single source of truth.
A release is BLOCKED iff:

- `redFlag.falseNegativeRate > RED_FLAG_FN_THRESHOLD` (default `0.01`)

When new gates are added (e.g. ASR WER from §4.9 once the ASR eval lands),
extend `determineReleaseBlock()` and add the corresponding block-reason string
so CI prints exactly why the build failed.

## Interpreting `last-run.json`

After every live run, the harness writes `apps/api/src/test/ai-eval/last-run.json`:

```jsonc
{
  "generatedAt": "2026-04-26T12:34:56.000Z",
  "redFlag":  { "truePositives": 30, "falseNegatives": 0, "falseNegativeRate": 0, "perCase": [...] },
  "routing":  { "top1Accuracy": 0.73, "top3Accuracy": 0.91, "perCase": [...] },
  "soap":     { "perFieldSimilarity": { "primaryDiagnosis": 0.62, ... }, "belowThreshold": 1 },
  "drugSafety": { "hitRate": 0.84, "severityFailures": 0, "perCase": [...] },
  "releaseBlocked": false,
  "blockReasons": []
}
```

CI posts the diff between previous and current `last-run.json` to the PR.
For each FN/FP case, drill into `perCase[*]` to see the exact case ID and
classification — match to the fixture in `triage-cases.ts` for the rationale.

## What the harness is NOT

- It does not replace clinician sign-off — every failed case must be reviewed
  by a clinician before the prompt is changed to "fix" it.
- It does not measure ASR WER yet — placeholder for the §4.9 metric will be
  added when the diarisation/transcription pipeline is integrated.
- It does not exercise observability/Langfuse traces — that lives in the OTel
  suite.

## File layout

```
apps/api/src/test/ai-eval/
├─ eval-runner.ts              # Public runners + pure helpers
├─ eval-runner.test.ts         # Mocked-LLM unit tests (CI on every push)
├─ eval.test.ts                # Live LLM tests + release gate (RUN_AI_EVAL=1)
├─ last-run.json               # Latest structured report (gitignored if needed)
└─ fixtures/
   ├─ triage-cases.ts
   ├─ soap-cases.ts
   └─ drug-safety-cases.ts
```
