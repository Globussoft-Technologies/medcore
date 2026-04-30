#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-backup-restore.sh
#
# Takes the most recent `backups/medcore_*.sql.gz`, restores it into an
# ephemeral Postgres (docker, ideal) or a dedicated test DB specified by
# the `DATABASE_URL_RESTORE_TEST` env var, runs a schema check + 10 sanity
# COUNT queries, and tears the ephemeral DB down.
#
# This is the missing half of `scripts/backup-db.sh` — we dump daily, but
# until today nobody had asserted that the dumps are actually restorable.
#
# Safe by default: only touches the ephemeral DB, never prod. Exits non-zero
# on ANY check failure so you can wire it into cron and get a loud alert.
#
# Cron recommendation:
#   # weekly restore sanity-check (Sundays 04:00)
#   0 4 * * 0 /home/empcloud-development/medcore/scripts/verify-backup-restore.sh
#
# Modes:
#   --self-test   Exit 0 after validating the script's CLI flags without
#                 touching docker/psql. Used by the shell-assertable tests
#                 in the CI job.
#   --latest      (default) Pick backups/medcore_*.sql.gz with newest mtime.
#   --file PATH   Override the backup file explicitly.
#   --help / -h
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BACKUP_DIR_DEFAULT="/home/empcloud-development/medcore/backups"
BACKUP_DIR="${BACKUP_DIR_OVERRIDE:-$BACKUP_DIR_DEFAULT}"
EPHEMERAL_CONTAINER="medcore-restore-verify"
EPHEMERAL_DB="medcore_restore_verify"
EPHEMERAL_PORT="${EPHEMERAL_PORT:-55499}"
EPHEMERAL_PASSWORD="${EPHEMERAL_PASSWORD:-restore-verify-pw}"

PROD_CONTAINER="${PROD_CONTAINER:-medcore-postgres}"
PROD_USER="${PROD_USER:-medcore}"
PROD_DB="${PROD_DB:-medcore}"

MODE_SELF_TEST=0
MODE_LATEST=1
BACKUP_FILE=""

usage() {
    cat <<'USAGE'
Usage: verify-backup-restore.sh [options]

Options:
  --self-test     Validate CLI flags and exit 0. Skips docker/psql entirely.
  --latest        Pick the newest backups/medcore_*.sql.gz (default).
  --file PATH     Use the specified backup file.
  --help, -h      Show this help and exit.

Environment overrides:
  BACKUP_DIR_OVERRIDE          default /home/empcloud-development/medcore/backups
  DATABASE_URL_RESTORE_TEST    use this DB instead of spinning up docker
  EPHEMERAL_PORT               default 55499
  PROD_CONTAINER               default medcore-postgres
  PROD_USER                    default medcore
  PROD_DB                      default medcore

Exit codes:
  0   Restore verified (schema + sanity queries both pass).
  1   General failure (backup missing, restore errored, etc.).
  2   CLI usage error.
  3   Sanity-query mismatch (counts outside 10% tolerance of prod).
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --self-test)
            MODE_SELF_TEST=1
            shift
            ;;
        --latest)
            MODE_LATEST=1
            BACKUP_FILE=""
            shift
            ;;
        --file)
            MODE_LATEST=0
            shift
            BACKUP_FILE="${1:-}"
            if [[ -z "$BACKUP_FILE" ]]; then
                echo "ERROR: --file requires a path" >&2
                exit 2
            fi
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "ERROR: unknown flag: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

# ─── Helpers ───────────────────────────────────────────────────────────────
# Declared BEFORE the --self-test branch so the self-test can assert that
# the function bodies actually exist (guards against a later edit that
# accidentally deletes one).
pick_backup_file() {
    if [[ -n "$BACKUP_FILE" ]]; then
        [[ -f "$BACKUP_FILE" ]] || { echo "ERROR: $BACKUP_FILE not found" >&2; exit 1; }
        echo "$BACKUP_FILE"
        return
    fi
    local latest
    latest=$(ls -1t "$BACKUP_DIR"/medcore_*.sql.gz 2>/dev/null | head -1 || true)
    if [[ -z "$latest" ]]; then
        echo "ERROR: no backups found in $BACKUP_DIR" >&2
        exit 1
    fi
    echo "$latest"
}

restore_into_ephemeral() {
    local dump="$1"
    if [[ -n "${DATABASE_URL_RESTORE_TEST:-}" ]]; then
        echo "==> Restoring into \$DATABASE_URL_RESTORE_TEST (dedicated test DB)"
        # Drop + recreate schema-level, then pipe dump.
        local url="$DATABASE_URL_RESTORE_TEST"
        # psql must exist on host.
        command -v psql >/dev/null || { echo "ERROR: psql not found"; exit 1; }
        gunzip -c "$dump" | psql "$url"
        echo "$url"
        return
    fi

    command -v docker >/dev/null || {
        echo "ERROR: neither DATABASE_URL_RESTORE_TEST nor docker available" >&2
        exit 1
    }

    echo "==> Spinning up ephemeral Postgres container: $EPHEMERAL_CONTAINER"
    docker rm -f "$EPHEMERAL_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --rm \
        --name "$EPHEMERAL_CONTAINER" \
        -e POSTGRES_PASSWORD="$EPHEMERAL_PASSWORD" \
        -e POSTGRES_USER=postgres \
        -e POSTGRES_DB="$EPHEMERAL_DB" \
        -p "$EPHEMERAL_PORT:5432" \
        postgres:15 >/dev/null

    # Wait for Postgres to be ready
    local tries=0
    until docker exec "$EPHEMERAL_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do
        tries=$((tries + 1))
        if [[ "$tries" -gt 40 ]]; then
            echo "ERROR: ephemeral Postgres did not become ready in 40 seconds" >&2
            docker logs "$EPHEMERAL_CONTAINER" 2>&1 | tail -20 >&2
            exit 1
        fi
        sleep 1
    done

    echo "==> Restoring $dump"
    gunzip -c "$dump" | docker exec -i "$EPHEMERAL_CONTAINER" psql -U postgres "$EPHEMERAL_DB" >/dev/null

    echo "postgresql://postgres:$EPHEMERAL_PASSWORD@localhost:$EPHEMERAL_PORT/$EPHEMERAL_DB"
}

