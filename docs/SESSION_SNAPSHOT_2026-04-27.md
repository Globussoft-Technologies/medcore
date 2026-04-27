# MedCore — Session snapshot, 2026-04-27 (refreshed end-of-day)

End-of-day handoff for the next Claude Code session. Supersedes
`SESSION_SNAPSHOT_2026-04-26.md` (kept as historical checkpoint).

---

## TL;DR

- **HEAD:** `8e3586c` — closes 5 data-quality bugs (#166, #167, #170,
  #171, #172) and retires 3 long-standing seed-script TS errors. Marketing
  landing page + README refreshed with the latest feature list.
- **Prod:** medcore.globusdemos.com — last deploy was `92fe51a` (the
  56-issue sweep batch); the data-quality + docs commits will be deployed
  on the next cycle. PM2 healthy, `/api/health` 200.
- **Tests:** apps/api **1,208 / 0** active passing (+1,873 DB-integration
  skipped); apps/web **608 / 0** + 2 deliberately skipped. Typecheck clean
  across api / web / shared / **db** (the seed-script errors are gone).
- **Open issues:** 5 — tracker `#94` + 4 from the sweep (`#168`, `#169`,
  `#173`, `#174`). The 5 data issues from this morning are all closed.

---

## What landed today (2026-04-27)

Three commits, all on `main`:
- `92fe51a` — six-agent batch closing #95–#165 (deployed yesterday)
- `8e3586c` — data-quality batch closing #166, #167, #170 (Critical
  Pediatric crash), #171, #172; plus seed-script TS-error cleanup
- `<docs>` (next commit, not yet pushed) — marketing landing page +
  README + this snapshot refresh

Plus the 4 closed-as-duplicate yesterday: #115, #126, #131, #154.

### Data-quality fixes (commit 8e3586c)

- **#170 Critical Pediatric crash** — root cause was twofold: the
  `GET /patients/:id` route used a single `findUnique` with a wide
  `include` that 503'd on any failing relation, and the page spread
  the response into `Math.max(...)` without coercing to array. Backend
  now splits into independent queries with `.catch(() => [])` per
  relation; page coerces every iterated field.
- **#172 Lab QC empty** — seeded 80 Levey-Jennings entries (8 reference
  targets × 10 days) so the QC page renders.
- **#167 age=0 silently** — `superRefine` rejects age=0 unless DOB is
  provided (newborn path).
- **#166 email format** — surfaced `data-testid="error-email"` + zod
  regex on the patient registration form.
- **#171 Required patient on ANC + Emergency** — picker is `required`,
  zod refine forces `patientId` (or `unknownName` for trauma).
- **Seed-script TS errors retired** — `seed-lab-data.ts:256` (type-guard
  helper) + `seed-realistic.ts:344, :364` (widen-cast). `packages/db`
  now typechecks clean.

### Notable groupings closed

