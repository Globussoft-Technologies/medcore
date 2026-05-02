#!/usr/bin/env bash
# Local Playwright runner that mirrors release.yml's e2e jobs.
#
# When to use this: iterating on e2e specs / page-level changes that need
# real browser validation. Targets the same Postgres + API + Web stack
# release.yml uses, just on alternative ports so it can coexist with your
# normal dev stack. Re-uses Playwright browsers if already installed
# (~2 min savings per run vs CI).
#
# When NOT to use this: visual-baseline updates (those generate
# Linux-specific PNGs that need to land via the
# `update-visual-baselines.yml` workflow). API-only changes (just run
# `npm run test:api` directly).
#
# Usage:
#   scripts/run-e2e-locally.sh                          # full Chromium suite
#   scripts/run-e2e-locally.sh e2e/ambulance.spec.ts    # single spec
#   scripts/run-e2e-locally.sh e2e/ambulance.spec.ts:191
#   scripts/run-e2e-locally.sh --webkit                 # full-webkit project
#   scripts/run-e2e-locally.sh --both                   # chromium then webkit
#   scripts/run-e2e-locally.sh --smoke                  # smoke project only
#   scripts/run-e2e-locally.sh --keep-db <spec>         # skip reset+seed
#   scripts/run-e2e-locally.sh <spec> -- --headed --debug
#
# Ports (all alternates so the dev stack can coexist):
#   Postgres  54322  (dev box typically uses 5432 or 5433)
#   API       4001   (dev typically 4000)
#   Web       3001   (dev typically 3000)

set -euo pipefail

# ----- defaults --------------------------------------------------------------

PG_CONTAINER="medcore-e2e-pg"
PG_PORT=54322
API_PORT=4001
WEB_PORT=3001
PG_USER="medcore"
PG_PASS="medcore"
PG_DB="medcore_e2e"

PROJECT="full"
RUN_WEBKIT=0
RUN_BOTH=0
RUN_SMOKE=0
KEEP_DB=0
PASSTHROUGH_ARGS=()
PLAYWRIGHT_FLAGS=()

# ----- argument parsing ------------------------------------------------------

# Anything before `--` is either a recognized flag or a Playwright positional
# (e.g. a spec path). Anything after `--` is forwarded verbatim to
# `playwright test`.
SEEN_DD=0
for arg in "$@"; do
    if [ "$SEEN_DD" -eq 1 ]; then
        PLAYWRIGHT_FLAGS+=("$arg")
        continue
    fi
    case "$arg" in
        --)         SEEN_DD=1 ;;
        --webkit)   RUN_WEBKIT=1 ;;
        --both)     RUN_BOTH=1 ;;
        --smoke)    RUN_SMOKE=1 ;;
        --keep-db)  KEEP_DB=1 ;;
        -h|--help)
            sed -n '2,28p' "$0"
            exit 0
            ;;
        --*)
            echo "unknown flag: $arg" >&2
            echo "use -h for help" >&2
            exit 2
            ;;
        *)          PASSTHROUGH_ARGS+=("$arg") ;;
    esac
done

if [ "$RUN_BOTH" -eq 1 ] && [ "$RUN_WEBKIT" -eq 1 ]; then
    echo "warn: --both implies webkit; ignoring --webkit" >&2
fi
if [ "$RUN_SMOKE" -eq 1 ] && { [ "$RUN_WEBKIT" -eq 1 ] || [ "$RUN_BOTH" -eq 1 ]; }; then
    echo "error: --smoke is mutually exclusive with --webkit/--both" >&2
    exit 2
fi

# ----- repo root + log dir ---------------------------------------------------

# Resolve repo root from the script's own location so the script works
# regardless of the caller's $PWD.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="$REPO_ROOT/.e2e-local"
mkdir -p "$LOG_DIR"
API_LOG="$LOG_DIR/api.log"
WEB_LOG="$LOG_DIR/web.log"
API_PID_FILE="$LOG_DIR/api.pid"
WEB_PID_FILE="$LOG_DIR/web.pid"

