#!/bin/bash
# One-command deployment script for MedCore.
#
# PRIMARY INVOKER: GitHub Actions (.github/workflows/test.yml `deploy` job).
# Every push to `main` that passes the typecheck gate triggers the workflow,
# which SSHes into the dev server and runs `bash scripts/deploy.sh --yes`.
# **Do not deploy by hand** for normal pushes to `main` — the workflow does it.
#
# Manual fallback (CI down, hotfix, destructive op like --seed):
#   ssh empcloud-development@163.227.174.141
#   cd /home/empcloud-development/medcore
#   bash scripts/deploy.sh [--seed] [--yes]
# See docs/DEPLOY.md "Manual fallback runbook" for the full walkthrough.
#
# Guard rails:
#   * refuses to run with uncommitted local changes
#   * shows pending migrations and asks to confirm (skip with --yes)
#   * verifies migrate status is clean after deploy
#   * exits non-zero on ANY step failure

set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

MEDCORE_DIR="/home/empcloud-development/medcore"
DB_URL="postgresql://medcore:medcore_secure_2024@localhost:5433/medcore?schema=public"
SCHEMA_PATH="packages/db/prisma/schema.prisma"

AUTO_YES=0
DO_SEED=0
DO_ROLLBACK=0
for arg in "$@"; do
    case "$arg" in
        --yes|-y)    AUTO_YES=1 ;;
        --seed)      DO_SEED=1 ;;
        --rollback)  DO_ROLLBACK=1 ;;
    esac
done

cd "$MEDCORE_DIR"

# ─── Rollback path (CI hardening Phase 2.2) ─────────────────────────────
# Triggered by the workflow when the post-deploy smoke check fails. Resets
# the checkout to PREV_SHA (recorded by the previous successful deploy at
# /tmp/medcore-prev-sha), reinstalls deps at that SHA, and restarts pm2 —
# but does NOT roll back the database. Reasoning:
#   - Most migrations in this codebase are additive (add column, add table).
#     Old code tolerates them.
#   - Rolling back a destructive migration requires the pre-migrate dump
#     from step 4b (see DEPLOY.md "Recovery from a bad migration" — that's
#     a human ops procedure, not an automated workflow step).
# If pm2 won't come up at PREV_SHA after rollback, the smoke check after
# this script exits will still fail and the workflow turns red — at that
# point a human takes over.
if [ "$DO_ROLLBACK" -eq 1 ]; then
    if [ ! -s /tmp/medcore-prev-sha ]; then
        echo "ABORT — /tmp/medcore-prev-sha is missing; nothing to roll back to."
        exit 1
    fi
    ROLLBACK_TO="$(cat /tmp/medcore-prev-sha)"
    echo "=== ROLLBACK to ${ROLLBACK_TO} ==="
    git checkout -- package-lock.json 2>/dev/null || true
    git fetch origin
    git reset --hard "$ROLLBACK_TO"
    npm ci --ignore-scripts 2>/dev/null || npm ci
    DATABASE_URL="$DB_URL" npx prisma generate --schema "$SCHEMA_PATH"
    # NB: skipping `prisma migrate deploy` — schema may be ahead of this
    # SHA. If a destructive migration broke things, restore from the dump
    # in $MEDCORE_DIR/backups/ per DEPLOY.md.
    # Tag Sentry events with the rolled-back SHA so post-rollback errors
    # are attributed to the now-serving commit, not the bad one.
    export SENTRY_RELEASE="$ROLLBACK_TO"
    export NEXT_PUBLIC_SENTRY_RELEASE="$ROLLBACK_TO"
    npm --prefix apps/web run build
    pm2 restart medcore-api medcore-web --update-env
    sleep 3
    curl -sf http://localhost:4100/api/health && echo " API OK after rollback" || { echo " API STILL FAILED after rollback — page a human"; exit 1; }
    curl -sf http://localhost:3200 > /dev/null && echo "Web OK after rollback" || { echo "Web STILL FAILED after rollback — page a human"; exit 1; }
    pm2 save
    echo "=== Rollback complete (HEAD=${ROLLBACK_TO}) ==="
    exit 0
