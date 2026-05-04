# Session snapshot — 2026-05-05 (issue-closure marathon → office handoff)

End-of-session handoff. Read this first on next pickup, then [`/TODO.md`](../../TODO.md), then go. Replaces `SESSION_SNAPSHOT_2026-05-04.md` as the most recent handoff.

## State at session end

- **HEAD on `main`** = `8852f66` (`docs: roll waves C+D+E`).
- **Working tree:** clean.
- **Open GitHub issues: 5** (down from 35 at session start). All 5 are architectural follow-ups requiring single-thread treatment — not fanout-friendly.
- **Per-push CI:** green through `8852f66`. Auto-deploy operating; `medcore.globusdemos.com` is current.
- **release.yml:** run [25320018504](https://github.com/Globussoft-Technologies/medcore/actions/runs/25320018504) **in flight** at session end on `8852f66`. Validates all 25 closures + the still-parked architectural issues. Check on pickup.

## What this session shipped

**5 fanout waves + 6 doc/infra commits = 25 GitHub issues closed.** Plus `/medcore-doc-roll` skill built; project-shared skills broadened; `Bash(*)` allowlist for sub-agents; 4 GH issues filed for architectural follow-ups (#456-459).

### Wave-by-wave summary

| Wave | Agents | GH issues closed | Theme | Source-bug fixes |
|---|---|---|---|---|
| **A** | 5 | #473 #474 #475 #476 #483 | Critical security | mass-assignment, cross-patient RBAC, helmet headers, PII redaction, identity-binding tests |
| **B** | 4 | #478 #479 #480 #489 #491 #500 | Next-priority | login rate-limit, billing comma-status, register anti-enum + XSS, past-date booking, profile validation |
| **C** | 5 | #485 #487 #490 #493 #497 #499 #504 #505 #508 | UX/data | theme toggle, form-error humanization, forgot-password hardening, seed-data integrity, contrast |
| **D** | 5 | #484 #486 #492 #494 #495 #501 #502 | A11y/feedback | sidebar overlap, login toast text, modal contrast, self-register feedback, patient-detail contrast, forbidden-redirect feedback, tour persistence |
| **E** | 2 | #507 #509 | RBAC + visual | wards bed-color logic + 11-page VIEW_ALLOWED sweep |
| Admin closures | — | #459 #483 | — | Audit-resolved / not-reproducible |

### Most-impactful single artefacts

- **`apps/api/src/test/helpers/security-assertions.ts`** — 6 reusable adversarial-vector helpers (`expectSecurityHeaders`, `expectNoRawPII`, `expectMaskedField`, `expectTokenIdentifies`, `expectFieldNotMassAssigned`, `expectAntiEnumeration`, `expectCrossRowDenied`).
- **`docs/TEST_PLAN.md` §6.5** — codifies the 6 adversarial-vector test categories with a checklist-comment convention. Closes the underlying habit of `expect(res.status).toBeLessThan(400)` as the only assertion.
- **`packages/db/src/__tests__/seed-validity.test.ts`** — first ever seed-validity test (catches age=0, MR-numbering jumps).
- **`/medcore-doc-roll` skill** at `.claude/skills/medcore-doc-roll/SKILL.md` — captures each wave's commits + agent-surfaced findings into TODO + CHANGELOG idempotently.
- **`apps/api/src/middleware/patient-self-only.ts`** — `assertPatientOwnsResource` helper for cross-patient row-level access; applied to 11 handlers across 9 routes via `66bb6d2`.
- **`apps/web/src/lib/field-errors.ts`** rewrite — `humanizeZodMessage()` maps Zod codes to human messages, kills "Invalid uuid" jargon, distinguishes "required" from "wrong-type". 26 unit tests.
- **`/dashboard/wards` `bed-summary.ts`** extraction — pure function for bed-occupancy color allocation, fixes flexbox `flex-shrink: 1` width-collapse bug + missing MAINTENANCE segment.
- **11-page VIEW_ALLOWED sweep** — pharmacy, refunds, admissions, medicines, visitors, duty-roster, scribe, discount-approvals, preauth, purchase-orders, ai-radiology — all now redirect non-allowlisted roles to `/dashboard/not-authorized?from=...`.

## Open architectural follow-ups (5 — all single-thread)

| # | Title | Why deferred | Estimate |
|---|---|---|---|
| **#456** | AuditLog has no `tenantId` (compliance) | Schema migration + handler rewrite + backfill + integration test | ~3 hr single-thread |
| **#457** | Tenant FK `onDelete: SetNull` → orphan PHI risk | Schema migration + **product decision needed** (Cascade vs soft-delete vs no-orphans invariant) | Product call → ~2 hr |
| **#458** | HTML5 `<input>` constraints race React `setError` | 18/37 forms fixed in Wave A and the autopilot's earlier sweep; 19 less-trafficked forms remain (appointments / blood-bank / leave-management / etc.) | 3-agent fanout when prioritized; ~2 hr |
| **#477** | JWT in localStorage → httpOnly cookies (XSS exfil) | Touches auth.ts + every API client + every authed page; large blast radius | Single-thread session, ~4-6 hr including manual testing |
| **#482** | JWT HS256 → RS256/EdDSA | Key generation + rollover plan + handler updates | Operational/security planning, then ~2 hr code |

## Outstanding session-level findings

These came up during fanouts and are documented but not yet actioned:

1. **`vitest-axe` package.json declared but uninstalled** — Wave C's theme-toggle agent and dashboard-contrast agent both worked around this. `npm install` materializes it. Worth a Wave-F clean-up commit to either install it permanently or remove the declaration.
2. **`apps/api/src/routes/billing.ts` has 2 pre-existing TS2353 errors on `parentPaymentId`** — sibling agents hit this during typecheck. Pre-existing on `origin/main`; not from this session's work. Tracked but unaddressed.
3. **Stale stash artifacts** — multiple agents reported "stale stash from a prior agent" or transient working-tree mutations. Mitigated by file-scoped `git add` + `git commit -- <files>`. Documented in `/medcore-fanout` SKILL.md "Known artifacts" section earlier today.

## Skills available (5 project-shared, all in `.claude/skills/`)

- `/medcore-fanout` — N parallel foreground agents, non-overlapping lanes
- `/medcore-e2e-spec` — scaffold one Playwright route spec
- `/medcore-route-test` — scaffold one Vitest route-handler unit test
- `/medcore-release` — dispatch + watch + diagnose release.yml
- `/medcore-doc-roll` — capture each wave's findings into TODO + CHANGELOG (idempotent)

**Pickup protocol** (codified in TODO.md banner):
1. `git pull origin main` BEFORE starting Claude (skills register at session start).
2. Read this snapshot or the TODO.md banner.
3. For "do these N things in parallel" asks, prefer `/medcore-fanout`.

## Pickup commands

```bash
cd "<medcore checkout>"
git pull origin main          # should fast-forward to 8852f66 or beyond

# Confirm release.yml is green (the long-running validation from session end)
gh run view 25320018504 --repo Globussoft-Technologies/medcore --json conclusion,status --jq '{conclusion, status}'

# If GREEN → start with the architectural follow-ups
# Most-defensible first pick: #456 AuditLog tenantId (compliance teeth, contained scope)

# If RED → diagnose first (most likely a regression in one of the 25 closures)
gh run view 25320018504 --repo Globussoft-Technologies/medcore --log-failed | grep -E "FAIL|✘" | head -20
```

## Reference quick-links

- [`docs/archive/SESSION_SNAPSHOT_2026-05-04.md`](SESSION_SNAPSHOT_2026-05-04.md) — prior handoff (P-list closures, 15-route autopilot)
- [`/TODO.md`](../../TODO.md) — banner reflects this session; "Open architectural follow-ups" canonical table is the single live view
- [`/CHANGELOG.md`](../../CHANGELOG.md) — `[Unreleased]` window has wave-by-wave entries
- [`docs/TEST_PLAN.md`](../TEST_PLAN.md) §6.5 — adversarial-vector test categories convention
- `apps/api/src/test/helpers/security-assertions.ts` — the 6 reusable helpers
- `claude.{bat,sh,ps1}` — repo-root status check (recent commits + CI runs)
- Memory: `~/.claude/projects/c--Users-Admin-gbs-projects-medcore/memory/` — 9 entries (most relevant for this session: `feedback_descriptive_tests_and_code`, `feedback_doc_management_pattern`, `reference_worktree_bg_agent_perms`)