# ----- cleanup trap ----------------------------------------------------------

# Trap covers EXIT (normal exit + non-zero from set -e), INT (Ctrl-C), TERM.
# We always kill API + Web; we only kill Postgres if --keep-db was NOT passed.
cleanup() {
    local exit_code=$?
    set +e
    echo ""
    echo "=== cleanup ==="
    if [ -f "$API_PID_FILE" ]; then
        local apid
        apid="$(cat "$API_PID_FILE" 2>/dev/null || echo)"
        if [ -n "${apid:-}" ] && kill -0 "$apid" 2>/dev/null; then
            echo "  killing API pid $apid"
            kill "$apid" 2>/dev/null || true
            # On Git Bash the npm wrapper spawns a node child; sweep by port.
        fi
        rm -f "$API_PID_FILE"
    fi
    if [ -f "$WEB_PID_FILE" ]; then
        local wpid
        wpid="$(cat "$WEB_PID_FILE" 2>/dev/null || echo)"
        if [ -n "${wpid:-}" ] && kill -0 "$wpid" 2>/dev/null; then
            echo "  killing Web pid $wpid"
            kill "$wpid" 2>/dev/null || true
        fi
        rm -f "$WEB_PID_FILE"
    fi
    # Sweep any straggler children listening on our ports. Best-effort only;
    # `lsof` is missing on stock Git Bash, so wrap in `command -v`.
    if command -v lsof >/dev/null 2>&1; then
        for p in "$API_PORT" "$WEB_PORT"; do
            local pids
            pids="$(lsof -ti tcp:"$p" 2>/dev/null || true)"
            if [ -n "$pids" ]; then
                echo "  sweeping pids on :$p — $pids"
                # shellcheck disable=SC2086
                kill $pids 2>/dev/null || true
            fi
        done
    fi
    if [ "$KEEP_DB" -ne 1 ]; then
        if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
            echo "  stopping Postgres container ($PG_CONTAINER)"
            docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
        fi
    else
        echo "  --keep-db set; leaving $PG_CONTAINER running"
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ----- preflight: ports + docker --------------------------------------------

require_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "error: docker not found on PATH" >&2
        echo "  install Docker Desktop or set up the host Postgres on :$PG_PORT manually" >&2
        exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
        echo "error: docker daemon is not reachable" >&2
        echo "  start Docker Desktop / dockerd, then retry" >&2
        exit 1
    fi
}

port_in_use() {
    local p="$1"
    # Git Bash usually ships netstat; macOS/Linux usually ship lsof. Try both.
    if command -v lsof >/dev/null 2>&1; then
        lsof -iTCP:"$p" -sTCP:LISTEN -t >/dev/null 2>&1 && return 0
    fi
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$" && return 0
    fi
    if command -v netstat >/dev/null 2>&1; then
        netstat -an 2>/dev/null | grep -E "[:.]$p[[:space:]].*LISTEN" >/dev/null && return 0
    fi
    return 1
}

ensure_port_free() {
    local p="$1" name="$2"
    if port_in_use "$p"; then
        # If it's our own DB container from a previous --keep-db run, that's
        # fine — only the API/Web ports need to be exclusive.
        if [ "$p" = "$PG_PORT" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
            return 0
        fi
        echo "error: port $p ($name) is already in use" >&2
        echo "  stop whatever is bound to :$p, or edit this script to pick another port" >&2
        exit 1
    fi
}

# ----- env block (same as release.yml, retargeted at our alt ports) ---------

DB_URL="postgresql://${PG_USER}:${PG_PASS}@localhost:${PG_PORT}/${PG_DB}"

export DATABASE_URL="$DB_URL"
export JWT_SECRET="local-jwt-secret"
export JWT_REFRESH_SECRET="local-jwt-refresh-secret"
export NODE_ENV="production"
export DISABLE_RATE_LIMITS="true"
export NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}/api/v1"
export E2E_BASE_URL="http://localhost:${WEB_PORT}"
export E2E_API_URL="http://localhost:${API_PORT}/api/v1"

