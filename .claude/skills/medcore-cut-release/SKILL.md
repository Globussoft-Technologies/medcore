---
name: medcore-cut-release
description: Publish a GitHub release for MedCore from current main — stamps CHANGELOG.md [Unreleased] as the new version, creates an annotated tag at HEAD, pushes both, and creates the GitHub release with the stamped CHANGELOG section as the release body. Use when the user says "cut a release", "publish v1.X.Y", "tag this", or "make this an actual GitHub release I can roll out". Reads recent commits to suggest the version bump (minor by default; major if breaking changes), validates the release.yml status before tagging, and produces a fully-published release (not draft) by default. Codified from the 2026-05-07 v1.3.0 cut.
---

# medcore-cut-release

Publishes a MedCore release from current `main`. The repo has a long-standing
gap between local git tags (v1.0.0/v1.1.0/v1.2.0 existed locally) and actual
GitHub releases (zero published before v1.3.0 on 2026-05-07). This skill
collapses the seven-step manual ritual into one well-defined pass so future
release cuts don't re-derive `awk` ranges, `--target` quirks, and CHANGELOG
section boundaries.

## Why this skill exists

The 2026-05-07 v1.3.0 cut surfaced four small but cumulative gotchas that
each cost ~30 seconds the first time:

1. **`gh release create --target c6fe52d` fails with `target_commitish is invalid`** when the tag already exists locally. Drop `--target`; the tag itself is the commit pointer.
2. **CHANGELOG body extraction needs `awk` range + `sed '$d'`** to slice from `## [X.Y.Z]` up to (but not including) the next `## [` header. A naive `grep -A` count breaks across versions of different sizes.
3. **First a fresh `[Unreleased]` block goes ABOVE the stamped one** — otherwise the next session has nowhere to land "Added"/"Changed"/"Fixed" entries and either appends to the released section (wrong) or skips CHANGELOG entirely (worse).
4. **The CHANGELOG-stamping commit is what gets tagged**, not the underlying validated SHA. That's fine and intentional — it's a docs-only commit, code is identical to the validated SHA. But the release body should explicitly cite the validated SHA so the deploy-correlation chain is documented.

## When to invoke

Invoke when:
- User says "cut a release", "publish v1.X.Y", "tag this", "make a GitHub release", "create the release we can deploy from".
- A `release.yml` run on `main` has just gone green and the user wants to formalize the milestone.
- CHANGELOG `[Unreleased]` has accumulated enough entries to warrant a version bump (typically end-of-session or end-of-week).

Do NOT invoke when:
- The user wants a *draft* release for review only — that's a one-shot `gh release create --draft`, no CHANGELOG stamping.
- A `release.yml` run is currently failing — fix the failures first via `/medcore-test-triage` or `/medcore-release`.
- The user wants to retag an existing version (move v1.3.0 to a different SHA) — that's a `git tag -f` + `git push --force` operation that affects published artifacts; ask first.

## Inputs

- **Version** (required if not derivable): `vX.Y.Z`. If user doesn't specify, suggest:
  - **Minor bump** (default): if commits since last tag are features + fixes + tests with no breaking API/schema changes. Use this 90% of the time.
  - **Major bump**: if there are documented breaking changes (auth-store rewrite, schema field renames, breaking REST contract changes). Surface the commits that justify it and ask the user to confirm.
  - **Patch bump**: if commits since last tag are exclusively bug-fixes / docs / CI tweaks (no `feat()` commits). Rare for MedCore session cadence.
- **Release date** (optional): defaults to today (UTC). Use `today` from environment.

## Workflow

### 1. Pre-flight checks

```bash
# Confirm we're on main + clean tree
git status --porcelain && git branch --show-current
# Confirm release.yml is green for current HEAD
gh run list --workflow=release.yml --branch=main --limit=1 \
  --json conclusion,headSha --jq '.[0]'
```

If `release.yml` is `failure` or `in_progress`, **STOP** and surface the
failing run to the user. Don't tag a red SHA.

### 2. Discover the previous tag and commit count since it

```bash
git tag --list --sort=-v:refname | head -3
PREV_TAG=$(git tag --list --sort=-v:refname | head -1)
git log --oneline ${PREV_TAG}..HEAD | wc -l
```

If commits-since-prev-tag is < 5, push back: "Only N commits since
${PREV_TAG} — usually we cut a release after a session-sized batch.
Continue anyway?"

### 3. Stamp CHANGELOG.md

The CHANGELOG follows Keep-a-Changelog. Locate `## [Unreleased]` (line 7 in
the canonical layout) and replace with:

```markdown
## [Unreleased]

_Nothing yet — new entries land here._

## [X.Y.Z] - YYYY-MM-DD

<one-paragraph release-context block describing what was validated and where it
landed. Cite the validated SHA + the release.yml run number + the deploy job
URL. This is what readers see at the top of the GitHub release page.>

<then everything that was previously under [Unreleased] verbatim>
```

