---
name: medcore-test-triage
description: Diagnose a failing per-push Test workflow run by pulling assertion-level details, grouping failures by symptom, classifying each cluster (stale contract / cred mismatch / cascade poisoning / strip-vs-reject / pre-existing), and surfacing the root cause that's poisoning others. Use when CI Test on main goes red with multiple failures across files, when a per-push run fails after a wave of API/handler changes, or when "the suite was green yesterday and now N tests fail" without a single obvious cause. Companion to /medcore-release (which covers the heavier release.yml E2E gate).
---

# medcore-test-triage

The codified per-push **Test workflow** failure-cluster diagnosis playbook. When 3+ tests fail across multiple files after a recent wave of merges, the quickest path to green is NOT to fix each failure in isolation — it's to **find the cascade root**. One bug in shared module-scope state can produce 8 downstream failures that disappear when the root is fixed.

This skill exists because of the 2026-05-04 wave: 16 auth-integration failures across 6 files looked like 16 separate bugs. They were 5 root causes, one of which (a `_loginLimiterImpl` cache leak across `vitest.config.ts singleFork: true`) cascaded 429s into 8 unrelated tests. Diagnosed-and-fixed in ~30 min using this playbook; would have been a multi-hour rabbit-hole otherwise.

> **Shell note**: this skill's diagnostic commands use `gh run view --log-failed 2>&1 | grep ...` and `grep -rln ... | while read f` constructs. **Run them via the Bash tool, not PowerShell.** On Windows PowerShell, redirecting a native exe's stderr inside a pipe wraps each line as a NativeCommandError and `while read` doesn't exist as written — the bash idioms below assume POSIX semantics.

## When to invoke

- Per-push Test workflow on `origin/main` is red with 3+ failures across 2+ files.
- A wave of fanout commits just landed and CI is failing in non-obvious ways.
- "X test was green yesterday and now fails" but the obvious git blame doesn't reveal a clear cause.
- After a `b6601ad`-style contract change (mass-assignment, anti-enum, schema rejection) — old regression tests likely assert the OLD shape.

Do NOT invoke when:
- Only one test is failing — read it directly.
- The failure is a Playwright spec on `release.yml` — use `/medcore-release` instead (E2E failures rarely cascade and need different triage).
- Build / typecheck failure — that's a `build-error-resolver` agent task.
- The user already knows the root cause and just wants the fix.

## Workflow

### 1. Identify the failed run

```bash
gh run list --branch main --limit 3 \
  --workflow="Test" \
  --json databaseId,name,status,conclusion,headSha
```

Pick the most recent `failure`. Capture `databaseId` and `headSha`.

### 2. List the failed JOBS

```bash
gh run view <run-id> --json jobs \
  --jq '.jobs[] | select(.conclusion == "failure") | {name, url}'
```

Per-push Test runs typically have 4 jobs: `API tests`, `Web component tests`, `Type check`, plus optional E2E. Focus on whichever failed.

### 3. Pull assertion-level details (not just test names)

This is the load-bearing step. Test NAMES alone can't tell you stale-contract from cascade. The actual assertion text can.

```bash
gh run view --job <failed-job-id> --log-failed 2>&1 | \
  grep -B 2 -A 8 "AssertionError\|Expected:\|Received:\|to be defined\|to match" | head -120
```

You want, for each failure: the full assertion line + Expected/Received values + the test file:line.

### 4. Group failures by SYMPTOM (not by test name)

Read the assertions and categorize by what they're saying:

| Symptom | Common cause |
|---|---|
| `expected X to be Y` where X is the response status | Cred mismatch (401), cascade limiter (429), contract drift (201 vs 409) |
| `expected 'PATIENT' to be 'PHARMACIST'` (or any role) | `#473` mass-assignment fix — non-PATIENT roles need admin Bearer |
| `expected 201 to be 400` on an XSS / validation test | Global `sanitize` middleware silently strips before schema rejects |
| `expected 201 to be 409` on duplicate-email | `#480` anti-enumeration changed the contract |
| `expected null to be truthy` after register | Side-effect didn't fire (often role downgrade silently broke it) |
| `expected 429 to be 200` on login | Rate-limiter cache leak in `singleFork` worker |

Cluster the failures into 3-5 symptom buckets. **The same root cause usually produces multiple failures with the same Expected/Received shape.**

### 5. Classify each cluster into one of 5 categories

