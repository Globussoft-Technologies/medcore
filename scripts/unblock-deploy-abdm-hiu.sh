#!/usr/bin/env bash
# ================================================================
# unblock-deploy-abdm-hiu.sh — one-shot deploy recovery (2026-06-12)
#
# `prisma migrate deploy` is failing with P3009 because the dev/deploy
# DB holds a FAILED record for migration:
#   20260612000001_abdm_hiu_records
# (started 2026-06-12 08:11:03 UTC, failed — a prior partial run left
# some objects behind). P3009 blocks ALL subsequent migrations until
# that failed record is cleared.
#
# The migration SQL itself is already fully IDEMPOTENT (guarded enums
# via DO/EXCEPTION, tables/indexes via IF NOT EXISTS, FKs via
# NOT EXISTS lookups), so re-applying it after a `--rolled-back`
# resolve succeeds even if some objects already exist. This script:
#
#   1. Shows the current `_prisma_migrations` state.
#   2. Runs `prisma migrate resolve --rolled-back` on the failed
#      abdm_hiu_records migration so the next deploy re-applies it.
#   3. Runs `prisma migrate deploy` to apply abdm_hiu_records + the
#      remaining pending migrations (tenancy, super-admin catalog,
#      user lastLoginAt, patient state/pincode, …).
#
# Usage (on the deploy server, from the repo root after `git pull`):
#   bash scripts/unblock-deploy-abdm-hiu.sh
#
# Prereqs:
#   - DATABASE_URL set in env (or .env loaded the usual way)
#   - node_modules installed (npx prisma available)
#   - Run from the repo root so the schema path resolves
#
# Idempotent: re-running after the resolve is harmless — a
# `--rolled-back` on a non-failed migration errors loudly and is
# handled gracefully; the subsequent `migrate deploy` is a no-op once
# everything is applied.
# ================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SCHEMA="packages/db/prisma/schema.prisma"
FAILED_MIG="20260612000001_abdm_hiu_records"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "::error::DATABASE_URL not set in env. Source the deploy .env first."
  exit 1
fi

echo "============================================================"
echo "unblock-deploy-abdm-hiu.sh"
echo "Repo root : $REPO_ROOT"
echo "Schema    : $SCHEMA"
echo "Target DB : ${DATABASE_URL%%@*}@[redacted]"
echo "Failed mig: $FAILED_MIG"
echo "============================================================"
echo

# ── Step 1: Inspect current migration state ─────────────────────
echo "── Step 1: current Prisma migration status ────────────────"
npx prisma migrate status --schema "$SCHEMA" || true
echo

# ── Step 2: Clear the failed abdm_hiu_records record ────────────
# `migrate resolve --rolled-back` proved unreliable here, so delete the FAILED
# row directly (finished_at IS NULL) — the idempotent migration then re-applies
# cleanly on the next migrate deploy. Only ever touches a failed row for this
# exact name; a successfully-applied migration (finished_at set) is untouched.
echo "── Step 2: clear failed record for $FAILED_MIG ──"
printf 'DELETE FROM "_prisma_migrations" WHERE migration_name = '"'"'%s'"'"' AND finished_at IS NULL;\n' "$FAILED_MIG" \
  | npx prisma db execute --schema "$SCHEMA" --stdin
echo "  ✅ failed record cleared (if any)"
echo

# ── Step 3: Apply all pending migrations ────────────────────────
echo "── Step 3: applying pending migrations (migrate deploy) ────"
echo "  abdm_hiu_records re-applies idempotently, then the tenancy +"
echo "  super-admin catalog + user lastLoginAt + patient state/pincode"
echo "  migrations follow."
npx prisma migrate deploy --schema "$SCHEMA"
echo

echo "============================================================"
echo "Done. Re-run the deploy (or let the deploy workflow proceed)."
echo "============================================================"
