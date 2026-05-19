"""
Read-only probe of medcore.globusdemos.com via paramiko.

Reads DEPLOY_HOST / DEPLOY_USER / DEPLOY_PASSWORD from local.env at the
repo root and runs a bundle of diagnostic commands. No mutations.

Usage:
  python scripts/probe-dev-server.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

# pm2's list table is Unicode (box-drawing). On Windows cp1252 stdout the
# default print() crashes — force UTF-8 throughout.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        sys.exit(f"local.env not found at {path}")
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def run(ssh: paramiko.SSHClient, label: str, cmd: str) -> None:
    print(f"\n=== {label} ===")
    print(f"$ {cmd}")
    # Wrap in `bash -lc` so .bashrc / .nvm / .npm-global PATH all load —
    # otherwise pm2 (installed via npm-global on nvm) isn't on PATH for
    # paramiko's non-interactive exec_command.
    full = f"bash -lc {repr(cmd)}"
    _, stdout, stderr = ssh.exec_command(full, timeout=30)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out:
        # Trim very long output but keep readable
        if len(out) > 6000:
            out = out[:6000] + f"\n... [truncated, {len(out)} bytes total]"
        print(out.rstrip())
    if err:
        print(f"  [stderr] {err.rstrip()}")


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    env = load_env(repo_root / "local.env")

    host = env.get("DEPLOY_HOST")
    user = env.get("DEPLOY_USER")
    password = env.get("DEPLOY_PASSWORD")
    if not (host and user and password):
        sys.exit("DEPLOY_HOST / DEPLOY_USER / DEPLOY_PASSWORD not all set in local.env")

    print(f"Connecting to {user}@{host} ...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(
            hostname=host,
            username=user,
            password=password,
            timeout=15,
            allow_agent=False,
            look_for_keys=False,
        )
    except Exception as e:
        sys.exit(f"SSH connect failed: {e}")

    print("Connected. Running probe bundle (all read-only) ...")

    # pm2 isn't on the default PATH for non-interactive shells on this box.
    # Absolute path from `find / -name pm2`. pm2 has a `#!/usr/bin/env node`
    # shebang, so node ALSO must be on PATH — prepend the nvm node-20 bin.
    NODE_BIN = "/home/empcloud-development/.nvm/versions/node/v20.20.1/bin"
    pm2 = f"PATH={NODE_BIN}:$PATH {NODE_BIN}/pm2"
    probes = [
        ("hostname + uptime", "hostname && uptime"),
        ("pm2 list (table)", f"{pm2} list 2>&1 | head -50"),
        ("medcore-api describe (tail)", f"{pm2} describe medcore-api 2>&1 | tail -40"),
        ("medcore-web describe (tail)", f"{pm2} describe medcore-web 2>&1 | tail -40"),
        ("medcore-api logs (last 80)", f"{pm2} logs medcore-api --lines 80 --nostream 2>&1 | tail -120"),
        ("medcore-web logs (last 40)", f"{pm2} logs medcore-web --lines 40 --nostream 2>&1 | tail -80"),
        ("listening ports 3200/4100", "ss -tlnp 2>/dev/null | grep -E ':3200|:4100' || netstat -tlnp 2>/dev/null | grep -E ':3200|:4100'"),
        ("curl localhost:4100/api/health", "curl -sS -m 5 -w '\\n[HTTP %{http_code}]\\n' http://localhost:4100/api/health 2>&1 | head -20"),
        ("curl localhost:3200", "curl -sS -m 5 -o /dev/null -w '[HTTP %{http_code}, %{size_download} bytes]\\n' http://localhost:3200 2>&1"),
        ("disk + memory", "df -h / | tail -2 && echo && free -m"),
        ("repo HEAD (medcore checkout)", "cd ~/medcore 2>/dev/null && git log -1 --format='%h %s' || echo '  ~/medcore not found'"),
    ]
    for label, cmd in probes:
        run(ssh, label, cmd)

    ssh.close()
    print("\nProbe complete. Connection closed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