This is the core skill — you have to recognize which CATEGORY a cluster is in before you can pick the right fix shape.

| Category | Signature | Typical fix shape |
|---|---|---|
| **A. Stale-contract** | Test asserts pre-change behavior; handler changed in a recent commit | Update test assertions to match new contract; preserve the test's regression-marker intent |
| **B. Cred mismatch** | Test uses prod-seed creds (`admin@medcore.local`/`admin123`) but DB only has test-seed creds (`admin@test.local`/`MedCoreT3st-2026`) | Swap creds; add explicit `await resetDB()` in `beforeAll` |
| **C. Cascade poisoning** | One test mutates module-scope state (env var, lazy cache, in-memory Map) without cleanup → downstream files in the same `singleFork` worker fail | Export `__resetXForTests()` from the source; pair with `afterAll` in the polluting test |
| **D. Strip-vs-reject layering** | Test expects schema rejection; global middleware silently mutated the body upstream so schema sees clean input | Add the route to `middleware/sanitize.ts:SCHEMA_REJECT_PATHS` skip-list, OR move validation before mutation |
| **E. Pre-existing** | Failure has nothing to do with recent commits — it was already red on the prior run | Tag and defer; not in this triage's scope |

### 6. Find the cascade root

Cascade failures (category C) **multiply** the apparent failure count. If 3 tests pass alone but fail when run together, the cause is shared mutation, not the test logic. Always fix cascade roots FIRST — fixing downstream symptoms is wasted work.

Diagnostic: look for a test that mutates `process.env.X` or constructs a singleton in `beforeAll`. Check whether it pairs with `afterAll` cleanup. If not — that's your root.

```bash
# Find tests that flip env vars without afterAll cleanup
grep -rln "process.env\." apps/api/src/test/integration/ | while read f; do
  if grep -q "process.env.*=.*\"true\"" "$f" && ! grep -q "afterAll\|afterEach" "$f"; then
    echo "SUSPECT: $f"
  fi
done
```

### 7. Fix in priority order

1. **Cascade roots (C)** — without these, downstream fixes will keep regressing.
2. **Cred mismatches (B)** — quick, mechanical, often unblocks several tests at once.
3. **Strip-vs-reject layering (D)** — production code change; verify no other tests rely on the old layering.
4. **Stale contracts (A)** — slowest because each test needs human judgment about what the regression marker is *supposed* to pin.
5. **Pre-existing (E)** — defer to a separate commit/PR.

### 8. Verify

Local integration tests don't reliably run on Windows (per `project_repo_conventions.md`). The local-verifiable bar is:

```bash
cd "<repo root>/apps/api" && npx tsc --noEmit 2>&1 | \
  grep -vE "@sentry/node|cookie-parser|helmet|audit\.ts.*tenantId" | head -20
```

(Filter out the 4 known pre-existing errors on `origin/main`.) If clean → ship and let CI verify. The Test workflow takes ~7-10 min on push.

## Triage report template

Single message back to the user when filing the triage:

```
🔎 Test workflow run <run-id> on <sha-8>: <N> failures across <M> files

Symptom buckets:
  • <count>x  status 401/200    — login failures (admin@... not in DB?)
  • <count>x  status 429/200    — rate-limit cascade?
  • <count>x  role PATIENT/X    — #473 mass-assignment contract drift
  • <count>x  status 201/400    — XSS strip-vs-reject conflict

Root causes:
  RC1: <one line — which file:line, which mutation>     → fixes <count> tests
  RC2: <one line>                                        → fixes <count> tests
  …

Fix order:
  1. RC<X> (cascade root) — must land first
  2. RC<Y> (mechanical, unblocks <N>)
  3. RC<Z> (judgment call — preserve regression-marker intent)

Pre-existing / out-of-scope:
  - <test name>  (failed on prior run, unrelated)
```

## Recognizing the 5 categories — concrete examples from the 2026-05-04 wave

These are the canonical examples. If you see something that looks like one of these, lean into the corresponding category.

### A. Stale-contract example

`ai-regressions-2026-04-26.test.ts` had this test:
```ts
it("#190: /auth/register accepts PHARMACIST role", async () => {
  const res = await request(app).post("/api/v1/auth/register").send({ ..., role: "PHARMACIST" });
  expect(res.body.data.user.role).toBe("PHARMACIST");
});
```
Failed with `expected 'PATIENT' to be 'PHARMACIST'`. Root cause: commit `b6601ad` (`#473`) added `resolveRegistrationRole(req, ...)` that downgrades non-PATIENT to PATIENT unless the caller has an admin Bearer. Fix: add `.set("Authorization", "Bearer " + adminToken)` to the request. The test still pins #190's zod-enum guard — what changed was the auth gate.

