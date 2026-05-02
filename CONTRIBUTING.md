# Contributing to MedCore

Thank you for considering a contribution. This document collects the rules
that keep the codebase shippable in a hospital environment, where downtime
and data loss have real-world consequences.

## Database changes — migration policy (READ THIS FIRST)

MedCore is **migration-driven**. The Prisma schema lives at
`packages/db/prisma/schema.prisma`, and every change to it must be accompanied
by a new migration in `packages/db/prisma/migrations/`.

### The rule

> Schema changes require a new migration created with
> `prisma migrate dev --name <descriptor>`. Never edit `schema.prisma` and
> run `prisma db push` against a database that holds real data (production,
> staging, or a shared dev DB).

`prisma db push` syncs the schema by inferring the diff at runtime — it has
no record of what changed, no rollback, and silently performs destructive
column/table drops. `prisma migrate deploy` only applies committed,
reviewed SQL.

### Workflow for a schema change

1. Spin up (or reset) a throwaway local Postgres:
   ```bash
   docker run -d --name medcore-pg-dev \
     -e POSTGRES_USER=medcore -e POSTGRES_PASSWORD=medcore_dev \
     -e POSTGRES_DB=medcore_dev -p 5433:5432 postgres:16-alpine
   ```
2. Edit `packages/db/prisma/schema.prisma`.
3. Generate the migration:
   ```bash
   DATABASE_URL="postgresql://medcore:medcore_dev@localhost:5433/medcore_dev?schema=public" \
     npx prisma migrate dev --name <short_descriptor> \
     --schema packages/db/prisma/schema.prisma
   ```
4. Inspect the generated SQL under
   `packages/db/prisma/migrations/<timestamp>_<descriptor>/migration.sql`.
   Hand-edit if Prisma chose a destructive default (e.g. dropping a column
   you intended to rename — use `RENAME COLUMN` instead).
5. Commit `schema.prisma` AND the new migration folder in the **same** PR.

### Notes on Postgres enum changes

Postgres requires `ALTER TYPE ... ADD VALUE` to run outside a transaction.
Prisma handles this transparently for `migrate deploy`, but if you need to
hand-write SQL the pattern is:

```sql
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'NEW_ROLE';
```

### Production deploys

`scripts/deploy.sh` runs `prisma migrate deploy`. It will:
- apply any new migrations in order,
- refuse to run if the local migration history is missing or has been edited,
- never drop or reset data.

If a deploy fails because the production DB has drift (likely on the first
`migrate deploy` after switching from `db push`), the ops runbook is to
baseline:

```bash
# On the prod box, with a backup taken first.
DATABASE_URL=$DB_URL npx prisma migrate resolve \
  --schema packages/db/prisma/schema.prisma \
  --applied 20260415000000_initial
```

This marks the initial migration as already-applied without re-running its
SQL, then later migrations apply cleanly on top.

## Code style

- TypeScript everywhere; `tsc --noEmit` must be clean.
- Express routes return the `{ success, data, error }` envelope.
- Authorization: import `authorize` from `middleware/auth` and pass the
  full set of roles permitted to call the endpoint.

## Tests

- Before pushing, run `scripts/run-tests-locally.sh` to mirror every per-push CI gate locally (~5-7 min vs 25 min via Actions). Full guide:
  [`docs/LOCAL_TESTING.md`](docs/LOCAL_TESTING.md).
- Pure unit tests: `npm test` (runs without a DB).
- Integration tests: set `DATABASE_URL_TEST` to a throwaway Postgres and
  run `npm test`. The suite resets the DB in `beforeAll`. Integration is
  **opt-in** in the local runner via `--with-integration`; CI runs them
  on every push.

### E2E policy (read this before adding any Playwright spec)

Playwright e2e is **explicit-invocation only**. It never runs on push,
deploy, or post-deploy. It runs only when:

- a developer invokes `scripts/run-e2e-locally.sh` (or
  `npx playwright test ...`) locally, OR
- release validation is triggered via `release.yml` `workflow_dispatch`
  in CI.

Auto-deploy gates only on the non-e2e tests
`[test, web-tests, typecheck, lint, npm-audit, migration-safety,
web-bundle]`. **Do NOT add e2e steps to `test.yml`'s per-push gate or
to any post-deploy chain.** The full rationale (speed + failure
isolation) is documented at
[`docs/TEST_PLAN.md` §3 Layer 5](docs/TEST_PLAN.md#layer-5--e2e-playwright--added-2026-04-30)
and in [`docs/CI_HARDENING_PLAN.md`](docs/CI_HARDENING_PLAN.md).
