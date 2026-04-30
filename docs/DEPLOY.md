# MedCore Deploy Runbook

> **Deployment is automated via GitHub Actions.** This runbook documents
> how the automation works and the manual fallback for the rare cases when
> CI itself is unavailable.
>
> Host: `163.227.174.141` (Ubuntu 22.04). nginx terminates TLS and proxies
> to PM2 processes `medcore-api` (port 4100) and `medcore-web` (port 3200).
> PostgreSQL runs in Docker (`medcore-postgres`) bound to host port 5433.
>
> Companion docs:
> - Migration policy: [`MIGRATIONS.md`](MIGRATIONS.md)
> - Architecture overview: [`ARCHITECTURE.md`](ARCHITECTURE.md)
> - AI subsystems: [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md)
> - Dev onboarding: [`ONBOARDING.md`](ONBOARDING.md)
> - Operational FAQ: [`OPERATIONS_FAQ.md`](OPERATIONS_FAQ.md)
> - Observability + metrics: [`OBSERVABILITY.md`](OBSERVABILITY.md)

---

## How auto-deploy works (the canonical path)

Every push to `main` triggers `.github/workflows/test.yml`. On a green CI
gate, the `deploy` job SSHes into the dev server and runs the deploy script.
**You do not deploy by hand for normal pushes** — the workflow does it.
Watch each run at https://github.com/Globussoft-Technologies/medcore/actions.

What the workflow does:

1. **CI gate.** Currently `needs: [typecheck]` while pre-existing test rot
   tracked at issue #415 is being cleared. Will be restored to
   `needs: [test, web-tests, typecheck, e2e]` once #415 is closed. Type
   check is mandatory; it catches the kind of error that breaks at runtime.
2. **SSH.** The `Deploy to dev server` job loads the `DEPLOY_SSH_KEY` secret
   into an ssh-agent, pins `DEPLOY_KNOWN_HOSTS`, and SSHes in as
   `${DEPLOY_USER}@${DEPLOY_HOST}`.
3. **Invoke the script.** Runs `bash -lc "bash /home/empcloud-development/medcore/scripts/deploy.sh --yes"`.
   The explicit `bash <path>` (rather than executing the path directly) is
   deliberate — git commits `.sh` files as `100644` by default on Windows
   contributors' clones, so the file's executable bit is unreliable. Going
   through `bash` makes the deploy work regardless of file mode.
4. **The script** (`scripts/deploy.sh`) does git pull → `npm ci` → prisma
   generate + `migrate deploy` → `npm --prefix apps/web run build` →
   `pm2 restart medcore-api medcore-web` → curl `localhost:4100/api/health`
   and `localhost:3200`.
5. **Public smoke check.** After the script returns 0 the runner curls
   `https://medcore.globusdemos.com/api/health` and `/` from outside the
   box to confirm nginx is forwarding correctly.

The concurrency group `deploy-medcore-dev` queues overlapping deploys so
two pushes can't race on `npm ci` or pm2 restart.

### Required GitHub secrets (already configured)

| Secret | Purpose |
|---|---|
| `DEPLOY_SSH_KEY` | ed25519 private key whose pubkey is in `~/.ssh/authorized_keys` on the dev server. Generate a CI-only keypair; do not reuse a personal key. |
| `DEPLOY_HOST` | `163.227.174.141`. |
| `DEPLOY_USER` | `empcloud-development`. |
| `DEPLOY_KNOWN_HOSTS` | Output of `ssh-keyscan -H 163.227.174.141`. Pinning the host key avoids TOFU + MITM. |

### Temporarily disabling auto-deploy

Comment out the `if:` line on the `deploy` job in
`.github/workflows/test.yml` and push. Re-enable by reverting that commit.

---

## When to use the manual fallback

The rest of this document is **only** for the scenarios where CI cannot
ship the change for you:

- CI is itself broken and you need to ship a hotfix (workflow file has a
  syntax error, GH Actions outage, the deploy job's secrets have been
  rotated).
- You're shipping a destructive op (`--seed`, manual migration backfill,
  data-correction script) that the CI workflow intentionally never runs.
- The dev server's CI key has been revoked.
- You want a tighter feedback loop on a tricky migration and would rather
  drive each step yourself.

For everything else: push to `main`, watch the workflow run, and if it
goes red consult the troubleshooting section.

---

### Known issue: `package-lock.json` drift pattern