### B. Cred mismatch example

`auth-cookies-csrf.test.ts` used `admin@medcore.local`/`admin123` (the production seed in `seed-realistic.ts`). The integration-test `setup.ts:resetDB()` only seeds `admin@test.local`/`MedCoreT3st-2026`. Login returned 401, which then triggered category C below.

### C. Cascade-poisoning example

`auth.test.ts > describeRateLimit > beforeAll` did:
```ts
process.env.ENABLE_LOGIN_RATELIMIT_IN_TESTS = "true";
const mod = await import("../../app");
rlApp = mod.buildApp().app;
```
But `auth.ts` had a module-scope `_loginLimiterImpl` lazy cache. Once constructed with `enableInTests=true`, the real 5/min limiter persisted for the entire vitest worker (`singleFork: true`). Downstream files (`auth-edges`, `auth-session-bleed`, `users.test`) calling `/auth/login` hit the leftover quota → 429s.

Fix: export `__resetLoginLimiterForTests()` from `auth.ts`; call it in `afterAll` along with `delete process.env.ENABLE_LOGIN_RATELIMIT_IN_TESTS`. **Order matters** — env unset first, cache reset second, so the next caller rebuilds with `enableInTests=false`.

### D. Strip-vs-reject layering example

`auth.test.ts` XSS test sent `name: "<script>alert(1)</script>"` and expected 400 from the schema's `containsHtmlOrScript` refine. Got 201 instead. Root cause: global `sanitize` middleware in `app.ts:190` strips `<...>` tags before the schema sees the body, so the refine sees clean `"alert(1)"` and accepts it.

Fix: `middleware/sanitize.ts` now has a `SCHEMA_REJECT_PATHS` skip-list that bypasses tag-stripping for paths whose schemas explicitly reject (currently just `/api/v1/auth/register`). Other routes (e.g. emergency-room notes — issue #424) keep the strip behavior.

### E. Pre-existing example

`apps/api/src/routes/billing.ts` has 2 long-standing TS2353 errors on `parentPaymentId`. Reported by sibling agents during `medcore-fanout` runs. Not from any current commit; tracked as a residual finding in `SESSION_SNAPSHOT_2026-05-04-evening.md`. Defer.

## Anti-patterns

- **Don't fix downstream symptoms before the cascade root.** You'll fix 5 tests, push, and the next run shows 4 NEW tests failing because the cascade just shifted.
- **Don't read assertion failures one at a time.** Group by symptom first — patterns appear in aggregates that get lost in single-test reads.
- **Don't trust local integration runs on Windows** (per `project_repo_conventions.md`). Typecheck is the local-verifiable bar; CI is authoritative.
- **Don't update a stale-contract test without preserving the regression marker.** The original test was written to pin a SPECIFIC bug fix; figure out what part of the contract that bug touched, and update only that part. Wholesale rewrites lose the historical pin.
- **Don't add `process.env.X = "Y"` in any `beforeAll` without a matching `afterAll`** that resets it — even if you think the test "owns" the env. `singleFork: true` means it'll leak.
- **Don't skip the typecheck filter for pre-existing errors.** If you see `@sentry/node` / `cookie-parser` / `helmet` / `audit.ts:tenantId` in the typecheck output, those are NOT yours.

## Composability

- Pairs with `/medcore-release` for the heavier release.yml gate (Playwright + integration full suite). Different ergonomics — release.yml takes 25-40 min and rarely cascades; the per-push Test workflow is 7-10 min and cascades easily.
- Naturally precedes `/medcore-doc-roll` if the triage produced a fix worth documenting (architectural finding, new convention).
- Pairs with `/medcore-fanout` if the triage surfaces N independent root causes that can be fixed in parallel (rare — usually 1-2 root causes drive the cluster).

## Reference: cumulative findings from triage waves

Add new findings as discovered. The 5-category framework above is the stable scaffolding; the specific examples grow over time.

| Wave | Date | Failure count | Root causes | Cascade source |
|---|---|---|---|---|
| Auth-integration drift | 2026-05-04 | 16 across 6 files | 5 (one each per category A-E) | `_loginLimiterImpl` cache + env-var leak in `singleFork` |
