# MedCore — Session snapshot, 2026-04-24

A traveling summary so a fresh Claude Code / Claude agent session on any
machine can pick up where this one left off. Mirrors the local auto-memory
at `~/.claude/projects/d--gbs-projects-medcore/memory/` (which does not
sync across machines). Refresh this file at the end of significant sessions.

---

## TL;DR

- HEAD: `ff24f22` — PRD AI-features gap closure (§3 / §4 / §7)
- Prod: `163.227.174.141`, `/api/health` returning 200 with
  `rateLimitsEnabled: true`; 18 migrations applied (including
  `20260424000004_prd_closure_models`)
- Tests: `apps/api` 1048 / 0 / 1803 skipped; `apps/web` 560 / 0; typecheck
  clean on `apps/api`, `apps/web`, `packages/shared`

---

## User + collaboration context

- Sumit at Globussoft Technologies, full-stack / tech lead on MedCore
  (Turborepo: Next.js web + Express API + Prisma + React Native Expo).
- Email: `sumit@globussoft.com`
- Prefers terse, direct responses — no lengthy summaries / commentary.
- Windows 11 + Git Bash + Node.js at `C:\Program Files\nodejs\`.
- Auto-approve all tool calls (no permission prompts).
- **No native browser dialogs** — never `window.prompt` / `alert` /
  `confirm`. Always in-DOM modals / toasts with `data-testid` hooks so
  Playwright and the Claude cloud browser can interact. Canonical
  pattern: `apps/web/src/app/dashboard/appointments/page.tsx`
  `patientIdPrompt`. Toasts: `@/lib/toast`.

---

## Production server

- IP: `163.227.174.141`, user `empcloud-development`, app dir
  `/home/empcloud-development/medcore`.
- Password in `.env` at repo root (key `SERVER_PASSWORD`). Not in git.
- Services on PM2: `medcore-api` (:4100) + `medcore-web` (:3200).
- DB: PostgreSQL on `:5433`, db name `medcore`.
- **Deploy**: SSH in, run `bash scripts/deploy.sh --yes`. Script does
  git pull, npm install, `prisma migrate deploy`, `next build`, PM2
  restart, and a post-deploy health probe. Refuses to run with
  uncommitted changes.
- From Windows without sshpass: use `plink.exe` with the hostkey flag
  (fingerprint in the script you wrote), see the prior session log.

---

## What shipped 2026-04-24 (commit `ff24f22`)

Migration `20260424000004_prd_closure_models` — additive only; 4 new
tables + 2 enums + nullable columns on existing tables.

| PRD § | Feature | Where |
|---|---|---|
| 3.5.1 | Phase-2 regional languages (8 langs: en/hi/ta/te/bn/mr/kn/ml) | `packages/shared/src/i18n/triage-symptom-chips.ts`; zod `TRIAGE_LANGUAGE_CODES` |
| 3.5.4 | SNOMED-CT curated subset (119 concepts, Hindi synonyms) | `SnomedConcept` DB model + `apps/api/src/services/ai/snomed-mapping.ts`; DB/JSON dual path |
| 3.5.6 | Agent console for call-center handoff | `/api/v1/agent-console/*`; `apps/web/src/app/dashboard/agent-console/` |
| 3.9 + 4.9 | AI-KPI dashboards + CSV export | `/api/v1/ai/kpis/*`; `apps/web/src/app/dashboard/ai-kpis/`; new `FrontDeskCall` + `MedicationIncident` models + `PatientFeedback.appointmentId` + `AIScribeSession.doctorNps/...` columns |
| 4.5.2 | Medical-vocabulary ASR tuning | Originally shipped as a 317-word `word_boost` list piped to AssemblyAI. Removed on 2026-04-25 along with AssemblyAI itself (US-region, fails PRD §3.8 / §4.8). Re-introduce when Sarvam exposes a vocabulary hook or when an India-region diarizing provider appears. |
| 7.2 | Radiology region-overlay UI (DICOM + click-to-highlight) | `apps/web/src/app/dashboard/ai-radiology/page.tsx` with `data-testid` hooks |
| 7 / DPDP | Patient data export (right-to-portability) | `PatientDataExport` model; `/api/v1/patient-data-export/*`; signed URLs |

### Infra fixes shipped alongside

- `audit_log_archival` + `rate_limit_bypass_check` scheduled tasks
- `getSchedulerStatus` + `getOldestPromptCacheAgeSeconds` gauges
- Full `healthRouter` mounted (replaces inline `/api/health`)
- Tenant subdomain validator now rejects uppercase literally
- Rate-limit test unsets `NODE_ENV=test` to exercise real limiter
- AI eval harness auto-skips without live LLM keys
- KPI date range uses `setUTCHours` so filename slice matches input YYYY-MM-DD
- Multi-tenant onboarding UX — `/api/v1/tenants/*` + web console
  (platform plumbing, not strict PRD)

---

## PRD items NOT closed (intentional)

- ABDM DPA vendor API integration — needs real vendor contract.
- MEPA enrollment — needs external partnership.
- Sarvam ASR medical-vocabulary tuning — no API hook exposed by Sarvam
  as of Apr 2026; re-evaluate when Sarvam ships one.
- Acoustic diarization — was previously available via AssemblyAI; removed
  on 2026-04-25 because both AssemblyAI and Deepgram process audio
  outside India, violating PRD §3.8 / §4.8 ("India-region deployment for
  all PII and PHI"). Scribe falls back to manual speaker tagging. Re-add
  any candidate provider only after confirming India-region processing
  AND under a `DEPLOYMENT_REGION` runtime gate.
- `TenantConfig` first-class table — `SystemConfig` key-prefix scheme
  works; deferred to next schema-churn window.

Schema proposal docs for future work:
`apps/api/src/services/.prisma-models-*.md`.

---

## Prior shipped features (for orientation)

- **AI Triage** (`/api/v1/ai/triage/*`) — conversational symptom intake,
  red-flag detection, doctor ranking. Red-flag rules at
  `apps/api/src/services/ai/red-flag.ts` (deterministic, no LLM).
- **AI Scribe** (`/api/v1/ai/scribe/*`) — ambient transcription, SOAP
  auto-draft, ICD-10 codes, EHR write-back on sign-off.
- **Drug Safety** — two-layer inside scribe transcript endpoint:
  deterministic curated pairs → LLM fallback. `CONTRAINDICATED` alerts
  block sign-off until ack.

All three shipped 2026-04-22 (commit `9740f3a`). Primary LLM is Sarvam
(sarvam-105b); OpenAI + Anthropic as failover.

---

## Codebase shape

- Turborepo. `apps/api` (Express 4, port 4100), `apps/web` (Next.js 15,
  port 3200), `apps/mobile` (React Native / Expo).
- `packages/shared` (types + zod + i18n bundles), `packages/db` (Prisma
  6 with 18 hand-crafted + generated migrations, 151+ models).
- Multi-tenant via `TENANT_SCOPED_MODELS` set in
  `apps/api/src/services/tenant-prisma.ts` (129+ models) + Prisma
  `$extends` middleware.
- Prompt registry with versioning/rollback (DB-backed, 60s cache).
- Prometheus metrics via prom-client, scrapable at `/api/metrics`
  (localhost-bound).
- FHIR R4 export + HL7 v2 (ADT^A04, ORM^O01, ORU^R01, MDM^T02, VXU^V04)
  + ABDM/ABHA.
- Playwright E2E + Maestro mobile E2E.

---

## Known not-this-session issues

- `packages/db/src/seed-lab-data.ts` + `seed-realistic.ts` have
  pre-existing TS errors (`AppointmentStatus` enum narrowing). Not from
  2026-04-24 work.
- AI eval harness tests at `apps/api/src/test/ai-eval/eval.test.ts`
  require `SARVAM_API_KEY` or `OPENAI_API_KEY`; they now auto-skip when
  absent.

---

## Resume checklist for a fresh machine

1. `git clone git@github.com:Globussoft-Technologies/medcore.git`
2. Populate `.env` at repo root (ask Sumit for creds; `SERVER_PASSWORD`,
   `DATABASE_URL`, `SARVAM_API_KEY`, etc.).
3. `npm install` at the root. `npx prisma generate --schema
   packages/db/prisma/schema.prisma`.
4. Read this file + the PRD at `MedCore_AI_Features_PRD.md` (gitignored
   — ask Sumit).
5. Run `npx vitest run --reporter=dot` — expect 1048 pass + 560 pass.
6. If working on UI, `npm run dev` in `apps/web` and visit `:3200`.