This bit us three deploys in a row in April 2026 and is worth knowing before
you start. The web build depends on `@tailwindcss/oxide`, which ships native
binaries under `optionalDependencies`. Because of npm/cli#4828, `npm ci` on
the Linux prod host used to resolve to a different optional set than a
laptop (Windows / macOS) resolved, which caused either:

- `Cannot find native binding` when the Linux-specific binding was missing, or
- A modified `package-lock.json` in the working tree after `npm ci`, breaking
  the "working tree clean" guard in step 0 of `scripts/deploy.sh`.

**Fix (already in place):** `apps/web/package.json` pins
`@tailwindcss/oxide-linux-x64-gnu` in `optionalDependencies` at the exact
version resolved in `package-lock.json`. See the comment block at the top of
`scripts/deploy.sh` (step 2) for the bump recipe if it ever drifts again.

`scripts/deploy.sh` additionally runs `git checkout -- package-lock.json` if
the post-`npm ci` tree is dirty on prod — last-line defence so the deploy
doesn't abort on a cosmetic lock-file reshuffle. If that revert ever silences
a *real* drift, the symptom is a sudden `Cannot find module` at runtime on
prod despite a clean deploy — at that point compare `apps/web/package.json`
`optionalDependencies` against `package-lock.json` `node_modules/@tailwindcss/oxide-*`
entries and re-pin if they've drifted.

---

## Manual fallback runbook

The remaining sections are the manual fallback. **Use these only when
auto-deploy isn't available** — see the "When to use the manual fallback"
section above for the four scenarios where this applies.

### 1. Pre-deploy checklist (run locally)

Do all of this on your laptop **before** SSHing into prod.

- [ ] `git fetch && git status` — working tree clean, on `main`, up to date.
- [ ] `scripts/pre-deploy-check.sh` passes (green summary).
- [ ] Release notes / CHANGELOG updated for any schema or breaking change.
- [ ] Any new env var documented in `apps/api/.env.example`.
- [ ] Confirmed the migration list in section 2 matches what is pending.
- [ ] You have SSH access to `163.227.174.141` as `empcloud-development`.
- [ ] You know the last verified-healthy SHA (section 7) so you can roll back.
- [ ] Backups have run within 24 h: `ls -lh /var/backups/medcore/ | head -3`.
- [ ] A teammate is reachable on Slack in case rollback is needed.

Do **not** deploy when:

- The CI pipeline on `main` is red. (Auto-deploy already enforces this; the
  rule applies to manual fallback too.)
- Any `prisma migrate dev` has been run against the dev DB but the resulting
  migration folder is not committed.
- There are local modifications to `packages/db/prisma/schema.prisma` that
  have not been materialised as a migration folder.

If auto-deploy is healthy, **prefer pushing to main and watching CI** over
SSHing in — the workflow runs the same `scripts/deploy.sh --yes` you would
run by hand, with the same pre-flight guards, plus a public-side smoke
check that catches nginx/proxy regressions a localhost curl can miss.

---

### 2. Outstanding migrations

The migration history under `packages/db/prisma/migrations/` currently
holds 16 migrations (all committed through 2026-04-24):

| Folder | Introduces |
|---|---|
| `20260415000000_initial` | Initial schema |
| `20260415000001_auth_persistence_tables` | DB-backed 2FA temp tokens + password-reset codes |
| `20260415000002_add_pharmacist_lab_tech_roles` | `PHARMACIST` + `LAB_TECH` roles |
| `20260415111002_razorpay_webhook_and_push_token` | Razorpay webhook idempotency; Expo push tokens |
| `20260415120000_marketing_enquiry` | Marketing-site lead capture |
| `20260422000000_ai_features` | First AI feature tables (scribe, triage) |
| `20260422000001_triage_consent_fields` | Triage consent audit columns |
| `20260423000001_ai_features_models` | AI Triage / Scribe / Drug-safety data models |
| `20260423000002_abdm_insurance_jitsi_rag_models` | ABDM linkage, InsuranceClaim2 (TPA-aware), Jitsi rooms, RAG ingest tables |
| `20260423000003_adherence_dose_log` | Medication-adherence dose-log + reminder queue |
| `20260423000004_tenant_foundation` | `Tenant` table + nullable `tenantId` on 20 foundation tables |
| `20260423000005_tenant_scope_extended` | Nullable `tenantId` on 37 more tables *(requires `backfill-default-tenant.ts`)* |
| `20260423000006_prompts` | `Prompt` table for the LLM prompt registry |
| `20260423000007_prd_ai_features` | 13 PRD AI feature models (claims, capacity, coaching, roster, fraud, doc-QA, etc.) |
| `20260424000001_admission_unique_and_invoice_gst` | Admission uniqueness constraint + invoice GST columns |
| `20260424000002_admission_dama_and_tenant_extension` | DAMA status + more tenant-scope columns *(requires `backfill-default-tenant.ts`)* |

