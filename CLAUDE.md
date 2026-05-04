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

1. **Audit row writes — distinguish two surfaces:**
   - `auditLog(req, action, entity, entityId, payload)` — the middleware in `apps/api/src/middleware/audit.ts`. **Awaited** — the route doesn't return until the AuditLog.create() promise resolves. Tests against handlers that use this can read AuditLog immediately after the action.
   - `safeAudit(req, ...)` — per-route wrappers that do `auditLog(...).catch(console.error)`. **Fire-and-forget** — the route returns 200/201 BEFORE the deferred Promise resolves. Tests that read AuditLog immediately race the deferred write and flake intermittently. Examples: `ai-scribe.ts:35`, `ai-predictions.ts:26`, `agent-console.ts:43`. **Fix**: use `await waitForAuditFlush()` (single row) or `waitForAuditRows()` (array) from `apps/api/src/test/helpers/audit-wait.ts` — polls AuditLog every 50ms up to 2s for the matching `(action, entity, entityId, userId)` tuple. Schema field is `entity` (NOT `entityType`). See the `audit-phi` flake recurrences on `INSURANCE_CLAIMS_LIST` (2026-05-05) and `AI_SCRIBE_READ` (2026-05-03), both fixed by `d1488d7`.

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

11. **`EntityPicker` echoes `id` onto each row's `<li>` as `data-entity-id`.** Best selector pattern for picking a SPECIFIC seeded row is `[data-testid="<picker>-option"][data-entity-id="${entity.id}"]` — exact lock-on, no name-collision risk. Fallback: `getByTestId("<picker>-option").filter({ hasText: name })` when only the display name is known. See `9d7391a` (prescriptions/new spec) + `2823d9c` (payment-plans fix) for canonical examples. Updates extension of TODO C3.

12. **BOLA sweep — when the URL param is `:childId`, you MUST add a parent fetch before `assertPatientOwnsResource` can compare.** Surfaced by 4 admissions handlers + 2 antenatal handlers in the 2026-05-05 #511 wave: handlers were querying child tables (`vitals`, `intakeOutput`, `belongings`, `dischargeSummary`, `ultrasoundRecord`, `postnatalVisit`) directly by URL param without ever loading the parent. Worst BOLA shape — there's literally nothing to compare ownership against. Fix pattern: add `prisma.<parent>.findUnique({where:{id:req.params.id}, select:{patientId:true}})` first, then call the helper with `parent.patientId`. The `/medcore-bola-sweep` skill codifies this as "verdict A3" in its workflow. Codebase precedent: `c87107e`, `bfb52ab`. Helper signature reference: `apps/api/src/middleware/patient-self-only.ts`.

13. **BOLA sweep — non-patient resources go through `authorize(...)`, NOT the helper.** `BloodDonor` has no `User`/`Patient` link; `AuditLog` is system-wide; admin routes don't gate per-row. For these, use `authorize(Role.ADMIN, Role.DOCTOR, ...)` matching the file's other staff-only handlers. Don't try to force `assertPatientOwnsResource` onto a non-patient resource. The `/medcore-bola-sweep` skill calls this "verdict C — STAFF-ONLY". Codebase precedent: `a7bfc8c` for `BloodDonor` sub-resources.

