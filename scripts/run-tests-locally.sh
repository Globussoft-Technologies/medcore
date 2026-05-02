#!/usr/bin/env bash
# Local CI-mirror test runner.
#
# Runs every gating job from .github/workflows/test.yml against your working
# tree so you can validate before pushing. NOT a pre-commit hook — opt-in.
#
# Tiers:
#   --quick / -q   typecheck + lint + npm-audit + migration-safety + web-bundle
#                  (~3-5 min, no DB)
#   default        --quick + web-tests + api-tests
#                  (~7-10 min, one-shot Postgres on :54322)
#   --with-e2e     default + scripts/run-e2e-locally.sh (Chromium full)
#                  (~15-20 min)
#   --with-e2e=both same but Chromium + WebKit (mirrors release.yml)
#                  (~25 min)
#
# Other flags:
#   --keep-db      keep the api-tests Postgres container around between runs
#                  (also forwarded to the e2e runner if --with-e2e)
#   --skip-audit   skip npm audit (useful offline; audit hits the registry)
#   --skip-build   skip web-bundle (and the build it depends on)
#   --bail         stop on first failure (default: run everything, summarize)
#   -h | --help    print this header
#
# Ports (alt ports so the dev stack can coexist):
#   Postgres  54322  (shared with run-e2e-locally.sh; same container)
#
# See docs/LOCAL_TESTING.md for the workflow guide and tier table.

set -uo pipefail

# ----- defaults --------------------------------------------------------------

# Container + port match run-e2e-locally.sh deliberately so `--with-e2e`
# can hand the running Postgres off to the e2e runner without restart.
PG_CONTAINER="medcore-test-pg"
PG_PORT=54322
PG_USER="medcore"
PG_PASS="medcore"
PG_DB="medcore_test"

TIER_QUICK=0
WITH_E2E=""           # "" | "chromium" | "both"
KEEP_DB=0
SKIP_AUDIT=0
SKIP_BUILD=0
BAIL=0

# ----- argument parsing ------------------------------------------------------

print_help() {
    sed -n '2,29p' "$0"
}

for arg in "$@"; do
    case "$arg" in
        -q|--quick)         TIER_QUICK=1 ;;
        --with-e2e)         WITH_E2E="chromium" ;;
        --with-e2e=both)    WITH_E2E="both" ;;
        --with-e2e=*)
            echo "error: unknown --with-e2e value: ${arg#--with-e2e=}" >&2
            echo "  valid: --with-e2e (chromium) | --with-e2e=both" >&2
            exit 2
            ;;
        --keep-db)          KEEP_DB=1 ;;
        --skip-audit)       SKIP_AUDIT=1 ;;
        --skip-build)       SKIP_BUILD=1 ;;
        --bail)             BAIL=1 ;;
        -h|--help)          print_help; exit 0 ;;
        *)
            echo "unknown flag: $arg" >&2
            echo "use -h for help" >&2
            exit 2
            ;;
    esac
done

# ----- repo root + log dir ---------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="$REPO_ROOT/.test-local"
mkdir -p "$LOG_DIR"

# Per-job log files. Listed in display order so the summary loop can iterate.
JOB_NAMES="typecheck lint npm-audit migration-safety web-bundle web-tests api-tests e2e"
declare -A JOB_STATUS    # PASS | FAIL | SKIP | "-"
declare -A JOB_DURATION  # human-readable
declare -A JOB_LOG

for j in $JOB_NAMES; do
    JOB_STATUS[$j]="-"
    JOB_DURATION[$j]="-"
    JOB_LOG[$j]="$LOG_DIR/$j.log"
done

# ----- cleanup trap ----------------------------------------------------------

PG_STARTED=0   # set to 1 after we successfully started the container