`prisma migrate deploy` applies them in lexical (timestamp) order. Never edit
a migration folder after it has landed on prod — add a forward-only fix.
Any migration marked *(requires `backfill-default-tenant.ts`)* means you
must run the backfill helper before flipping those columns to `NOT NULL`
in a follow-up migration (see step 5 below).

---

### 3. Step-by-step deploy sequence

Nine ordered steps. Every step must succeed before moving to the next.

```bash
ssh empcloud-development@163.227.174.141
cd /home/empcloud-development/medcore
```

1. **Record the current SHA** (rollback target):
   ```bash
   git rev-parse HEAD | tee /tmp/medcore-prev-sha
   ```
2. **Pull latest `main`:**
   ```bash
   git fetch origin && git checkout main && git pull --ff-only origin main
   ```
3. **Install dependencies (clean, lockfile-exact):**
   ```bash
   npm ci --ignore-scripts
   ```
4. **Show pending migrations** (read-only confirmation):
   ```bash
   npx prisma migrate status --schema packages/db/prisma/schema.prisma
   ```
5. **Apply migrations (forward-only, never resets):**
   ```bash
   npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
   ```

   **After every tenant-scope-extension migration** run
   `scripts/backfill-default-tenant.ts` (dry-run, then `--apply`) so
   pre-existing rows get attached to the seed tenant. Precedent:
   `20260423000005_tenant_scope_extended` and
   `20260424000002_admission_dama_and_tenant_extension` both required it.
   The script is idempotent — already-scoped rows are untouched. Command
   reference in [`DEPLOY_DATA_SCRIPTS.md`](DEPLOY_DATA_SCRIPTS.md).
6. **Regenerate Prisma client** (schema may have new models/enums):
   ```bash
   npx prisma generate --schema packages/db/prisma/schema.prisma
   ```
7. **Build web bundle:**
   ```bash
   npm --prefix apps/web run build
   ```
8. **Restart PM2 processes:**
   ```bash
   pm2 restart medcore-api medcore-web && pm2 save
   ```
9. **Health check + smoke test:**
   ```bash
   scripts/verify-deploy.sh
   npx tsx scripts/prod-smoke-test.ts
   ```

   `prod-smoke-test.ts` now hits **20 dashboard pages** (7 original AI +
   13 Apr 2026 PRD). Green means: `verify-deploy.sh` exits 0, and all 20
   pages return 200/302/307 (the dashboard redirects unauthenticated hits
   to `/login`). Any 5xx → capture the summary JSON, head to section 9
   before rolling back; a single 502 is usually Next.js still warming.

Prefer the wrapper script which chains 2-9 with pre-flight guards:

```bash
scripts/deploy.sh
```

---

### 4. Rollback plan

If any step 5-9 fails or post-deploy verification finds a regression:

```bash
# 1. Stop serving bad code
pm2 stop medcore-api medcore-web

# 2. Revert working tree to the recorded previous SHA
cd /home/empcloud-development/medcore
git reset --hard "$(cat /tmp/medcore-prev-sha)"

# 3. Reinstall (lockfile may have moved)
npm ci --ignore-scripts

# 4. Regenerate Prisma client for the OLD schema
npx prisma generate --schema packages/db/prisma/schema.prisma

# 5. Rebuild web and bring processes back up
npm --prefix apps/web run build
pm2 restart medcore-api medcore-web
pm2 save

# 6. Verify
scripts/verify-deploy.sh
```

**Migrations are additive and NOT rolled back automatically.** The
`20260423*` migrations only add tables/columns — old application code
ignores them safely. If a migration ever needs to be reverted:

1. Restore from backup — see [`DEPLOY_DATA_SCRIPTS.md`](DEPLOY_DATA_SCRIPTS.md) for the canonical restore procedure. Always prefer this over manual fixes.
2. Or hand-write a forward-only fix migration; never edit a committed one.

