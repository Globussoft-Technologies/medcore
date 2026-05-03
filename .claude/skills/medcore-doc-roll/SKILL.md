---
name: medcore-doc-roll
description: Roll forward MedCore docs (TODO.md banner + "What landed" section, CHANGELOG.md [Unreleased], optional new SESSION_SNAPSHOT) so nothing is lost between waves of /medcore-fanout work. Reads recent commits + their bodies (which carry agent findings), categorizes them into doc destinations, deduplicates against existing entries, and pushes one consolidated docs commit. Idempotent — safe to run multiple times. Use after any /medcore-fanout wave, after any 3+ commit batch, or at end-of-session as a checkpoint.
---

# medcore-doc-roll

Captures the state of recent commits + the architectural findings agents surface in commit bodies INTO the canonical doc files (TODO.md, CHANGELOG.md, optionally a SESSION_SNAPSHOT) — so the next session, the next wave's agents, and the next reader of `git log` all see the same picture.

## Why this skill exists

`/medcore-fanout` waves ship 3-7 commits each. Each commit body usually carries a real architectural finding the agent surfaced organically: "page X has no client gate", "modal Y has bare labels", "API Z is open-auth". Without a checkpoint discipline, those findings live ONLY in `git log` until someone manually rolls them into TODO.md — and between waves we'd accumulate dozens of unrolled findings, easy to lose. This skill is the codified roll-forward.

## When to invoke

- **After every `/medcore-fanout` wave completes.** Should be the chained next step in the fanout flow.
- **After a 3+ commit ad-hoc batch** that wasn't a formal fanout.
- **At end-of-session** as a final checkpoint (or invoke `/medcore-handoff` which subsumes this for full snapshots).

Do NOT invoke when:
- The working tree has uncommitted changes (the roll commits docs; conflicting WT state will pollute the commit).
- A doc-roll commit is already the latest commit (idempotent — running again would no-op, which is fine, but pointless).
- The wave landed only doc commits (nothing to summarize that isn't already in the doc).

## Inputs

- **Optional commit-range**: e.g. "since `dde9534`" (the last doc commit), or "the last 7 commits". If omitted, auto-detect by reading the TODO.md banner's `HEAD on main = <SHA>` line and rolling everything since.
- **Optional wave label**: e.g. "2026-05-05 autopilot batch 6", "Cluster 1 sweeps + Cluster 2 E2E". If omitted, infer from commit titles.

## Workflow

### 1. Detect the roll range

```bash
cd c:/Users/Admin/gbs-projects/medcore
# Find the last doc-roll / TODO-update commit:
git log --oneline -20 --grep="docs.*TODO\|docs.*CHANGELOG\|docs.*handoff\|docs.*roll"
# OR pull the SHA from TODO.md's banner:
grep -E "HEAD on \`main\` = \`[0-9a-f]+\`" TODO.md | head -1
```

The "from" commit is whichever the banner currently references. The "to" commit is `git log -1 --format=%H origin/main`.

If the range is empty (banner SHA == origin HEAD), exit with "nothing to roll".

### 2. Extract per-commit findings

For each commit in the range:

```bash
git log <from>..<to> --format='%H%n%s%n---%n%b%n===END===' --reverse
```

For each commit body, extract:
- **The one-line summary** (subject).
- **Findings worth documenting** (lines under "Surprises" / "Findings" / "Architectural" / "Worth flagging" headers, OR any sentence beginning with "Page" / "Module" / "API" / "Modal" that describes a state of the codebase).
- **Files touched** (from `git show --stat <SHA>`).
- **Conventional-commit type** (`test(...)`, `fix(...)`, `feat(...)`, `docs(...)`, etc.) — drives which CHANGELOG section the entry lands in.

### 3. Categorize each finding into doc destinations

| Finding type | Destination |
|---|---|
| Spec/test added or fixed | TODO.md "What landed" section + CHANGELOG.md `[Unreleased] > Added` (or `> Fixed`) |
| **OPEN architectural / cross-cutting bug** | TODO.md "Open architectural follow-ups" canonical table (deduplicated, with a stable A-prefix ID like A11) — NOT just buried under a "What landed" sub-section |
| **CLOSED architectural finding** (was open, now fixed by this wave) | Move from "Open" table to "Closed (kept for log)" table in TODO.md, citing closing commit |
| New E2E coverage (route closed) | Inline strikethrough closure on the relevant `/dashboard/<route>` line in `docs/E2E_COVERAGE_BACKLOG.md` (the agent that wrote the spec usually does this; verify it landed) |
| New test-type coverage (P-list closure) | Inline annotation on the relevant `P<N>` heading in `docs/TEST_COVERAGE_AUDIT.md` |
| Convention / pattern codified | CHANGELOG.md `[Unreleased]` + project memory (out of scope here) |
| Source bug fixed | TODO.md "What landed" + CHANGELOG.md `[Unreleased] > Fixed` + if it closes an open A-finding, mark it closed in the canonical table |
| Schema migration | TODO.md "What landed" + CHANGELOG.md `[Unreleased] > Added` |
| **High-impact source bug deserving an issue** (compliance, security, data correctness) | Offer to file as a GitHub issue via `gh issue create` (ask user before filing — issues are user-managed) |

**Critical:** the "Open architectural follow-ups" table in TODO.md is
the SINGLE SOURCE OF TRUTH for live findings. The "What landed" sections
are CHRONOLOGICAL LOG ONLY. Do not let findings drift to the chronological
log without an entry in the canonical table — the next reader will miss
them. When reading commits in step 2, every architectural finding goes
THROUGH the canonical table first; the chronological log just references
the A-IDs.

### 4. Update TODO.md

a) **Refresh the banner**:
   - `HEAD on main = <new SHA>` line → update to the new HEAD.
   - "Updated: <timestamp>" → today's date + a short label for the wave (e.g. "post 7-agent Cluster 1+2 fanout").
   - If the banner cites release.yml status, refresh from `gh run list` if a relevant run completed.

