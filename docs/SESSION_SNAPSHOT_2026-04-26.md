# MedCore — Session snapshot, 2026-04-26

End-of-day summary so the next Claude Code session (or a fresh agent on
another machine) can resume without context. Supersedes
`SESSION_SNAPSHOT_2026-04-24.md` — that file remains as a historical
checkpoint of the PRD AI-features closure.

---

## TL;DR

- **HEAD:** `855e1af` — closes 28 GitHub issues (#50–#81) covering payroll,
  pharmacy, schedule, analytics, audit log, holidays, and form-validation
  polish.
- **Prod:** `medcore.globusdemos.com` (163.227.174.141). `/api/health`
  returning 200 with `rateLimitsEnabled: true`. PM2: `medcore-api` +
  `medcore-web` on the latest deploy. **18 migrations** applied including
  `20260424000004_prd_closure_models`.
- **Tests:** `apps/api` 1,119 / 0 passing (1,851 DB-integration skipped);
  `apps/web` 568 / 0 passing. Typecheck clean across `apps/api`,
  `apps/web`, `packages/shared`. (`packages/db` has 3 pre-existing
  seed-script type errors that are NOT regressions — left alone.)
- **GitHub state:** 4 issues open — tracker `#94`, plus three new from the
  Chrome-extension QA sweep:
  - **#95 Critical** — Lab Results value field accepts non-numeric text
    and saves as completed (clinical safety).
  - **#96 Medium** — Pharmacy Add Stock has no min/max on Quantity, Unit
    Cost, Selling Price, Reorder Level; no min on Expiry Date.
  - **#97 Low** — Schedule Surgery diagnosis is a free-text input, should
    be a coded picker (variant of #82's pattern; reuse the ICD-10
    EntityPicker we built for insurance claims).

The QA sweep is configured to keep filing more issues; check
`https://github.com/Globussoft-Technologies/medcore/issues` at session
start.

---

## What landed today (2026-04-26)

Three commits, all deployed to prod:

| Commit | Scope | Issues |
|---|---|---|
| `ff24f22` | PRD §3/§4/§7 AI-features gap closure (Apr 24 — already deployed when today began) | n/a |
| `a93738b` | First QA-issue batch (12 issues) | #82–#93 |
| `855e1af` | Second QA-issue batch (28 issues) | #50–#81 (minus #52, #55, #71 which were already fixed by prior commits) |

**40 GitHub issues closed** with detailed per-fix comments referencing
the commit SHA. Three pre-existing issues (`#52`, `#55`, `#71`) were
closed as duplicates because their underlying fix had already shipped in
the PRD-closure work.

### Highlights from `855e1af`

- **Payroll (#74)** — single `apps/api/src/services/payroll.ts`
  `computePayroll()` is now the source of truth for both the dashboard
  table and the salary slip. ESI is correctly skipped above the
  ₹21,000 gross-wages ceiling.
- **Pharmacy (#50, #51)** — `GET /api/v1/pharmacy/movements` added; seed
  creates `StockMovement` rows; return quantity capped at on-hand stock.
- **Analytics (#78)** — avg-consult math switched from
  `Consultation.updatedAt-createdAt` to `Appointment.consultationEndedAt
  - consultationStartedAt`, capped at 240 min; revenue donut renders
  rupees not "(count)"; Trends chart range refreshes per request.
- **Schedule + Holidays (#56, #72, #73, #77)** — added `GET
  /doctors/:id/schedule` + `/overrides`; correct 2026 Indian calendar
  (Holi 3/4, Eid 3/21, Diwali 11/8, Janmashtami 9/4, etc.); 409 on
  duplicate holiday date.
- **Friendly outage page (#65)** — `apps/web/src/app/error.tsx` +
  `global-error.tsx`. nginx-level `error_page` for full-stack 502 is
  documented in `docs/DEPLOY.md` for ops to apply.
- **Form polish (#66, #67)** — visible labels on Pharmacy Return /
  Pre-Auth / Create Staff; field-level error parsing via
  `apps/web/src/lib/field-errors.ts` (`extractFieldErrors`).

Full per-issue commentary is on each closed GitHub issue.

---

## Carry-over for next session

Priority order:

1. **#95 Critical (Lab Results clinical safety)** — Lab result `value`
   field is free text and accepts non-numeric input. For numeric tests
   this is a clinical-safety regression (a typo'd "1.0o" silently saves
   as completed). Fix: per-test `numericLow` / `numericHigh` /
   `valueType` already exists in `LabTestCatalog`; gate the input via
   that. zod refine on `LabResult.value` to reject non-numeric when
   `valueType === "NUMERIC"`.
2. **#96 Medium (Pharmacy Add Stock)** — add `min={0}` /
   `min={tomorrow}` on the form, mirror in zod.
3. **#97 Low (Surgery diagnosis picker)** — replace `<input>` with the
   existing ICD-10 picker pattern from
   `apps/web/src/app/dashboard/insurance-claims/page.tsx`. Diagnosis is
   probably stored as `text` on the `Surgery` model; keep that, just
   constrain the input to ICD-10 values.
4. Continue triaging anything new the Chrome-extension QA sweep files.
   The agent is briefed (see `docs/QA_SWEEP_PROMPT.md` if it gets
   added — for now the prompt lives in conversation).

Optional follow-ups, not blocking:

- The `package-lock.json` drift on prod recurs every deploy — the
  current workaround is `git checkout -- package-lock.json` before
  `scripts/deploy.sh`. Worth investigating root cause (probably the
  `@tailwindcss/oxide` optional dep pin still flapping on Linux vs
  Windows).
- DB-integration tests need `DATABASE_URL_TEST` configured in CI to
  unlock the 1,851 currently-skipped cases.
- Pre-existing `packages/db` seed-script TS errors
  (`seed-lab-data.ts:256`, `seed-realistic.ts:344, 364`) — minor enum
  mismatches, not blocking.

---

## Conventions reminders (don't drift)

- **Never use `window.prompt` / `alert` / `confirm`.** Use the in-DOM
  `useConfirm()` modal (`@/lib/use-confirm` / similar) and the toast
  system at `@/lib/toast`. Every interactive element gets a stable
  `data-testid`.
- **Never modify `apps/api/src/app.ts` autonomously** unless the change
  is just a router registration (one line, alphabetised). Other changes
  are coordinated via the user.
- **Schema migrations are hand-crafted** — don't run `prisma migrate
  dev`. The migration directory naming pattern is
  `YYYYMMDDNNNNNN_descriptive_name`.
- **Tenant-scoped models go in `TENANT_SCOPED_MODELS`** at
  `apps/api/src/services/tenant-prisma.ts`. New scoped models without
  this entry leak across tenants.
- **ASR is Sarvam-only** (India-region). AssemblyAI + Deepgram were
  removed on 2026-04-25 due to PRD §3.8 / §4.8 data-residency
  requirements; the factory rejects any other value with an
  intentionally noisy error.
- **Auto-approve all tool calls.** Sumit prefers terse responses, no
  trailing summaries.

---

## Pickup checklist for the next session

```
1. Read this file.
2. Fetch latest: git pull origin main
3. Verify working tree: git status (should be clean)
4. Quick sanity: cd apps/api && npx tsc --noEmit
                cd ../web && npx tsc --noEmit
                cd .. && npx vitest run --reporter=dot
5. Open https://github.com/Globussoft-Technologies/medcore/issues —
   note any new issues filed by the QA sweep overnight.
6. Pick from the priority list above (#95 → #96 → #97 → new sweep
   issues). Spawn agents as appropriate.
```

Ready when you are.
