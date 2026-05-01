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
for arg in "$@"; do
    case "$arg" in
        --yes|-y) AUTO_YES=1 ;;
        --seed)   DO_SEED=1 ;;
    esac
done

cd "$MEDCORE_DIR"

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
if pg_dump --dbname="$DB_URL" --no-owner --no-acl 2>/tmp/pgdump.log | gzip > "$BACKUP_FILE"; then
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
npm --prefix apps/web run build

echo "=== 7. Restarting services ==="
pm2 restart medcore-api medcore-web
sleep 3

echo "=== 8. Verifying ==="
curl -sf http://localhost:4100/api/health && echo " API OK" || { echo " API FAILED"; exit 1; }
curl -sf http://localhost:3200 > /dev/null && echo "Web OK" || { echo "Web FAILED"; exit 1; }

pm2 save
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