fi

echo "=== 0. Pre-flight: working tree clean ==="
# Workaround for npm/cli#4828: `npm ci` on Linux can leave package-lock.json
# dirty after resolving @tailwindcss/oxide's optional deps. The pin in
# apps/web/package.json keeps this rare, but if it does happen we want the
# next deploy to recover, not abort. Drop the cosmetic dirty state silently;
# any genuine local edit to package-lock.json on prod is itself a bug we
# don't want to preserve.
git checkout -- package-lock.json 2>/dev/null || true
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "  ABORT — uncommitted local changes on prod checkout."
    echo "  git status:"
    git status --short
    exit 1
fi
PREV_SHA="$(git rev-parse HEAD)"
echo "  OK — HEAD=${PREV_SHA}"
echo "$PREV_SHA" > /tmp/medcore-prev-sha

echo "=== 1. Pulling latest code ==="
git fetch origin
git checkout main
git pull --ff-only origin main

echo "=== 2. Installing dependencies ==="
# NOTE: @tailwindcss/oxide-linux-x64-gnu is pinned in apps/web/package.json
# `optionalDependencies` to work around the npm optional-deps race (npm/cli#4828)
# that used to crash the web build with "Cannot find native binding" after `npm ci`.
# Do NOT reintroduce a manual `npm install --no-save @tailwindcss/oxide-linux-x64-gnu`
# step here — if it ever breaks again, bump the pinned version in
# apps/web/package.json to match whatever @tailwindcss/oxide resolves to in
# package-lock.json (search `node_modules/@tailwindcss/oxide` and copy the version).
npm ci --ignore-scripts 2>/dev/null || npm ci

echo "=== 3. Generating Prisma client ==="
DATABASE_URL="$DB_URL" npx prisma generate --schema "$SCHEMA_PATH"

echo "=== 4. Pending migrations ==="
DATABASE_URL="$DB_URL" npx prisma migrate status --schema "$SCHEMA_PATH" || true
if [ "$AUTO_YES" -ne 1 ]; then
    read -r -p "Apply the above migrations? [y/N] " reply
    case "$reply" in
        y|Y|yes|YES) : ;;
        *) echo "  Aborted by user."; exit 1 ;;
    esac
fi

echo "=== 4b. Pre-migrate DB backup ==="
# Snapshot the database BEFORE migrations run so a destructive migration can
# be reverted by restoring the dump. Healthcare data: this is non-negotiable.
# Backups land in $MEDCORE_DIR/backups, named with the deploy's incoming SHA
# and a UTC timestamp; deploy auto-rollback (CI hardening Phase 2.2) and the
# manual fallback runbook in DEPLOY.md both reference this path.
INCOMING_SHA="$(git rev-parse HEAD)"
BACKUP_DIR="$MEDCORE_DIR/backups"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/predeploy-$(date -u +%Y%m%dT%H%M%SZ)-${INCOMING_SHA:0:8}.sql.gz"
echo "  → $BACKUP_FILE"
# `pg_dump --no-owner --no-acl` keeps the dump portable across role names if
# we ever migrate Postgres servers (see TODO.md priority #2). gzip drops the
# size by ~5x for our schema shape.
#
# Strip the `?schema=public` query parameter — it's a Prisma-specific URL
# extension that pg_dump rejects with "invalid URI query parameter".
# pg_dump dumps every schema by default; the `public` schema is what we
# want and gets included automatically.
PGDUMP_URL="${DB_URL%%\?*}"
if pg_dump --dbname="$PGDUMP_URL" --no-owner --no-acl 2>/tmp/pgdump.log | gzip > "$BACKUP_FILE"; then
    echo "  OK — backup size $(du -h "$BACKUP_FILE" | cut -f1)"
