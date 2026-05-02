# MedCore — Developer Onboarding

Welcome. This is the 10-minute "get productive" guide. For depth, follow the
links at the bottom.

---

## 1. Clone, install, run

Prereqs: **Node ≥ 20**, **npm 8+**, **Docker** (for Postgres), **git**.

```bash
git clone <repo-url> medcore
cd medcore
npm install                                    # installs root + all workspaces

# Start Postgres in Docker
docker run -d --name medcore-pg-dev \
  -e POSTGRES_USER=medcore \
  -e POSTGRES_PASSWORD=medcore_dev \
  -e POSTGRES_DB=medcore_dev \
  -p 5432:5432 postgres:15

# Configure env for the API
cp apps/api/.env.example apps/api/.env
# edit apps/api/.env: set DATABASE_URL to
#   postgresql://medcore:medcore_dev@localhost:5432/medcore_dev?schema=public

# Apply migrations + generate client
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
npx prisma generate        --schema packages/db/prisma/schema.prisma

# Seed with realistic test data
npx tsx packages/db/src/seed-realistic.ts

# Web env
cp apps/web/.env.local.example apps/web/.env.local

# Run all dev servers (turborepo)
npm run dev
# - API:    http://localhost:4000
# - Web:    http://localhost:3000
# - Mobile: from apps/mobile, run `npm run dev` (Expo)
```

Log in with a seeded doctor account — the seed script prints credentials on
first run.

---

## 2. Where each area lives

| Area | Path |
|---|---|
| HTTP API (Express) | `apps/api/src/routes/` |
| API middleware (auth, audit, validate, error) | `apps/api/src/middleware/` |
| API domain services | `apps/api/src/services/` |
| AI subsystems (Sarvam, RAG, prompts, ER-triage, scribe, etc.) | `apps/api/src/services/ai/` |
| Notification channels (WhatsApp/SMS/email/push) | `apps/api/src/services/channels/` |
| Background schedulers | `apps/api/src/services/*-scheduler.ts` |
| Web pages (Next.js app router) | `apps/web/src/app/` |
| Web dashboard feature pages | `apps/web/src/app/dashboard/<feature>/` |
| Web shared components | `apps/web/src/app/_components/` |
| Web API client + socket | `apps/web/src/lib/` |
| Mobile app (Expo, React Native) | `apps/mobile/` |
| Prisma schema | `packages/db/prisma/schema.prisma` |
| Prisma migrations | `packages/db/prisma/migrations/` |
| Seed scripts | `packages/db/src/seed-*.ts` |
| Shared validation (Zod) + types | `packages/shared/src/` |
| Deploy / migration / backup scripts | `scripts/` |
| Runbooks & architecture | `docs/` |
| E2E tests (Playwright) | `e2e/` |

---

## 3. Running tests at each layer

```bash
# All vitest suites (unit + integration + web)
npm test

# Single-purpose subsets
npm run test:unit          # packages/shared + apps/api/src/services
npm run test:contract      # Zod validation contracts (shared)
npm run test:api           # apps/api/src/test/integration
npm run test:web           # apps/web tests (jsdom)
npm run test:smoke         # apps/api smoke suite

# Coverage
npm run test:coverage
npm run test:coverage:web
npm run test:coverage:unit

# E2E (Playwright — needs running dev servers)
npm run test:e2e
npm run test:e2e:ui        # UI mode

# E2E (Playwright — local stack via scripts/run-e2e-locally.sh)
scripts/run-e2e-locally.sh                          # full Chromium suite (~5-10 min)
scripts/run-e2e-locally.sh e2e/<spec>.spec.ts       # single spec (<30 s after warm-up)
# See docs/LOCAL_E2E.md for full flag reference + comparison vs release.yml.

# Load tests
npm run test:load          # real
npm run test:load:mock     # against mock-server.ts
```

Before a PR: `npm run test:unit && npm run test:web && npm run test:api`.
Before a deploy: `scripts/pre-deploy-check.sh` — chains all of the above
plus tsc, lockfile, and prisma validate.

---

## 4. Adding a new feature — the checklist

### 4a. Prisma migration policy

If your change touches `schema.prisma`:

1. Create the migration locally **against a throwaway dev DB**:
   ```bash
   npx prisma migrate dev --name add_some_table \
     --schema packages/db/prisma/schema.prisma
   ```
2. Commit the generated `packages/db/prisma/migrations/<ts>_add_some_table/`
   folder **as-is**. Never edit past migrations.
3. Never run `prisma db push` on a shared DB.
4. Full policy: [`MIGRATIONS.md`](MIGRATIONS.md).

### 4b. i18n requirement

Any user-facing string (web or mobile) must go through the translation
layer — do not hard-code English. Add the key to the shared locales bundle,
reference via the hook/helper used by sibling pages.

### 4c. Audit log requirement

Any write endpoint that touches PHI (patient, prescription, admission, lab,
claim, ABDM, FHIR, insurance, scribe output, etc.) **must** emit an audit
record. Use the `audit` middleware pattern already wired in routes like
`apps/api/src/routes/admissions.ts`, `apps/api/src/routes/abdm.ts`, and
`apps/api/src/routes/ai-chart-search.ts`. Do **not** write a bespoke
audit-insert — reuse the middleware so PHI-access rows stay uniform and
queryable from `/dashboard/audit`.

### 4d. PR checklist

Before you mark a PR "ready for review":

- [ ] New/changed code covered by a test at the right layer (unit for pure
      functions, integration for route handlers, web test for pages,
      Playwright for full flows).
- [ ] If schema changed: migration folder committed; `prisma validate`
      passes; `npm run db:generate` ran; any manual data-migration script
      lives in `scripts/` with a dry-run default.
- [ ] If API shape changed: Zod schema in `packages/shared/src/validation/`
      updated; corresponding `contract` test updated.
- [ ] User-facing strings go through i18n.
- [ ] Write-path touching PHI: audit middleware applied.
- [ ] New env var: added to `apps/api/.env.example` with a comment describing
      its fallback behaviour, and to `docs/DEPLOY.md` section 8.
- [ ] No secrets committed (grep the diff for `key`, `secret`, `token`).
- [ ] CHANGELOG updated for anything user-facing or ops-facing.

---

## 5. Links

- [`MIGRATIONS.md`](MIGRATIONS.md) — Prisma migration policy & first-time
  adoption.
- [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) — Sarvam integration, RAG
  pipeline, prompt layering, red-team posture for the AI features.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — System overview, service boundaries,
  scheduled tasks.
- [`DEPLOY.md`](DEPLOY.md) — The single authoritative prod deploy runbook.
- [`OPERATIONS_FAQ.md`](OPERATIONS_FAQ.md) — Recovery, rollback, and ops cheatsheet.
- [`TEST_PLAN.md`](TEST_PLAN.md) — Test coverage matrix and known gaps.
- [`LOCAL_E2E.md`](LOCAL_E2E.md) — Local Playwright runner that mirrors
  release.yml's e2e jobs in 5-10 min instead of 25.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — Long-form contributor rules.

If you get stuck, ping `#medcore-dev` on Slack and include: the command you
ran, the full error, and your `git rev-parse HEAD`.
