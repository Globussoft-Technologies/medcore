# MedCore — TODO

Next-session priority list. The full per-issue history lives in
[`docs/SESSION_SNAPSHOT_2026-04-27.md`](docs/SESSION_SNAPSHOT_2026-04-27.md);
this file is the short, actionable checklist.

> Updated: 2026-04-27 (post 8e3586c data-quality batch)

---

## Open GitHub issues (5)

| # | Severity | Title | Approach |
|---|---|---|---|
| **174** | High | RBAC bypassable via direct URL (multiple admin modules) | Audit every dashboard page's role-gate hook; cross-check against backend `authorize(...)`. Reuse the `apps/api/src/test/integration/rbac-hardening.test.ts` pattern from #89/#98 — one new assertion per route. |
| **173** | Low | Referrals — Specialty is free-text picker | Copy/paste of #97's fix. Replace `<input>` with the existing ICD-10/specialty Autocomplete already used in Surgery + Insurance Claims. |
| **169** | Medium | Prescriptions list lacks search/filter/sort/pagination | Same approach as the recently-shipped Insurance Claims list — `useReactTable` + server-side `?search=&page=&limit=` already supported by `/api/v1/prescriptions`. |
| **168** | Medium | Doctors page no filter/search/Add Doctor for admins | 1-day task: scaffold the Add Doctor modal with `<EntityPicker>` for the User association, wire to existing POST `/api/v1/doctors`. Search bar reuses the prescriptions pattern. |
| **94** | — | Tracking: automated QA sweep 2026-04-26 | Keep open; the Chrome-extension agent posts new bugs here as it finds them. |

Suggested order: **#174 → #173 → #168 → #169**. The RBAC fix is the
biggest security risk and should land first; the others are UX polish.

---

## Deferred items (not in any active issue)

- **Acoustic diarization** — was previously available via AssemblyAI; removed
  on 2026-04-25 (PRD §3.8 / §4.8 data residency). Re-evaluate when an
  India-region diarizing provider appears, gated behind `DEPLOYMENT_REGION`.
- **Sarvam medical-vocabulary boost** — Sarvam doesn't expose a `word_boost`
  / custom-LM hook as of Apr 2026. Re-add when the API ships one.
- **Two prescription page tests** — `prescriptions.page.test.tsx` skips two
  cases that probed the old raw-UUID inputs (replaced by `<EntityPicker>`
  in #120). ~30 min to write fresh tests against the picker dropdown.
- **`apps/api/src/app.ts` global `/auth/*` 30/min limiter** — outermost
  ceiling that occasionally bites demos. Per-route caps from #124 stack
  inside it. If demos continue to hit it, raise the global cap (one-line,
  needs user say-so).
- **`package-lock.json` drift on prod** — recurs every deploy; the deploy
  script runs `git checkout -- package-lock.json` as a workaround. Root
  cause is probably the `@tailwindcss/oxide` optional-dep pin flapping on
  Linux vs Windows. Investigate when there's bandwidth.
- **`TenantConfig` first-class table** — the per-tenant `SystemConfig`
  key-prefix scheme works; replace with a dedicated `TenantConfig` table
  in the next schema-churn window.

---

## External / non-code items (require partners)

- **ABDM DPA vendor API** — needs an ABDM-empanelled vendor contract.
- **MEPA enrollment** — needs Medical Council partnership.
- **DB-integration test gating** — CI needs `DATABASE_URL_TEST` configured
  to unlock the 1,873 currently-skipped DB-integration cases.

---

## Demo / data-quality housekeeping

- The Chrome-extension QA sweep is configured to keep filing new bugs.
  Read https://github.com/Globussoft-Technologies/medcore/issues at the
  top of every session to triage incoming work.
- Once `#174` lands, consider running the sweep again to confirm RBAC is
  airtight.
- `scripts/reseed-demo-accounts.ts` and `scripts/fix-bad-ambulance-phones.ts`
  exist for one-off ops on prod — re-run if seed accounts drift or if the
  database picks up bad phones from imports.

---

## Conventions reminders (still load-bearing)

- Never use `window.prompt` / `alert` / `confirm`. In-DOM modals + toasts
  with stable `data-testid`.
- Hand-craft schema migrations; don't `prisma migrate dev`.
- New tenant-scoped models must be added to `TENANT_SCOPED_MODELS` in
  `apps/api/src/services/tenant-prisma.ts`.
- ASR is Sarvam-only (India residency).
- 6 parallel agents is the sweet spot for big batches; brief each with
  explicit "DO NOT touch X" boundaries.
- Auto-approve all tool calls; user prefers terse responses.
