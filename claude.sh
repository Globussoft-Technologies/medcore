#!/usr/bin/env bash
# Quick "is Claude / the cloud actually working?" status check.
#
#   bash claude.sh           # one-shot snapshot
#   bash claude.sh --watch   # auto-refresh every 5s (Ctrl+C to exit)
#
# Six sections:
#   1. Live tail of the unified test runner's log (.test-local/run-full.out)
#   2. Per-job log mtimes (newest = the job currently writing)
#   3. Docker test container state (medcore-test-pg on :54322)
#   4. Local test-related processes (node / vitest / playwright / next / tsc)
#   5. Background bash processes (Claude's run_in_background tasks)
#   6. GitHub Actions runs in flight on this repo (the "cloud agents")
#
# What this CAN'T see:
#   - Claude Code subagents I spawn via the Agent tool: they run only
#     during my turn and disappear when they report back.
#   - Anthropic-side scheduled routines: visible only via the schedule
#     skill or the Anthropic console.

set -uo pipefail

cd "$(dirname "$0")"

snapshot() {
    clear 2>/dev/null || true
    echo "=== claude.sh @ $(date '+%H:%M:%S') ==="
    echo

    echo "--- 1. Live test runner output (last 25 lines) ---"
    if [ -f .test-local/run-full.out ]; then
        tail -n 25 .test-local/run-full.out
    else
        echo "(no .test-local/run-full.out - no test run in progress)"
    fi
    echo

    echo "--- 2. Per-job log mtimes (newest first) ---"
    if compgen -G ".test-local/*.log" >/dev/null 2>&1; then
        ls -lat .test-local/*.log 2>/dev/null | head -8
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

    echo "--- 4. Local test processes (node/vitest/playwright/next/tsc) ---"
    if command -v tasklist >/dev/null 2>&1; then
        tasklist 2>/dev/null \
            | grep -iE "node\.exe|vitest|playwright|next|tsc" \
            | head -6 \
            || echo "(no test processes)"
    else
        ps -ef 2>/dev/null \
            | grep -E "node|vitest|playwright|next|tsc" \
            | grep -v grep \
            | head -6 \
            || echo "(no test processes)"
    fi
    echo

    echo "--- 5. Background bash processes (Claude's run_in_background) ---"
    if command -v tasklist >/dev/null 2>&1; then
        tasklist 2>/dev/null \
            | grep -iE "bash\.exe" \
            | head -8 \
            || echo "(no bash processes)"
    else
        ps -ef 2>/dev/null \
            | grep -E "bash" \
            | grep -v grep \
            | head -8 \
            || echo "(no bash processes)"
    fi
    echo

    echo "--- 6. GitHub Actions in flight (cloud agents) ---"
    if command -v gh >/dev/null 2>&1; then
        gh run list --repo Globussoft-Technologies/medcore --limit 6 \
            --json status,conclusion,headSha,workflowName,createdAt \
            --jq '.[] | "\(.createdAt[11:16]) \(.status | (. + "        ")[0:11]) \(.conclusion // "..." | (. + "        ")[0:9]) \(.headSha[:8])  \(.workflowName)"' \
            2>/dev/null \
            || echo "(gh not authenticated or repo unreachable)"
    else
        echo "(gh CLI not on PATH)"
    fi
}

if [ "${1:-}" = "--watch" ] || [ "${1:-}" = "-w" ]; then
    while true; do
        snapshot
        echo
        echo "(refresh every 5s - Ctrl+C to exit)"
        sleep 5
    done
else
    snapshot
fi