The `_Nothing yet_` placeholder under the new `[Unreleased]` keeps the next
session's first CHANGELOG addition from accidentally landing in the released
block. Removing it is harmless once a real entry lands.

### 4. Commit the CHANGELOG stamp

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): stamp [Unreleased] as [X.Y.Z] - YYYY-MM-DD

Cuts the vX.Y.Z release at commit <validated-SHA> (release.yml run #<N>;
deployed to medcore.globusdemos.com). New entries land under a fresh
[Unreleased] header."
```

Do NOT skip hooks (no `--no-verify`). Do NOT include the `Co-Authored-By: Claude`
trailer (forbidden by global CLAUDE.md gotcha #11).

### 5. Tag at HEAD (the CHANGELOG-stamping commit)

```bash
git tag -a vX.Y.Z -m "MedCore vX.Y.Z - YYYY-MM-DD

<2-3 sentence summary of the highlight band — security, stabilization,
features, etc. Drawn from the [Unreleased] focus paragraph.>

See CHANGELOG.md [X.Y.Z] for full notes."
```

### 6. Push branch + tag

```bash
git push origin main
git push origin vX.Y.Z
```

If `git push origin main` fails on a non-fast-forward, someone pushed
between pre-flight and now. Pull-rebase and retry — DO NOT force-push to
main.

### 7. Extract the release body section

```bash
awk '/^## \[X\.Y\.Z\]/,/^## \[/' CHANGELOG.md | sed '$d' > /tmp/release-body-X.Y.Z.md
wc -l /tmp/release-body-X.Y.Z.md
```

`awk '/^## \[X\.Y\.Z\]/,/^## \[/'` selects from the `[X.Y.Z]` header up to
and including the next `## [` header (which is the new `[Unreleased]`
above it... wait, this is a corner case — the new `[Unreleased]` is ABOVE
`[X.Y.Z]`, so the next `## [` after `[X.Y.Z]` is the OLD `[Unreleased - 2026-04-15]`
or the previous version. Either way, `awk` grabs everything up to that
header and `sed '$d'` strips that trailing duplicate header.

Sanity-check the size: GitHub's release body limit is **125,000 characters**.
v1.3.0 was 81,536 chars and fit fine. If `wc -c` shows > 100k, truncate to
the top sections + a "(...full notes in CHANGELOG.md)" pointer.

### 8. Create the published release

```bash
gh release create vX.Y.Z \
  --title "MedCore vX.Y.Z - YYYY-MM-DD" \
  --notes-file /tmp/release-body-X.Y.Z.md
```

**Do NOT pass `--target <sha>`.** It fails with HTTP 422
`Release.target_commitish is invalid` when the tag already exists. The
tag itself is the commit pointer.

For a draft (review-first) release, add `--draft`. For a pre-release
(release-candidate), add `--prerelease`. By default the release is
published immediately.

### 9. Verify

```bash
gh release view vX.Y.Z --json tagName,name,publishedAt,isDraft,isPrerelease,url
```

The `url` is the `https://github.com/Globussoft-Technologies/medcore/releases/tag/vX.Y.Z`
that the user can share with ops to deploy from.

## Common pitfalls

- **Tagging before release.yml is green** — produces a release that points at a known-broken SHA. Always pre-flight check.
- **Stamping CHANGELOG without adding a fresh `[Unreleased]` above** — next session has nowhere to write. Always add the placeholder.
- **Using `--target c6fe52d` on a pre-pushed tag** — produces the 422 confusion. Drop the flag once the tag is pushed.
- **Forgetting `git push origin vX.Y.Z`** — `gh release create` will fail if the tag isn't on the remote yet. Push the tag separately from the branch (or use `git push --tags` once).
- **Putting `Co-Authored-By: Claude`** in the CHANGELOG-stamp commit message — forbidden by global CLAUDE.md.

## Output

A short summary of the form:

```
Release vX.Y.Z published.

URL: https://github.com/Globussoft-Technologies/medcore/releases/tag/vX.Y.Z
Tag: vX.Y.Z → commit <abbreviated-sha> (CHANGELOG stamp on top of <validated-SHA>)
State: published / draft / pre-release
Notes size: N lines, M KB
Deploy server status: medcore.globusdemos.com is running <validated-SHA>; release SHA is +1 docs-only commit.
```

The deploy-server line confirms the live demo is functionally on the
released code (the docs-only stamp commit doesn't change runtime behavior).

## Post-release follow-ups

- If you bumped a major version, mention the breaking changes in your end-of-turn summary so the user knows to communicate them to ops.
- If `gh release view` shows a `notes_file_too_large` warning, the body got truncated server-side. Re-create with a shorter body and link to CHANGELOG.md for the full text.
- The release does NOT trigger any deploy automation by default — `test.yml`'s "Deploy to dev server" job is gated on PR-merge to main, not tag creation. The release is a milestone marker, not an action trigger.