else
    echo "  ABORT — pg_dump failed. Last 20 lines of stderr:"
    tail -n 20 /tmp/pgdump.log || true
    rm -f "$BACKUP_FILE"
    exit 1
fi
# Retain only the last 14 backups so disk usage doesn't grow unbounded.
# Older backups are removed silently — older recoverability lives in the
# Postgres WAL on the host's daily snapshot.
ls -1t "$BACKUP_DIR"/predeploy-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "=== 5. Applying database migrations ==="
# `migrate deploy` applies pending migrations only — never resets, never prompts.
# New migrations must come from `prisma migrate dev` locally and be committed.
# If this step or 5b fails, restore the dump above:
#   gunzip -c $BACKUP_FILE | psql "$DB_URL"
# (See DEPLOY.md "Recovery from a bad migration" for the full procedure.)
DATABASE_URL="$DB_URL" npx prisma migrate deploy --schema "$SCHEMA_PATH"

echo "=== 5b. Verifying no pending migrations remain ==="
STATUS_OUT="$(DATABASE_URL="$DB_URL" npx prisma migrate status --schema "$SCHEMA_PATH" 2>&1 || true)"
echo "$STATUS_OUT"
if echo "$STATUS_OUT" | grep -qiE "following migration.*have not yet been applied|pending"; then
    echo "  ABORT — prisma migrate status still shows pending after deploy."
    exit 1
fi

echo "=== 6. Building web app ==="
# Export SENTRY_RELEASE so the Next.js build embeds it in the browser
# bundle as NEXT_PUBLIC_SENTRY_RELEASE. Both apps read this at runtime to
# tag every Sentry event with the deploying SHA. CI hardening Phase 4.2.
export SENTRY_RELEASE="$INCOMING_SHA"
export NEXT_PUBLIC_SENTRY_RELEASE="$INCOMING_SHA"
npm --prefix apps/web run build

echo "=== 7. Restarting services ==="
# `--update-env` forces pm2 to re-read the parent shell's env vars on
# restart, picking up the SENTRY_RELEASE we just exported. Without this
# pm2 caches the env from when each process was first spawned.
pm2 restart medcore-api medcore-web --update-env
sleep 3

echo "=== 8. Verifying ==="
# Retry loop: the dev box runs ~30 PM2 processes for several apps; under
# load `pm2 restart` + 3s sleep is sometimes too tight for medcore-api to
# bind :4100 before the curl fires. Single-shot was the root cause of
# 4 consecutive 'API FAILED' deploy-step failures observed 2026-05-05.
api_ok=0
for attempt in 1 2 3 4 5; do
    if curl -sf -m 5 http://localhost:4100/api/health > /dev/null; then
        echo " API OK (attempt $attempt)"; api_ok=1; break
    fi
    echo " API not ready (attempt $attempt/5), retrying in 5s..."
    sleep 5
done
[ "$api_ok" -eq 1 ] || { echo " API FAILED after 5 retries"; exit 1; }

web_ok=0
for attempt in 1 2 3 4 5; do
    if curl -sf -m 5 http://localhost:3200 > /dev/null; then
        echo "Web OK (attempt $attempt)"; web_ok=1; break
    fi
    echo "Web not ready (attempt $attempt/5), retrying in 5s..."
    sleep 5
done
[ "$web_ok" -eq 1 ] || { echo "Web FAILED after 5 retries"; exit 1; }

pm2 save

# Issue #40 / #41: keep the medicine catalog rows aligned with the
# canonical seed values on every deploy. seed-pharmacy.ts is idempotent
# (every write is an upsert keyed by `name` for medicines, `code` for lab
# tests, and a composite key for inventory) so re-running it on every
# deploy fixes the demo's stale `prescriptionRequired=false` Amlodipine
# row + empty `brand` columns without ever destroying tenant data.
# Failures here MUST NOT fail the deploy — the catalog is non-critical
# relative to the API/Web smoke checks above.
echo "=== 8b. Re-applying pharmacy catalog seed (Issue #40, #41) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-pharmacy.ts; then
    echo "  OK — pharmacy catalog re-seeded."