b) **Append a "What landed" subsection** under the latest one. Use the same shape as existing sections in TODO.md:
   ```
   ## What landed YYYY-MM-DD — <wave label> (<N> commits)

   <1-paragraph context>

   | Commit | What |
   |---|---|
   | `<SHA>` | **<conv-commit-type> — <one-line summary>.** <body excerpt with key finding/diff> |
   | ...

   ### Architectural findings surfaced by this wave (worth flagging for future PRs)

   <numbered list, deduplicated against existing entries — see step 5 for dedup>
   ```

c) **Append architectural findings** to the consolidated "Open follow-ups / Architectural findings" section IF they're new. Critical: read existing TODO.md first and SKIP findings that are already present (substring match on the finding's distinctive keyword, e.g. "LanguageDropdown" or "AuditLog tenantId").

### 5. Deduplicate + state-track findings

Before adding a finding to TODO.md's "Open architectural follow-ups" table:
- Read TODO.md's current contents.
- Substring-search for the finding's distinctive keyword (e.g., "LanguageDropdown", "AuditLog", "openPrintEndpoint").
- If FOUND in **Open** table → skip; already tracked.
- If FOUND in **Closed** table → if this wave RE-OPENS it (regression), move back to Open with the regression context. Otherwise skip.
- If NOT FOUND → add to Open with a new A-prefix ID (next available number). Include the surfacing commit SHA.

When a wave's commits CLOSE an open A-finding (e.g., a sweep fix or a source patch):
- Move the row from "Open" to "Closed (kept for log)" with the closing commit SHA in the "Closed by" column.
- Update the Open table's A-IDs ONLY if their numbering is non-stable; otherwise leave gaps (A1 → A3 → A5 is fine — A-IDs are stable references).

This makes the skill safely idempotent (running twice produces the same TODO.md) AND lets the reader see at a glance: "Open follow-ups" = work to do; "Closed" = log of past work.

### 6. Update CHANGELOG.md `[Unreleased]`

Locate the most recent `[Unreleased]` block. Append a wave-level rollup paragraph following the existing voice:

```
- **YYYY-MM-DD wave — <label>**. <one-paragraph summary mentioning all
  N commits with a sentence each, naming the routes/specs/files
  affected and any architectural finding worth surfacing at this
  level.> Closes <existing backlog references>.
```

### 7. Commit + push

```bash
git add TODO.md CHANGELOG.md
git commit -m "docs: roll <wave label> (<N> commits, <K> architectural findings logged)

<2-4 sentence summary mentioning the wave's headline outcomes — what
got closed, what findings got surfaced, what the next session should
care about>" -- TODO.md CHANGELOG.md

# Standard rebase-retry push pattern — agents may be pushing concurrently:
for i in 1 2 3 4 5; do
  if git push origin main; then break; fi
  git fetch origin main
  git rebase origin/main
done
```

Conventional commit. **NO `Co-Authored-By: Claude` trailer** (forbidden by the user's global CLAUDE.md).

## Anti-patterns

- **Don't fabricate findings.** Only document findings that are explicitly stated in commit bodies. If an agent's body says "page has no role gate", that's documentable. If it says nothing, don't infer one.
- **Don't double-add architectural findings.** Always grep TODO.md first. Idempotency requires it.
- **Don't roll docs while the working tree is dirty.** Stash or commit your own pending work first.
- **Don't drop existing TODO.md content.** Always APPEND or update banner — never delete prior "What landed" sections.
- **Don't include doc commits in the wave's "What landed" table.** A previous `/medcore-doc-roll` commit shouldn't appear in the next roll's table — filter out commits whose subject starts with `docs:` AND were authored by this skill.
- **Don't roll if HEAD already matches the TODO.md banner SHA.** Exit early with "nothing to roll".

## Reporting

Single-paragraph report (under 200 words):
- Commit SHA of the roll commit.
- Range rolled (from-SHA..to-SHA, N commits).
- Number of architectural findings added to TODO.md (vs deduplicated as already present).
- Anything that DIDN'T fit cleanly into a category (e.g., a commit whose body had no findings — usually a refactor).

## Composability

`/medcore-doc-roll` is the natural follow-up to:
- `/medcore-fanout` (chain immediately after every wave completes — best practice)
- Any focused 3+ commit batch
- A solo session that just finished

It's also a building block of `/medcore-handoff` (TBD): handoff = doc-roll + new SESSION_SNAPSHOT_<date>.md + archive registration. If `/medcore-handoff` exists, prefer it at session boundaries; use bare doc-roll for mid-session checkpoints.

## Why this isn't built into /medcore-fanout itself

Single-responsibility. Fanout dispatches and reports. Doc-roll captures and persists. Keeping them separate means:
- Doc-roll can be invoked standalone after a non-fanout batch.
- A failed fanout (some agent crashed) can still be partially captured if needed.
- The fanout skill stays focused on its parallelism contract.

The fanout SKILL.md explicitly mentions chaining doc-roll as the recommended next step.
