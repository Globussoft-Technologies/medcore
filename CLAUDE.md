# MedCore — Claude session notes

Auto-loaded into every Claude Code session that opens this repo. Captures recurring patterns + gotchas surfaced across recent fanout waves so future sessions don't relearn them.

For the live state, read `/TODO.md` and the latest `docs/archive/SESSION_SNAPSHOT_*.md`. For test strategy, read `docs/TEST_PLAN.md` (especially §6.5 adversarial-vector categories). For agent dispatch, read `.claude/skills/medcore-fanout/SKILL.md`.

## Pickup protocol

1. `git pull origin main` BEFORE starting Claude — skills register at session start.
2. Read TODO.md banner + latest SESSION_SNAPSHOT first.
3. For "do N things in parallel", invoke `/medcore-fanout`.
4. The 15-min auto-pilot cron is session-only (harness durable flag dropped). Re-arm at session start if you want autopilot — see TODO.md banner step 4.

## Project skills (7, all in `.claude/skills/`)

- `/medcore-fanout` — N parallel foreground agents in non-overlapping lanes (Mode A per-agent commits OR Mode B single-bundled commit)
- `/medcore-e2e-spec` — scaffold one Playwright route spec under the descriptive-headers convention
- `/medcore-route-test` — scaffold one Vitest route-handler unit test (with cleanup-contract addendum)
- `/medcore-release` — dispatch + watch + diagnose `release.yml`
- `/medcore-doc-roll` — capture each wave's findings into TODO + CHANGELOG (idempotent)
- `/medcore-ai-route-audit` — apply the AI inference audit-row contract to any AI route
- `/medcore-test-triage` — 5-category per-push CI failure diagnosis playbook

## Recurring patterns + gotchas (read before writing code)

These were surfaced during recent fanout waves and bit multiple agents. Codified here so future agents don't repeat the discovery.

### Test infra

1. **Audit row writes are fire-and-forget** — `auditLog(req, ...)` returns immediately and writes to DB on a deferred Promise (`.catch(console.error)`). Tests asserting on the row immediately after the action will be flaky. **Fix**: use `await waitForAuditFlush()` from `apps/api/src/test/helpers/audit-wait.ts` (polls AuditLog up to 2s for the expected `(action, entity, entityId)` tuple). See the `audit-phi` flake recurrence on `INSURANCE_CLAIMS_LIST` (2026-05-05) and `AI_SCRIBE_READ` (2026-05-03).

2. **Module-scope state under `singleFork: true`** — vitest's `singleFork: true` shares one worker across files in the same suite. Any module-scope cache (rate limiter, auth helper, lazy singleton) leaks state across test files. **Fix**: every route that constructs lazy module-scope state MUST export a `__resetXForTests()` reset hook AND tests using it MUST pair `beforeAll` with `afterAll` to call the reset. Pattern reference: `apps/api/src/routes/auth.ts:__resetLoginLimiterForTests()`. Codified in `/medcore-route-test` SKILL.md "Cleanup contract for module-scope mutations".

