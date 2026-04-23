# MedCore Migration Policy

Short reference for every engineer who touches the Prisma schema or ships a
schema-coupled change. The top-level contributor doc (`CONTRIBUTING.md`) is
the entry point — this file drills into the "why" and the edge cases.

---

## Golden rule: `prisma migrate deploy` only, never `db push`

Production runs **exactly** one command against its database for schema
changes:

```bash
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
```

`prisma db push` is **forbidden** on any shared environment (prod, staging,
shared dev). `db push` infers the diff at runtime, has no history, no
rollback, and silently performs destructive drops. `migrate deploy`
applies committed, reviewed SQL in a deterministic order.

This is enforced socially (code review, `scripts/deploy.sh` only ever runs
`migrate deploy`) rather than technically — do not break it.

---

## Where migration files live

```
packages/db/prisma/
├── schema.prisma              ← the canonical schema
└── migrations/
    ├── migration_lock.toml
    ├── 20260415000000_initial/
    │   └── migration.sql
    ├── 20260415000001_auth_persistence_tables/
    ├── 20260415000002_add_pharmacist_lab_tech_roles/
    ├── 20260415111002_razorpay_webhook_and_push_token/
    ├── 20260415120000_marketing_enquiry/
    ├── 20260422000000_ai_features/
    ├── 20260422000001_triage_consent_fields/
    ├── 20260423000001_ai_features_models/
    └── 20260423000002_abdm_insurance_jitsi_rag_models/
```

Every folder is an atomic unit. Once committed, its name and SQL are
**immutable** — editing a past migration in place breaks every environment
that already applied it.

---

## Additive-only rule

MedCore's production database holds real hospital data. Destructive SQL
is not allowed in a migration without an explicit runbook entry and an
ops sign-off in the PR description. In practice this means:

- No `DROP TABLE`.
- No `DROP COLUMN` on a populated column.
- No `ALTER COLUMN ... SET NOT NULL` without a prior backfill migration.
- No `RENAME` on a populated column — add the new column, backfill, cut
  readers over, drop the old column in a **separate** migration in a
  later release.

Enforcement is a grep-check in review:

```bash
grep -E "\bDROP (TABLE|COLUMN)\b|\bDROP TYPE\b" \
  packages/db/prisma/migrations/<new_folder>/migration.sql
```

If the grep finds anything, the PR description must justify it under a
`### Destructive SQL rationale` heading and the migration must land in its
own PR — never bundled with a feature.

---

## Hand-crafting migrations when Docker isn't available

`prisma migrate dev` needs a shadow database — normally a throwaway
Postgres instance you spin up with Docker. On machines without Docker
(restricted Windows corp laptops, CI runners without privileged mode), the
workflow is:

1. **Edit `schema.prisma`** as you would normally.
2. **Hand-write `migration.sql`** under a new folder named
   `packages/db/prisma/migrations/<YYYYMMDDHHMMSS>_<descriptor>/`.
   Use the timestamp in UTC, zero-padded — this establishes ordering.
3. Write the SQL by hand. Patterns to reach for:
   - `CREATE TABLE ... IF NOT EXISTS` for new tables.
   - `ALTER TABLE "Foo" ADD COLUMN IF NOT EXISTS "bar" TEXT;` for nullable
     columns with defaults.
   - `ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'NEW_ROLE';` for enum
     extension (must run outside a transaction; Prisma handles this).
   - `CREATE INDEX IF NOT EXISTS` for secondary indexes.
4. **Diff-check the generated client** locally:
   ```bash
   npx prisma generate --schema packages/db/prisma/schema.prisma
   npx tsc --noEmit -p apps/api/tsconfig.json
   ```
   If the generated client references tables your hand-written SQL did not
   create, you missed a column — fix the SQL before committing.
5. **Do not hand-edit `migration_lock.toml`.** Prisma owns it.
6. **Peer review the SQL.** A second engineer reads the raw SQL before
   merge — not just the `schema.prisma` diff — since a hand-written
   migration bypasses Prisma's SQL generator and can drift from the
   schema.