cleanup() {
    local exit_code=$?
    set +e
    if [ "$PG_STARTED" -eq 1 ] && [ "$KEEP_DB" -ne 1 ]; then
        if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
            echo ""
            echo "=== cleanup: stopping Postgres ($PG_CONTAINER) ==="
            docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
        fi
    elif [ "$PG_STARTED" -eq 1 ] && [ "$KEEP_DB" -eq 1 ]; then
        echo ""
        echo "=== --keep-db: leaving $PG_CONTAINER running on :$PG_PORT ==="
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ----- helpers ---------------------------------------------------------------

# Pretty-print a duration in seconds as "Ns" or "Nm Ms".
fmt_duration() {
    local s="$1"
    if [ "$s" -lt 60 ]; then
        echo "${s}s"
    else
        local m=$((s / 60))
        local r=$((s % 60))
        echo "${m}m ${r}s"
    fi
}

# run_job <name> <log-file> -- <command...>
# Captures stdout+stderr to the log file, records pass/fail + duration in
# JOB_STATUS / JOB_DURATION. Honors --bail.
run_job() {
    local name="$1" logf="$2"
    shift 2
    if [ "$1" = "--" ]; then shift; fi

    echo ""
    echo "=== $name ==="
    echo "  log: $logf"
    local start end rc
    start=$(date +%s)

    # Run the job, streaming to file AND to stdout (tee). Use a subshell so
    # `set -e` in the inner command doesn't kill the outer script.
    (
        # Force unbuffered output where possible so the log captures live.
        "$@"
    ) >"$logf" 2>&1
    rc=$?

    end=$(date +%s)
    JOB_DURATION[$name]="$(fmt_duration $((end - start)))"

    if [ "$rc" -eq 0 ]; then
        JOB_STATUS[$name]="PASS"
        echo "  ${name}: PASS (${JOB_DURATION[$name]})"
    else
        JOB_STATUS[$name]="FAIL"
        echo "  ${name}: FAIL rc=$rc (${JOB_DURATION[$name]}) — see $logf"
        # Tail a few lines so the user sees the failure mode without
        # opening the log.
        echo "  --- last 20 lines ---"
        tail -n 20 "$logf" 2>/dev/null | sed 's/^/  /' || true
        echo "  --- end ---"
        if [ "$BAIL" -eq 1 ]; then
            echo "  --bail: stopping on first failure" >&2
            print_summary
            exit 1
        fi
    fi
    return 0
}

# ----- job bodies ------------------------------------------------------------

job_db_generate() {
    # Prereq for typecheck / lint / web-bundle. Run once up front.
    npm run db:generate
}

job_typecheck() {
    set -e
    npx tsc --noEmit -p apps/api/tsconfig.json
    npx tsc --noEmit -p apps/web/tsconfig.json
}

job_lint() {
    set -e
    npm --prefix apps/web run lint
}

job_npm_audit() {
    set -e
    # Mirrors test.yml: scope to apps/api + apps/web, omit dev, fail on high+.
    npm audit --workspace=apps/api --workspace=apps/web \
        --audit-level=high --omit=dev
}

job_migration_safety() {
    # Mirror the workflow's logic but diff against origin/main since the
    # GHA `before` SHA isn't meaningful locally. We auto-fetch so the
    # comparison is against an up-to-date origin/main.
    set -e
    if ! git rev-parse --verify origin/main >/dev/null 2>&1; then
        echo "fetching origin/main for diff base..."
        git fetch origin main --quiet || {
            echo "warning: could not fetch origin/main; falling back to repo's first commit"
        }
    else
        # Best-effort refresh; tolerate offline.
        git fetch origin main --quiet 2>/dev/null || true
    fi

    local BASE
    if git rev-parse --verify origin/main >/dev/null 2>&1; then
        BASE="origin/main"
    else
        BASE="$(git rev-list --max-parents=0 HEAD | tail -1)"
    fi
    local HEAD_SHA
    HEAD_SHA="$(git rev-parse HEAD)"
    echo "Diffing $BASE..$HEAD_SHA for migration changes"

    local CHANGED
    CHANGED="$(git diff --name-only --diff-filter=AM "$BASE..$HEAD_SHA" -- 'packages/db/prisma/migrations/**/migration.sql' || true)"
    if [ -z "$CHANGED" ]; then
        echo "No migration changes since $BASE — pass."
        return 0
    fi

    echo "Migration files added/modified:"
    echo "$CHANGED"
    echo

    local DESTRUCTIVE=0
    local DESTRUCTIVE_LOG=""
    local PATTERNS='DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|ALTER\s+TABLE\s+\S+\s+ALTER\s+COLUMN\s+\S+\s+TYPE|DROP\s+INDEX'
    local f
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        if [ -f "$f" ] && grep -iEn "$PATTERNS" "$f" >/dev/null; then
            DESTRUCTIVE=1
            DESTRUCTIVE_LOG="${DESTRUCTIVE_LOG}
--- $f ---
$(grep -iEn "$PATTERNS" "$f")"
        fi
    done <<EOF
$CHANGED
EOF

    if [ "$DESTRUCTIVE" -eq 0 ]; then
        echo "Migration changes are additive — pass."
        return 0
    fi

    echo "Destructive ops found:"
    printf "%s\n" "$DESTRUCTIVE_LOG"
    echo

    local MSGS
    MSGS="$(git log --format=%B "$BASE..$HEAD_SHA")"
    if echo "$MSGS" | grep -qF '[allow-destructive-migration]'; then
        echo "Destructive migration explicitly allowed via commit message marker — pass."
        return 0
    fi

    echo "FAIL: destructive migration without [allow-destructive-migration] marker."
    echo "Add the marker to a commit message in this push (any line) if intentional."
    return 1
}

job_web_bundle() {
    set -e
    npm --prefix apps/web run build
    local CHUNKS_DIR="apps/web/.next/static/chunks"
    if [ ! -d "$CHUNKS_DIR" ]; then
        echo "FAIL: $CHUNKS_DIR missing — next build did not produce static chunks."
        return 1
    fi
    # Use du -sk for portability (Git Bash's du has no -b).
    local KB
    KB=$(du -sk "$CHUNKS_DIR" | awk '{print $1}')
    local MB
    MB=$(awk -v k="$KB" 'BEGIN { printf "%.2f", k/1024 }')
    echo "Static chunks: ${MB} MB"
    echo
    echo "Top 10 chunks by size:"
    du -k "$CHUNKS_DIR"/*.js 2>/dev/null | sort -nr | head -10 | \
        awk '{printf "  %.2f MB  %s\n", $1/1024, $2}' || true
    echo
    local BUDGET_MB=7
    if awk -v m="$MB" -v b="$BUDGET_MB" 'BEGIN { exit !(m > b) }'; then
        echo "FAIL: bundle exceeded ${BUDGET_MB} MB budget (${MB} MB)."
        return 1
    fi
    echo "Bundle ${MB} MB is under the ${BUDGET_MB} MB tripwire."
}

job_web_tests() {
    set -e
    npm run test:coverage:web
}

# api-tests body. Assumes Postgres is up on $PG_PORT and DATABASE_URL is set.
job_api_tests() {
    set -e
    echo "--- prisma db push (force-reset) ---"
    npx prisma db push --schema packages/db/prisma/schema.prisma --force-reset --skip-generate
    echo
    echo "--- unit + contract (with coverage) ---"
    npm run test:coverage:unit
    echo
    echo "--- smoke ---"
    npm run test:smoke
    echo
    echo "--- integration ---"
    npm run test:api
}

job_e2e() {
    local args=()
    if [ "$WITH_E2E" = "both" ]; then
        args+=("--both")
    fi
    if [ "$KEEP_DB" -eq 1 ]; then
        args+=("--keep-db")
    fi
    bash "$REPO_ROOT/scripts/run-e2e-locally.sh" ${args[@]+"${args[@]}"}
}

# ----- postgres lifecycle ----------------------------------------------------

require_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "error: docker not found on PATH" >&2
        exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
        echo "error: docker daemon is not reachable" >&2
        exit 1
    fi
}

start_postgres() {
    require_docker
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
        echo "=== postgres: reusing existing $PG_CONTAINER on :$PG_PORT ==="
        PG_STARTED=1
        return 0
    fi
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
        docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
    fi
    echo "=== postgres: starting $PG_CONTAINER on :$PG_PORT ==="
    docker run -d --rm \
        --name "$PG_CONTAINER" \
        -e POSTGRES_USER="$PG_USER" \
        -e POSTGRES_PASSWORD="$PG_PASS" \
        -e POSTGRES_DB="$PG_DB" \
        -p "${PG_PORT}:5432" \
        postgres:16 >/dev/null
    PG_STARTED=1

    local i=0
    while ! docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; do
        i=$((i + 1))
        if [ "$i" -gt 30 ]; then
            echo "error: postgres did not become ready within 30s" >&2
            docker logs "$PG_CONTAINER" 2>&1 | tail -n 20 >&2 || true
            exit 1
        fi
        sleep 1
    done
    echo "  postgres ready"
}

# ----- summary table ---------------------------------------------------------

print_summary() {
    echo ""
    echo "+------------------+------+----------+"
    echo "| Job              | Pass | Duration |"
    echo "+------------------+------+----------+"
    local j s mark
    for j in $JOB_NAMES; do
        s="${JOB_STATUS[$j]}"
        case "$s" in
            PASS) mark="P " ;;
            FAIL) mark="F " ;;
            SKIP) mark="- " ;;
            *)    mark="- " ;;
        esac
        printf "| %-16s |  %s  | %-8s |\n" "$j" "$mark" "${JOB_DURATION[$j]}"
    done
    echo "+------------------+------+----------+"
    echo ""

    local failed=""
    for j in $JOB_NAMES; do
        if [ "${JOB_STATUS[$j]}" = "FAIL" ]; then
            failed="${failed} ${j}"
        fi
    done
    if [ -n "$failed" ]; then
        echo "FAILED:${failed}"
        echo "Logs in: $LOG_DIR/"
        return 1
    fi
    echo "All jobs passed."
    return 0
}

# ----- main ------------------------------------------------------------------

# Dirty tree warning (non-blocking).
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
    echo "warn: working tree has uncommitted changes; results reflect those."
fi

# E2E sanity-check the underlying script exists.
if [ -n "$WITH_E2E" ] && [ ! -f "$REPO_ROOT/scripts/run-e2e-locally.sh" ]; then
    echo "error: --with-e2e requested but scripts/run-e2e-locally.sh is missing" >&2
    exit 1
fi

# Phase 1: prisma generate (prereq for typecheck/lint/web-bundle).
echo "=== prisma generate (prereq) ==="
if ! job_db_generate >"$LOG_DIR/db-generate.log" 2>&1; then
    echo "error: npm run db:generate failed — see $LOG_DIR/db-generate.log" >&2
    tail -n 20 "$LOG_DIR/db-generate.log" 2>/dev/null | sed 's/^/  /' || true
    exit 1
fi
echo "  ok"

# Phase 2: parallel — typecheck, lint, npm-audit, migration-safety.
# Each runs in a background subshell writing to its own log + an rc file.
# We do this inline rather than via run_job so we can wait on all of them
# at once, then post-process status + duration from the rc files.
echo ""
echo "=== Phase 2: typecheck + lint + npm-audit + migration-safety (parallel) ==="

phase2_start_job() {
    local name="$1"
    shift
    local logf="${JOB_LOG[$name]}"
    local rcf="$LOG_DIR/$name.rc"
    local startf="$LOG_DIR/$name.start"
    date +%s >"$startf"
    (
        "$@" >"$logf" 2>&1
        echo $? >"$rcf"
    ) &
}

phase2_finalize_job() {
    local name="$1"
    local rcf="$LOG_DIR/$name.rc"
    local startf="$LOG_DIR/$name.start"
    local logf="${JOB_LOG[$name]}"
    local rc=1
    if [ -f "$rcf" ]; then
        rc="$(cat "$rcf" 2>/dev/null || echo 1)"
    fi
    local now
    now=$(date +%s)
    local start
    start="$(cat "$startf" 2>/dev/null || echo "$now")"
    JOB_DURATION[$name]="$(fmt_duration $((now - start)))"
    if [ "$rc" -eq 0 ]; then
        JOB_STATUS[$name]="PASS"
        echo "  ${name}: PASS (${JOB_DURATION[$name]})"
    else
        JOB_STATUS[$name]="FAIL"
        echo "  ${name}: FAIL rc=$rc (${JOB_DURATION[$name]}) — see $logf"
        echo "  --- last 20 lines ---"
        tail -n 20 "$logf" 2>/dev/null | sed 's/^/  /' || true
        echo "  --- end ---"
    fi
}

phase2_start_job typecheck         job_typecheck
phase2_start_job lint              job_lint
if [ "$SKIP_AUDIT" -eq 1 ]; then
    JOB_STATUS[npm-audit]="SKIP"
    JOB_DURATION[npm-audit]="skipped"
else
    phase2_start_job npm-audit     job_npm_audit
fi
phase2_start_job migration-safety  job_migration_safety

wait

phase2_finalize_job typecheck
phase2_finalize_job lint
if [ "$SKIP_AUDIT" -ne 1 ]; then
    phase2_finalize_job npm-audit
fi
phase2_finalize_job migration-safety

if [ "$BAIL" -eq 1 ]; then
    for j in typecheck lint npm-audit migration-safety; do
        if [ "${JOB_STATUS[$j]}" = "FAIL" ]; then
            print_summary
            exit 1
        fi
    done
fi

# Phase 3: web-bundle (always, unless --skip-build), plus web-tests +
# api-tests in default tier. Run in parallel. api-tests needs Postgres,
# so we start it first.
#
# In --quick mode: only web-bundle runs (no DB).
# In default tier: all three run in parallel.

if [ "$SKIP_BUILD" -eq 1 ]; then
    JOB_STATUS[web-bundle]="SKIP"
    JOB_DURATION[web-bundle]="skipped"
fi

if [ "$TIER_QUICK" -eq 1 ]; then
    # --quick: only web-bundle (if not skipped). Foreground so output streams.
    if [ "$SKIP_BUILD" -ne 1 ]; then
        echo ""
        echo "=== Phase 3: web-bundle ==="
        run_job web-bundle "${JOB_LOG[web-bundle]}" -- job_web_bundle
    fi
    JOB_STATUS[web-tests]="SKIP"
    JOB_DURATION[web-tests]="skipped"
    JOB_STATUS[api-tests]="SKIP"
    JOB_DURATION[api-tests]="skipped"
else
    # Default tier: bundle + web-tests + api-tests in parallel.
    echo ""
    echo "=== Phase 3: web-bundle + web-tests + api-tests (parallel) ==="

    start_postgres
    DB_URL="postgresql://${PG_USER}:${PG_PASS}@localhost:${PG_PORT}/${PG_DB}"
    export DATABASE_URL="$DB_URL"
    export DATABASE_URL_TEST="$DB_URL"
    export JWT_SECRET="local-jwt-secret"
    export JWT_REFRESH_SECRET="local-jwt-refresh-secret"
    export NODE_ENV="test"

    if [ "$SKIP_BUILD" -ne 1 ]; then
        phase2_start_job web-bundle  job_web_bundle
    fi
    phase2_start_job web-tests       job_web_tests
    phase2_start_job api-tests       job_api_tests

    wait

    if [ "$SKIP_BUILD" -ne 1 ]; then
        phase2_finalize_job web-bundle
    fi
    phase2_finalize_job web-tests
    phase2_finalize_job api-tests

    if [ "$BAIL" -eq 1 ]; then
        for j in web-bundle web-tests api-tests; do
            if [ "${JOB_STATUS[$j]}" = "FAIL" ]; then
                print_summary
                exit 1
            fi
        done
    fi
fi

# Phase 4: optional e2e delegation.
if [ -n "$WITH_E2E" ]; then
    echo ""
    echo "=== Phase 4: e2e (delegating to scripts/run-e2e-locally.sh: $WITH_E2E) ==="
    run_job e2e "${JOB_LOG[e2e]}" -- job_e2e
fi

# ----- summary + exit --------------------------------------------------------

if print_summary; then
    exit 0
else
    exit 1
fi
