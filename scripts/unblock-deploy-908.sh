#!/usr/bin/env bash
# ================================================================
# unblock-deploy-908.sh — one-shot dev-server recovery for issue #908
#
# Auto-deploy to medcore.globusdemos.com has been silently broken
# since ~2026-05-08 because migration
# `20260509000001_backfill_stale_visitors_and_misrouted_patient_notifications`
# used `USING "User"` (uppercase) but the table is `users`
# (lowercase). The SQL is fixed in commit cd50553 on main, but the
# dev DB still holds the failed-migration record. This script:
#
#   1. Inspects the current `_prisma_migrations` state so the
#      operator sees what's actually in the DB.
#   2. Runs `prisma migrate resolve --rolled-back` on the failed
#      `20260509000001` so the next deploy can re-apply the
#      corrected migration.
#   3. Inspects `20260508000003` to confirm whether it was
#      force-applied earlier (per #908's secondary finding).
#   4. Reports what the next deploy will do.
#
# Usage (on the dev server, from the repo root after a `git pull`):
#   bash scripts/unblock-deploy-908.sh
#
# Prereqs:
#   - DATABASE_URL set in env (or .env, loaded the usual way)
#   - npx prisma available (i.e. node_modules installed)
#   - Run from the repo root so packages/db/prisma/schema.prisma
#     resolves
#
# Idempotent: re-running after the resolve completes is a no-op —
# `migrate resolve --rolled-back` on a non-failed migration errors
# loudly rather than silently; the script handles this gracefully.
# ================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SCHEMA="packages/db/prisma/schema.prisma"
FAILED_MIG="20260509000001_backfill_stale_visitors_and_misrouted_patient_notifications"
SUSPECT_MIG="20260508000003_cleanup_attacker_test_users_and_test_ambulances"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "::error::DATABASE_URL not set in env. Source the dev .env first."
  exit 1
fi

echo "============================================================"
echo "unblock-deploy-908.sh"
echo "Repo root : $REPO_ROOT"
echo "Schema    : $SCHEMA"
echo "Target DB : ${DATABASE_URL%%@*}@[redacted]"
echo "============================================================"
echo

# ── Step 1: Inspect current migration state ─────────────────────
echo "── Step 1: current Prisma migration status ────────────────"
npx prisma migrate status --schema "$SCHEMA" || true
echo

# ── Step 2: Resolve the failed 0001 ─────────────────────────────
echo "── Step 2: resolve failed migration $FAILED_MIG as rolled-back ──"
if npx prisma migrate resolve --schema "$SCHEMA" --rolled-back "$FAILED_MIG" 2>&1; then
  echo "  ✅ resolve completed"
else
  rc=$?
  echo "  ⚠ resolve exit $rc — likely already resolved (idempotent). Continuing."
fi
echo

# ── Step 3: Inspect 0003's state ────────────────────────────────
echo "── Step 3: inspect $SUSPECT_MIG state ──"
echo "  If finished_at is set but rolled_back_at is NULL, the SQL"
echo "  likely never ran (it had the same \"User\" bug) and was"
echo "  force-marked applied earlier. The fresh migration"
echo "  20260517000001 re-does the #722/#738 cleanup with the"
echo "  correct table name on the next deploy."
echo
psql "$DATABASE_URL" -t -A -F '|' -c "
  SELECT migration_name,
         started_at,
         finished_at,
         rolled_back_at,
         applied_steps_count
    FROM _prisma_migrations
   WHERE migration_name = '$SUSPECT_MIG'
      OR migration_name = '$FAILED_MIG'
   ORDER BY migration_name;
" || echo "  (psql not available — check via Prisma Studio or manually)"
echo

# ── Step 4: Report next-deploy expectations ─────────────────────
echo "── Step 4: what the next deploy will do ──"
echo "  The next push to main (or a manual workflow re-trigger of"
echo "  the most recent test.yml run) will:"
echo
echo "  1. Re-apply $FAILED_MIG"
echo "     — corrected SQL from commit cd50553 (lowercase \"users\")"
echo "     — backfills stale ACTIVE visitors (#761)"
echo "     — deletes misrouted patient-copy notifications (#759)"
echo
echo "  2. Apply 20260517000001_redo_attacker_test_users_and_ambulance_cleanup_with_correct_table_name"
echo "     — re-does the #722/#738 cleanup with the correct table"
echo "       name (replaces the silently-skipped work from $SUSPECT_MIG)"
echo
echo "  3. Apply ALL subsequent migrations that have been blocked"
echo "     since 2026-05-08 (Next 16 schema bits, anything else"
echo "     added in the past 9 days)."
echo
echo "  4. Deploy the API + Web bundles so the demo box at"
echo "     medcore.globusdemos.com finally reflects current main."
echo
echo "============================================================"
echo "Done. Trigger the next deploy with either of:"
echo "  - git commit --allow-empty -m 'chore: trigger redeploy post-#908 unblock' && git push"
echo "  - gh workflow run Test --ref main"
echo "============================================================"