else
    echo "  WARN — pharmacy seed failed (non-fatal). Investigate offline."
fi

# Issue #46: pediatric immunization rows seeded long ago show "9+ years
# overdue" on the dashboard because their nextDueDate was anchored to
# DOB + UIP age offset, which slid into the deep past as the demo aged.
# fix-stale-immunizations.ts walks every PENDING row whose nextDueDate is
# >365d old and either RECOMPUTEs to a 7-60d overdue window (kids) or
# marks it MISSED (adults — too late for a pediatric vaccine). The script
# is idempotent (only touches rows that ARE >365d stale) and dry-run-safe
# by default; we pass --apply here. As with the pharmacy seed, failures
# MUST NOT block the deploy — the overdue dashboard cosmetic is
# non-critical relative to API/Web smoke checks above.
echo "=== 8c. Re-clamping stale immunization due-dates (Issue #46) ==="
if DATABASE_URL="$DB_URL" npx tsx scripts/fix-stale-immunizations.ts --apply; then
    echo "  OK — stale immunization rows re-clamped."
else
    echo "  WARN — fix-stale-immunizations failed (non-fatal). Investigate offline."
fi

# Steps 8d–8j: idempotent demo-fixture seeds.
#
# Each script below is fully idempotent (upsert on a stable unique column,
# OR findFirst/findUnique guard before .create), and seeds dashboard-visible
# fixture rows whose absence has previously surfaced as a "live demo bug"
# despite the underlying code already being correct. Wired post-deploy so
# every push to main re-asserts the canonical fixture state without ever
# touching real user-created rows. Each step is non-fatal — a single seed
# failure must NOT break the deploy (catalog/fixture data is non-critical
# relative to the API/Web smoke checks above).
#
# Seeds NOT wired (intentionally — see chore commit body):
#   - seed-clinical-enhancements, seed-acute-care-enhancements,
#     seed-ancillary-enhancements, seed-ipd,
#     seed-pediatric-patients, seed-ops-enhancements,
#     seed-phase4-{specialty,engagement,ops}
#                              — all do raw `.create` per row with no guard,
#                                or use `deleteMany` (destructive) up-front.
# These need an idempotency pass (see chore commit) before they can be auto-
# applied. Until then, run them manually via the `--seed` destructive path
# only when willing to accept a full reset.
#
# Wired below (deploy.sh wave 2 — idempotency lifted 2026-05-10):
#   - seed-chat-conversations.ts     (8n) — [CHAT-SEED-<roomKey>-NNNN] tag findFirst on content startsWith
#   - seed-visitors-history.ts       (8o) — VIS-HIST-SEED-NNNN passNumber findUnique skip-or-create
#   - seed-asset-history.ts          (8p) — [seed:ASSET-HIST-SEED-<tag>-<j>] description marker + [seed:ASSET-XFER-SEED-<tag>] notes marker findFirst-skip
#   - seed-doctor-ratings.ts         (8q) — [seed:DR-RATE-SEED-<doctorId>-<i>] comment marker findFirst-skip on PatientFeedback
#   - seed-complaints-data.ts        (8r) — CMP-SEED-NNNN ticketNumber findUnique (does NOT poison live CMP-YYYY-NNNNN counter)
#   - seed-notifications-history.ts  (8s) — NOTIF-SEED-NNNN dedupKey findUnique (cannot collide with broadcast `${broadcastId}:${userId}`)
#   - seed-immunization-data.ts      (8t) — IMMUN-SEED-NNNNNN tag in `notes` + findFirst on (patientId, vaccine, doseNumber)
#   - seed-lab-data.ts               (8u) — LAB-SEED-NNNNNN orderNumber findUnique
#   - seed-lab-panels.ts             (8v) — LAB-SEED-PANEL-NNNNNN orderNumber findUnique + per-test reference-range count guard
# All share the mulberry32 PRNG idempotency strategy that seed-realistic.ts
# pioneered — re-runs make byte-identical decisions.