# ----- step 1: postgres ------------------------------------------------------

start_postgres() {
    require_docker
    if [ "$KEEP_DB" -eq 1 ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
        echo "=== postgres ($PG_CONTAINER) — reusing existing container ==="
        return 0
    fi
    # Wipe any stale container of the same name (e.g. from a crashed prior run).
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
        docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
    fi
    echo "=== postgres ($PG_CONTAINER on :$PG_PORT) ==="
    docker run -d --rm \
        --name "$PG_CONTAINER" \
        -e POSTGRES_USER="$PG_USER" \
        -e POSTGRES_PASSWORD="$PG_PASS" \
        -e POSTGRES_DB="$PG_DB" \
        -p "${PG_PORT}:5432" \
        postgres:16 >/dev/null
    # Wait for ready. pg_isready inside the container is portable across
    # Docker Desktop on Win/Mac and native dockerd on Linux.
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

# ----- step 2: deps + browsers ----------------------------------------------

ensure_deps() {
    if [ ! -d node_modules ] || [ ! -d node_modules/@playwright/test ]; then
        echo "=== installing deps (npm install --include=dev) ==="
        npm install --include=dev
    else
        echo "=== deps present (skipping npm install) ==="
    fi
}

# Detect a usable Playwright browser cache. This is the single biggest CI
# saver: `playwright install --with-deps` is ~90s in CI but free locally
# once the cache is populated.
playwright_cache_dir() {
    if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
        echo "$PLAYWRIGHT_BROWSERS_PATH"
        return
    fi
    case "$(uname -s 2>/dev/null || echo)" in
        Darwin)            echo "$HOME/Library/Caches/ms-playwright" ;;
        Linux)             echo "$HOME/.cache/ms-playwright" ;;
        MINGW*|MSYS*|CYGWIN*|*NT*)
            # Git Bash: $LOCALAPPDATA is normally set; fall back to APPDATA.
            local base="${LOCALAPPDATA:-${APPDATA:-$HOME/AppData/Local}}"
            echo "$base/ms-playwright"
            ;;
        *)                 echo "$HOME/.cache/ms-playwright" ;;
    esac
}

ensure_browser() {
    local browser="$1"
    local cache
    cache="$(playwright_cache_dir)"
    # Check by directory prefix; Playwright versions browsers like
    # `chromium-1112`, `webkit-1908`. If any matching dir exists, trust it.
    if [ -d "$cache" ] && ls -1 "$cache" 2>/dev/null | grep -q "^${browser}-"; then
        echo "  $browser cache present in $cache (skipping install)"
        return 0
    fi
    echo "=== installing playwright browser: $browser ==="
    # `--with-deps` needs sudo on Linux; on macOS / Git Bash it's a no-op
    # for native libs. Fall back to plain `install` if the deps step fails
    # (typical on a dev laptop without sudo).
    npx playwright install --with-deps "$browser" || npx playwright install "$browser"
}

# ----- step 3: schema + seed -------------------------------------------------

prepare_db() {
    echo "=== prisma generate ==="
    npm run db:generate
    if [ "$KEEP_DB" -eq 1 ]; then
        echo "=== --keep-db: skipping db push + seed ==="
        return
    fi
    echo "=== prisma db push (force-reset) ==="
    npx prisma db push --schema packages/db/prisma/schema.prisma --force-reset --skip-generate
    echo "=== seed ==="
    npm run db:seed
}

# ----- step 4: build web -----------------------------------------------------

build_web() {
    echo "=== next build (apps/web) ==="
    npm --prefix apps/web run build
}

# ----- step 5: start servers -------------------------------------------------

