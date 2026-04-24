# Operations FAQ

Short, opinionated answers for ops-style questions that get asked in the
#medcore channel every other week. Deeper context lives in the linked docs.

---

## How do I roll back a bad deploy?

1. SSH to prod (`empcloud-development@163.227.174.141`).
2. `cd /home/empcloud-development/medcore`.
3. Point HEAD at the previous verified-healthy SHA (step 0 of
   `scripts/deploy.sh` writes it to `/tmp/medcore-prev-sha`):
   ```bash
   git reset --hard "$(cat /tmp/medcore-prev-sha)"
   ```
4. Reinstall (lockfile may have moved):
   ```bash
   npm ci --ignore-scripts
   ```
5. Regenerate Prisma for the old schema, rebuild web, and restart PM2:
   ```bash
   npx prisma generate --schema packages/db/prisma/schema.prisma
   npm --prefix apps/web run build
   pm2 restart medcore-api medcore-web && pm2 save
   ```
6. Verify: `scripts/verify-deploy.sh` must exit 0.

### But what about migrations?

**Migrations are additive and NOT rolled back automatically.** Every one of
our `20260423*` / `20260424*` migrations only adds tables or columns, so the
older application code ignores them safely. If a migration genuinely needs
to be reverted, restore from the most recent `/var/backups/medcore/` dump —
never write a `DROP COLUMN` forward-fix without pairing with a DBA.

### What if I ran one of the fix-*.ts / dedup-*.ts scripts and it made things worse?

There is **no automated undo** for the data-correction scripts. Recovery
is per-script and documented inline (see `DEPLOY_DATA_SCRIPTS.md` for the
full list, and the per-action rollback sections in
[`AUDIT_RENAME_MAP_2026-04-23.md`](AUDIT_RENAME_MAP_2026-04-23.md) for the
audit-action rename script). The safest move is almost always to restore
the affected tables from the most recent pg_dump.

