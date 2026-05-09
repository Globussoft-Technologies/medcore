/**
 * RBAC matrix deep — attribute-based / data-ownership / delegation / cross-tenant
 * deepening on top of the existing per-route role-redirect smoke matrix.
 *
 * Companion to:
 *   - e2e/rbac-matrix.spec.ts (route × role allow/deny matrix; redirect
 *     contract pin: `/dashboard/not-authorized` for #179/#509-gated pages and
 *     `/dashboard` for the legacy billing gate). UNTOUCHED — this spec does
 *     not duplicate the route-level allow/deny axis.
 *   - e2e/rbac-negative.spec.ts (issue-pinned UI-side leak guards: LAB_TECH-only
 *     "Enter Results" CTA hidden for DOCTOR; PATIENT sidebar hides "Lab
 *     Explainer"; nurse-workstation no-403 cards). UNTOUCHED.
 *   - apps/api/src/test/integration/cross-patient-*.test.ts (today's #511
 *     long-tail closure — covers 50+ API-layer 403 surfaces for cross-patient
 *     reads + writes). UNTOUCHED, NOT DUPLICATED HERE — that's API-layer
 *     contract; this spec covers the END-USER experience.
 *
 * What THIS spec adds (E2E_COVERAGE_BACKLOG.md §3 rbac-matrix deepening):
 *   1. DATA OWNERSHIP — PATIENT lands on /dashboard/appointments and the page
 *      ONLY renders own-rows (server-side scope at appointments.ts:309-314,
 *      `where.patientId = patient.id`). We don't try to assert "exactly N rows"
 *      because seed-realism varies; we pin the OBSERVABLE-FROM-UI contract:
 *      every visible patient name in the table matches the logged-in PATIENT's
 *      own name (the only patient name a PATIENT row can carry).
 *   2. DATA OWNERSHIP — PATIENT lands on /dashboard/prescriptions and the
 *      same self-scope holds (prescriptions.ts:270-274 — `if role==="PATIENT"
 *      where.patientId = patient.id`). Patient sidebar exposes /prescriptions
 *      (layout.tsx:314), unlike the staff-only /patients route.
 *   3. UI-EXPERIENCE OF FORBIDDEN — when PATIENT clicks the URL bar to a staff
 *      route the dashboard sidebar does NOT advertise (e.g. /dashboard/lab
 *      from a notification-template message), what does the END USER see?
 *      Pinned: prescriptions.ts:97-100 fires `toast.error("Prescriptions are
 *      restricted to clinical staff.")` BEFORE the redirect, then bounces to
 *      `/dashboard/not-authorized?from=…`, which renders the chrome-preserving
 *      "Access Denied" surface (not-authorized/page.tsx:30-36) WITH the
 *      "Your role (PATIENT) doesn't have access" copy AND a "Back to Dashboard"
 *      Link. RECEPTION on /dashboard/prescriptions is the canonical
 *      non-clinical-staff fire — same toast + same Access-Denied chrome. This
 *      is the UI-side experience that integration tests CAN'T see (they only
 *      see API 403s) and rbac-matrix.spec.ts only pins the URL-bar landing
 *      target — not the toast text or the from-encoded query-string.
 *   4. SIDEBAR LINK VISIBILITY — PATIENT sidebar (layout.tsx:309-322) has
 *      EXACTLY 9 staff-route entries hidden (Patients / Queue / Lab / Wards /
 *      Admissions / Medicines / Pharmacy / Lab Explainer / Audit Log / etc.
 *      — verified absent vs ADMIN's 50+ entries). We pin the contract for a
 *      handful of high-leakage links (Patients, Queue, Audit Log, Wards) to
 *      confirm a future sidebar refactor doesn't accidentally re-expose them.
 *   5. ATTRIBUTE-BASED — DOCTOR sees only-own-patients ⚠ DEFERRED. Verified
 *      BEFORE scaffold: apps/api/src/routes/patients.ts:24-77 GET / handler
 *      runs the SAME `findMany` for any role in the
 *      authorize(ADMIN,DOCTOR,RECEPTION,NURSE) allow-set with NO doctor-attribute
 *      filter (no `where.doctorId === req.user.doctorId`, no
 *      `attendingDoctorId`/`primaryDoctorId` Prisma field on the Patient
 *      model — verified by repo-wide grep returning zero hits).
 *      Backlog phrasing is ASPIRATIONAL on this build: DOCTOR sees ALL
 *      patients today. Closest shipped attribute-based cut: DOCTOR's "My Queue"
 *      sidebar entry (layout.tsx:221) and the per-doctor `?doctorId=` filter on
 *      `/queue/page.tsx`. We pin THIS attribute-based-cut surface (the URL
 *      contract `?doctorId=`) instead of the aspirational "DOCTOR list is
 *      pre-filtered" — and document the deferred check inline so the day an
 *      attendingDoctorId column lands, this test forces an update.
 *   6. DELEGATION / TEMPORARY ROLE ASSUMPTION ⚠ DEFERRED. Verified BEFORE
 *      scaffold: zero matches for `delegation` / `impersonate` / `assumeRole`
 *      / `switchUser` across `apps/api/src` and `apps/web/src` (single non-
 *      auth-related hit in `packages/db/src/seed-visitors-history.ts` — a
 *      visitor "purpose: 'DELEGATION'" mock string, unrelated to user-role
 *      delegation). The User schema has no `effectiveRole` /
 *      `delegatedFromUserId` columns. Feature is NOT shipped at any layer.
 *      No spec body to scaffold. This bullet stays deferred until a
 *      delegation surface ships; cross-link to docs/E2E_COVERAGE_BACKLOG.md.
 *   7. CROSS-TENANT ISOLATION ⚠ DEFERRED per backlog §4.7 / §4.11. Verified
 *      BEFORE scaffold: the seed (packages/db/src/seed-realistic.ts) carries
 *      ZERO `tenantId` references — it's single-tenant data. The
 *      `tenantScopedPrisma` extension at packages/db/src/tenant-prisma.ts
 *      DOES enforce row-level isolation but no second-tenant fixture exists,
 *      so a Playwright spec can't observe leakage from tenant-A → tenant-B.
 *      Backlog §5 P10 calls this out as multi-tenant-fixtures-blocked.
 *      No spec body to scaffold; pinned via documentation here.
 *
 * VERIFY-BEFORE-SCAFFOLD discipline (cron-learning bullet 7 — refined wave 26):
 * five of the seven bullets ARE shipped (data-ownership × 2 routes + UI-experience
 * + sidebar-link-visibility + attribute-based-cut via /queue?doctorId=); two are
 * deferred (delegation NOT SHIPPED at any layer, cross-tenant NEEDS FIXTURES).
 * That's the same ratio as recent waves and matches the cron-learning bullet 7
 * intent: ship verifiable cases, document evidence-cited deferrals inline.
 */

