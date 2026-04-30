#!/usr/bin/env bash
# Shell-assertable tests for scripts/verify-backup-restore.sh.
#
# Runs the target script in --self-test mode and verifies its CLI behaviour
# (flag parsing, helper-function presence, usage exit codes). Does NOT touch
# docker or psql. Safe to run in CI on any box that has bash.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/verify-backup-restore.sh"

if [[ ! -x "$TARGET" && ! -r "$TARGET" ]]; then
    echo "FATAL: $TARGET not found / not readable" >&2
    exit 1
fi

fails=0

# Test 1: --self-test exits 0 with a recognisable success banner.
out=$(bash "$TARGET" --self-test 2>&1) || {
    echo "FAIL test 1: --self-test exit $? (expected 0)"
    fails=$((fails + 1))
}
if ! echo "$out" | grep -q "SELF-TEST OK"; then
    echo "FAIL test 1: success banner not found. Output: $out"
    fails=$((fails + 1))
else
    echo "PASS test 1: --self-test prints SELF-TEST OK"
fi

# Test 2: --help exits 0 and mentions the key flag names.
out=$(bash "$TARGET" --help 2>&1) || {
    echo "FAIL test 2: --help exit $? (expected 0)"
    fails=$((fails + 1))
}
if ! echo "$out" | grep -q -- "--self-test"; then
    echo "FAIL test 2: --help does not mention --self-test"
    fails=$((fails + 1))
fi
if ! echo "$out" | grep -q -- "--file"; then
    echo "FAIL test 2: --help does not mention --file"
    fails=$((fails + 1))
else
    echo "PASS test 2: --help lists --self-test and --file"
fi

# Test 3: unknown flag exits 2 (usage error).
set +e
bash "$TARGET" --not-a-real-flag >/dev/null 2>&1
rc=$?
set -e
if [[ "$rc" -ne 2 ]]; then
    echo "FAIL test 3: unknown flag should exit 2, got $rc"
    fails=$((fails + 1))
else
    echo "PASS test 3: unknown flag exits 2"
fi

if [[ "$fails" -gt 0 ]]; then
    echo "==> $fails assertion(s) failed"
    exit 1
fi

echo "==> all self-tests passed"
exit 0
