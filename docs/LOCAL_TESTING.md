# Local CI-mirror test runner

A single script that runs every gating job from
[`.github/workflows/test.yml`](../.github/workflows/test.yml) against your
working tree, so you can validate before pushing instead of waiting 7-25 min
on GitHub Actions.

Source: [`scripts/run-tests-locally.sh`](../scripts/run-tests-locally.sh).

> This is **not** a pre-commit hook — it doesn't block commits. It's an
> opt-in script you run when you're ready to push.

---

## Why local-first

Per-push CI takes ~7 min in the happy case (with cold runners) and ~25 min
when the optional Playwright suite runs via `release.yml`. Iterating
through CI failures one round-trip at a time burns wall-clock and Actions
minutes. Running the same gates locally — sharing your warm npm cache,
warm `.next` directory, and warm Prisma client — typically completes in
under 7 min for the default tier.

CI is still the source of truth for "ready to merge" (real Linux runner,
clean Postgres image, cold `node_modules`). Local-first is the
**first-line check**; CI is the second-line backstop.

---

## Quick start

```bash
# 3-5 min, no DB needed. Runs typecheck + lint + npm-audit
# + migration-safety + web-bundle.
scripts/run-tests-locally.sh --quick

# 7-10 min, with one-shot Postgres on :54322.
# Adds web-tests + api-tests (unit + contract + smoke + integration).
scripts/run-tests-locally.sh

# 15-20 min, full pre-push validation.
# Adds Chromium full Playwright suite via scripts/run-e2e-locally.sh.
scripts/run-tests-locally.sh --with-e2e

# 25 min, mirrors release.yml exactly (Chromium + WebKit).
scripts/run-tests-locally.sh --with-e2e=both
```

Logs land under `.test-local/<job>.log`. The end-of-run summary calls
out which jobs failed and points at the relevant log.

---

## Tier table

| Tier | Command | Target time | Covers |
|---|---|---|---|
| Quick | `--quick` | 3-5 min | typecheck, lint, npm-audit, migration-safety, web-bundle |
| Default | (no flag) | 7-10 min | quick + web-tests + api-tests |
| Pre-push | `--with-e2e` | 15-20 min | default + Chromium e2e |
| Release | `--with-e2e=both` | ~25 min | default + Chromium + WebKit e2e (mirrors release.yml) |

### Other flags

| Flag | Effect |
|---|---|
| `--keep-db` | Keep the test Postgres container running between invocations. Forwarded to the e2e runner when `--with-e2e` is set. |
| `--skip-audit` | Skip `npm audit` (useful offline — audit hits the registry). |
| `--skip-build` | Skip `web-bundle` (and the `next build` it depends on). |
| `--bail` | Stop on first failure. Default is to run everything and summarize. |
| `-h` / `--help` | Print usage. |

---

## Recommended commit workflow

```
edit -> --quick -> (default) -> commit -> push
                ^                        ^
                3-5 min                  CI is the second-line backstop
```

1. **While iterating**: `--quick` after each meaningful change. 3-5 min
   feedback that catches typecheck regressions, lint, audit drift, and
   bundle bloat without booting Postgres.
2. **Before committing**: full default run. 7-10 min, hits the same
   surface as the per-push CI gate.
3. **Before pushing to `main`** (or anything that triggers `release.yml`):
   `--with-e2e`. 15-20 min, covers the Playwright Chromium suite.
4. **Push**. CI re-runs everything against a clean Linux environment
   (different OS, different docker, different npm cache, different
   timezone). It's still authoritative — local green is necessary but
   not sufficient for "ready to merge".

---

## What this does NOT replace

- **CI matrix differences**: GitHub Actions runs Linux + cold `node_modules`
  + a fresh `postgres:16` image every push. Your laptop is probably
  macOS/Windows + a warm cache + a long-lived test container. Drift is
  rare but real (file-case sensitivity, timezone, locale). CI is the
  source of truth.
- **Visual regression baselines**: those PNGs are Linux-rendered and live
  on `update-visual-baselines.yml`. Don't try to regenerate them locally.
- **Deploy + smoke check**: the `deploy` job in `test.yml` SSHes into
  the dev server and runs `scripts/deploy.sh`. Out of scope here — local
  validation is about the gating jobs that come before it.

---

## Troubleshooting

### Port `54322` already in use

The runner shares `medcore-test-pg` with `scripts/run-e2e-locally.sh`. If
both have a stale container, remove it:

```bash
docker rm -f medcore-test-pg
```

If something else is listening on `:54322` (rare), edit `PG_PORT` at the
top of `scripts/run-tests-locally.sh`.

### Docker not running

```
error: docker daemon is not reachable
```

Start Docker Desktop (macOS/Win) or `sudo systemctl start docker`
(Linux), then retry. The default tier and `--with-e2e` need Docker;
`--quick` does not.

### Prisma generate fails

The runner runs `npm run db:generate` before any other job because the
Web app and the API both import generated Prisma types. If this step
fails, every downstream job will fail too. Fix:

```bash
# Make sure the workspace is clean; sometimes a half-installed
# node_modules leaves the prisma binary missing.
npm install
npm run db:generate
```

### `migration-safety` says "could not fetch origin/main"

The runner auto-runs `git fetch origin main` so the destructive-migration
diff is up-to-date. If you're offline, it falls back to whatever ref
`origin/main` already points at locally. The CI version of this check
diffs against the GHA `before` SHA; the local version diffs against
`origin/main`, which is the closest stable-meaning anchor a dev box has.

### A job hangs

The runner doesn't enforce per-job timeouts (CI does, via `timeout-minutes`
in the workflow). If something hangs:

1. Check `.test-local/<job>.log` to see which step it's stuck on.
2. `Ctrl-C` cleans up the Postgres container (unless `--keep-db`).
3. Common culprits: stuck Docker volume, stale `.next` build cache
   (`rm -rf apps/web/.next`).

---

## Cross-references

- [`docs/LOCAL_E2E.md`](LOCAL_E2E.md) — the underlying Playwright runner
  this script delegates to when `--with-e2e` is set.
- [`docs/ONBOARDING.md`](ONBOARDING.md) §3 — full per-layer test command
  reference (vitest, playwright, load tests).
- [`.github/workflows/test.yml`](../.github/workflows/test.yml) — the CI
  workflow this script mirrors. Authoritative source for the exact step
  ordering and env block; if `test.yml` drifts, this script needs to
  follow.
- [`docs/TEST_PLAN.md`](TEST_PLAN.md) — the full test-layer matrix and
  known coverage gaps.