echo "=== 8d. Re-applying hospital identity SystemConfig seed ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-hospital-config.ts; then
    echo "  OK — hospital config re-seeded."
else
    echo "  WARN — hospital-config seed failed (non-fatal). Investigate offline."
fi

echo "=== 8e. Re-applying notification templates seed ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-notification-templates.ts; then
    echo "  OK — notification templates re-seeded."
else
    echo "  WARN — notification-templates seed failed (non-fatal). Investigate offline."
fi

echo "=== 8f. Re-applying medicine leaflets / renal / controlled flags ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-medicine-leaflets.ts; then
    echo "  OK — medicine leaflets re-applied."
else
    echo "  WARN — medicine-leaflets seed failed (non-fatal). Investigate offline."
fi

echo "=== 8g. Re-applying controlled-substance register seed (Issue #93) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-controlled-register.ts; then
    echo "  OK — controlled register re-seeded."
else
    echo "  WARN — controlled-register seed failed (non-fatal). Investigate offline."
fi

echo "=== 8h. Re-applying prompt registry v1 seed ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-prompts.ts; then
    echo "  OK — prompt registry v1 re-seeded."
else
    echo "  WARN — seed-prompts failed (non-fatal). Investigate offline."
fi

echo "=== 8i. Re-applying prompt registry v2 (TRIAGE_SYSTEM) seed ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-prompt-v2-triage.ts; then
    echo "  OK — prompt v2 re-seeded."
else
    echo "  WARN — seed-prompt-v2-triage failed (non-fatal). Investigate offline."
fi

echo "=== 8j. Re-applying SNOMED-CT curated subset seed ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-snomed.ts; then
    echo "  OK — SNOMED concepts re-seeded."
else
    echo "  WARN — seed-snomed failed (non-fatal). Investigate offline."
fi

# Step 8k (2026-05-09): seed-realistic.ts is now fully idempotent — all
# downstream `.create` calls on appointments / vitals / consultations /
# prescriptions / invoices / payments / insurance claims now go through
# either an upsert on a stable unique column OR a `findUnique` /
# `findFirst` skip-or-create guard. Stable seed ids:
#   - mrNumber          → MRSEED${i}
#   - invoiceNumber     → INV-SEED-${seq}
#   - transactionId     → TXN-SEED-${seq} (CASH gets one too, deviates
#                         from production-CASH null-txnId, intentional)
#   - providerClaimRef  → ${tpa}-SEED-${seq}
# All RNG is driven by a fixed-seed mulberry32 so re-runs make
# byte-identical decisions and the `(doctorId, date, tokenNumber)` upsert
# key keeps mapping back to the same rows. `next_invoice_number` and
# `next_mr_number` SystemConfig entries are NO LONGER touched — those are
# the live production counters consumed by billing.ts / patients.ts.
# Failures MUST NOT block the deploy (matches every other 8x seed step).
echo "=== 8k. Re-applying realistic OPD flow seed (idempotent) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-realistic.ts; then
    echo "  OK — realistic OPD flow re-seeded."
else
    echo "  WARN — seed-realistic failed (non-fatal). Investigate offline."
fi

# Step 8p (deploy.sh wave 3 — 2026-05-10): seed-asset-history.ts is now
# fully idempotent — every AssetMaintenance row is tagged with
# `[seed:ASSET-HIST-SEED-<assetTag>-<j>]` in `description` and gated by
# findFirst-on-marker; AssetTransfer rows use `[seed:ASSET-XFER-SEED-<tag>]`
# in `notes`. Asset row updates (amcExpiry / nextCalibration) are gated on
# the `calibrationInterval=365` marker so re-runs preserve the first run's
# AMC mix instead of resampling random offsets each deploy. All RNG goes
# through a fixed-seed mulberry32. Failures MUST NOT block the deploy.
echo "=== 8p. Re-applying asset history seed (maintenance / transfers / disposal) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-asset-history.ts; then
    echo "  OK — asset history re-seeded."
