#!/usr/bin/env bash
# Quick "is Claude still working?" status check.
#
# Run this from any terminal (Git Bash on Windows, or POSIX) at the repo
# root any time you want to peek at what Claude is doing without touching
# its terminal. Read-only — never starts/kills processes.
#
#   bash claude.sh           # one-shot snapshot
#   bash claude.sh --watch   # auto-refresh every 5s (Ctrl+C to exit)
#
# What it shows:
#   1. Last 30 lines of the unified test runner's live log
#      (.test-local/run-full.out) — phase markers + PASS/FAIL per job.
#   2. Per-job log mtimes — the most-recently-modified file is the job
#      Claude is actively writing to. If mtimes stop advancing for >2 min,
#      something is genuinely stuck.
#   3. Docker test container state (medcore-test-pg on :54322).
#   4. Top node/vitest/playwright processes by CPU.

set -uo pipefail

cd "$(dirname "$0")"

snapshot() {
    clear 2>/dev/null || true
    echo "=== claude.sh @ $(date '+%H:%M:%S') ==="
    echo

    echo "--- 1. Live test runner output (last 30 lines) ---"
    if [ -f .test-local/run-full.out ]; then
        tail -n 30 .test-local/run-full.out
    else
        echo "(no .test-local/run-full.out — no test run in progress)"
    fi
    echo

    echo "--- 2. Per-job log mtimes (newest first) ---"
    if compgen -G ".test-local/*.log" >/dev/null 2>&1; then
        ls -lat .test-local/*.log 2>/dev/null | head -10
    else
        echo "(no per-job logs)"
    fi
    echo

    echo "--- 3. Docker test container ---"
    if command -v docker >/dev/null 2>&1; then
        docker ps --filter "name=medcore-test-pg" \
            --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null \
            || echo "(docker not running or unreachable)"
    else
        echo "(docker not on PATH)"
    fi
    echo

    echo "--- 4. Test-related processes ---"
    if command -v tasklist >/dev/null 2>&1; then
        # Windows
        tasklist 2>/dev/null \
            | grep -iE "node\.exe|vitest|playwright|next|tsc" \
            | head -8 \
            || echo "(no test processes)"
    else
        # POSIX
        ps -ef 2>/dev/null \
            | grep -E "node|vitest|playwright|next|tsc" \
            | grep -v grep \
            | head -8 \
            || echo "(no test processes)"
    fi
}

if [ "${1:-}" = "--watch" ] || [ "${1:-}" = "-w" ]; then
    while true; do
        snapshot
        echo
        echo "(refresh every 5s — Ctrl+C to exit)"
        sleep 5
    done
else
    snapshot
fi
