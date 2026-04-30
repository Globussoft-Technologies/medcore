#!/usr/bin/env bash
# Toggle the DISABLE_RATE_LIMITS env var on the prod medcore-api process.
#
# Usage:
#   scripts/toggle-rate-limits.sh on    # rate limiting DISABLED (DISABLE_RATE_LIMITS=true)
#   scripts/toggle-rate-limits.sh off   # rate limiting ENABLED  (var unset)
#
# Reads SERVER_USER / SERVER_PASSWORD / SERVER_IP from the repo-root .env.
# Prefers plink on Windows (Git-Bash/MSYS) and falls back to sshpass / ssh
# on POSIX hosts. After restarting medcore-api with --update-env it hammers
# /api/v1/auth/login 40 times and reports the 429 count so you can confirm
# the new state took effect.
#
# This change lives in pm2's runtime env only. It is NOT persisted into
# ecosystem.medcore.config.js on purpose — DISABLE_RATE_LIMITS is an ops
# escape hatch, not a configuration knob. See docs/DEPLOY.md section
# "Runtime rate-limit controls" for the manual recipe and rationale.

set -euo pipefail

if [[ "${1:-}" != "on" && "${1:-}" != "off" ]]; then
    echo "Usage: $0 on|off" >&2
    echo "  on  = disable rate limiting (DISABLE_RATE_LIMITS=true)" >&2
    echo "  off = enable  rate limiting (variable unset)" >&2
    exit 2
fi
MODE="$1"

# ---------- locate repo root + load creds -------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: expected $ENV_FILE with SERVER_USER / SERVER_PASSWORD / SERVER_IP" >&2
    exit 1
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

: "${SERVER_USER:?SERVER_USER missing from .env}"
: "${SERVER_PASSWORD:?SERVER_PASSWORD missing from .env}"
: "${SERVER_IP:?SERVER_IP missing from .env}"

# ---------- pick an SSH transport --------------------------------------
SSH_CMD=""
if command -v plink >/dev/null 2>&1; then
    # plink: -batch so it never prompts, caller must have host key cached OR pass -hostkey.
    SSH_CMD="plink -batch -ssh -pw $SERVER_PASSWORD $SERVER_USER@$SERVER_IP"
elif command -v sshpass >/dev/null 2>&1; then
    SSH_CMD="sshpass -p $SERVER_PASSWORD ssh -o StrictHostKeyChecking=accept-new $SERVER_USER@$SERVER_IP"
else
    echo "ERROR: need either plink (PuTTY) or sshpass to authenticate non-interactively." >&2
    echo "  Install one of them or run the pm2 command manually (see docs/DEPLOY.md)." >&2
    exit 1
fi

# ---------- build the remote command ------------------------------------
# The remote shell (bash via plink/ssh) needs nvm sourced for pm2 to be on PATH.
if [[ "$MODE" == "on" ]]; then
    SET_ENV='export DISABLE_RATE_LIMITS=true'
    HUMAN_STATE="DISABLED (DISABLE_RATE_LIMITS=true)"
    EXPECT_429="fewer"
else
    SET_ENV='unset DISABLE_RATE_LIMITS'
    HUMAN_STATE="ENABLED  (variable unset)"
    EXPECT_429="some"
fi

REMOTE_CMD=$(cat <<REMOTE
set -e
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
cd /home/empcloud-development/medcore
$SET_ENV
pm2 restart medcore-api --update-env
pm2 save >/dev/null
sleep 4
echo "--- post-restart env (medcore-api) ---"
pm2 env \$(pm2 jlist | python3 -c 'import json,sys;apps=json.load(sys.stdin);print([a["pm_id"] for a in apps if a["name"]=="medcore-api"][0])') 2>/dev/null | grep -iE 'DISABLE_RATE_LIMITS|NODE_ENV' || true
REMOTE
)

echo "==> flipping DISABLE_RATE_LIMITS to '$MODE' on $SERVER_IP ..."
# shellcheck disable=SC2086
$SSH_CMD "$REMOTE_CMD"

# ---------- verify with 40 rapid logins ---------------------------------
echo ""
echo "==> verifying (40 rapid POSTs to /api/v1/auth/login, expect $EXPECT_429 HTTP 429s)..."
URL="https://medcore.globusdemos.com/api/v1/auth/login"
N_429=0
N_OTHER=0
for _ in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "$URL" \
        -H 'Content-Type: application/json' \
        --data '{"email":"nobody-rate-limit-probe@example.com","password":"x"}' || echo 000)
    if [[ "$code" == "429" ]]; then
        N_429=$((N_429 + 1))
    else
        N_OTHER=$((N_OTHER + 1))
    fi
done

echo "==> result: 429s=$N_429  other=$N_OTHER  (rate-limit state now: $HUMAN_STATE)"
if [[ "$MODE" == "on" && "$N_429" -gt 0 ]]; then
    echo "    WARN: got 429s despite rate limits being disabled — investigate." >&2
    exit 3
fi
if [[ "$MODE" == "off" && "$N_429" -eq 0 ]]; then
    echo "    WARN: got zero 429s despite rate limits being enabled — investigate." >&2
    exit 3
fi
echo "==> OK"