else
    echo "  WARN — seed-asset-history failed (non-fatal). Investigate offline."
fi

# Step 8q (deploy.sh wave 3 — 2026-05-10): seed-doctor-ratings.ts is now
# fully idempotent — every PatientFeedback row's `comment` carries a
# stable `[seed:DR-RATE-SEED-<doctorId>-<i>]` marker, gated by findFirst.
# All RNG (rating distribution, sentiment score, NPS, requestedVia,
# patient pick) is driven by a fixed-seed mulberry32 so re-runs reuse the
# same per-(doctor, i) tuple. Failures MUST NOT block the deploy.
echo "=== 8q. Re-applying doctor ratings seed (per-doctor PatientFeedback rows) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-doctor-ratings.ts; then
    echo "  OK — doctor ratings re-seeded."
else
    echo "  WARN — seed-doctor-ratings failed (non-fatal). Investigate offline."
fi

# Step 8r (deploy.sh wave 3 — 2026-05-10): seed-complaints-data.ts is now
# fully idempotent — sample tickets use a stable `CMP-SEED-NNNN`
# `ticketNumber` namespace (1..16) gated by findUnique. The runtime
# generator at apps/api/src/routes/feedback.ts mints `CMP-YYYY-NNNNN`
# (digits only in the tail), so its DESC sort + trailing-digit parse can
# never get poisoned by the seed's `0001..0016` tail (those numbers are
# below any realistic live ticket count). Failures MUST NOT block the
# deploy.
echo "=== 8r. Re-applying complaints seed (16 fixture tickets) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-complaints-data.ts; then
    echo "  OK — complaints re-seeded."
else
    echo "  WARN — seed-complaints-data failed (non-fatal). Investigate offline."
fi

# Step 8s (deploy.sh wave 3 — 2026-05-10): seed-notifications-history.ts is
# now fully idempotent — each of 220 sample notifications carries a stable
# `NOTIF-SEED-NNNN` value in `dedupKey` (a `@unique` column added 2026
# for the broadcast-fanout dedup feature, Issue #750). Live broadcast rows
# use the form `${broadcastId}:${userId}` (uuid-prefixed) so collisions
# are impossible. RNG is mulberry32-seeded for stable template / channel /
# status picks per iteration. Failures MUST NOT block the deploy.
echo "=== 8s. Re-applying notifications history seed (220 audience-aware delivery logs) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-notifications-history.ts; then
    echo "  OK — notifications history re-seeded."
else
    echo "  WARN — seed-notifications-history failed (non-fatal). Investigate offline."
fi

# Step 8n (deploy.sh wave 2 — 2026-05-10): seed-chat-conversations.ts is now
# fully idempotent — every seed-created chat message starts with a stable
# `[CHAT-SEED-<roomKey>-NNNN]` content prefix and is guarded by
# `findFirst({roomId, content:{startsWith}})` skip-or-create. Rooms +
# participants were already idempotent (findFirst by name+department,
# upsert on `@@unique([roomId, userId])`). All RNG goes through a fixed-seed
# mulberry32 so re-runs pick the same senders / reactions / pins / mentions
# even on partial-run recovery. Failures MUST NOT block the deploy.
echo "=== 8n. Re-applying chat conversations seed (rooms + seeded message history) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-chat-conversations.ts; then
    echo "  OK — chat conversations re-seeded."
else
    echo "  WARN — seed-chat-conversations failed (non-fatal). Investigate offline."
fi

