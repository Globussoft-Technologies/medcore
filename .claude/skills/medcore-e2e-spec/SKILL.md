---
name: medcore-e2e-spec
description: Scaffold a new Playwright e2e spec for a MedCore dashboard route, following the descriptive-headers convention and the existing fixtures/helpers contract. Use when the user asks to "write an e2e for /dashboard/X", "close the backlog entry for /Y", or "add Playwright coverage for Z". Produces a complete `e2e/<route>.spec.ts` plus the closure annotation in docs/E2E_COVERAGE_BACKLOG.md, validated via `playwright test --list`. Pair with /medcore-fanout to close 3-4 backlog routes in parallel.
---

# medcore-e2e-spec

Scaffolds a new Playwright e2e spec for a single MedCore dashboard route, following the descriptive-headers convention codified in [`docs/README.md`](../../../../docs/README.md). The reference template is [`e2e/symptom-diary.spec.ts`](../../../../e2e/symptom-diary.spec.ts) — read it first if unfamiliar.

## Inputs

- **Route path** (required): e.g. `/dashboard/medicines`, `/dashboard/purchase-orders`. Ask the user if not provided.
- **Optional notes**: any specific flows the user wants exercised (a particular form, a specific RBAC matrix entry, a known edge case). If unspecified, default to: 1 happy path per allowed role + 1 disallowed-role bounce per role outside the allow set.

## Page-shape decision matrix (read this before scaffolding)

The `apps/web/src/app/dashboard/<route>/page.tsx` you're about to test will be one of **THREE archetypes**. Pick the right one BEFORE writing assertions or you'll write a brittle/wrong test.

### Archetype A — redirect-bounce (most common, ~70% of pages)

The page has a `useEffect`/`router.push("/dashboard")` (or `router.replace("/dashboard")`) that fires for non-allowed roles. The page **unmounts** for those roles — no chrome renders.

**Two redirect-target sub-shapes** (codified from a 10:2 split observed across 12+ pages):

