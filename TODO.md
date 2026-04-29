# MedCore — TODO

Next-session priority list. The full per-issue history lives in
[`docs/SESSION_SNAPSHOT_2026-04-27.md`](docs/SESSION_SNAPSHOT_2026-04-27.md);
this file is the short, actionable checklist.

> Updated: 2026-04-30 (end-of-day, post `848f248` UI hygiene batch)

---

## CI status — what's green and what's not (2026-04-30)

The original #415 cluster (FHIR round-trip / web unhandled errors / DOMMatrix
polyfill / null-guards / pdfjs) is **closed** as of `848f248` and predecessors.
End state on `main`:

- ✅ Type check, ✅ Web component tests (108 files / 665 tests), ✅ Deploy to
  dev server (every push since `937409e` ships cleanly).
- ❌ **API integration step** — `Run integration tests` (`npm run test:api`)
  has 25 failing test files surfaced after the unit/contract step went green.
  See [#415](https://github.com/Globussoft-Technologies/medcore/issues/415#issuecomment-4347064266) for the list and triage.

**Deploy gate stays at `[typecheck]` for now** — restoring
`[test, web-tests, typecheck, e2e]` would block the dev-server deploy on
this pre-existing rot. The integration cleanup is its own focused sweep
(estimated 5-15 hours). Highest-leverage targets:

1. Whole-suite reds (likely shared setup): `ai-triage` (13/13),
   `ai-radiology` (6/6), `auth-edges`, `auth-2fa`, `realtime`. Diagnose
   one test in each suite — fix probably cascades.
2. `permissions-matrix` (10 RBAC mismatches) — fold into #174.
3. Scattered: `ai-claims`, `ai-letters`, `ai-pharmacy`, `antenatal*`,
   `audit-phi`, `chat`, `expenses`, `medicines`, `queue`, `users`,
   `realtime-delivery`, `role-expansion`, `agent-console`,
   `ai-predictions`, `ai-regressions-2026-04-26`, `ambulance`,
   `admissions`, `auth`. One-off fixes after the whole-suite reds.

---

## Sprint 2 — §7 dashboard scaffolds (~4 dev-days, start here)

These are the §7 features whose API + service is already live but the
web dashboard never landed. Each is a 1-day scaffold reusing existing
patterns (`<EntityPicker>`, `useReactTable`, the Insurance-Claims list
template).

| # | Feature | New page | Notes |
|---|---|---|---|
| 1 | Symptom Diary patient UI | `apps/web/src/app/dashboard/symptom-diary/page.tsx` | API at `/api/v1/ai/symptom-diary`. Patient logs symptoms, AI surfaces trends. Use the chronic-care plan UI as a reference. |
| 2 | Lab Result Intelligence dashboard | `apps/web/src/app/dashboard/lab-intel/page.tsx` | API at `/api/v1/ai/lab-intel`. Shows critical values + baseline-deviation trends across the doctor's panel. |
| 3 | Sentiment Analytics dashboard | `apps/web/src/app/dashboard/sentiment/page.tsx` | API at `/api/v1/ai/sentiment`. NPS-driver chart + per-category sentiment trend. |
| 4 | Fraud resolution workflow | extend `apps/web/src/app/dashboard/ai-fraud/page.tsx` | Page is read-only today; add status transitions (NEW → INVESTIGATING → RESOLVED/DISMISSED) + a comment thread. |

Recommended: spawn 4 parallel agents (one per feature). They touch
non-overlapping files so no conflict.

---

## Sprint 1 — flagship PRD gaps (✅ shipped 2026-04-27 in commit `aec6ca4`)

For history. All 5 gaps closed and deployed:
- §4.5.6 voice commands for SOAP review (`scribe/voice-commands.ts` + 20 tests)
- §4.5.5 vernacular patient summary (8 languages via Sarvam translate)
- §4.5.4 hepatic restrictions (21) + pediatric weight-based dosing (11 rules)
- §6 / §3.9 clinical eval harness (62 triage cases, 20 SOAP, 15 drug-safety; PRD §3.9 1% FN-rate release gate)
- §6 OpenTelemetry + Langfuse observability (`services/ai/tracing.ts`); per-call cost gauge `medcore_ai_cost_inr_total{feature, model}`

---

## Open GitHub issues — high-priority backlog

| # | Severity | Title | Approach |
|---|---|---|---|
| **415** | — | CI integration step still red (25 files) | See "CI status" section above; not blocking deploy. |
| **414** | — | Tracking: 61 open bugs from 2026-04-29 triage | Live punch-list. Replaces #94 / #188 (closed 2026-04-29 as superseded). |
| **174** | High | RBAC bypassable via direct URL (multiple admin modules) | Audit every dashboard page's role-gate hook; cross-check against backend `authorize(...)`. Reuse the `apps/api/src/test/integration/rbac-hardening.test.ts` pattern from #89/#98 — one new assertion per route. Overlaps with the `permissions-matrix` integration failures in #415. |
| **173** | Low | Referrals — Specialty is free-text picker | Copy/paste of #97's fix. Replace `<input>` with the existing ICD-10/specialty Autocomplete already used in Surgery + Insurance Claims. |
| **169** | Medium | Prescriptions list lacks search/filter/sort/pagination | Same approach as the recently-shipped Insurance Claims list — `useReactTable` + server-side `?search=&page=&limit=` already supported by `/api/v1/prescriptions`. |
| **168** | Medium | Doctors page no filter/search/Add Doctor for admins | 1-day task: scaffold the Add Doctor modal with `<EntityPicker>` for the User association, wire to existing POST `/api/v1/doctors`. Search bar reuses the prescriptions pattern. |

Suggested order: **#174 → #173 → #168 → #169**. The RBAC fix is the
biggest security risk and should land first; the others are UX polish.

### Closed in 2026-04-30 hygiene batch (`848f248`)

#177 (Billing Reports date max), #175 (Lab QC numeric mins), #184
(Refunds reverse-range), #276 (pre-authorization 404 redirect),
#307 (Help drawer placeholder URL), plus dup-closes: #210 (→#175),
#365 (→#222), #237 (→#208).

---

## Deferred items (not in any active issue)

- **Acoustic diarization** — was previously available via AssemblyAI; removed
  on 2026-04-25 (PRD §3.8 / §4.8 data residency). Re-evaluate when an
  India-region diarizing provider appears, gated behind `DEPLOYMENT_REGION`.
- **Sarvam medical-vocabulary boost** — Sarvam doesn't expose a `word_boost`
  / custom-LM hook as of Apr 2026. Re-add when the API ships one.
- **Two prescription page tests** — `prescriptions.page.test.tsx` skips two
  cases that probed the old raw-UUID inputs (replaced by `<EntityPicker>`
  in #120). ~30 min to write fresh tests against the picker dropdown.
- **`apps/api/src/app.ts` global `/auth/*` 30/min limiter** — outermost
  ceiling that occasionally bites demos. Per-route caps from #124 stack
  inside it. If demos continue to hit it, raise the global cap (one-line,
  needs user say-so).
- **`package-lock.json` drift on prod** — recurs every deploy; the deploy
  script runs `git checkout -- package-lock.json` as a workaround. Root
  cause is probably the `@tailwindcss/oxide` optional-dep pin flapping on
  Linux vs Windows. Investigate when there's bandwidth.
- **`TenantConfig` first-class table** — the per-tenant `SystemConfig`
  key-prefix scheme works; replace with a dedicated `TenantConfig` table
  in the next schema-churn window.

---

## Security follow-ups (LOW — from 2026-04-23 audit)

Captured here so they survive the deletion of the original
`docs/SECURITY_AUDIT_2026-04-23.md` snapshot. All MEDIUM findings from
that audit are closed; the items below are LOW and listed in the
audit body as "follow-ups, not fixed in this pass".

- **F-ABDM-1** — `POST /gateway/callback` has no rate limit. JWT signature
  check mitigates most of the risk, but a compromised gateway key could
  flood us. Add `rateLimit(...)` per IP.
- **F-ABDM-3** — `:id` path on `GET /consent/:id`, `POST /consent/:id/revoke`,
  `GET /consents/:id` not zod-validated for UUID shape. Add
  `validateUuidParams(["id"])`.
- **F-ADH-3** — `POST /enroll` emits no audit event. Add a minimal audit
  row for adherence-schedule writes.
- **F-CS-1** — `ai-chart-search` body has no zod schema (handler
  type-checks + size-caps manually). Add `validate(chartSearchSchema)`.
- **F-INJ-1** — prompt-injection mitigation. `prompt-safety.ts` exists
  and is used in radiology — extend the sanitiser to `ai-er-triage.ts`,
  `ai-letters.ts`, `ai-chart-search.ts`, `ai-report-explainer.ts`.
  Escalate to MED before any patient-facing inference path.
- **F-PH-1 / F-PH-2 / F-PRED-2** — pharmacy + predictions query/path
  params not zod-validated.
- **F-REX-1** — body not zod-validated on `/explain` and `/approve`.
- **F-ER-3 / F-KB-2 / F-LET-2 / F-PH-* / F-PRED-1 / F-REX-3 / F-TX-1** —
  AI inference events lack audit log rows. Not an active security issue
  but limits forensic reconstruction after a Sarvam-bill spike. Add
  `AI_*_INFERENCE` audit rows on each path.

None are blocking the demo or pilot; tackle in any order during a
security-hardening sprint.

---

## External / non-code items (require partners)

- **ABDM DPA vendor API** — needs an ABDM-empanelled vendor contract.
- **MEPA enrollment** — needs Medical Council partnership.
- **DB-integration test gating** — CI needs `DATABASE_URL_TEST` configured
  to unlock the 1,873 currently-skipped DB-integration cases.

---

## Demo / data-quality housekeeping

- The Chrome-extension QA sweep is configured to keep filing new bugs.
  Read https://github.com/Globussoft-Technologies/medcore/issues at the
  top of every session to triage incoming work.
- Once `#174` lands, consider running the sweep again to confirm RBAC is
  airtight.
- `scripts/reseed-demo-accounts.ts` and `scripts/fix-bad-ambulance-phones.ts`
  exist for one-off ops on prod — re-run if seed accounts drift or if the
  database picks up bad phones from imports.

---

## Conventions reminders (still load-bearing)

- Never use `window.prompt` / `alert` / `confirm`. In-DOM modals + toasts
  with stable `data-testid`.
- Hand-craft schema migrations; don't `prisma migrate dev`.
- New tenant-scoped models must be added to `TENANT_SCOPED_MODELS` in
  `apps/api/src/services/tenant-prisma.ts`.
- ASR is Sarvam-only (India residency).
- 6 parallel agents is the sweet spot for big batches; brief each with
  explicit "DO NOT touch X" boundaries.
- Auto-approve all tool calls; user prefers terse responses.