# Step 8o (deploy.sh wave 2 — 2026-05-10): seed-visitors-history.ts is now
# fully idempotent — historical Visitor rows use a stable
# `VIS-HIST-SEED-NNNN` `passNumber` prefix guarded by `findUnique` skip.
# Distinct from the live production format (`VIS<digits>-<YYYYMMDD>`,
# generated by apps/api/src/routes/visitors.ts) AND from the
# ops-enhancement seed prefix (`VIS-OPS-NNNN`) so the live `nextPassNumber`
# logic is never advanced by this seed. Blacklist entries already use a
# `findFirst` guard on idProofNumber/phone. Failures MUST NOT block the
# deploy.
echo "=== 8o. Re-applying visitor history seed (30-day rolling history + blacklist) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-visitors-history.ts; then
    echo "  OK — visitor history re-seeded."
else
    echo "  WARN — seed-visitors-history failed (non-fatal). Investigate offline."
fi

# Step 8t (deploy.sh wave 2 — 2026-05-10): seed-immunization-data.ts is now
# fully idempotent — every Immunization row is gated by a `findFirst`
# guard on the natural tuple `(patientId, vaccine, doseNumber)` and tagged
# with a stable `[IMMUN-SEED-NNNNNN]` marker in the `notes` field. The
# upcoming-booster sentinel uses doseNumber=99 so it never collides with
# the past-dose tuple. All RNG is driven by a fixed-seed mulberry32 so
# re-runs make byte-identical decisions. Failures MUST NOT block the deploy.
echo "=== 8t. Re-applying immunization data seed (UIP child schedule + adult vaccines) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-immunization-data.ts; then
    echo "  OK — immunization data re-seeded."
else
    echo "  WARN — seed-immunization-data failed (non-fatal). Investigate offline."
fi

# Step 8u (deploy.sh wave 2 — 2026-05-10): seed-lab-data.ts is now fully
# idempotent — LabOrder.orderNumber uses stable `LAB-SEED-NNNNNN` keys
# (gated by findUnique) instead of the previous max+1 counter that minted
# fresh batches each run. LabResult creation is guarded by a per-orderItem
# count check. Lab QC entries block was already idempotent. Failures MUST
# NOT block the deploy.
echo "=== 8u. Re-applying lab orders + results seed (61 scenarios + QC entries) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-lab-data.ts; then
    echo "  OK — lab orders + results re-seeded."
else
    echo "  WARN — seed-lab-data failed (non-fatal). Investigate offline."
fi

# Step 8v (deploy.sh wave 2 — 2026-05-10): seed-lab-panels.ts is now fully
# idempotent — specialty-test orders use stable `LAB-SEED-PANEL-NNNNNN`
# keys (replacing `LAB-${YYYY}-${existingOrders+5000+i}` which compounded
# each re-run). LabTest upsert by `code` was already idempotent;
# LabTestReferenceRange now uses a per-test count guard. Failures MUST NOT
# block the deploy.
echo "=== 8v. Re-applying specialty lab panels seed (VITD/B12/IronStudies/etc.) ==="
if DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-lab-panels.ts; then
    echo "  OK — specialty lab panels re-seeded."
else
    echo "  WARN — seed-lab-panels failed (non-fatal). Investigate offline."
fi

echo "=== Deployment complete (previous SHA recorded at /tmp/medcore-prev-sha) ==="

# Optional: re-seed (destructive — triple-guarded; see env var below).
if [ "$DO_SEED" -eq 1 ]; then
    if [ "${ALLOW_PROD_SEED_RESET:-}" != "YES_I_WILL_WIPE_THE_HOSPITAL" ]; then
        echo "--seed requested but ALLOW_PROD_SEED_RESET guard is not set. Refusing."
        exit 1
    fi
    echo "=== Re-seeding database ==="
    DATABASE_URL="$DB_URL" npx prisma db push --schema "$SCHEMA_PATH" --force-reset --accept-data-loss
    DATABASE_URL="$DB_URL" npx tsx packages/db/src/seed-realistic.ts
    pm2 restart medcore-api
    echo "=== Seed complete ==="
fi