start_api() {
    echo "=== starting API on :$API_PORT ==="
    # `setsid` is unavailable on Git Bash; run plain `&` and capture the PID.
    # `nohup` keeps the child alive if the parent shell loses its tty (rare
    # locally but harmless).
    (
        cd apps/api
        PORT="$API_PORT" nohup npm run dev > "$API_LOG" 2>&1 &
        echo $! > "$API_PID_FILE"
    )
}

start_web() {
    echo "=== starting Web on :$WEB_PORT ==="
    (
        cd apps/web
        PORT="$WEB_PORT" nohup npm start > "$WEB_LOG" 2>&1 &
        echo $! > "$WEB_PID_FILE"
    )
}

wait_for_servers() {
    echo "=== waiting for API + Web (timeout 90s) ==="
    npx wait-on \
        "http://localhost:${API_PORT}/api/health" \
        "http://localhost:${WEB_PORT}/login" \
        --timeout 90000 || {
        echo "error: servers did not come up within 90s" >&2
        echo "--- last 40 lines of api.log ---" >&2
        tail -n 40 "$API_LOG" >&2 || true
        echo "--- last 40 lines of web.log ---" >&2
        tail -n 40 "$WEB_LOG" >&2 || true
        exit 1
    }
    echo "  ready: api=http://localhost:${API_PORT} web=http://localhost:${WEB_PORT}"
}

# ----- step 6: run playwright -----------------------------------------------

run_playwright() {
    local proj="$1"
    echo "=== playwright test --project=$proj ==="
    # Note the deliberate `+ "${ARR[@]+...}"` idiom: under `set -u` an empty
    # bash array dereference would otherwise abort. Git Bash 4.x respects this.
    set -x
    npx playwright test \
        --project="$proj" \
        ${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"} \
        ${PLAYWRIGHT_FLAGS[@]+"${PLAYWRIGHT_FLAGS[@]}"}
    set +x
}

# ----- main ------------------------------------------------------------------

# Pick project(s) to run.
if [ "$RUN_SMOKE" -eq 1 ]; then
    PROJECTS=("smoke")
elif [ "$RUN_BOTH" -eq 1 ]; then
    PROJECTS=("full" "full-webkit")
elif [ "$RUN_WEBKIT" -eq 1 ]; then
    PROJECTS=("full-webkit")
else
    PROJECTS=("$PROJECT")
fi

ensure_port_free "$PG_PORT" "Postgres"
ensure_port_free "$API_PORT" "API"
ensure_port_free "$WEB_PORT" "Web"

start_postgres
ensure_deps

# Install only the browsers we need for the chosen projects.
NEEDS_CHROMIUM=0
NEEDS_WEBKIT=0
for p in "${PROJECTS[@]}"; do
    case "$p" in
        full-webkit) NEEDS_WEBKIT=1 ;;
        *)           NEEDS_CHROMIUM=1 ;;
    esac
done
[ "$NEEDS_CHROMIUM" -eq 1 ] && ensure_browser chromium
[ "$NEEDS_WEBKIT" -eq 1 ] && ensure_browser webkit

prepare_db
build_web
start_api
start_web
wait_for_servers

# Run each project serially. We do NOT short-circuit on a project failure —
# the `--both` user typically wants to see both Chromium AND WebKit results
# in one pass, so we record the first non-zero exit and surface it at the end.
FIRST_RC=0
for p in "${PROJECTS[@]}"; do
    if ! run_playwright "$p"; then
        rc=$?
        echo "  project $p exited $rc" >&2
        if [ "$FIRST_RC" -eq 0 ]; then
            FIRST_RC=$rc
        fi
    fi
done

if [ "$FIRST_RC" -ne 0 ]; then
    echo ""
    echo "=== FAILED (rc=$FIRST_RC) — see playwright-report/index.html ==="
    exit "$FIRST_RC"
fi

echo ""
echo "=== all green — projects: ${PROJECTS[*]} ==="