3. **`expect(res.status).toBeLessThan(400)` is contract-of-existence, not contract-of-correctness** — every authed integration test must also assert response shape. The 5 critical security issues (#473 mass-assignment, #474 cross-patient, #475 headers, #476 PII, #483 identity) all shipped past tests that asserted only status. Use the 6 helpers from `apps/api/src/test/helpers/security-assertions.ts` and the checklist convention in `docs/TEST_PLAN.md` §6.5.

4. **Test DB seed creds:** `admin@test.local` / `MedCoreT3st-2026` — NOT the prod-seed `admin@medcore.local` / `admin123`. Confusion has cost ~6 test-failure debug sessions. The integration suite's `resetDB()` helper materializes the test creds.

### Source-side gotchas

5. **Global `sanitize` middleware can override schema-level rejections** — `apps/api/src/middleware/sanitize.ts` strips HTML tags from request bodies BEFORE the Zod schema runs. Schemas that REJECT raw HTML via `containsHtmlOrScript.refine()` (e.g. `/auth/register`) are silently neutralized — the user's `<script>` payload reaches the schema as plain text and passes validation. **Fix**: add the route to `SCHEMA_REJECT_PATHS` in `sanitize.ts` so it skips global stripping for that path. Currently registered: `/api/v1/auth/register`.

6. **Tenant scoping wrapper lives in `@medcore/db`** (NOT `apps/api/src/services/`) — A10 lifted it 2026-05-05. New consumers (workers, cron, mobile API, secondary services) should `import { tenantScopedPrisma, runWithTenant, tenantContextMiddleware } from "@medcore/db"` directly without crossing the apps→packages arrow. The old import path is still a back-compat shim; don't add new code paths through it.

7. **Many dashboard pages have NO client-side `VIEW_ALLOWED` gate** (A1 — currently open architectural follow-up). Page chrome renders for any authed user; security depends entirely on the API's `authorize(...)`. Non-allowlisted roles see a partial shell + empty list rather than `/dashboard/not-authorized`. **Decision pending** — don't add new gates blindly; ask the user.

8. **`PATIENT_NAME_REGEX = /^[A-Za-zऀ-ॿ\s.\-']{1,100}$/` rejects digits.** Spec authors generating timestamp-tagged unique names (`Date.now()`) get silent POST 4xx. Encode uniqueness via email/phone/MR-number instead. Documented at `e2e/helpers.ts:528` near `indianishName()`.

9. **`LanguageDropdown` injects a `<select>` into every authed dashboard layout.** Any spec doing `locator('select').first()` is brittle — scope to `select:has(option[value="<unique>"])` instead. Repo-wide sweep already done (`b2e78d7`); future specs must follow the convention.

10. **Next.js renders `<div role="alert" id="__next-route-announcer__">` globally.** Any `getByRole('alert')` will hit it. Use `[role="alert"]:not(#__next-route-announcer__)` instead. Repo-wide sweep already done (`f44c9a0`).

### Doc + commit conventions

11. **NO `Co-Authored-By: Claude` trailer in commit messages** — forbidden by user's global CLAUDE.md.

12. **Conventional commits required** (`fix(...)`, `test(...)`, `docs(...)`, `feat(...)`, `chore(...)`, `refactor(...)`, `perf(...)`, `ci(...)`).

13. **File-scoped commits in fanout** — `git add <specific files>` (NEVER `-A`) + `git commit -m "<msg>" -- <files>` (the trailing `-- <files>` scopes the commit even if other agents' staged files are in the index). Push with rebase-retry loop (5 attempts).

14. **Living references update in-place with closure annotations**; only date-stamped artefacts get archived. `docs/archive/gaps/` is reserved for FULLY closed gap-tracking docs (every item worked through). Open gap files (`E2E_COVERAGE_BACKLOG.md`, `TEST_COVERAGE_AUDIT.md`) stay in `docs/`.

15. **Tests + new entry-point files (route handlers, services, top-level components) get a 2-4 line header comment** — what / which modules / why. The one override to the global "default to no comments" rule. `describe(...)` strings should be specific full sentences. Reference template: `e2e/symptom-diary.spec.ts`.

### Harness gotchas (Claude Code v2.1.126)

16. **Background agents are broken** for tasks involving `Read` — every Read fires an interactive permission popup, watchdog kills at 600s. Use `/medcore-fanout` (foreground) instead. See memory `reference_worktree_bg_agent_perms.md`.

17. **`durable: true` on `CronCreate` is silently dropped** — crons die when the editor closes. Re-arm at session start (TODO.md banner step 4).

18. **Project-shared `.claude/skills/` is tracked in git** via `.gitignore` exception (`.claude/* + !.claude/skills/`). `.claude/settings.local.json` stays gitignored (per-user). `.claude/settings.json` IS tracked (project-shared allowlist).
