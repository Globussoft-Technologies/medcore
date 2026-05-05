---
name: medcore-bola-sweep
description: For a single Express route file under apps/api/src/routes/, verify each /:id-shaped handler against the cross-patient access (BOLA / IDOR / OWASP API1:2023) checklist and either patch the gap with assertPatientOwnsResource OR document the verified-safe verdict inline. Pairs with /medcore-fanout (one agent per route file) when closing batches of Issue #511's long tail. Codified from 5 successful agent runs on 2026-05-05 covering admissions / antenatal / ai-adherence-coaching / ai-scribe-triage-explainer / bloodbank.
---

# medcore-bola-sweep

Sweeps a single Express route file under `apps/api/src/routes/` for cross-patient access gaps and patches them. The pattern is codified from 5 parallel agent runs on 2026-05-05 (Issue #511 closure wave) — they shipped 19 real fixes + 6 verified-safe across 5 route files in ~15 min wall-clock.

## When to invoke

- The user surfaces a route file as a BOLA candidate (Issue #511 long tail).
- A new route handler is reviewed and you want to confirm it's not BOLA-vulnerable.
- After a `/medcore-fanout` BOLA-closure batch lands, before the next batch.

Do NOT invoke when:
- The route file is already known-clean (e.g., admin-only via router-level mount with no PATIENT-reachable surface).
- The handler doesn't touch a patient-scoped resource (e.g., system config, marketing pages, public health endpoints).

## Inputs

- **Route file** (required): `apps/api/src/routes/<x>.ts`.
- **Optional handler list**: specific line numbers to focus on. If omitted, scan ALL `router.{get,patch,delete,put}(...)` handlers whose path contains `:id` (or `:patientId`, `:sessionId`, `:orderId`, etc.).

## Workflow

### 1. Read router-level mounts (lines 1-50 typically)

Find every `router.use(...)` call. Note any:
- `router.use(authenticate)` — every handler is JWT-gated (ALL routes do this).
- `router.use(authorize(...))` — entire file gated to specific roles. **If PATIENT not in this list, ALL handlers are verified-safe.** Comment each handler with `// #511: router-level authorize() at line N excludes PATIENT — verified safe.` and exit.
- `router.use(validateUuidParams(...))` — UUID validation, doesn't gate access.

### 2. For each candidate handler

Decide one of three verdicts:

**A. PATCHED** — handler is reachable by PATIENT and accesses a row that may not belong to them. Apply the helper:
```ts
import { assertPatientOwnsResource } from "../middleware/patient-self-only";

router.get("/:id", async (req, res, next) => {
  const resource = await prisma.<model>.findUnique({
    where: { id: req.params.id },
    select: { patientId: true /* ... + other needed fields */ },
  });
  if (!resource) {
    res.status(404).json({ success: false, data: null, error: "Not found" });
    return;
  }
  if (!(await assertPatientOwnsResource(req, res, resource.patientId))) return;
  // ... rest of handler
});
```

**Three sub-cases:**

- **A1 — Resource has direct `patientId` FK.** Pass `resource.patientId` to the helper.
- **A2 — Resource links via Patient → User.** Some helpers want the User.id, not Patient.id. Read `apps/api/src/middleware/patient-self-only.ts` to confirm signature. Common shape: load `{ patient: { user: { select: { id: true } } } }` and pass `resource.patient.user.id`.
- **A3 — No parent fetch in current handler** (the worst BOLA shape — handler queries child rows by URL param without ever loading the parent). **Add a minimal `findUnique` on the parent** to get a `patientId`, THEN apply the helper. Example from antenatal `/cases/:id/ultrasound`: handler was directly querying `ultrasoundRecord` by `ancCaseId`; needed to add a `prisma.antenatalCase.findUnique` first.

**B. VERIFIED-SAFE** — handler is reachable by PATIENT but already has gating. Add a one-line documenting comment `// #511 audit: VERIFIED-SAFE — <reason>` so future audits don't re-flag it. Reasons:
- Inline ownership check (e.g., `where: { patientId: req.user.patientId }` in the Prisma call).
- Per-handler `authorize(Role.X, ...)` that excludes PATIENT (the naive grep missed it because it was on a different line).
- Path is admin-only via different mechanism (e.g., wrapped in a separate sub-router with its own mount).

**C. STAFF-ONLY (apply `authorize(...)`)** — handler is reachable by PATIENT but the resource is genuinely staff-only (donor PII, audit logs, system config, etc.). Don't use `assertPatientOwnsResource` — instead add `authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, ...)` matching the file's other staff-only handlers. Example: `bloodbank.ts /donors/:id/eligibility` — donors don't link to Patient at all; staff-only is the correct contract.

### 3. Refactor verified-but-fragile handlers (optional but recommended)

If a handler has hand-rolled inline ownership logic (e.g., `if (req.user.role === "PATIENT" && resource.patientId !== req.user.patientId) return res.status(403)`), refactor to use `assertPatientOwnsResource` for drift prevention. The ai-adherence + ai-coaching agent (`fbc898d`) did exactly this on 4 handlers — naive grep was a false-positive but the refactor still added value.

### 4. Test fix

New file: `apps/api/src/test/integration/cross-patient-<route>.test.ts`. Do NOT append to `cross-patient-rbac.test.ts` (the canonical file) — the multi-agent fanout would race on it. New per-route file is the safe pattern.

For each PATCHED handler, write 3 standard assertions:
```ts
it("<HANDLER>: PATIENT-A cannot GET PATIENT-B's <resource> (403)", async () => {
  const res = await request(app)
    .get(`/api/v1/<path>/${resourceB.id}`)
    .set("Authorization", `Bearer ${patientAToken}`);
  expect(res.status).toBe(403);
});

it("<HANDLER>: PATIENT-A CAN GET own <resource> (200) [positive control]", async () => {
  const res = await request(app)
    .get(`/api/v1/<path>/${resourceA.id}`)
    .set("Authorization", `Bearer ${patientAToken}`);
  expect(res.status).toBe(200);
});

it("<HANDLER>: DOCTOR can GET any <resource> (200) [staff control]", async () => {
  const res = await request(app)
    .get(`/api/v1/<path>/${resourceA.id}`)
    .set("Authorization", `Bearer ${doctorToken}`);
  expect(res.status).toBe(200);
});
```

Self-skip via `describeIfDB` if no `DATABASE_URL_TEST`. Reference `apps/api/src/test/integration/cross-patient-rbac.test.ts` for the fixture-setup pattern (two-patient seed via `freshPatientToken`, doctor seed, admin token).

For STAFF-ONLY (verdict C) handlers, the test is `expect(res.status).toBe(403)` for PATIENT and `expect(res.status).toBe(200)` for staff — no positive PATIENT-self control.

### 5. Validate

```bash
cd c:/Users/Admin/gbs-projects/medcore
npx vitest run apps/api/src/test/integration/cross-patient-<route>.test.ts
npx turbo run lint --filter=@medcore/api
```

Tests will skip without `DATABASE_URL_TEST` (per `describeIfDB`); CI runs them.

### 6. Commit + push (concurrency-safe — paired with /medcore-fanout)

```bash
git add apps/api/src/routes/<route>.ts apps/api/src/test/integration/cross-patient-<route>.test.ts
git commit -m "fix(api/<route>): close BOLA gaps on N /:id handlers per #511

<body listing per-handler verdict>

Closes part of #511." -- <files>

for i in 1 2 3 4 5; do
  if git push origin main; then break; fi
  git fetch origin main
  git rebase origin/main
done
```

Conventional commit (`fix(api/<route>):`). NO `Co-Authored-By: Claude` trailer.

### 7. Comment on Issue #511 with verdict table

```bash
gh issue comment 511 --repo Globussoft-Technologies/medcore --body "$(cat <<'EOF'
## <route>.ts (Agent N)

| Handler | Verdict | Fix |
|---|---|---|
| L<N> <method> <path> | PATCHED / VERIFIED-SAFE / STAFF-ONLY | <one-line reason> |

Commit: <SHA>
Tests: <count> in cross-patient-<route>.test.ts
EOF
)"
```

## Anti-patterns observed in the 5-agent #511 wave

- **Don't append to `cross-patient-rbac.test.ts`** — concurrent fanout agents race on it. Per-route test files (`cross-patient-<route>.test.ts`) are isolated.
- **Don't trust the naive audit grep at face value.** It's a candidate list, not a gap list. Always read each handler's actual gating before patching. The ai-adherence + ai-coaching wave was a 4/4 false-positive.
- **Don't skip the parent fetch when the URL param is `:childId`.** If the handler currently queries the child table directly, you MUST add a parent fetch first (verdict A3 above) — otherwise there's nothing to compare ownership against.
- **Don't apply `assertPatientOwnsResource` to non-patient resources.** BloodDonor (no Patient link), AuditLog (system), system-config — these are staff-only via `authorize()`, not patient-self.
- **Don't write generic "is patient" checks inline if the helper already exists** — drift over time is the real cost. Refactor to the canonical helper for consistency, even if the existing inline check is correct today.

## Expanded audit criterion (added 2026-05-05)

**The original audit grep (handlers with NO `authorize()` call) misses a SECOND class of BOLA bug:** handlers that DO have `authorize(...)` BUT include `Role.PATIENT` in the role list AND don't add a per-row ownership check. These bypassed the original audit because the handler "looks gated."

Two real instances surfaced in the long-tail wave:

- `appointments.ts PATCH /:id/reschedule` — `authorize(...)` allowed PATIENT for self-service reschedule, but no per-row check. **Any PATIENT could reschedule any appointment.**
- `growth.ts POST /:id/feeding` — `authorize(...)` allowed PATIENT, but no per-row check. **PATIENT-A could write feeding logs against PATIENT-B's record (cross-tenant PHI write).**

Both were extra-grep finds by alert agents.

**For ANY handler with `Role.PATIENT` in the authorize() list AND a row-keyed param (`:id`, `:patientId`, `:invoiceId`, `:scheduleId`, `:consultationId`, `:appointmentId`, `:sessionId`, etc.) — verify per-row ownership.** Either:

1. The handler scopes its Prisma query to `req.user.patientId` (e.g., `where: { patientId: req.user.patientId }`) — verified-safe.
2. The handler calls `assertPatientOwnsResource(req, res, parent.user.id)` after loading the parent — verified-safe.
3. The handler uses `getCallerPatient(req)` for self-self surfaces (no row id needed) — verified-safe.
4. **None of the above → real BOLA gap, apply the helper or scope the query.**

### Discovery grep for this criterion

```bash
grep -lE "authorize\([^)]*Role\.PATIENT" apps/api/src/routes/*.ts
```

Returns the universe of files to audit under the expanded criterion. As of 2026-05-05 there are 17 such files. Many already swept; check `/medcore-bola-sweep` previous-wave commit history before running redundantly.

For each file, scan every handler (not just `/:id` ones) — the expanded criterion applies to any PATIENT-allowed surface that operates on rows.

## Catalog endpoint eager-include leak audit (added 2026-05-05 — wave 8 + wave 17)

**Pattern**: a non-patient resource (no direct `patientId` FK on the row itself) ships a route handler that eagerly includes a patient-bearing relation, leaking PII to PATIENT callers who legitimately reach the endpoint as a "catalog" surface.

Two confirmed instances:

- `apps/api/src/routes/packages.ts GET /:id` — `HealthPackage` is the catalog row (no `patientId` FK), but the handler did `include: { purchases: { patient: { user } } }` exposing up-to-10 purchaser identities (name + phone) to ANY PATIENT hitting the catalog detail.
- `apps/api/src/routes/doctors.ts GET /` — `Doctor` is the staff-catalog row (PATIENT can browse for booking), but the handler eagerly returned `user.email + user.phone` for every doctor — booking-surface need vs. PII shape mismatch.

**Discovery grep**:

```bash
grep -nE "include:\s*\{[^}]*purchases|include:\s*\{[^}]*user:|include:\s*\{[^}]*patient:" apps/api/src/routes/*.ts
```

Returns include shapes worth auditing. For each match, ask: "if a PATIENT hits this endpoint, what user/patient PII does this include() expose?"

**Fix pattern (identical across both instances)**:

```ts
// Branch the projection by role: full include for staff, minimal for PATIENT.
const isStaff = req.user!.role !== "PATIENT";
const data = await prisma.<model>.findUnique({
  where: { id: req.params.id },
  ...(isStaff
    ? { include: { purchases: { include: { patient: { include: { user: true } } } } } }
    : { include: { /* only catalog fields, no patient-bearing relations */ } }),
});
```

**When to apply this lens**: any time you sweep a route file where:
- The primary resource has NO `patientId` FK on its own row (catalog/master-data shape), AND
- PATIENT is in the `authorize()` list for the GET handler (or no `authorize()` at all), AND
- The handler's `include` block reaches into a patient-bearing relation

If all three are true, audit the include shape against role.

## Post-fix verification grep (added 2026-05-05 — wave 7 CI-unblock learning)

**Why this exists**: the BOLA-closure waves on 2026-05-05 shipped 69 real fixes, but 3 bug shapes slipped past the per-agent commit and were caught only by the next push's `test.yml`. Two of the three were cheap-grep-detectable. Adding this as a final pre-doc-roll step would have flagged them at fanout-end.

**Run BOTH greps before the doc-roll commit** in any /medcore-bola-sweep wave:

### (i) Express route-shadow regression class

When you add or modify a route file, verify static-segment routes are declared BEFORE dynamic-segment siblings of the same prefix:

```bash
# For each /<prefix>/:id-shaped handler in the file, check that all
# /<prefix>/<literal-name> handlers appear earlier in the file. Express
# matches in declaration order — declaring `/results/:orderItemId` before
# `/results/trends` will silently 404 the latter forever.
awk '/^router\.(get|post|patch|delete|put)\("/{print NR, $0}' apps/api/src/routes/<route>.ts
```

Read the output: any literal route declared AFTER a dynamic sibling of the same prefix is shadowed.

Real instance: commit `a5a6224` had to fix `apps/api/src/routes/lab.ts` where `GET /results/:orderItemId` (line 556) was shadowing `GET /results/trends` (line 977 originally) and `GET /results/pending-verification` (line 1211 originally) — both static handlers returned 404 against any literal path component bound to `:orderItemId`.

### (ii) `assertPatientOwnsResource` arg-shape verification

Every call site MUST pass the **Patient row's id** (i.e. `Patient.id`), NOT the User row's id:

```bash
grep -nE "assertPatientOwnsResource\(req,\s*res,\s*[^)]+\)" apps/api/src/routes/*.ts
```

Read each match. The 3rd argument should be one of:
- A `.patientId` field-access (canonical: `resource.patientId`, `existing.patientId`, `parent.patientId`, etc.)
- A direct `req.params.<patientId-param>` (e.g., `req.params.patientId` for handlers keyed on patientId)
- A `.id` access on a freshly-loaded `prisma.patient` row (i.e., `patient.id` where `patient` came from `findUnique`)

The arg-shape ANTI-pattern: `.userId` or `.user.id` or `.user?.id`. The helper queries `prisma.patient.findUnique({ where: { id: <arg> }})` — passing a User row's id will never match and will 403 PATIENT-A on their own chart (real bug shipped in commit `80c4b89`, fixed in `a5a6224`).

Run both greps after the route-handler edits but BEFORE the doc-roll commit. Both checks are cheap and catch the two paper-cut classes that recur most often.

## Inverse pattern: "writes-gated, reads-bare" audit (added 2026-05-05 — wave 5)

**Pattern**: a route file has `authorize(...)` on POST/PATCH/DELETE handlers but the corresponding GET handlers slipped through without gating. The audit grep catches "no authorize() at all" but misses files where SOME handlers are gated.

Three confirmed instances surfaced in waves 5+:

- `apps/api/src/routes/pharmacy.ts` — 4 GET handlers without `authorize()` while POST/PATCH were gated
- `apps/api/src/routes/med-reconciliation.ts` — 3 GETs bare while writes were gated
- `apps/api/src/routes/preauth.ts` — `GET /` honored client-supplied `?patientId=` query bypass while writes were gated

**Discovery grep**: for each route file, list GET handlers and check whether they have a per-handler `authorize()` AND whether the file has at least one OTHER `authorize()` call somewhere (selective-gating signal):

```bash
# List GET handlers per file:
grep -nE "router\.get\(" apps/api/src/routes/<route>.ts

# Count authorize() calls in the file:
grep -c "authorize(" apps/api/src/routes/<route>.ts
```

If GET handlers > 0 AND total `authorize(` > 0 AND the GET handlers themselves don't include `authorize(` on their own line — that's the selective-gating signal. Audit each bare GET.

**Caveat**: naive grep produces ~50% false positives — already-helper-applied handlers don't match the `authorize(` pattern but ARE gated via inline `req.user.patientId` self-scope or `assertPatientOwnsResource()` post-load. Confirm before patching.

## Concurrency safety in /medcore-fanout

When invoked by `/medcore-fanout` (one agent per route file):
- Each agent owns a UNIQUE route file. No file overlap.
- Each agent writes a UNIQUE `cross-patient-<route>.test.ts` file. No test-file race.
- Each agent comments on Issue #511 — concurrent comments are safe (GitHub serializes).
- Push race resolved by the standard rebase-retry loop.

Tested on 2026-05-05: 5 parallel agents shipped 5 commits in ~15 min with one rebase-retry observed. No data loss.

## Composability

`/medcore-bola-sweep` is invoked by:
- `/medcore-fanout` agents during BOLA-closure waves on Issue #511 (canonical use)
- Direct user invocation when adding a new route handler and wanting to confirm it's not BOLA-vulnerable

It pairs with:
- `/medcore-route-test` for the test-scaffolding patterns (the cross-patient test convention is an extension)
- `/medcore-doc-roll` after the fanout completes (capture the per-route verdicts in TODO + CHANGELOG)

## References

- `apps/api/src/middleware/patient-self-only.ts` — the helper
- `apps/api/src/test/integration/cross-patient-rbac.test.ts` — original (#474) regression suite; do NOT append to this file in a fanout
- `80c4b89` — patients/:id fix (the canonical template)
- `66bb6d2` — original #474 sweep (11 handlers)
- `c87107e` `bfb52ab` `fbc898d` `96b9700` `a7bfc8c` — 5-agent #511 wave precedent
- `7bc72c7` `3d501f0` `dafad04` `b183fab` `95cdc13` — long-tail wave precedent
- `27eb610` `5b31ee7` `c015bd5` `1285c8f` — expanded-criterion wave precedent