- **`/dashboard` target (10 pages — dominant)**: agent-console, workstation, tenants, insurance-claims, audit, fhir-export, workspace, billing-patient, tenants-onboarding, reports-custom. Test pattern: `expect(page).toHaveURL(/\/dashboard$/)` or `not.toHaveURL(/\/dashboard\/<route>/)`.
- **`/dashboard/not-authorized` target (2 pages — explicit access-denied UX, Issue #179)**: lab-intel, visitors. Test pattern: `expect(page).toHaveURL(/\/dashboard\/not-authorized/)`.

**ANTI-PATTERN**: assuming one target without checking page.tsx first. ALWAYS grep `apps/web/src/app/dashboard/<route>/page.tsx` for the actual `router.push/replace` call site BEFORE writing the assertion. Both targets are valid contracts; mismatching the assertion to the actual call breaks the test silently.

### Archetype B — universal-access (no client gate, API-only)

The page has NO `VIEW_ALLOWED`, NO `router.push`, NO inline gate. Page chrome renders for every authenticated role; security depends entirely on the API's `authorize(...)`. Non-allowlisted roles see a partial shell + empty list rather than `/dashboard/not-authorized`.

Test pattern: pin `expect(page).toHaveURL(/\/dashboard\/<route>/)` (no redirect happened) AND assert the staff-only CTA testid is hidden via `toHaveCount(0)`. Don't assert a redirect — it won't happen.

Examples: `/dashboard/profile`, `/dashboard/my-schedule`, `/dashboard/calendar`, `/dashboard/antenatal/[id]`, `/dashboard/referrals`.

### Archetype C — admin-gate placeholder (3rd archetype, RIPE 3 instances 2026-05-05)

The page renders chrome + outer wrapper, but data panels are replaced with a placeholder card for non-allowed roles. The bundle stays mounted, the URL stays put, no redirect fires.

Three confirmed instances:
- `/dashboard/ai-kpis`: `data-testid="ai-kpis-admin-gate"` placeholder for non-ADMIN (page.tsx:296)
- `/dashboard/ai-fraud`: inline `<ShieldCheck>` "Restricted" placeholder for non-{ADMIN,RECEPTION} via `canRead` flag (page.tsx:478-487; reuses `ai-fraud-page` testid)
- `/dashboard/leave-management`: inline "Access restricted to administrators." card for non-ADMIN (page.tsx:67-73)

Test pattern: `expect(page).toHaveURL(/\/dashboard\/<route>/)` (no redirect) + assert the gate-placeholder testid IS visible AND the data-panel testids are absent.

**Inconsistent testid conventions across the 3 instances**:
- ai-kpis uses a dedicated `<route>-admin-gate` testid (cleanest)
- ai-fraud reuses outer-wrapper testid + textual "Restricted" copy
- leave-management uses no gate-testid at all (must distinguish via the textual copy)

**For NEW pages adopting this shape, recommend a dedicated `<route>-admin-gate` testid** to dodge the textual-copy fragility — file an Issue if you spot a new page without one.

## VERIFY-BEFORE-SCAFFOLD discipline (RIPE bullet promoted 2026-05-05 — 8+ instances)

Before writing test cases, **VERIFY each backlog scenario actually has a UI surface**. Backlog framing in `docs/E2E_COVERAGE_BACKLOG.md` (especially §5 P-priorities) is sometimes aspirational — describing INTENDED UX rather than shipped behaviour. Confirmed cases:

- `/dashboard/workspace` "config (smoke-visited)" → actual page is a DOCTOR-only personal cockpit, not a config surface
- `/dashboard/reports` "department + metric filters" → actual page is Daily/History 2-tab + Generate/Schedule modals (Issue #301)
- ER "overflow → waitlist branching" + "fast-track vs standard" → 4-column kanban, no overflow lane shipped
- HR-ops "bulk CSV import + permission matrix UI + role-effective-date + shift-conflict UI" → none shipped
- P4 chart "active medication list with start/stop dates" + "medication reconciliation" + "inline imaging viewer" → none shipped
- P1 billing "edit line-item quantity PATCH endpoint" + "period-locked invoice" + "credit-note UI" + "overpayment carry-forward" → none shipped

**The verify-before-scaffold step**:

1. Grep `apps/web/src/app/dashboard/<route>/**/page.tsx` for each scenario in the backlog item (form fields, CTAs, modal triggers, filter inputs)
2. Grep `apps/api/src/routes/<route>.ts` to enumerate endpoints (does the API even ship the action?)
3. For each scenario, classify into one of three buckets:
   - **UI-shipped** → write a regular case asserting selectors + behavior
   - **API-ahead-of-UI** → write an **API-contract-pin case** (see below)
   - **Neither** → defer with explicit page.tsx/route-file evidence-citation in the spec header AND backlog closure annotation

### API-contract-pin escape valve (RIPE sub-pattern — 6+ confirmed instances)

When the backend ships a fully-validated/authorized/audit-logged endpoint but no UI surfaces it (recurring across prescription-lifecycle / insurance-claims-lifecycle / telemedicine-deep waves), don't fabricate selectors against ghost UI. Instead, write an **API-contract-pin case** that asserts the POST/PATCH body shape via `page.route` stub:

```ts
test("<API-shipped, UI-not-shipped> — POST /api/v1/<resource> body-shape contract pin (no UI surface yet)", async ({ adminPage }) => {
  const page = adminPage;
  let captured: any = null;
  await page.route("**/api/v1/<resource>", async (route) => {
    if (route.request().method() === "POST") {
      captured = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ status: 201, body: JSON.stringify({ id: "fake-id" }) });
    } else {
      await route.continue();
    }
  });
  // Drive the page through whatever proxy surface DOES exist — e.g. a
  // related modal that triggers the same endpoint, or fall back to a
  // direct fetch via `page.evaluate(() => fetch(...))` if no UI proxy
  // exists. The point is to lock the request body shape for the future
  // UI builder.
  // ...
  expect(captured).toMatchObject({ <field>: <value> });
});
```

The pattern is **"test the wire, not the widget."** Locks the contract for the future UI builder rather than rotting against ghost selectors.

Document deferred sub-scenarios in the spec header AND in the backlog closure annotation with grep-evidence so the next reader doesn't re-scope the same gap.

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