Full runbook: [`DEPLOY.md` §4](DEPLOY.md#4-rollback-plan).

---

## How do I verify a tenant's data?

Log in as a user with the `ADMIN` role and open
`/dashboard/admin-console`. The console:

- Lists every tenant (id, name, subdomain, plan, created-at).
- Shows per-tenant row counts across the main tenant-scoped tables
  (Patient, Appointment, Consultation, Invoice, Admission, …).
- Lets you drill into a tenant to see its users, doctors, and recent
  activity without switching JWTs.

For row-level spot-checks outside the UI, open a psql shell on prod and
filter by `tenantId`:

```sql
SELECT COUNT(*) FROM "Patient" WHERE "tenantId" = '<tenantId>';
```

Every tenant-scoped query in the API goes through `tenantScopedPrisma`
(middleware in `apps/api/src/middleware/tenant.ts`), so a stray admin
request can never cross tenants — but the raw `prisma` client in a psql
shell or an admin script bypasses that.

---

## How do I enable / disable rate limits for a load test?

Use the helper script — it SSHes, sets `DISABLE_RATE_LIMITS`, restarts
`medcore-api` with `--update-env`, and sanity-hammers
`/api/v1/auth/login` so you have immediate evidence the toggle took effect:

```bash
scripts/toggle-rate-limits.sh on    # bypass ON — limits OFF (load-test mode)
scripts/toggle-rate-limits.sh off   # bypass OFF — limits back on (safe)
```

The bypass is **intentionally NOT** persisted in
`ecosystem.medcore.config.js` — baking it there would survive reboots and
silently expose the prod API. If you toggle `on` for a campaign, set a
reminder to toggle `off` within the day. Leaving prod with limits disabled
is a P2.

Manual pm2 recipe (for when the helper script isn't available) and the
full rationale live in [`DEPLOY.md` §8a](DEPLOY.md#8a-runtime-rate-limit-controls).

---

## Where do I add a new prompt version?

The prompt registry (shipped April 2026) keeps every LLM prompt in the
`Prompt` table, with a row per version. To ship a new version of, say,
`TRIAGE_SYSTEM`:

1. POST the new (inactive) content:
   ```
   POST /api/v1/ai/admin/prompts/TRIAGE_SYSTEM/versions
   { "content": "...", "notes": "tighten red-flag wording" }
   ```
2. Dry-run it against the AI eval harness
   (`apps/api/src/test/ai-eval/`) locally before activating.
3. Activate:
   ```
   POST /api/v1/ai/admin/prompts/versions/<versionId>/activate
   ```
4. If the activated version misbehaves in prod, one-shot roll back:
   ```
   POST /api/v1/ai/admin/prompts/TRIAGE_SYSTEM/rollback
   ```
   This flips the previous-active version back and audit-logs
   `PROMPT_VERSION_ROLLBACK`.

End-to-end rollout procedure, eval-gate criteria, and the list of
registered prompt keys live in [`docs/PROMPT_ROLLOUT.md`](PROMPT_ROLLOUT.md)
(written by the prompt-registry agent in parallel — if the doc isn't there
yet, the service source at
`apps/api/src/services/ai/prompt-registry.ts` is the interim source of
truth).

---

## Why did the web build fail on `@tailwindcss/oxide`?

`@tailwindcss/oxide` ships its native bindings as `optionalDependencies`,
and npm/cli#4828 sometimes drops the Linux binding on a cross-platform
`npm ci` — you'd see `Cannot find native binding` on prod or a modified
`package-lock.json` breaking the deploy-script "working tree clean" guard.

**This is fixed.** `apps/web/package.json` now pins
`@tailwindcss/oxide-linux-x64-gnu` in `optionalDependencies` at the exact
version resolved in the lockfile, so `npm ci` on Linux always installs it.

`scripts/deploy.sh` also runs `git checkout -- package-lock.json` if the
tree is dirty after `npm ci`, as a last-line defence. See the comment
block at the top of step 2 in `scripts/deploy.sh` (and
[`DEPLOY.md` §0](DEPLOY.md#0-the-package-lockjson-drift-pattern)) for
the bump recipe if it ever drifts again — you need to bump the pinned
version in `apps/web/package.json` to match whatever
`@tailwindcss/oxide` resolves to in `package-lock.json`.

---

## A new GitHub issue came in — what's the flow?

1. **Triage severity.** P0 (prod down, data loss, security) interrupts
   current work. P1 (customer-blocking, wrong clinical data) goes into
   the current sprint. P2 (polish, observability) lands in the backlog.
2. **Scope it.** Read the issue, poke at the repo, write a one-paragraph
   brief describing the fix (files touched, tests to add, migrations
   required). If a migration is needed, include the proposed
   `.prisma-models-<feature>.md` filename — the migration policy lives
   in [`MIGRATIONS.md`](MIGRATIONS.md).
3. **Spin an agent with that brief.** Tight scope + explicit "don't touch
   X" lines are what keep the agent from over-reaching.
4. **The agent must:** typecheck both apps, run the relevant test tiers,
   commit, and push. Pre-commit hooks will catch formatting / type
   drift — never skip them with `--no-verify` unless the user explicitly
   authorises it.
5. **Close via the commit.** Include `Closes #N` in the commit body (or
   the PR body if you're shipping via PR). GitHub auto-closes the issue
   once `main` has the commit.
6. **If it's prod-touching**, follow the full [`DEPLOY.md`](DEPLOY.md)
   runbook after merge.

---

## Related docs

- [`DEPLOY.md`](DEPLOY.md) — nine-step production deploy runbook.
- [`DEPLOY_ENV_VARS.md`](DEPLOY_ENV_VARS.md) — every env var by role.
- [`DEPLOY_DATA_SCRIPTS.md`](DEPLOY_DATA_SCRIPTS.md) — every
  `fix-*` / `dedup-*` / `backfill-*` script with dry-run + apply commands.
- [`AUDIT_RENAME_MAP_2026-04-23.md`](AUDIT_RENAME_MAP_2026-04-23.md) —
  per-script rollback sections for the audit-action rename.
- [`MIGRATIONS.md`](MIGRATIONS.md) — Prisma migration policy.
- [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) — AI subsystems.
