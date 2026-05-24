# Doc Cleanup Proposal — 2026-05-25

These cleanups require operator confirmation. Each entry is a separate
review-able decision. Apply them one at a time after sign-off; **none
of these have been executed**.

Companion to the safe-cleanup wave that landed on 2026-05-25:

- `6c01479` — moved `docs/06-05-26-test-gaps.md` →
  `docs/archive/gaps/TEST_GAPS_2026-05-06.md` (closed gap-tracking
  artefact, misnamed at root).
- `f254b0a` — refreshed `docs/README.md` archive index (12 → 27
  SESSION_SNAPSHOT count; added TEST_GAPS_2026-05-06 entry).

## Conventions

Each entry below has:
- **Path**: file under review.
- **Verdict**: archive / delete / merge / rewrite / leave-as-is.
- **Reason**: 1-3 sentence rationale.
- **Inbound refs**: grep result so the operator can re-verify before
  acting.
- **Action**: exact command(s) to execute if approved.

---

## 1. ARCHIVE candidates (closed-in-place that I didn't move autonomously)

### 1.1 `HANDOFF.md` (root) — archive to `docs/archive/HANDOFF_2026-05-14.md`

- **Path**: `/HANDOFF.md`
- **Verdict**: archive (rename + move)
- **Reason**: The file is a dated 2026-05-14 session handoff
  (`# MedCore Session Handoff — 2026-05-14 → office pickup`). The
  current handoff is `docs/archive/SESSION_SNAPSHOT_2026-05-22-afternoon.md`
  (8 days newer). The "First commands at the office" instructions are
  stale (references gone-merged PRs #784/#783/#906). `TODO.md`'s top
  banner already points to the 2026-05-22 snapshot, so nothing live
  reads HANDOFF.md anymore.
- **Inbound refs**: 3 in `TODO.md` (lines 286, 324, 361) — all are
  historical narrative bullets ("HANDOFF.md's 'Next 16 will clear
  audit' prediction was wrong"), NOT live links. Safe to break those
  references; the operator just needs to know they exist.
- **Risk**: low. Moving it out of root signals to a returning operator
  to read `TODO.md` (the live banner) rather than the stale HANDOFF.
- **Action**:
  ```
  git mv HANDOFF.md docs/archive/HANDOFF_2026-05-14.md
  git commit -m "docs(archive): move stale HANDOFF.md to docs/archive/" \
    -- HANDOFF.md docs/archive/HANDOFF_2026-05-14.md
  ```
- **Why I didn't auto-apply**: root-level file + 3 TODO.md prose
  references + CLAUDE.md lists TODO.md as hands-off → wanted explicit
  approval before touching the surfaces around it.

---

## 2. DELETE candidates

None this pass. Every doc under review either (a) carries historical
context the operator may want to grep later or (b) is still a live
reference.

---

## 3. MERGE candidates

### 3.1 `docs/LOCAL_TESTING.md` + `docs/LOCAL_E2E.md`

- **Paths**: `docs/LOCAL_TESTING.md` + `docs/LOCAL_E2E.md`
- **Verdict**: leave-as-is (NOT merge) — listed for transparency
- **Reason looked at it**: Both are short, both wrap a single
  `scripts/run-*-locally.sh`, both describe local-CI-mirroring runners.
  Looks like a merge candidate at first glance.
- **Why leaving alone**: the two scripts mirror DIFFERENT CI gates
  (`test.yml` vs `release.yml`); the e2e runner is
  explicit-invocation-only (per TEST_PLAN §3 Layer 5) while the
  test-runner is the default tier. Merging would muddy that gating
  distinction. `docs/README.md` cleanly distinguishes them. Skip.

### 3.2 `docs/TEST_PLAN.md` + `docs/SYSTEM_TEST_PLAN.md`

- **Verdict**: leave-as-is (NOT merge)
- **Reason**: SYSTEM_TEST_PLAN is aspect-oriented (auth /
  clinical-safety / money paths / RBAC) — TEST_PLAN is layer-oriented
  (unit → integration → e2e). They're complementary axes, not
  duplicates. README already explains the relationship.

---

## 4. SIGNIFICANT REWRITE candidates

### 4.1 `docs/E2E_COVERAGE_BACKLOG.md` — content drift since 2026-05-05

- **Path**: `docs/E2E_COVERAGE_BACKLOG.md`
- **Verdict**: refresh banner + counts (NOT delete)
- **Reason**: Top banner says "Status update 2026-05-05" and "131
  spec files". Since then several Pearl-driven E2E waves have shipped
  (e.g. the 2026-05-22 cron added more specs). If the operator picks
  up an item from the §C-onwards backlog without re-verifying, they
  may scaffold a spec that already exists.
- **Risk**: the inline `(date / spec / commit / summary)` closure
  annotations are still authoritative for the entries that were
  closed; only the top banner + open-count statistics are stale.
- **Recommendation**: a 30-min refresh pass to update the banner
  (current spec count, current HEAD, "recently closed since 2026-05-05"
  bullet list) without touching the per-entry annotations. Not a >30%
  content change, just a banner + summary refresh. Could be folded
  into the next medcore-doc-roll wave.
- **Why I didn't auto-apply**: requires reading the e2e/ directory and
  cross-checking against recent commits — outside the 30-min cap for
  this cleanup.

### 4.2 `docs/TEST_COVERAGE_AUDIT.md` — content drift since 2026-05-03

- **Path**: `docs/TEST_COVERAGE_AUDIT.md`
- **Verdict**: refresh banner + §1 snapshot counts (NOT delete or
  archive)
- **Reason**: Banner says "As of 2026-05-03: ~510 new test cases
  shipped today" and "README total: ~2,700+ active cases". The §3
  "test types ABSENT" backlog (the active future-direction list) is
  still valid — Storybook, Pact, property-based, mutation testing,
  mobile E2E remain absent or partial. But the §1 snapshot numbers
  and §5 Top-10 status are stale.
- **Recommendation**: same as 4.1 — refresh banner + §1 counts
  without rewriting §3. Defer to the next doc-roll wave.

### 4.3 `docs/MYKARE_GAP_ANALYSIS.md` — still load-bearing, watch for stale claims

- **Path**: `docs/MYKARE_GAP_ANALYSIS.md`
- **Verdict**: leave-as-is for now
- **Reason**: explicit "INTERNAL ONLY — sales / public claims now
  ahead of code" banner, dated 2026-05-16. Captures real build
  commitments. Operator should re-verify monthly whether the 5
  Mykare-parity capabilities (AI Voice Receptionist, Outbound
  Follow-up Agent, etc.) have shipped — but no signal in this pass
  that any have. Living reference with a built-in expiry; trust the
  banner.

---

## 5. CLOSURE candidates for living refs

### 5.1 `docs/CI_HARDENING_PLAN.md`

- **Path**: `docs/CI_HARDENING_PLAN.md`
- **Verdict**: archive (move to `docs/archive/`)
- **Reason**: Top banner says "ALL GATING PHASES SHIPPED. Phases 1,
  2, 3, and 4.2 are live on `main`. Phase 4.1 + 4.3 are user-owned
  ops items tracked in `/TODO.md`." The work is done; nothing in
  here is a future to-do. It's a historical record of why each CI
  gate exists — exactly the shape of an `archive/` artefact.
- **Inbound refs**: `docs/README.md` "Testing & CI" section links to
  it. Update that link if archiving.
- **Risk**: low. The document remains valuable historical context for
  "why does CI run `npm audit` here?" — but it belongs alongside
  TODO_2026-04-29.md, not next to TEST_PLAN.md.
- **Action**:
  ```
  git mv docs/CI_HARDENING_PLAN.md docs/archive/CI_HARDENING_PLAN.md
  # then update docs/README.md "Testing & CI" section to either drop
  # the link or repoint it to docs/archive/CI_HARDENING_PLAN.md
  git commit -m "docs(archive): move shipped CI_HARDENING_PLAN to archive/"
  ```
- **Why I didn't auto-apply**: it's a CLAUDE.md test-ops adjacency
  file and the operator may have a specific opinion on whether
  shipped multi-phase plans archive or stay in `docs/` as a
  "lessons-learned" artefact (vs the existing convention which only
  archives fully-closed *gap-tracking* docs).

---

## 6. ORPHANS

### 6.1 `docs/TESTER_PROMPT.md`

- **Path**: `docs/TESTER_PROMPT.md`
- **Verdict**: leave-as-is
- **Reason**: paste-ready prompt for an external Chrome-plugin QA
  agent. Listed in `docs/README.md` under "Testing & CI". Has real
  per-role seeded credentials. Looks orphaned because it's not
  obviously a "doc" — but it's the live source of truth for that
  workflow.

---

## Summary

| Section | Verdict | Count |
|---|---|---|
| 1. ARCHIVE | needs approval | 1 (`HANDOFF.md`) |
| 2. DELETE | none | 0 |
| 3. MERGE | none recommended | 0 |
| 4. REWRITE | banner-refresh suggestions, no rewrite | 3 (E2E_COVERAGE_BACKLOG, TEST_COVERAGE_AUDIT, MYKARE_GAP_ANALYSIS [watch]) |
| 5. CLOSURE for living refs | needs approval | 1 (`CI_HARDENING_PLAN.md`) |
| 6. ORPHANS | none | 0 |

**Total risky items awaiting operator review**: 2 (HANDOFF.md
archive + CI_HARDENING_PLAN.md archive). The 3 banner-refresh items
are best folded into the next `/medcore-doc-roll` wave, not handled
as discrete commits.
