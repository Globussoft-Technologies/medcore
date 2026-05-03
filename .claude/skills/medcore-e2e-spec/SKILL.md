---
name: medcore-e2e-spec
description: Scaffold a new Playwright e2e spec for a MedCore dashboard route, following the descriptive-headers convention and the existing fixtures/helpers contract. Use when the user asks to "write an e2e for /dashboard/X", "close the backlog entry for /Y", or "add Playwright coverage for Z". Produces a complete `e2e/<route>.spec.ts` plus the closure annotation in docs/E2E_COVERAGE_BACKLOG.md, validated via `playwright test --list`. Pair with /medcore-fanout to close 3-4 backlog routes in parallel.
---

# medcore-e2e-spec

Scaffolds a new Playwright e2e spec for a single MedCore dashboard route, following the descriptive-headers convention codified in [`docs/README.md`](../../../../docs/README.md). The reference template is [`e2e/symptom-diary.spec.ts`](../../../../e2e/symptom-diary.spec.ts) — read it first if unfamiliar.

## Inputs

- **Route path** (required): e.g. `/dashboard/medicines`, `/dashboard/purchase-orders`. Ask the user if not provided.
- **Optional notes**: any specific flows the user wants exercised (a particular form, a specific RBAC matrix entry, a known edge case). If unspecified, default to: 1 happy path per allowed role + 1 disallowed-role bounce per role outside the allow set.

## Workflow

### 1. Discover the route surface

Read in parallel (one tool message):

- `apps/web/src/app/dashboard/<route>/page.tsx` (and `[id]/page.tsx` if dynamic) — extract:
  - `VIEW_ALLOWED` / `ALLOWED_ROLES` constant (the role allowlist) — names vary; grep for `Set(["...`, `ALLOWED`, `canView`, `canAdmit`, etc.
  - All `data-testid` attributes (used as Playwright selectors).
  - Form fields if there's a write flow (description, severity, etc.).
  - Redirect rules (`router.replace("/dashboard/not-authorized")`, etc.).
  - Any `?queryParam=` reads (e.g. `?patientId=`, `?id=`).
- `apps/api/src/routes/<route>.ts` (best guess at filename) — extract:
  - `authorize(Role.X, Role.Y)` calls — server-side RBAC truth.
  - Zod schemas for any POST/PATCH bodies the spec might exercise.
  - Endpoint paths (e.g. `POST /api/v1/<resource>`).
- One similar existing spec under `e2e/` — use [`e2e/symptom-diary.spec.ts`](../../../../e2e/symptom-diary.spec.ts) as the descriptive-headers reference, plus the closest-shape spec to the new route (form-heavy → `pharmacist.spec.ts`; list-heavy → `patient.spec.ts`; staff/patient split → `symptom-diary.spec.ts`).

If the route page is fully accessible to all authenticated users (only specific CTAs are role-gated), pin THAT real behaviour rather than assuming a redirect contract — see `e2e/admissions.spec.ts` for the precedent and the route-shape correction in commit `65b5e0a`.

### 2. Pick the role lanes

Based on the page's `VIEW_ALLOWED` / API `authorize(...)`:

- **Positive happy paths** for each allowed role from the fixture pool (`adminPage`, `doctorPage`, `nursePage`, `receptionPage`, `patientPage`, `labTechPage`, `pharmacistPage`).
- **RBAC bounces** for at least 2 disallowed roles (or pin the "no redirect, just empty list" behaviour if that's the truth).
- If the route has a write flow (form / button / modal), exercise it under the most relevant role with a unique tag (`Date.now()`-suffixed string) so the assertion survives shared-account state leakage across runs.

### 3. Write the spec at `e2e/<route-slug>.spec.ts`

The slug strips `/dashboard/` and replaces `/` with `-`. Examples: `/dashboard/medicines` → `e2e/medicines.spec.ts`, `/dashboard/purchase-orders/[id]` → `e2e/purchase-orders.spec.ts`.

Use this skeleton (replace `<…>` placeholders):

```ts
/**
 * <Feature name> patient/staff-journey + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/<route> (apps/web/src/app/dashboard/<route>/page.tsx)
 *   <HTTP method> /api/v1/<resource> (apps/api/src/routes/<route>.ts)
 *
 * Surfaces touched:
 *   - <role>: <one-line description of the happy path>
 *   - Staff RBAC: <which roles bounce + which see what>
 *
 * Why these tests exist:
 *   <one paragraph: regulation, prior incident, audit gap entry, RBAC matrix
 *   line, or which §X.Y of docs/E2E_COVERAGE_BACKLOG.md this closes>
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden /*, seedPatient, stubAi, etc as needed */ } from "./helpers";

test.describe("<Feature> — /dashboard/<route> (<one-line: what's pinned, role matrix>)", () => {
  test("<allowed role> lands on /dashboard/<route>, page chrome renders, <key CTA> is visible", async ({ <rolePage> }) => {
    const page = <rolePage>;
    await page.goto("/dashboard/<route>", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(page.getByRole("heading", { name: /<page-title-regex>/i }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="<key-cta>"]')).toBeVisible();
  });

  // <write flow if applicable — see the symptom-diary log-entry test for the pattern>

  test("<disallowed role> bounces to /dashboard/not-authorized — <role> is outside VIEW_ALLOWED in page.tsx:<line>", async ({ <rolePage> }) => {
    const page = <rolePage>;
    await page.goto("/dashboard/<route>", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    await expect(page.locator('[data-testid="<key-cta>"]')).toHaveCount(0);
  });
});
```

**`describe(...)` strings** must be specific and read like a full thought:
> ✅ `"Symptom Diary — /dashboard/symptom-diary (PATIENT capture flow + staff RBAC redirects)"`
> ❌ `"symptom diary"`

**`it(...)` strings** must describe behaviour + surface, not just function names:
> ✅ `"PATIENT can log a new entry through the modal: opens form, fills description / severity / datetime, saves, sees the entry land in history"`
> ❌ `"patient logs entry"`

### 4. Validate

```bash
cd <repo root>
npx playwright test --list e2e/<route-slug>.spec.ts
```

Must list every test you wrote × 2 projects (`[full]` + `[full-webkit]`). If listing fails, the file has a syntax/import error.

If the e2e tsconfig has issues, also run:
```bash
npx tsc --noEmit -p e2e/tsconfig.json
```

**Do NOT actually run the e2e** — Playwright is explicit-invocation-only per [`docs/TEST_PLAN.md`](../../../../docs/TEST_PLAN.md) §3 Layer 5. The user kicks off `release.yml` to validate.

### 5. Annotate the backlog

In [`docs/E2E_COVERAGE_BACKLOG.md`](../../../../docs/E2E_COVERAGE_BACKLOG.md), find the existing entry for the route under §2 and replace it with the strikethrough + closure-annotation pattern (the doc-management convention from [`docs/README.md`](../../../../docs/README.md)):

```diff
- - `/dashboard/<route>` — <existing description>
+ - ~~`/dashboard/<route>` — <existing description>~~ ✅ closed (<N> tests; `e2e/<route-slug>.spec.ts`)
```

If the route isn't already listed, add the closure-annotation entry under the right §2 subsection.

### 6. Commit (concurrency-safe — paired with /medcore-fanout)

```bash
git add e2e/<route-slug>.spec.ts docs/E2E_COVERAGE_BACKLOG.md
git commit -m "test(e2e): /dashboard/<route> — <one-line summary>

<2-4 sentence body: what's covered, role matrix, any pinned behaviour
worth flagging (e.g. 'no redirect — page is fully accessible'), closes
which backlog entry>

Tests: <N> cases × <M> projects." -- e2e/<route-slug>.spec.ts docs/E2E_COVERAGE_BACKLOG.md

# Rebase-retry push (mandatory under fanout — concurrent agents):
for i in 1 2 3 4 5; do
  if git push origin main; then break; fi
  git fetch origin main
  git rebase origin/main
done
```

**No `Co-Authored-By: Claude` trailer.** Conventional-commit format (`test(e2e): ...`).

## Reporting

Single-paragraph report (under 150 words):
- Commit SHA
- Route + test count
- Allowed roles tested + disallowed roles bounced
- Any test you skipped + why (e.g. "feature flag off in seed; un-skip when X ships")
- Anything surprising you found in the page surface (route shape correction, missing data-testid, RBAC asymmetry between page + API)

## Anti-patterns

- **Don't fabricate selectors.** Every `[data-testid="..."]` you assert on must exist in the page source you read.
- **Don't assume the redirect contract.** Some MedCore routes (admissions, purchase-orders, payment-plans) are fully accessible to all auth'd users; only CTAs are role-gated. Confirm before writing the bounce test.
- **Don't write 12 tests.** 5-7 well-chosen tests beat 12 thin ones. Aim: 1 happy per role × 2-3 roles + 1 write/validation flow + 1-2 RBAC bounces.
- **Don't skip the descriptive header.** It's the one override to "default to no comments" — see [`docs/README.md`](../../../../docs/README.md).
- **Don't forget the rebase-retry loop** — concurrent agents in a fanout will race the push.
