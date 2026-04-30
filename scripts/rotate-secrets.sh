#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rotate-secrets.sh
#
# Rotate a single prod secret (Sarvam API key, JWT secret, JWT refresh
# secret, or upload-signing key) in-place on prod's apps/api/.env, restart
# medcore-api with `--update-env`, and smoke-test the new key before
# declaring success.
#
# On failure: roll back to the backed-up previous .env and restart again.
#
# Usage
# ─────
#   scripts/rotate-secrets.sh --key sarvam         --value NEW_KEY
#   scripts/rotate-secrets.sh --key jwt            --generate
#   scripts/rotate-secrets.sh --key jwt-refresh    --generate
#   scripts/rotate-secrets.sh --key upload-signing --generate
#
#   --generate   Generates a random 32-byte hex value (valid for jwt,
#                jwt-refresh, upload-signing). NOT valid for --key sarvam —
#                a human-issued API key must be provided via --value.
#
# SSH transport uses plink (Windows / Git-Bash) or sshpass (POSIX),
# reading SERVER_USER / SERVER_PASSWORD / SERVER_IP from the repo-root
# .env. Same pattern as scripts/toggle-rate-limits.sh.
#
# Safety
# ──────
# - The remote .env is ALWAYS backed up as .env.bak-$(timestamp) before any
#   write. The backup is what the rollback step restores from.
# - The smoke test hits https://medcore.globusdemos.com/api/health and,
#   for --key sarvam, also runs `scripts/test-ai-live.ts` which issues
#   exactly one runTriageTurn. If that call fails, we roll back.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ---------- CLI parsing ----------------------------------------------------
KEY=""
VALUE=""
GENERATE=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --key)
            shift
            KEY="${1:-}"
            shift
            ;;
        --value)
            shift
            VALUE="${1:-}"
            shift
            ;;
        --generate)
            GENERATE=1
            shift
            ;;
        --help|-h)
            sed -n '3,40p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "ERROR: unknown flag: $1" >&2
            exit 2
            ;;
    esac
done

case "$KEY" in
    sarvam)         ENV_VAR="SARVAM_API_KEY";      HUMAN="Sarvam API key";      SMOKE_AI=1 ;;
    jwt)            ENV_VAR="JWT_SECRET";          HUMAN="JWT secret";          SMOKE_AI=0 ;;
    jwt-refresh)    ENV_VAR="JWT_REFRESH_SECRET";  HUMAN="JWT refresh secret";  SMOKE_AI=0 ;;
    upload-signing) ENV_VAR="UPLOAD_SIGNING_KEY";  HUMAN="upload-signing key";  SMOKE_AI=0 ;;
    "")
        echo "ERROR: --key is required (one of: sarvam, jwt, jwt-refresh, upload-signing)" >&2
        exit 2
        ;;
    *)
        echo "ERROR: unknown --key '$KEY' (expected sarvam|jwt|jwt-refresh|upload-signing)" >&2
        exit 2
        ;;
esac

# --generate vs --value
if [[ "$GENERATE" -eq 1 && -n "$VALUE" ]]; then
    echo "ERROR: --generate and --value are mutually exclusive" >&2
    exit 2
fi
if [[ "$GENERATE" -eq 1 && "$KEY" == "sarvam" ]]; then
    echo "ERROR: --generate is not valid for Sarvam (needs a real API key). Use --value." >&2
    exit 2
fi
if [[ "$GENERATE" -eq 0 && -z "$VALUE" ]]; then
    echo "ERROR: supply either --value or --generate" >&2
    exit 2
fi

if [[ "$GENERATE" -eq 1 ]]; then
    # 32-byte hex (=64 hex chars). OpenSSL is available on Git-Bash / Linux.
    if command -v openssl >/dev/null 2>&1; then
        VALUE=$(openssl rand -hex 32)
    else
        VALUE=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
    fi
fi

# ---------- load server creds ---------------------------------------------
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

# ---------- pick SSH transport --------------------------------------------
SSH_CMD=""
if command -v plink >/dev/null 2>&1; then
    SSH_CMD="plink -batch -ssh -pw $SERVER_PASSWORD $SERVER_USER@$SERVER_IP"
elif command -v sshpass >/dev/null 2>&1; then
    SSH_CMD="sshpass -p $SERVER_PASSWORD ssh -o StrictHostKeyChecking=accept-new $SERVER_USER@$SERVER_IP"
else
    echo "ERROR: need either plink (PuTTY) or sshpass to authenticate non-interactively." >&2
    exit 1
fi

REMOTE_ENV="/home/empcloud-development/medcore/apps/api/.env"
TS=$(date +%Y%m%d-%H%M%S)
REMOTE_BAK="$REMOTE_ENV.bak-$TS"

# ---------- push rotation --------------------------------------------------
echo "==> Rotating $HUMAN ($ENV_VAR) on $SERVER_IP"
echo "==> Backing up $REMOTE_ENV → $REMOTE_BAK"

# We intentionally pass VALUE through a heredoc to avoid shell quoting bugs.
# The remote `sed` rewrites the existing line or appends if missing.
REMOTE_ROTATE=$(cat <<REMOTE
set -e
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"

cp "$REMOTE_ENV" "$REMOTE_BAK"

# Strip any existing line for ENV_VAR, then append the new one. Using python
# so we don't have to worry about special characters in the value.
python3 - <<'PY'
import os, re
path = "$REMOTE_ENV"
key  = "$ENV_VAR"
val  = """$VALUE"""
with open(path) as f:
    lines = f.readlines()
pattern = re.compile(r"^" + re.escape(key) + r"=")
new_lines = [l for l in lines if not pattern.match(l)]
new_lines.append(key + "=" + val + "\n")
with open(path, "w") as f:
    f.writelines(new_lines)
PY

cd /home/empcloud-development/medcore
pm2 restart medcore-api --update-env
pm2 save >/dev/null
sleep 4

# Smoke test: /api/health must be 200.
http_code=\$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4100/api/health)
if [ "\$http_code" != "200" ]; then
    echo "ROLLBACK: /api/health returned \$http_code (expected 200)"
    cp "$REMOTE_BAK" "$REMOTE_ENV"
    pm2 restart medcore-api --update-env
    exit 42
fi
echo "Health OK (200)"
REMOTE
)

# shellcheck disable=SC2086
if ! $SSH_CMD "$REMOTE_ROTATE"; then
    echo "==> Rotation failed; remote script rolled back to $REMOTE_BAK" >&2
    exit 1
fi

# ---------- Sarvam-specific live test --------------------------------------
if [[ "$SMOKE_AI" -eq 1 ]]; then
    echo "==> Sarvam key rotated — issuing one test triage turn"
    REMOTE_AI=$(cat <<REMOTE
set -e
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
cd /home/empcloud-development/medcore
if ! npx tsx scripts/test-ai-live.ts --one-shot-triage 2>&1; then
    echo "ROLLBACK: test-ai-live failed — restoring previous key"
    cp "$REMOTE_BAK" "$REMOTE_ENV"
    pm2 restart medcore-api --update-env
    exit 43
fi
REMOTE
)
    # shellcheck disable=SC2086
    if ! $SSH_CMD "$REMOTE_AI"; then
        echo "==> Sarvam live check failed; rolled back" >&2
        exit 1
    fi
fi

echo "==> $HUMAN rotated and verified. Backup retained at $REMOTE_BAK."
echo "==> If everything looks healthy tomorrow, you can clean up old .env.bak-* files with:"
echo "    $SSH_CMD 'ls -t /home/empcloud-development/medcore/apps/api/.env.bak-* | tail -n +6 | xargs -r rm'"
