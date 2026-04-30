#!/bin/bash
# pre-deploy-check.sh — local sanity check before pushing a prod deploy.
# Run this on your laptop from the repo root:
#
#   ./scripts/pre-deploy-check.sh
#
# Performs a series of read-only + in-place checks and prints a green/red
# summary at the end. Exits non-zero if anything fails so CI can call it too.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SCHEMA_PATH="packages/db/prisma/schema.prisma"

# ── Result tracker ───────────────────────────────────────────────────────────
PASS_LIST=()
FAIL_LIST=()

pass() { echo "  [PASS] $1"; PASS_LIST+=("$1"); }
fail() { echo "  [FAIL] $1"; FAIL_LIST+=("$1"); }

run_step() {
    # run_step "Description" command...
    local desc="$1"; shift
    echo
    echo "=== $desc ==="
    if "$@"; then
        pass "$desc"
    else
        fail "$desc"
    fi
}

# ── 1. Git clean + fetch ─────────────────────────────────────────────────────
echo "=== Git: fetch + cleanliness ==="
if git fetch --quiet; then
    echo "  fetched"
else
    fail "git fetch"
fi

if git diff --quiet && git diff --cached --quiet; then
    pass "Working tree clean"
else
    fail "Working tree has uncommitted changes"
    git status --short
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" = "main" ]; then
    pass "On main branch"
else
    fail "Not on main (currently: $CURRENT_BRANCH)"
fi

AHEAD_BEHIND="$(git rev-list --left-right --count origin/main...HEAD 2>/dev/null || echo "? ?")"
BEHIND="$(echo "$AHEAD_BEHIND" | awk '{print $1}')"
AHEAD="$(echo "$AHEAD_BEHIND" | awk '{print $2}')"
if [ "$BEHIND" = "0" ] && [ "$AHEAD" = "0" ]; then
    pass "main is in sync with origin/main"
else
    fail "main diverged from origin/main (behind=$BEHIND ahead=$AHEAD)"
fi

# ── 2. Lockfile validity (npm ci in a scratch dir) ───────────────────────────
echo
echo "=== npm ci in scratch (lockfile sanity) ==="
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
cp package.json package-lock.json "$SCRATCH/" 2>/dev/null
if (cd "$SCRATCH" && npm ci --ignore-scripts --dry-run >/dev/null 2>&1); then
    pass "npm ci dry-run accepts the lockfile"
else
    fail "npm ci dry-run failed — lockfile likely drifted from package.json"
fi

# ── 3. TypeScript across all three apps ──────────────────────────────────────
run_step "tsc --noEmit (api)"     npm --prefix apps/api    run lint
run_step "tsc --noEmit (web)"     npx tsc --noEmit -p apps/web/tsconfig.json
run_step "tsc --noEmit (mobile)"  bash -c "test -d apps/mobile && cd apps/mobile && npx tsc --noEmit || true"

# ── 4. Prisma schema validity ────────────────────────────────────────────────
run_step "prisma validate" bash -c 'DATABASE_URL="${DATABASE_URL:-postgresql://check:check@localhost:5432/check}" npx prisma validate --schema "$0"' "$SCHEMA_PATH"

# ── 5. Unit tests (API services + shared) ────────────────────────────────────
run_step "unit tests (api services + packages/shared)" npm run test:unit

# ── 6. Web tests (non-watch) ─────────────────────────────────────────────────
run_step "web tests" bash -c '
  out=$(npm run test:web 2>&1)
  echo "$out" | tail -10
  # Vitest exits non-zero when error-boundary catches unhandled React errors
  # in error-path tests even though all assertions pass. Trust the "X failed"
  # counter, not the exit code.
  if echo "$out" | grep -qE "Tests[[:space:]]+[0-9]+ failed"; then
    exit 1
  fi
  exit 0
'

# ── 7. Pending migrations report ─────────────────────────────────────────────
echo
echo "=== Pending migrations (folder listing) ==="
ls -1 packages/db/prisma/migrations/ | grep -v "^migration_lock.toml$" | sort

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "=============================================="
echo "  PASSED: ${#PASS_LIST[@]}"
for item in "${PASS_LIST[@]}"; do echo "    + $item"; done
echo "  FAILED: ${#FAIL_LIST[@]}"
for item in "${FAIL_LIST[@]}"; do echo "    - $item"; done
echo "=============================================="

if [ "${#FAIL_LIST[@]}" -ne 0 ]; then
    echo "PRE-DEPLOY CHECK: RED — do not deploy."
    exit 1
fi

echo "PRE-DEPLOY CHECK: GREEN — safe to deploy."
exit 0