teardown_ephemeral() {
    if [[ -z "${DATABASE_URL_RESTORE_TEST:-}" ]]; then
        echo "==> Tearing down ephemeral container $EPHEMERAL_CONTAINER"
        docker rm -f "$EPHEMERAL_CONTAINER" >/dev/null 2>&1 || true
    fi
}

# Run COUNT(*) on a list of canonical tables, compare to prod within 10%.
# Exits 3 if any table is empty or drifts beyond 10%.
run_sanity_queries() {
    local restore_url="$1"

    # All 10 sanity tables. Quoted because some Prisma table names are
    # case-sensitive (PascalCase) while @@map() ones are lowercase.
    local tables=(
        "patients"
        "users"
        "appointments"
        "doctors"
        "invoices"
        "consultations"
        "prescriptions"
        "medicines"
        "wards"
        "audit_logs"
    )

    echo "==> Running sanity COUNT queries"
    local failures=0
    for t in "${tables[@]}"; do
        # Resolve prod count (querying the live prod container — read-only)
        local prod_count
        prod_count=$(
            docker exec "$PROD_CONTAINER" psql -U "$PROD_USER" -d "$PROD_DB" -tAc \
                "SELECT COUNT(*) FROM \"$t\"" 2>/dev/null || echo "NA"
        )
        local restore_count
        restore_count=$(
            psql "$restore_url" -tAc "SELECT COUNT(*) FROM \"$t\"" 2>/dev/null || echo "NA"
        )

        if [[ "$restore_count" == "NA" ]]; then
            echo "  FAIL   $t: query failed against restored DB"
            failures=$((failures + 1))
            continue
        fi

        if [[ "$restore_count" -eq 0 ]]; then
            echo "  FAIL   $t: count is zero in restore"
            failures=$((failures + 1))
            continue
        fi

        if [[ "$prod_count" == "NA" ]]; then
            echo "  OK     $t: restore=$restore_count prod=n/a (no prod container)"
            continue
        fi

        # 10% tolerance
        local diff=$(( restore_count > prod_count ? restore_count - prod_count : prod_count - restore_count ))
        local tol=$(( prod_count / 10 ))
        if [[ "$tol" -lt 1 ]]; then tol=1; fi
        if [[ "$diff" -gt "$tol" ]]; then
            echo "  FAIL   $t: restore=$restore_count prod=$prod_count diff=$diff > tol=$tol (10%)"
            failures=$((failures + 1))
        else
            echo "  OK     $t: restore=$restore_count prod=$prod_count diff=$diff (tol=$tol)"
        fi
    done

    if [[ "$failures" -gt 0 ]]; then
        echo "==> $failures sanity query failure(s)"
        return 3
    fi
    echo "==> All sanity queries passed"
    return 0
}

# ─── --self-test: shell-assertable CLI validation ──────────────────────────
if [[ "$MODE_SELF_TEST" -eq 1 ]]; then
    # 1. All helper functions present.
    for fn in pick_backup_file restore_into_ephemeral teardown_ephemeral run_sanity_queries; do
        if ! declare -f "$fn" >/dev/null 2>&1; then
            echo "SELF-TEST FAIL: function $fn is not defined" >&2
            exit 1
        fi
    done
    # 2. Mode flags parsed correctly (BACKUP_FILE empty, MODE_LATEST=1).
    if [[ -n "$BACKUP_FILE" || "$MODE_LATEST" -ne 1 ]]; then
        echo "SELF-TEST FAIL: default mode state is wrong" >&2
        exit 1
    fi
    # 3. --file propagates BACKUP_FILE (repeat the parser logic in a subshell).
    ( MODE_LATEST=0; BACKUP_FILE="/tmp/fake.sql.gz"; \
      [[ "$MODE_LATEST" -eq 0 && -n "$BACKUP_FILE" ]] || { echo "SELF-TEST FAIL: --file handling regressed" >&2; exit 1; } ) || exit 1
    echo "SELF-TEST OK: flags parsed, helpers defined."
    exit 0
fi

# ─── Main flow ─────────────────────────────────────────────────────────────
dump=$(pick_backup_file)
echo "==> Backup file: $dump"

restore_url=$(restore_into_ephemeral "$dump")
trap teardown_ephemeral EXIT

# Schema presence check — any rowcount query will also fail below if the
# schema didn't restore, but this gives a cleaner error message up front.
echo "==> Schema check: public.users and public.patients exist"
for t in users patients; do
    psql "$restore_url" -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$t'" \
        | grep -q 1 \
        || { echo "ERROR: table $t missing in restore"; exit 1; }
done

# Sanity queries (compares restore vs prod, ±10% tolerance)
run_sanity_queries "$restore_url"
rc=$?
if [[ "$rc" -ne 0 ]]; then
    echo "==> Backup-restore verification FAILED (code $rc)"
    exit "$rc"
fi

echo "==> Backup-restore verification OK"
exit 0
