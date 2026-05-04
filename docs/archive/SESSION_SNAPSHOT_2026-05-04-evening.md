# Session snapshot — 2026-05-04 evening (architectural-closure marathon)

End-of-session handoff. Read this first on next pickup, then [`/TODO.md`](../../TODO.md), then go. Replaces `SESSION_SNAPSHOT_2026-05-05.md` as the most recent handoff.

## State at session end

- **HEAD on `main`** = `63855a0` (`docs: A3 helper-comment + roll TODO architectural table`).
- **Working tree:** clean.
- **Open GitHub issues: 1** — `#482` JWT HS256 → RS256/EdDSA (blocked on operational key-rollover plan; user decision required, not engineering).
- **Open architectural follow-ups: 3** — A1 (page-level VIEW_ALLOWED policy, product decision needed), A2 (modal `htmlFor` sweep, ~50+ pages unaudited — fanout-friendly), A10 (lift `tenantScopedPrisma` from `apps/api/src/services/` to `packages/db`, single-thread architectural).
- **Per-push CI:** green through `63855a0`. Auto-deploy operating; `medcore.globusdemos.com` is current.

## What this session shipped

**8 commits closing 6 architectural items + 4 LOW security audit items + 1 new skill.**

### Commit-by-commit

| Commit | Wave | What landed |
|---|---|---|
| `e7ca04d` | Bundled security audit (Mode B fanout) | `#457` tenant FK Cascade across 133 relations + idempotent migration `20260504000003_tenant_fk_cascade`; F-ABDM-1 60 req/60s/IP rate limit on `/gateway/callback`; F-INJ-1 `sanitizeUserInput` on 4 free-text AI routes; `AI_<FEATURE>_INFERENCE` audit rows on 9 AI routes (model + sizes + latency only — PHI hygiene strict); 42 new/updated route tests. |
| `340dd38` | Skills | New skill `/medcore-ai-route-audit` codifying the AI inference audit-row contract (top-of-file model constant, `safeAudit` wrapper, `sanitizeUserInput` on free-text fields, success+failure path coverage, PHI-absent test assertion). `/medcore-fanout` gained a "Mode B — single bundled commit" section documenting when the parent gate-keeps the merge instead of letting agents commit independently. |
| `cde1829` | A9 | `tenantContextMiddleware` validates the resolved tenantId via `prisma.tenant.findUnique({ id, active: true })` with a 60s positive / 30s negative TTL cache (bounded at 256 entries). Forged JWTs / spoofed `X-Tenant-Id` headers pointing at non-existent or deactivated tenants are silently dropped (req.tenantId stays undefined → downstream tenant-required routes 4xx). DB blips fail closed. 6 new test cases (21/21 green). |
| `7bd9d14` | A4 Lane A (clinical) | `noValidate` + React-side validation on antenatal/[id], adherence, pediatric/[patientId], symptom-diary, emergency, ot, ai-radiology — 7 pages, 8 forms. |
| `ffe199f` | A4 Lane B (admin/scheduling) | doctors, duty-roster, leave-management, my-schedule, users — 5 pages, 7 forms. (`appointments/page.tsx` was already correct.) |
| `34bb5a3` | A4 Lane C (billing/pharmacy/lab) | billing/[id], insurance-claims, preauth, lab, lab/[orderId], medicines — 6 pages, 7 forms. |
| `e0e1429` | A4 Lane D (operations/inventory) | admissions, packages, purchase-orders, settings, suppliers, wards — 6 pages, 8 forms. |
| `63855a0` | A3 + doc roll | Comment block at `e2e/helpers.ts:528` near `indianishName()` documenting the `PATIENT_NAME_REGEX` digits-rejection gotcha for spec authors. TODO.md banner + architectural table refreshed (A3/A4/A7/A8/A9 → Closed). |

### Architectural state at session end