14. **`authorize(...)` containing `Role.PATIENT` does NOT exempt the handler from per-row checks.** The original BOLA audit (#511) only flagged handlers WITHOUT any `authorize()`. Two later finds — `appointments.ts PATCH /:id/reschedule` and `growth.ts POST /:id/feeding` — were handlers that DID have `authorize()` BUT included PATIENT and skipped per-row scoping. Result: any PATIENT could reschedule any appointment / write feeding logs against any patient. **For every handler with `Role.PATIENT` in `authorize()` AND a row-keyed param**, verify one of: (a) Prisma `where: { patientId: req.user.patientId }` self-scope, (b) `assertPatientOwnsResource(req, res, parent.user.id)` post-load, (c) `getCallerPatient(req)` for self-self surfaces. None → real BOLA. Discovery grep: `grep -lE "authorize\([^)]*Role\.PATIENT" apps/api/src/routes/*.ts`. The `/medcore-bola-sweep` skill's "Expanded audit criterion" section codifies this.

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

19. **`.claude/skills/**` writes ALWAYS prompt the user** on this harness build (Claude Code v2.1.126), even with `permissions.defaultMode: "acceptEdits"` set. This is a deliberate harness boundary — skills define automated behaviors and the harness wants explicit user consent before Claude self-modifies its own instruction set. The escape hatch is the popup's option 2 ("Yes, allow `.claude/skills/<name>/` for all projects") which writes to user-level settings (`~/.claude/settings.json`). For unattended cron operation: **never edit/create skill files**. Capture learnings in CLAUDE.md instead (see "Cron learnings" section below) and let the user convert ripe learnings to skills manually.

---

## Cron learnings (review every 24h)

This is the **dump zone for the auto-pilot cron's wave-end learnings**. The cron runs every 15 min (`3,18,33,48 * * * *`) and may not be at the keyboard to approve `.claude/skills/**` popups. So when the cron's wave-end agent surfaces a learning that *would* warrant a new skill or skill edit, it appends a bullet here instead.

**Reviewer's job (once every ~24h, when the user is at the keyboard):**
1. Read the bullets below.
2. Decide which are skill-worthy: ripe pattern, ≥2 instances, codifiable workflow.
3. Author or extend the skill manually (clicking through the harness popups, which are safe when you're present).
4. Move the converted bullet to "Promoted to skill: `/medcore-<name>`" with the commit SHA.
5. Stale bullets (> 7 days, never ripened) get deleted.

**Format for new bullets:** `YYYY-MM-DD HH:MM (commit-SHA): <one-line finding> → <suggested skill name or extension>`

### Open (cron-surfaced; not yet promoted)

- 2026-05-05 cron-tick (commits `585b757` + `4f02a2e` + `3beeeaf`): **"writes-gated, reads-bare" inverse pattern** surfaced in 3 route files now — pharmacy.ts had 4 GET handlers with no `authorize()` while POST/PATCH were gated; med-reconciliation.ts had 3 GETs bare while writes were gated; preauth.ts `GET /` honored `?patientId=` query bypass while writes were gated. **Suggested skill extension**: add a Section 4 ("inverse-pattern audit") to `/medcore-bola-sweep` codifying the discovery grep + the pattern-name. Ripe-when-promoted condition: 1 more confirming cycle would tip into "ripe" (current threshold ≥4 file instances). Discovery grep candidate: `awk` over each route file, find `router.get(` blocks lacking `authorize()` AND the file as a whole has at least one `authorize()` call elsewhere → flags "selectively-gated" files where reads slipped through. **Caveat**: naive grep produces ~50% false positives (already-helper-applied handlers don't match `authorize(` pattern); needs compound check including `assertPatientOwnsResource` AND inline `req.user.patientId` scoping.

- 2026-05-05 cron-tick (commits `3beeeaf` + `33b02c6`): **"eager-include leak in catalog endpoints"** — RIPE NOW (2 instances). (1) `apps/api/src/routes/packages.ts` `GET /:id` (catalog detail, no `patientId` FK on `HealthPackage` itself) had an eager `include: { purchases: { patient: { user } } }` block that exposed up-to-10 purchaser identities (name + phone) to ANY PATIENT hitting the catalog endpoint. (2) `apps/api/src/routes/doctors.ts` `GET /` catalog leaked `user.email + user.phone` for every doctor to PATIENT callers (booking-surface need vs. PII shape mismatch). Fix pattern across both: branch projection by role (full include for staff; minimal projection for PATIENT). **Suggested skill extension**: extend `/medcore-bola-sweep` with a "catalog vs patient-scoped resource" sub-check — when a resource has no direct `patientId` FK but its relations DO, audit the eager-include shape. **Ripe for promotion**: 2 confirming instances + the fix pattern is identical across both. Worth adding a Section 5 to the skill's workflow ("for catalog files: audit `select` / `include` shapes against the role-mask") so a future fanout agent applies the lens automatically.

- 2026-05-05 cron-tick (commit `7059900`): **Cross-patient test fixture/token identity-mismatch class** — `cross-patient-uploads-notifications-aiknowledge.test.ts` (commit `c6ceca5`) seeded `PatientDocument.uploadedBy = (fixtureDoctor).userId` but used `doctorToken = await getAuthToken("DOCTOR")` (the shared seed DOCTOR — a DIFFERENT User row from the fixture). When the test asserted DOCTOR could fetch the doc, `checkDocumentAccess()` saw `req.user.userId !== doc.uploadedBy` (different doctors) → fell through to the treating-doctor branch (no appointment seeded) → correctly 403'd. Test setup was the bug, not the helper. Fix: mint the JWT directly for the fixture doctor (mirrors the `createPatientWithToken` pattern used for patient JWTs in the same file). **Suggested skill extension**: extend `/medcore-bola-sweep`'s "Test fix" section with a guard rule — when a handler does identity comparison against `userId` / `uploadedBy` / `createdBy` (anything not `patientId`), the test MUST mint the corresponding JWT directly from the SAME User created via the fixture, not via `getAuthToken("<role>")` which returns a different seeded user. Single instance so far; ripe-when-promoted on a 2nd recurrence.

- 2026-05-05 cron-tick (commit `a5a6224`): **Express route-shadow regression class** — three different bug shapes from today's BOLA waves all surfaced by ONE failing `test.yml` run, and 2-of-3 are *cross-cutting paper-cuts* future BOLA fanouts can repeat: (a) `apps/api/src/routes/lab.ts` had `GET /results/:orderItemId` declared at line 556 — Express matched `/results/trends` and `/results/pending-verification` to the dynamic `:orderItemId` segment so the more-specific handlers (declared later) returned 404 forever. (b) `apps/api/src/routes/patients.ts:134` (introduced earlier today by `80c4b89`) called `assertPatientOwnsResource(req, res, patient.user?.id)` — passing the User row's id where the helper expects the Patient row's id; helper found no Patient row matching User.id and 403'd PATIENT-A on their own chart. **Suggested skill extension**: extend `/medcore-bola-sweep` with a "post-fix verification" lane that grep-asserts (i) static-segment routes are declared BEFORE dynamic-segment siblings of the same prefix AND (ii) every `assertPatientOwnsResource(req, res, X)` call site where `X` is a property access ends in `.patientId` or `.id` (Patient row id), NOT `.userId` or `.user.id`. Both checks are cheap (single grep + light AST) and would have flagged a5a6224's bugs at fanout-end time before the doc-roll. Ripe immediately if 1 more instance recurs in long-tail closure.

### Promoted to skill

_(empty — populated as bullets above get converted)_

### Stale / dropped

_(empty — populated by the user when learnings don't ripen in 7 days)_