Never run `prisma migrate reset`, `db push --force-reset`, or
`--accept-data-loss` in prod. Ever.

---

### 5. Data migration — insurance claims v2

The legacy `insurance_claims` table is being migrated into the TPA-aware
`insurance_claims_v2` table. Script:
`scripts/migrate-insurance-claims-to-v2.ts`. Detailed field-map in
[`scripts/README-insurance-migration.md`](../scripts/README-insurance-migration.md).

Run this **after** step 9 of section 3 — never during the deploy window.

```bash
# (A) Dry-run — prints what would change, writes nothing:
npx tsx scripts/migrate-insurance-claims-to-v2.ts

# (B) Review the summary JSON on stdout + stderr log:
#     - total legacy rows, planned inserts, skipped rows, synthesised fields
#     - any rows with ambiguous PreAuthRequest linkage (must be accepted)

# (C) Apply (idempotent via providerClaimRef = "LEGACY-<id>"):
npx tsx scripts/migrate-insurance-claims-to-v2.ts --apply

# (D) Verify parity:
npx tsx scripts/verify-insurance-claims-migration.ts
```

The migration never deletes legacy rows. Only after the verifier reports
green (row-count + field spot-checks match) do we consider the legacy table
safe to drop — and that drop is a separate, future, reviewed migration.

Tunables: `--batch-size=<N>` (default 100). Each batch is one
`prisma.$transaction` so a bad row only rolls back its own batch.

---

### 6. Post-deploy verification

Two scripted checks + four manual spot-checks.

### Scripted

```bash
scripts/verify-deploy.sh
#   - GET /api/health returns 200 {status:"ok"}
#   - OPTIONS against 10 AI routes — none return 5xx
#   - psql SELECT 1 succeeds

npx tsx scripts/prod-smoke-test.ts
#   - GETs 7 dashboard pages; accepts 200/302/307
```

Both must exit 0.

### Manual spot-checks

Log in as a test doctor and walk through:

| Page | What to check |
|---|---|
| `/dashboard/abdm` | ABDM status tile renders; "Link ABHA" flow opens without 500. |
| `/dashboard/fhir-export` | Patient picker loads; test export to scratch patient returns a downloadable bundle. |
| `/dashboard/insurance-claims` | Table loads from `insurance_claims_v2` (TPA column visible); "New claim" form accepts submit. |
| `/dashboard/ai/chart-search` | Search bar returns results; answer cites 1+ source chart row. |

If any fail, see section 8 before rolling back — most are nginx cache or
Prisma-client-regen issues, not data corruption.

---

### 7. Known-good baseline

| Field | Value |
|---|---|
| Last verified-healthy SHA | `b69da68` (`docs: add AI Triage, AI Scribe, Drug Safety to README; update stats`) |
| Verified on | 2026-04-22 |
| Env-var template in use | `apps/api/.env.example` at that SHA (no new required vars since) |
| `prisma migrate status` at that SHA | all applied through `20260422000001_triage_consent_fields`, none pending |
| Pending at time of next deploy | `20260423000001`, `20260423000002`, `20260423000003`, (`20260423000004` once merged) |

Record the new SHA here after each green deploy — this file is the source
of truth for "what is actually on the box right now".

---

### 8. Environment variables

The full API / Web / Mobile env-var table (including the HL7 v2 inbound
network note and the TPA connector matrix) lives in a dedicated doc so
rotations don't collide with deploy-step edits:

→ [`DEPLOY_ENV_VARS.md`](DEPLOY_ENV_VARS.md)

Canonical template: `apps/api/.env.example`. Prod `.env` at
`/home/empcloud-development/medcore/.env` (chmod 600, git-ignored). When
rotating an `SM` (secret-management) value: change it in the vault,
`pm2 restart medcore-api` after updating `.env`, and invalidate any signed
URLs that used the old signing secret.

---

### 8a. Runtime rate-limit controls

The API has a hard ops escape hatch for bulk testing / load campaigns:
setting `DISABLE_RATE_LIMITS=true` on `medcore-api` turns every limiter
into a pass-through (implemented in `apps/api/src/middleware/rate-limit.ts`;
only `"true"` — exact string — bypasses, anything else leaves limits on).

