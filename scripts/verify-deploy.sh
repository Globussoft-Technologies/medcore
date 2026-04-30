#!/bin/bash
# verify-deploy.sh — post-deployment smoke test.
# Run immediately after scripts/deploy.sh. Exits non-zero on any failure so
# CI/automation can surface broken deploys.
#
# Checks performed:
#   1. /api/health returns 200 with {status: "ok"}
#   2. All 10 AI route mount points respond to OPTIONS without a 5xx
#      (a 500 means a router module failed to load; 401/404/204 are fine).
#   3. Postgres is reachable via psql.

set -u

API_BASE="${API_BASE:-http://localhost:4100}"
DB_URL="${DATABASE_URL:-postgresql://medcore:medcore_secure_2024@localhost:5433/medcore?schema=public}"

FAILURES=0
PASSES=0

pass() { echo "  [PASS] $1"; PASSES=$((PASSES + 1)); }
fail() { echo "  [FAIL] $1"; FAILURES=$((FAILURES + 1)); }

echo "=== 1. /api/health ==="
HEALTH_RESP=$(curl -sS -o /tmp/verify_health_body -w "%{http_code}" "${API_BASE}/api/health" || echo "000")
HEALTH_BODY=$(cat /tmp/verify_health_body 2>/dev/null || echo "")
if [ "$HEALTH_RESP" = "200" ] && echo "$HEALTH_BODY" | grep -q '"status":"ok"'; then
    pass "/api/health returned 200 with status:ok"
else
    fail "/api/health — HTTP $HEALTH_RESP, body: $HEALTH_BODY"
fi

echo
echo "=== 2. AI route modules loaded (OPTIONS, no 5xx) ==="
AI_ROUTES=(
    "/api/v1/ai/triage"
    "/api/v1/ai/scribe"
    "/api/v1/ai/transcribe"
    "/api/v1/ai/reports"
    "/api/v1/ai/predictions"
    "/api/v1/ai/letters"
    "/api/v1/ai/er-triage"
    "/api/v1/ai/pharmacy"
    "/api/v1/ai/adherence"
    "/api/v1/ai/knowledge"
)

for route in "${AI_ROUTES[@]}"; do
    CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X OPTIONS "${API_BASE}${route}" || echo "000")
    if [ "$CODE" = "000" ]; then
        fail "OPTIONS ${route} — connection failed"
    elif [ "$CODE" -ge 500 ] 2>/dev/null; then
        fail "OPTIONS ${route} — HTTP ${CODE} (module load failure suspected)"
    else
        pass "OPTIONS ${route} — HTTP ${CODE}"
    fi
done

echo
echo "=== 3. Database reachability ==="
if command -v psql >/dev/null 2>&1; then
    if psql "$DB_URL" -tAc 'SELECT 1' 2>/dev/null | grep -q '^1$'; then
        pass "psql SELECT 1 succeeded"
    else
        fail "psql SELECT 1 failed against \$DATABASE_URL"
    fi
else
    # Fallback: try docker exec into medcore-postgres
    if command -v docker >/dev/null 2>&1 && docker exec medcore-postgres pg_isready -U medcore >/dev/null 2>&1; then
        pass "pg_isready via docker exec medcore-postgres"
    else
        fail "psql not installed and docker fallback unavailable"
    fi
fi

echo
echo "=== Summary ==="
echo "  Passed:   $PASSES"
echo "  Failed:   $FAILURES"

if [ "$FAILURES" -ne 0 ]; then
    echo "DEPLOY VERIFICATION FAILED"
    exit 1
fi

echo "DEPLOY VERIFICATION OK"
exit 0