- **Auth + RBAC + sessions** (#98, #99, #101, #102, #124, #125, #128,
  #132, #138, #164) — `/auth/login` 20/min, `/forgot-password` 5/min,
  friendly 429 body, IP-lockout service (5 fails / 15 min → 15 min),
  global 401 web interceptor, RECEPTION blocked from Pharmacy writes /
  Controlled Register / Expenses (extends DOCTOR fix from #89),
  reseed-demo-accounts.ts script.
- **Validation** (#95, #96, #97, #103, #104, #120, #138, #141, #146) —
  Lab Results numeric enforcement, Patient name regex (Indian
  honorifics + Devanagari), duplicate-phone 409, Pharmacy Add Stock min
  validation, Surgery diagnosis ICD-10 picker, Prescription EntityPicker,
  ambulance phone cleanup script.
- **Dark mode + theme** (#105–#117 minus #115, #129, #133–#135, #140,
  #142, #145, #149–#153) — 22 pages updated, sidebar token in
  globals.css, theme toggle now flips sidebar correctly.
- **KPI / dates / stale workflows** (#108, #109, #119, #121, #139, #148,
  #159, #160, #161, #162, #163, #165) — canonical revenue helper,
  `elapsedMinutes()` clamping, daily auto-cancel-stale-surgeries +
  auto-assign-overdue-complaints scheduled tasks, MISSED_SCHEDULE row
  hides Start.
- **Routing + AI** (#100, #123, #136, #143, #144, #155, #156, #157,
  #158) — static-segment redirects (patients/register, blood-bank,
  medication, ot), branded /not-found.tsx, AI Scribe + Triage 500
  fixes, AI Radiology bounded polling, GET /api/v1/ai/scribe list.
- **UX polish** (#102, #118, #122, #127, #130, #137, #147) — login
  noValidate, walk-in success card, onboarding-skip persistence,
  forgot-password dark mode, registration multi-error display, dashboard
  language switcher, lab range-hint dedup.

### New scripts added

- `scripts/reseed-demo-accounts.ts` — idempotent upsert of 7 demo
  personas (run on prod after deploy if seed accounts don't authenticate).
- `scripts/fix-bad-ambulance-phones.ts` — dry-run by default, `--apply`
  writes; clears non-`/^\+?\d{10,15}$/` ambulance phones to NULL.

---

## Carry-over for next session

The QA sweep is still running and filing issues. Active queue at EOD:

| # | Severity | Title (short) |
|---|---|---|
| 174 | High | RBAC bypassable via direct URL (multiple admin modules) |
| 173 | Low | Referrals — Specialty is free-text (same as #97) |
| 169 | Medium | Prescriptions list lacks search/filter/sort/pagination |
| 168 | Medium | Doctors page no filter/search/Add Doctor for admins |
| 94  | — | Tracker (keep open) |

Priority order for the next session:
1. **#174 High RBAC bypass** — security regression beyond #98. Audit
   every dashboard page's role-gate, then probe each `/api/v1/*` route
   for missing `authorize(...)`.
2. **#173 Referrals specialty picker** — copy/paste of #97's fix
   (the ICD-10 EntityPicker for Surgery diagnosis).
3. **#168 Doctors page admin actions** — adds an Add Doctor flow + search
   (likely a 1-day task: scaffold the modal, wire to existing POST
   /api/v1/doctors, add `<EntityPicker>` for the User association).
4. **#169 Prescriptions list controls** — pagination/filter pattern
   (the same approach as the recently-shipped Insurance Claims list
   would work).

Open the GitHub issues page first thing — the sweep is configured to
keep batching new bugs. Rough heuristic: spawn one agent per cluster
of 4–6 related issues; the parallel pattern from today's run worked
well (1.2k API tests + 600 web tests, all green at end).

### Known follow-ups, not in any issue yet

- The two web tests skipped today (`prescriptions.page.test.tsx` —
  malformed UUID + negative dosage) need fresh versions that drive the
  EntityPicker dropdown rather than typing into raw inputs. ~30 min of
  test plumbing.
- `package-lock.json` drift on prod still recurs; `git checkout --
  package-lock.json` is the workaround in the deploy script.
- `apps/api/src/app.ts` global `/auth/*` 30/min limiter is the outermost
  ceiling that occasionally bites demos. The per-route caps added today
  stack inside that. If demos continue to hit it, raise the global cap
  (one-line change in `app.ts` — needs the user's say-so).

---

## Conventions reminders (still load-bearing)

- Never use `window.prompt` / `alert` / `confirm`. Always in-DOM
  modal/toast with `data-testid`.
- Hand-craft schema migrations; don't `prisma migrate dev`.
- New tenant-scoped models go in `TENANT_SCOPED_MODELS` in
  `apps/api/src/services/tenant-prisma.ts`.
- ASR is Sarvam-only (India-region). AssemblyAI + Deepgram were removed
  on 2026-04-25 due to PRD §3.8/§4.8 data-residency.
- Auto-approve all tool calls; user prefers terse responses, no trailing
  summaries.

---

## Pickup checklist for the next session

```
1. Read this file.
2. Fetch latest: git pull origin main
3. Verify working tree: git status (should be clean)
4. Sanity:
   cd apps/api && npx tsc --noEmit
   cd ../web && npx tsc --noEmit
   cd .. && npx vitest run --reporter=dot
5. Open https://github.com/Globussoft-Technologies/medcore/issues
   — note any new issues filed overnight by the sweep.
6. Spawn agents per the priority order above.
7. After every batch: typecheck + tests + commit + deploy + close
   GitHub issues with per-fix comments.
```

The deploy pattern that's been working all week:

```bash
# Local pre-flight
cd apps/api && npx tsc --noEmit && cd ../web && npx tsc --noEmit
cd "d:/gbs projects/medcore" && npx vitest run --reporter=dot

# Commit + push (multi-line message via heredoc; see prior commits for format)
git add -A
git commit -m "..."
git push origin main

# Deploy (Plink + 1Password-stored host key)
plink -ssh -batch -pw <pwd> -hostkey SHA256:DXDaCOdx65e8JeRoH4rI7AXcmW5Ge+e+D7rXFe2U5mw \
  empcloud-development@163.227.174.141 \
  "cd medcore && git checkout -- package-lock.json 2>/dev/null; bash scripts/deploy.sh --yes"
```

Ready when you are.