This is **intentionally NOT** persisted in `ecosystem.medcore.config.js`.
It is a short-lived ops tool; baking it into the ecosystem file would make
it survive reboots and silently expose the prod API. Instead toggle it at
runtime on the live pm2 process.

### Option A — helper script (recommended)

From a laptop with the repo checked out and `.env` populated:

```bash
# disable rate limits for an E2E / load window:
scripts/toggle-rate-limits.sh on

# re-enable (default behaviour) once done:
scripts/toggle-rate-limits.sh off
```

The script SSHs to prod, runs `pm2 restart medcore-api --update-env` with the
variable set/cleared, then hammers `/api/v1/auth/login` 40 times and prints
the 429 count so you have immediate evidence the state took effect.
Requires `plink` (Windows / Git-Bash) or `sshpass` (POSIX).

### Option B — manual pm2 recipe

Use this if the toggle script isn't available:

```bash
ssh empcloud-development@163.227.174.141
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"

# --- turn limits OFF (bypass ON) ---
DISABLE_RATE_LIMITS=true pm2 restart medcore-api --update-env

# --- turn limits back ON (the safe state) ---
# NOTE: `unset` in your shell does NOT propagate through --update-env
# because pm2 keeps the previously-set value. You MUST explicitly set it
# to a non-"true" value (anything else disables the bypass):
DISABLE_RATE_LIMITS=false pm2 restart medcore-api --update-env
pm2 save

# verify:
pm2 env $(pm2 jlist | jq '.[] | select(.name=="medcore-api") | .pm_id') \
  | grep DISABLE_RATE_LIMITS

# sanity-hammer: expect some 429s when limits are ON, zero when OFF
for i in $(seq 1 40); do \
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:4100/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    --data '{"email":"probe@x.com","password":"x"}'; \
done | sort | uniq -c
```

Default / safe state is **limits ON** (`DISABLE_RATE_LIMITS` unset or set to
anything other than the literal string `true`). Leaving prod with limits
disabled is considered a P2 until corrected.

---

### 9. Troubleshooting

#### Auto-deploy (GitHub Actions) failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `Deploy to dev server` job logs `bash: line 1: /home/.../scripts/deploy.sh: Permission denied` (exit 126). | Script lacks the executable bit on the dev server (git on Windows commits `.sh` files as `100644`). | The workflow now invokes via `bash <path>` so the bit doesn't matter — pull the latest workflow change. As belt-and-suspenders, on the server: `chmod +x scripts/deploy.sh`. |
| `Set up SSH agent` step fails with `error in libcrypto`. | The `DEPLOY_SSH_KEY` secret has CRLF line endings. | Re-upload the key with `tr -d '\r' < ~/medcore-ci-key \| gh secret set DEPLOY_SSH_KEY -R Globussoft-Technologies/medcore`. |
| `Set up SSH agent` succeeds but the deploy step times out connecting. | The CI key got removed from the dev server's `authorized_keys`. | Re-add the pubkey from `~/medcore-ci-key.pub` to `/home/empcloud-development/.ssh/authorized_keys`. |
| The deploy step succeeds but `Smoke-check public endpoints` fails on `https://medcore.globusdemos.com/api/health`. | nginx forwarding broken, or `medcore-api` failed to start cleanly post-restart. | SSH in, `pm2 status` + `pm2 logs medcore-api` to see if the API came up. If pm2 is healthy but the public URL is dead, `sudo systemctl reload nginx`. |
| Deploy job is skipped on a push to `main`. | The `if:` gate didn't match (e.g. someone temporarily disabled auto-deploy in the workflow), or required jobs in `needs:` failed. | Check the gating clause in `.github/workflows/test.yml`. Currently `needs: [typecheck]`; restore to `[test, web-tests, typecheck, e2e]` once #415 is closed. |

