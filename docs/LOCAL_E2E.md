# Local Playwright runner

A 5-10 min local replacement for the 25-min `release.yml` cycle. Mirrors
the same Postgres + API + Web + Playwright topology CI uses, just on
alternative ports so it can coexist with your normal dev stack.

Source: [`scripts/run-e2e-locally.sh`](../scripts/run-e2e-locally.sh).

---

## Prerequisites

- **Docker** running locally (Docker Desktop on macOS/Win, dockerd on
  Linux). The script uses a one-shot `postgres:16` container.
- **Node 20** (matches `.nvmrc`). `nvm use` if you have nvm.
- **Free ports**: `54322` (Postgres), `4001` (API), `3001` (Web). The
  script fails fast with a clear error if any are taken.
- **Playwright browsers**: auto-installed on first run (Chromium ~110 MB,
  WebKit ~130 MB). Cached at `~/.cache/ms-playwright` (Linux),
  `~/Library/Caches/ms-playwright` (macOS), or
  `%LOCALAPPDATA%\ms-playwright` (Windows / Git Bash); subsequent runs
  skip the install step.

---

## Quick start

```bash
scripts/run-e2e-locally.sh
```

First invocation: ~10 min (Docker image pull + npm install + Playwright
browser download + Web build + full Chromium suite). Steady-state: ~5 min
(everything cached, full suite runs against pre-built Web bundle).

Single-spec invocation after warm-up is sub-30s end-to-end if you also
pass `--keep-db` to skip the reset+seed.

---

## Common workflows

| Goal | Command |
|---|---|
| Full Chromium suite (default) | `scripts/run-e2e-locally.sh` |
| Single spec | `scripts/run-e2e-locally.sh e2e/ambulance.spec.ts` |
| Single test by line | `scripts/run-e2e-locally.sh e2e/ambulance.spec.ts:191` |
| Smoke project (3 specs, ~2 min) | `scripts/run-e2e-locally.sh --smoke` |
| WebKit only | `scripts/run-e2e-locally.sh --webkit` |
| Both browsers serially | `scripts/run-e2e-locally.sh --both` |
| Hot loop (skip db reset+seed) | `scripts/run-e2e-locally.sh --keep-db e2e/ambulance.spec.ts` |
| Headed / debug | `scripts/run-e2e-locally.sh e2e/foo.spec.ts -- --headed --debug` |

The double-dash separator forwards anything after it directly to
`playwright test` (so `--headed`, `--debug`, `--workers=1`,
`--update-snapshots`, etc. all work).

`--keep-db` keeps the `medcore-e2e-pg` container running after the script
exits and skips both `prisma db push --force-reset` and `npm run db:seed`
on the next run. Use it when you're hot-looping on a single spec and the
DB state from the prior run is fine. Tear down manually with
`docker rm -f medcore-e2e-pg` when you're done iterating.

---

## Local vs CI: when to pick which

| | Local (this script) | CI (release.yml) |
|---|---|---|
| Setup time (cold) | ~3 min | ~3 min |
| Setup time (warm) | ~30 s (cached) | ~3 min (no cache) |
| Full Chromium runtime | ~5 min | ~12 min |
| Full WebKit runtime | ~7 min | ~14 min |
| Both browsers | serial (~12 min) | parallel (~14 min wall-clock) |
| Browser coverage | Chromium and/or WebKit | Chromium + WebKit, parallel jobs |
| Visual baselines | not regenerated (Linux PNGs only) | not regenerated (own workflow) |
| Source of truth for "ready to merge" | no | yes |
| Best for | iterating on a fix | the final green-light gate |

Rule of thumb: **iterate locally, validate in CI**. Push when local is
green; release.yml on `main` is the authoritative gate.

---

## Troubleshooting

### Port `54322` / `4001` / `3001` already in use

The script aborts with `error: port N (Postgres|API|Web) is already in
use`. Find the offending process and stop it, or edit the constants at
the top of `scripts/run-e2e-locally.sh` to pick a different free port.

```bash
# Linux/macOS
lsof -iTCP:4001 -sTCP:LISTEN
# Git Bash on Windows
netstat -ano | grep :4001
```

### DB stuck in inconsistent state

```bash
docker rm -f medcore-e2e-pg
```

The script will recreate the container fresh on the next run.

### Playwright browser missing on first run

Expected. The script prints `installing playwright browser: chromium`
(or `webkit`) and proceeds. If the install fails (often due to missing
system libs on Linux without sudo), run it manually once:

```bash
npx playwright install --with-deps chromium webkit
```

### `npm install` keeps re-running

The script only re-runs `npm install --include=dev` if `node_modules/`
or `node_modules/@playwright/test` is missing. If you just ran a normal
`npm install` and the script still re-installs, check that
`node_modules/@playwright/test` exists — some workspace setups can omit
it. Once present, the script no-ops on the install step.

### Servers fail to come up within 90 s

The script tails the last 40 lines of `.e2e-local/api.log` and
`.e2e-local/web.log` to stderr and exits non-zero. The most common
culprits are:

- DATABASE_URL pointing at a stale schema (run without `--keep-db` to
  force a reset).
- Port 4001/3001 squatted by a leftover Node from a previous crashed
  run; check `lsof -iTCP:4001` (Linux/macOS) or `netstat -ano | grep
  :4001` (Git Bash). The exit trap covers normal exits and Ctrl-C, but
  a `kill -9` on the script can leak children.

### Windows users without Docker

If Docker Desktop won't run on your box (older Windows, no WSL2), the
script can't create the test Postgres. Workarounds:

- **WSL2**: install Ubuntu under WSL2 and run the script from there. The
  Linux Docker daemon inside WSL2 is the smoothest path on Windows.
- **Use the host's existing Postgres**: stand up the `medcore_e2e` DB
  manually on the dev box's Postgres on `:5433` (or wherever yours
  lives), then point the script at it by editing `PG_PORT` /
  `PG_USER` / `PG_PASS` / `PG_DB` at the top of the script and
  commenting out the `start_postgres` call in `main`. Fork-and-edit is
  fine for this — the script is intentionally short.

---

## Cross-references

- [`docs/TEST_PLAN.md`](TEST_PLAN.md) — the full testing-layer matrix
  (unit / contract / integration / web component / Playwright /
  load).
- [`docs/ONBOARDING.md`](ONBOARDING.md) §3 — quick command reference for
  every test layer.
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) —
  the CI workflow this script mirrors. Authoritative source for the
  exact env block + step ordering; if release.yml drifts, this script
  needs to follow.
- [`.github/workflows/update-visual-baselines.yml`](../.github/workflows/update-visual-baselines.yml)
  — the separate workflow for visual-regression baseline PNGs. Do not
  try to regenerate those locally; they must be Linux-rendered.