When Docker is available, `prisma migrate dev --name <descriptor>` is
always preferred; the hand-crafted path is a fallback, not the default.

---

## The `.prisma-models*.md` proposal pattern

When a feature needs new models but the schema-merger review hasn't
landed yet (or when we want to ship a route handler ahead of its table),
place a design doc alongside the code that will consume it:

```
apps/api/src/services/.prisma-models-<feature>.md
apps/api/src/routes/.prisma-models-<feature>.md
```

Examples in the tree today:

- `apps/api/src/services/.prisma-models-tenant.md` — multi-tenant
  `Tenant` model + per-model `tenantId` FK plan (not yet applied).
- `apps/api/src/services/.prisma-models-adherence-log.md` — proposed
  `AdherenceDoseLog` model (proposed ahead of the consuming route).

### Structure of a proposal

Each `.prisma-models-*.md` follows the same outline:

1. **Status line.** `Status: PROPOSAL — not yet merged into schema.prisma.`
   Be explicit that the schema edit has not happened.
2. **Model block(s).** Verbatim Prisma DSL, exactly as it should appear
   in `schema.prisma` when merged.
3. **Companion edits.** Inverse relations, index changes, or enum
   additions on other models.
4. **Field rationale table.** One row per field, one-line rationale.
5. **Index rationale.** Why each `@@index` exists and which query shape
   it serves.
6. **Cleanup checklist.** Every `(prisma as any).<model>` cast, every
   `// TODO(cast):` comment, and every follow-up test change that must
   happen once the model is merged and `prisma generate` is re-run.

### Why this pattern exists

- It keeps model design **in version control** so reviewers can see
  exactly what a route handler is assuming about future schema.
- It lets route code land before the migration — useful when the schema
  is owned by a different reviewer cadence — without silently casting
  through `any` forever.
- The cleanup checklist makes it a single mechanical pass to "land the
  schema and remove the scaffolding" later.

### Rules

- A `.prisma-models-*.md` is **not** a substitute for a migration.
  Before a feature ships to production, the doc must be merged into
  `schema.prisma` with an accompanying migration in
  `packages/db/prisma/migrations/`, and the cleanup checklist must be
  completed.
- Never `git mv` a proposal file to remove it — delete it in the same
  PR that merges the model into `schema.prisma`, so the git history
  shows the proposal → migration handoff clearly.
- If a proposal is abandoned, delete the `.md` in a dedicated PR with
  the rationale in the commit message.

---

## Rollback

There is no automatic rollback. If a migration breaks production:

1. Restore from the most recent `pg_dump` backup (`scripts/backup.sh` runs
   daily at 02:00, 30-day retention).
2. Write a forward-fixing migration with a new timestamp. Do **not**
   delete or edit the failed migration folder — it is already applied on
   other environments.
3. If the failure is drift (the prod schema diverged from the migration
   history, typically because an earlier engineer ran `db push`),
   baseline with:
   ```bash
   npx prisma migrate resolve \
     --schema packages/db/prisma/schema.prisma \
     --applied <timestamp_of_last_good_migration>
   ```
   Then apply pending migrations cleanly on top.

---

## Checklist before opening a PR with a schema change

- [ ] `schema.prisma` edit is minimal and single-purpose.
- [ ] New migration folder exists under `packages/db/prisma/migrations/`.
- [ ] `migration.sql` has been read by the author — not just
      auto-accepted from `prisma migrate dev`.
- [ ] No `DROP TABLE` / `DROP COLUMN` / `RENAME` on populated data.
- [ ] `npx prisma generate` runs clean.
- [ ] `npx tsc --noEmit` runs clean across all packages.
- [ ] Integration tests pass against a fresh Postgres (the suite
      re-applies every migration from zero on `beforeAll`).
- [ ] If this closes a `.prisma-models-*.md` proposal, the `.md` is
      deleted in the same PR and every `(prisma as any).<model>` cast
      in the affected routes is removed.