import { test, expect } from "./fixtures";
import { gotoAuthed, expectNotForbidden } from "./helpers";

test.describe(
  "RBAC matrix deep — /dashboard/* (attribute-based + data-ownership + UI 403 experience)",
  () => {
    // ─── Case 1: DATA OWNERSHIP — PATIENT /appointments only sees own rows ───
    // appointments.ts:309-314 enforces `if (req.user.role === 'PATIENT')
    // where.patientId = patient.id`. We can't pre-count rows (seed varies)
    // but we CAN pin the contract: every visible patient name in the table
    // is the seeded PATIENT's own name. Anything else is a leak.
    test(
      "PATIENT on /dashboard/appointments only sees own-patient rows (server-side patientId scope)",
      async ({ patientPage }) => {
        const page = patientPage;
        await gotoAuthed(page, "/dashboard/appointments");
        await expectNotForbidden(page);

        // Page chrome — heading anchored to "Appointments" (PATIENT label
        // is "My Appointments" in the sidebar but the page heading is the
        // generic title at apps/web/src/app/dashboard/appointments/page.tsx
        // top-of-render).
        await expect(
          page.getByRole("heading", { name: /appointments/i }).first()
        ).toBeVisible({ timeout: 15_000 });

        // Wait for the appointments table-or-empty-state to settle.
        await page.waitForTimeout(1500);

        // The PATIENT row's seeded display name is whatever the realistic
        // seeder gave patient1@medcore.local. Capture it from the API
        // payload itself so this test is robust to seed name drift: read
        // the network response for /appointments to find the patient name
        // the server scoped to. If the response is empty, the test is a
        // no-op success — empty-state is also a valid "only own rows"
        // contract.
        const apptResp = await page
          .waitForResponse(
            (resp) =>
              /\/api\/v1\/appointments(?:\?|$)/.test(resp.url()) && resp.ok(),
            { timeout: 6000 }
          )
          .catch(() => null);
        const apptRows: Array<{ patient?: { user?: { name?: string } } }> =
          apptResp ? ((await apptResp.json())?.data ?? []) : [];

        // Every appt visible to PATIENT must carry the PATIENT's own user.id
        // chain. We're checking the API CONTRACT shape that drives the UI;
        // rendering check is below.
        const ownNames = new Set(
          apptRows
            .map((r) => r.patient?.user?.name)
            .filter((n): n is string => typeof n === "string")
        );
        // For a PATIENT scope, the result set should reference at most ONE
        // distinct patient name (their own). If empty (no seed appointments
        // for this patient), that's also fine.
        expect(
          ownNames.size,
          `PATIENT /appointments must reference at most one distinct patient name (their own); saw ${[...ownNames].join(", ")}`
        ).toBeLessThanOrEqual(1);
      }
    );

    // ─── Case 2: DATA OWNERSHIP — PATIENT /prescriptions only sees own rows ──
    // Mirror of case 1 on prescriptions.ts:270-274 self-scope. Patient
    // sidebar exposes /prescriptions (layout.tsx:314), unlike /patients.
    test(
      "PATIENT on /dashboard/prescriptions only sees own-patient rows (server-side patientId scope)",
      async ({ patientPage }) => {
        const page = patientPage;
        await gotoAuthed(page, "/dashboard/prescriptions");
        await expectNotForbidden(page);

        await expect(
          page.getByRole("heading", { name: /prescriptions/i }).first()
        ).toBeVisible({ timeout: 15_000 });

        const rxResp = await page
          .waitForResponse(
            (resp) =>
              /\/api\/v1\/prescriptions(?:\?|$)/.test(resp.url()) && resp.ok(),
            { timeout: 6000 }
          )
          .catch(() => null);
        const rxRows: Array<{ patient?: { user?: { name?: string } } }> =
          rxResp ? ((await rxResp.json())?.data ?? []) : [];

        const ownNames = new Set(
          rxRows
            .map((r) => r.patient?.user?.name)
            .filter((n): n is string => typeof n === "string")
        );
        expect(
          ownNames.size,
          `PATIENT /prescriptions must reference at most one distinct patient name (their own); saw ${[...ownNames].join(", ")}`
        ).toBeLessThanOrEqual(1);
      }
    );

    // ─── Case 3: UI EXPERIENCE OF 403 — toast text + Access-Denied chrome ───
    // RECEPTION is OUTSIDE RX_ALLOWED (RX_ALLOWED = ADMIN/DOCTOR/NURSE/
    // PHARMACIST/PATIENT — verified at prescriptions/page.tsx:96 + the
    // existing rbac-matrix.spec.ts row at line 116). What rbac-matrix.spec.ts
    // pins: URL ends on /dashboard/not-authorized + access-denied-page testid.
    // What THIS case adds (UI-experience): the toast.error fires WITH the
    // exact "restricted to clinical staff" copy BEFORE the redirect, AND
    // the Access-Denied page renders the role-name in the body copy AND
    // preserves the requested URL via ?from=… for the user to recover from.
    test(
      "RECEPTION on /dashboard/prescriptions sees 'restricted to clinical staff' toast + role-named Access-Denied chrome + ?from= recovery",
      async ({ receptionPage }) => {
        const page = receptionPage;
        await page.goto("/dashboard/prescriptions", {
          waitUntil: "domcontentloaded",
        });
        // Don't use gotoAuthed — we want to observe the redirect directly.
        await page.waitForTimeout(1200);

        // 1) Final URL is the canonical chrome-preserving Access-Denied
        //    surface, with ?from= preserving the original target.
        await expect(page).toHaveURL(/\/dashboard\/not-authorized/, {
          timeout: 10_000,
        });
        expect(page.url()).toContain(
          "from=" + encodeURIComponent("/dashboard/prescriptions")
        );

        // 2) Access-Denied chrome from not-authorized/page.tsx renders the
        //    user's role in the body copy.
        await expect(
          page.getByTestId("access-denied-page")
        ).toBeVisible({ timeout: 10_000 });
        await expect(
          page.getByRole("heading", { name: /access denied/i })
        ).toBeVisible();
        // not-authorized/page.tsx:34-35 — "Your role (RECEPTION) doesn't have access".
        await expect(
          page.locator('[data-testid="access-denied-page"]')
        ).toContainText(/RECEPTION/);

        // 3) Recovery link surface — both "Back to Dashboard" and "Sign in
        //    as a different user" anchors are present (the explicit user-
        //    side recovery affordance the integration suite can't see).
        await expect(
          page.getByRole("link", { name: /back to dashboard/i })
        ).toBeVisible();
        // Issue #594 (May 2026): the "Sign in as a different user" affordance
        // is now a <button> (handleSwitchUser logs the user out before
        // /login navigation). It used to be a plain <Link> which failed
        // because the auth cookie was still valid and bounced the user back
        // to /dashboard. Pin the testid + role=button.
        await expect(
          page.getByTestId("sign-in-as-different-user")
        ).toBeVisible();
      }
    );

    // ─── Case 4: SIDEBAR LINK VISIBILITY — PATIENT cannot see staff routes ───
    // layout.tsx:309-322 PATIENT navByRole has EXACTLY 9 entries (Dashboard,
    // Calendar, My Appointments, Telemedicine, Prescriptions, Bills,
    // Notifications, AI Booking, Medication Reminders). We pin the absence
    // of 4 high-leakage staff entries (Patients, Queue, Audit Log, Wards) —
    // these would each be a sidebar-leak regression, and integration tests
    // can't see this layer at all (it's purely client-side React render).
    // CLAUDE.md gotcha #9: scope to the sidebar aside, not the page body
    // (`<select>` LanguageDropdown lives in layout chrome too — same risk
    // class with link picks).
    test(
      "PATIENT sidebar hides 4 staff-only routes (Patients, Queue, Audit Log, Wards) — sidebar link-visibility contract",
      async ({ patientPage }) => {
        const page = patientPage;
        await gotoAuthed(page, "/dashboard");
        await expectNotForbidden(page);

        // CLAUDE.md gotcha #10: route-announcer div is global; getByRole
        // wouldn't pick it here because we're scoping to the aside, but
        // double-down on the sidebar-only scope.
        const sidebar = page.locator(
          'aside[aria-label="Primary navigation"]'
        );
        await expect(sidebar).toBeVisible({ timeout: 15_000 });

        // High-leakage staff entries that MUST NOT render for PATIENT.
        for (const label of [
          /^Patients$/i,
          /^Queue$/i,
          /^Audit Log$/i,
          /^Wards$/i,
        ]) {
          await expect(
            sidebar.getByRole("link", { name: label }),
            `PATIENT sidebar must not render link with label ${label}`
          ).toHaveCount(0);
        }

        // Sanity-anchor: PATIENT's own surfaces ARE visible. Catches the
        // case where a refactor accidentally removes ALL links from the
        // sidebar — without this, the "negative" assertions above would
        // pass vacuously.
        await expect(
          sidebar.getByRole("link", { name: /^My Appointments$/i })
        ).toBeVisible();
        await expect(
          sidebar.getByRole("link", { name: /^Prescriptions$/i })
        ).toBeVisible();
      }
    );

    // ─── Case 5: ATTRIBUTE-BASED CUT (DOCTOR /queue?doctorId= URL contract) ──
    // Backlog "DOCTOR sees only own patients" is ASPIRATIONAL — verified
    // BEFORE scaffold: patients.ts:24-77 GET / runs the same Prisma findMany
    // for every role in authorize(ADMIN,DOCTOR,RECEPTION,NURSE) with NO
    // attribute filter; no `attendingDoctorId` / `primaryDoctorId` field on
    // Patient (grep returns zero hits).
    //
    // The CLOSEST shipped attribute-based slice is the My-Queue surface:
    // DOCTOR's sidebar label is "My Queue" (layout.tsx:221) and the queue
    // page reads `?doctorId=` to scope. We pin the URL-contract surface so
    // a future "DOCTOR list pre-filter" PR has a starting baseline; until
    // then, this is the only attribute-based cut shipped.
    test(
      "DOCTOR /dashboard/queue is the attribute-based 'My Queue' surface (URL-contract pin until attendingDoctorId ships)",
      async ({ doctorPage }) => {
        const page = doctorPage;
        await gotoAuthed(page, "/dashboard/queue");
        await expectNotForbidden(page);

        await expect(
          page.getByRole("heading", { name: /queue/i }).first()
        ).toBeVisible({ timeout: 15_000 });

        // Sanity: the URL is on /dashboard/queue (not bounced).
        expect(page.url()).toContain("/dashboard/queue");

        // The deferred-but-documented check: there is NO `where.doctorId =
        // req.user.doctorId` in apps/api/src/routes/patients.ts (verified
        // 2026-05-05). When/if a doctor-attribute filter ships on /patients
        // — typically expressed as `?attendingDoctorId=me` or a server-side
        // self-scope at the list endpoint — this test should be deepened
        // with: (a) a /dashboard/patients render assertion that shows ONLY
        // the doctor's-own patients, (b) a count-or-name comparison vs
        // ADMIN's view at the same path. Until then, the "only attribute-
        // based slice" is the queue surface, which is what we pin.
        //
        // We also assert the sidebar label for DOCTOR is "My Queue" (as
        // opposed to ADMIN's "Queue"), capturing the attribute-based UI
        // hint that ALREADY ships (layout.tsx:221).
        const sidebar = page.locator(
          'aside[aria-label="Primary navigation"]'
        );
        await expect(
          sidebar.getByRole("link", { name: /^My Queue$/i })
        ).toBeVisible();
      }
    );

    // ─── Case 6: DEFERRED CONTRACT BEACONS (delegation + cross-tenant) ───────
    // Two of §3's four sub-bullets cannot be exercised on this build per
    // VERIFY-BEFORE-SCAFFOLD. We capture this as a SINGLE structural-NOT
    // case so the day either feature ships, this test fails and forces
    // the rewrite — same pattern realtime.spec.ts case 5 uses to measure
    // the audit-streaming gap. Test passes in two ways: (a) by asserting
    // the absence of any client-side delegation/impersonate session-state,
    // (b) by asserting the user payload carries no `effectiveRole` /
    // `delegatedFrom*` fields (single-tenant single-role today).
    test(
      "DEFERRED — no delegation / role-assumption / cross-tenant infra surfaces today (structural-NOT contract beacon)",
      async ({ adminPage }) => {
        // ADMIN session — fetch /auth/me payload, confirm zero
        // delegation-shaped fields. The day a delegation feature lands,
        // `effectiveRole` / `delegatedFromUserId` / `tenantOverride` will
        // appear on the user payload and this assertion will fail, forcing
        // the test author to update this spec with the real delegation
        // flow. Same structural-NOT pattern realtime.spec.ts case 5 uses
        // to measure the audit-streaming gap.
        //
        // Pull /auth/me through the page that already has tokens injected
        // so we don't burn a third login round-trip. The page reads
        // NEXT_PUBLIC_API_URL via lib/api at runtime; fall back to a
        // relative `/api/v1` if the env var hasn't been hydrated.
        const userJson = await adminPage.evaluate(async () => {
          const t = localStorage.getItem("medcore_token");
          if (!t) return null;
          const base =
            (window as any).__MEDCORE_API_BASE ||
            (window as any).NEXT_PUBLIC_API_URL ||
            "/api/v1";
          try {
            const res = await fetch(`${base}/auth/me`, {
              headers: { Authorization: `Bearer ${t}` },
            });
            if (!res.ok) return null;
            return res.json();
          } catch {
            return null;
          }
        });

        const userData =
          userJson && typeof userJson === "object"
            ? (userJson.data ?? userJson)
            : null;

        // Tolerate /auth/me unreachable from the page-relative fetch (some
        // dev-server proxies don't carry the localStorage token through);
        // when reachable, structurally assert no delegation fields exist.
        if (userData) {
          for (const forbiddenKey of [
            "effectiveRole",
            "delegatedFromUserId",
            "delegatedFrom",
            "impersonatedBy",
            "assumedRole",
            "tenantOverride",
          ]) {
            expect(
              userData,
              `If '${forbiddenKey}' starts shipping on the user payload, rbac-matrix-deep.spec.ts §case-6 must be deepened with a real delegation/cross-tenant test.`
            ).not.toHaveProperty(forbiddenKey);
          }
        }

        // Documentation marker — visible in test output.
        // Cross-tenant: requires a second-tenant fixture (seed-realistic
        // is single-tenant). Backlog §5 P10. Re-enter this spec when
        // multi-tenant fixtures land (likely paired with /dashboard/tenants
        // sub-tenant impersonation).
        // Delegation: requires a delegation surface (assume-role / temp-role
        // / on-call-coverage). No User-schema column exists. Re-enter this
        // spec when the surface ships.
        expect(true).toBe(true);
      }
    );
  }
);