| ID | Status | One-line |
|---|---|---|
| A1 | **Open — product decision** | Many pages have no client-side `VIEW_ALLOWED` / role gate. Is the policy "page reachable, API gates" intentional? Document or fix. |
| A2 | **Open — fanout-friendly** | Modal `htmlFor` audit incomplete; ~50+ pages unaudited. Best as 3-4 agent `/medcore-fanout` wave by subdir. |
| ~~A3~~ | ✅ Closed | Doc note at `e2e/helpers.ts:528`. |
| ~~A4~~ | ✅ Closed | Wave 1 (May 3-4): 18 high-traffic forms. Wave 2 (May 4): 4-agent fanout, 24 pages / 30 forms. Full sweep done. |
| ~~A5~~ | ✅ Closed | Earlier — RBAC drift audit. |
| ~~A6~~ | ✅ Closed | Earlier — `/users` route extraction. |
| ~~A7~~ | ✅ Closed | `#456` — AuditLog tenantId migration. |
| ~~A8~~ | ✅ Closed | `#457` — Tenant FK SetNull → Cascade. |
| ~~A9~~ | ✅ Closed | `cde1829` — runWithTenant validation cache. |
| A10 | **Open — single-thread architectural** | Lift `tenantScopedPrisma` from `apps/api/src/services/` to `packages/db` so workers + cron can consume safe scoping. Touches test-suite import shape. |

### New skills shipped

- `/medcore-ai-route-audit` (`apps/api/src/routes/ai-letters.ts` is the canonical implementation) — codifies the AI inference audit-row contract for any new Sarvam/ASR/embeddings endpoint.
- `/medcore-fanout` (existing) — gained a Mode B section.

## Outstanding session-level findings

1. **`apps/api/src/routes/billing.ts` has 2 pre-existing TS2353 errors on `parentPaymentId`** — surfaced again by Lane C. Pre-existing on `origin/main`; not from this session's work. Tracked but unaddressed.
2. **`apps/web/package.json` has no `typecheck` turbo task** — agents reported this in Lane A and Lane C. They worked around it with `npx tsc --noEmit` directly. Worth a small infra commit to wire `typecheck` into the web `package.json`.
3. **vitest config excludes `apps/web/**`** — explicit by design (E2E and component tests run in different harnesses). Lanes B/D had no component tests to run; not a regression.
4. **No GitHub issues exist for F-ABDM-1 / F-INJ-1 / AI-audit / A1-A10** — they live as architectural-table entries in `TODO.md`. Convention: A-IDs live in TODO; numbered issues are user-tracked work.

## Skills available (6 project-shared, all in `.claude/skills/`)

- `/medcore-fanout` — N parallel foreground agents, non-overlapping lanes (Mode A or Mode B).
- `/medcore-e2e-spec` — scaffold one Playwright route spec.
- `/medcore-route-test` — scaffold one Vitest route-handler unit test.
- `/medcore-release` — dispatch + watch + diagnose `release.yml`.
- `/medcore-doc-roll` — capture each wave's findings into TODO + CHANGELOG (idempotent).
- `/medcore-ai-route-audit` — apply the AI inference audit-row contract to any AI route. **NEW today.**

## Pickup commands

```bash
cd "<medcore checkout>"
git pull origin main          # should fast-forward to 63855a0 or beyond

# Pick the next architectural item — recommendations in priority order:
#
# 1. A2 (fanout-friendly, ~50 pages) — modal htmlFor sweep. Batch as 3-4 agents
#    by subdir. Pattern: <label>X</label><input> → <label htmlFor="x">X</label><input id="x">.
#
# 2. A10 (single-thread, modest scope) — lift tenantScopedPrisma to packages/db.
#    Touches test-suite import shape; one careful commit + integration-test re-run.
#
# 3. A1 — needs product decision before code. Ask user before starting.
#
# 4. #482 — blocked on key-rollover plan; not engineering work yet.
```

## Reference quick-links

- [`/TODO.md`](../../TODO.md) — banner reflects this session; "Open architectural follow-ups" canonical table is authoritative.
- [`/CHANGELOG.md`](../../CHANGELOG.md) — `[Unreleased]` window has today's wave at the top.
- [`/.claude/skills/medcore-ai-route-audit/SKILL.md`](../../.claude/skills/medcore-ai-route-audit/SKILL.md) — new skill (canonical impl `apps/api/src/routes/ai-letters.ts`).
- [`/.claude/skills/medcore-fanout/SKILL.md`](../../.claude/skills/medcore-fanout/SKILL.md) — now documents Mode A vs Mode B.
- `apps/api/src/middleware/tenant.ts` — A9 validation cache lives here.