#### Manual-deploy / runtime issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `verify-deploy.sh` reports 500 on an AI route. | Prisma client out of sync with DB (missing new table). | Re-run `npx prisma generate`, `pm2 restart medcore-api`. |
| `migrate deploy` says "no pending migrations" but new ones exist in the folder. | Git pull didn't actually fast-forward; `HEAD` still points at old SHA. | `git log -1 --oneline`, confirm, then `git pull --ff-only`. |
| `migrate deploy` says "drift detected". | Someone ran `db push` against prod. Schema ≠ migration history. | Stop. See [`MIGRATIONS.md`](MIGRATIONS.md) for the adoption / drift-resolution procedure. Do **not** auto-resolve. Pair with DBA. |
| `/dashboard/*` returns old bundle after deploy. | nginx static cache stale OR web process didn't restart. | `pm2 restart medcore-web`, then `sudo nginx -s reload`. Hard-refresh browser (cache-busted by Next.js hash but CDN may cache index). |
| PM2 shows process as `online` but port 4100 refuses connections ("zombie"). | Previous process hung on shutdown; PM2 thinks new one is up. | `pm2 delete medcore-api && pm2 start ecosystem.medcore.config.js --only medcore-api && pm2 save`. |
| `prisma migrate status` shows pending after `migrate deploy` returned 0. | Separate `.env` loaded (DATABASE_URL pointed at wrong DB). | `echo $DATABASE_URL` — must match the one in `/home/empcloud-development/medcore/.env`. |
| Web build OOMs on the host. | Next.js type-check + build exceeds default Node heap. | `NODE_OPTIONS=--max-old-space-size=4096 npm --prefix apps/web run build`. |
| Insurance-claims v2 page shows empty rows. | Data migration (section 5) not yet applied. | Run the dry-run, review, then `--apply`. |
| ABDM callbacks 401 in prod. | `ABDM_SKIP_VERIFY=true` leaked in; or `ABDM_JWKS_URL` unreachable. | Ensure `ABDM_SKIP_VERIFY` unset/false; curl the JWKS URL from the host. |
| `pm2 logs medcore-api` shows `SARVAM_API_KEY not set`. | Soft-fail; AI features return mock data. | Set key and restart only if the feature is expected live. |

When in doubt: roll back (section 4), open an incident, investigate with
fresh eyes. A 10-minute rollback is cheaper than a 2-hour forward-fix.

---

## Appendix — Post-deploy data-correction scripts

Every `fix-*.ts`, `dedup-*.ts`, and `backfill-*.ts` in `scripts/`, with
their dry-run / apply commands and idempotency notes, lives in a separate
doc so ops can pin it on a second monitor:

→ [`DEPLOY_DATA_SCRIPTS.md`](DEPLOY_DATA_SCRIPTS.md)

---

## Appendix — Maintenance / 502 page (Issue #65 follow-up)

When the upstream Next.js process (`medcore-web`, port 3200) is **down**,
nginx serves its built-in raw `502 Bad Gateway` page — the in-Next React
error boundaries (`apps/web/src/app/error.tsx`,
`apps/web/src/app/global-error.tsx`) only catch errors **inside** a
running Next.js process and cannot help here. We need an nginx-side
`error_page` directive to render a friendly maintenance page instead.

Add the following to the MedCore site config (typically
`/etc/nginx/sites-available/medcore.conf`) inside the relevant `server`
block:

```nginx
# /etc/nginx/sites-available/medcore.conf — server { ... }
location = /maintenance.html {
    root /var/www/medcore-static;   # static, served directly by nginx
    internal;                        # not directly reachable
}

# When the upstream (Next.js on :3200 / API on :4100) is unreachable,
# render the friendly maintenance page instead of nginx's raw 502.
error_page 502 503 504 = /maintenance.html;
proxy_intercept_errors on;
```

`/var/www/medcore-static/maintenance.html` should mirror the brand
language used by `apps/web/src/app/global-error.tsx` so the user
experience is consistent regardless of which layer caught the outage.
A minimal starter:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>MedCore — Maintenance</title>
  </head>
  <body style="font-family: system-ui, sans-serif; background:#f9fafb;
               color:#111827; display:flex; align-items:center;
               justify-content:center; height:100vh; margin:0; text-align:center;">
    <div>
      <h1 style="font-size:1.25rem; margin:0 0 .5rem;">
        MedCore is currently performing maintenance
      </h1>
      <p style="color:#4b5563; max-width:480px; margin:0 auto;">
        Please try again in a few minutes. If the problem persists,
        contact your administrator.
      </p>
    </div>
  </body>
</html>
```

After editing the nginx config:

```bash
sudo nginx -t           # validate
sudo nginx -s reload    # apply, no downtime
# verify by stopping medcore-web briefly:
pm2 stop medcore-web && curl -s -o /tmp/page.html -w "%{http_code}\n" https://prod-host/dashboard
pm2 start medcore-web
```

This change is **not** deployable from `scripts/deploy.sh` (we don't
manage nginx config from the app repo). Schedule it with the ops owner.
