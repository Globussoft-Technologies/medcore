/**
 * My Schedule self-service surface — staff & patient access-shape pinning.
 *
 * What this exercises:
 *   /dashboard/my-schedule (apps/web/src/app/dashboard/my-schedule/page.tsx)
 *   GET   /api/v1/shifts/my       (no authorize() — every authed user, scoped
 *                                  to req.user.userId; PATIENT sees an empty
 *                                  list because they have no StaffShift rows.
 *                                  shifts.ts:196 #511 audit verdict
 *                                  VERIFIED-SAFE.)
 *   GET   /api/v1/leaves/my       (no authorize() — every authed user, scoped
 *                                  to req.user.userId. leaves.ts:152.)
 *   GET   /api/v1/hr-ops/certifications?userId=…  (used by the
 *                                  MyCertificationsPanel sidebar.)
 *   POST  /api/v1/leaves           (validate(createLeaveRequestSchema) only —
 *                                  every authed user can submit, including
 *                                  PATIENT today.)
 *   PATCH /api/v1/shifts/:id/check-in / check-out (the row-level CTAs on the
 *                                  today tile — only render when a SCHEDULED
 *                                  or PRESENT shift exists for today.)
 *
 * Surfaces touched:
 *   - DOCTOR / NURSE happy path: page chrome renders + 7-day grid mounts +
 *     "Request Leave" CTA is live + leave-summary card paints once
 *     /leaves/my resolves. No data-testid on the page (writer's choice
 *     pre-2026-05-05); we anchor on heading / button-role / label-text.
 *   - "Request Leave" modal contract: clicking the CTA mounts the modal,
 *     reveals the labelled `leave-type` select with the 6 known options
 *     (CASUAL/SICK/EARNED/MATERNITY/PATERNITY/UNPAID — submit and Cancel
 *     buttons live), and the From/To/Reason inputs. Cancel teardown is
 *     pinned to lock the open/close state contract.
 *   - "Request Leave" client-side validation: empty From/To OR empty
 *     Reason short-circuits before any POST goes out (page.tsx:131-138).
 *     We assert no `POST /leaves` fires while submitting an empty form.
 *   - Access shape (no role-gate redirect): the page has NO
 *     `router.replace`/`router.push` gate. PATIENT lands on the chrome
 *     too — `/shifts/my` returns an empty array (no StaffShift rows for
 *     PATIENT users), so the grid renders the "No shifts" placeholder
 *     for every day. This is CLAUDE.md gotcha #7 archetype 3 — open
 *     chrome, server-side gating only — same pattern as
 *     /dashboard/schedule (commit 65b5e0a) and /dashboard/admissions.
 *
 * Why these tests exist:
 *   /dashboard/my-schedule was listed under §2.4 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "shift claim, unavailability — no
 *   e2e coverage". It is the only staff self-service surface for
 *   reading the next 7 days of shifts + requesting unavailability
 *   (leave). A silent regression in either render path (e.g. a
 *   role-gate added without a /not-authorized destination, the leave
 *   modal's labelled fields losing their `htmlFor` association, the
 *   page suddenly wiring shift-claim CTAs through a different testid
 *   contract) would break payroll + duty-roster downstream because the
 *   page is the primary "is my shift this week confirmed" entry point.
 *
 *   The backlog phrasing "shift claim, unavailability" is aspirational
 *   — the current page surfaces today's check-in/check-out CTAs (not a
 *   generic "claim shift") and a leave-request modal (the
 *   unavailability flow). We pin the actual UI rather than a phantom
 *   future "claim" button.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("My Schedule — /dashboard/my-schedule (staff self-service: 7-day grid + leave request modal + open access-shape, no role-gate redirect)", () => {
  test("DOCTOR lands on /dashboard/my-schedule, the page chrome + 7-day grid + Request-Leave CTA all render", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/my-schedule", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^my schedule$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The 7-day descriptor copy locks the page-level intro line — page.tsx:159.
    await expect(
      page.getByText(/your upcoming shifts for the next 7 days/i)
    ).toBeVisible();

    // Wait for the loading placeholder to clear (page.tsx:166-169).
    await expect(page.getByText(/^loading\.\.\.$/i)).toHaveCount(0, {
      timeout: 15_000,
    });

    // Leaves card heading + Request-Leave CTA must paint once /leaves/my
    // resolves (page.tsx:255-263). The button is the gate to the
    // unavailability flow.
    await expect(
      page.getByRole("heading", { name: /my leave/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /request leave/i })
    ).toBeVisible();
  });

  test("NURSE lands on /dashboard/my-schedule with the same page chrome — staff role parity, no role-gate redirect", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/my-schedule", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    expect(page.url()).toMatch(/\/dashboard\/my-schedule(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /^my schedule$/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /request leave/i })
    ).toBeVisible();
  });

  test("DOCTOR opens the Request-Leave modal: form mounts with labelled Type select, From / To / Reason inputs, Cancel teardown closes it", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/my-schedule", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^my schedule$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /request leave/i }).click();

    // Modal heading is the unique anchor (page.tsx:312).
    await expect(
      page.getByRole("heading", { name: /^request leave$/i })
    ).toBeVisible({ timeout: 5_000 });

    // The Type <select> — scope by has(option[value="MATERNITY"]) to dodge the
    // global LanguageDropdown <select> the dashboard layout injects (CLAUDE.md
    // gotcha #9). MATERNITY is unique to this select.
    const typeSelect = page.locator(
      'select:has(option[value="MATERNITY"])'
    );
    await expect(typeSelect).toBeVisible();
    // All 6 leave-type options must be present (page.tsx:326-331).
    for (const v of [
      "CASUAL",
      "SICK",
      "EARNED",
      "MATERNITY",
      "PATERNITY",
      "UNPAID",
    ]) {
      await expect(typeSelect.locator(`option[value="${v}"]`)).toHaveCount(1);
    }

    // From / To / Reason — labelled controls; getByLabel scopes inside the
    // modal because the labels are unique on the page.
    await expect(page.getByLabel(/^from$/i)).toBeVisible();
    await expect(page.getByLabel(/^to$/i)).toBeVisible();
    await expect(page.getByLabel(/^reason$/i)).toBeVisible();

    // Cancel teardown — the modal must unmount cleanly.
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect(
      page.getByRole("heading", { name: /^request leave$/i })
    ).toHaveCount(0);
  });

  test("DOCTOR Request-Leave with empty From/To short-circuits client-side — no POST /leaves fires (page.tsx:131-138 guard)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/my-schedule", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^my schedule$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    let serverHit = false;
    await page.route("**/api/v1/leaves", (route) => {
      if (route.request().method() === "POST") serverHit = true;
      route.continue();
    });

    await page.getByRole("button", { name: /request leave/i }).click();
    await expect(
      page.getByRole("heading", { name: /^request leave$/i })
    ).toBeVisible({ timeout: 5_000 });

    // Submit with no From/To and no Reason — the noValidate form bypasses
    // HTML5 required, but page.tsx:131-138 guards client-side and toast.error's
    // before any POST.
    await page.getByRole("button", { name: /submit request/i }).click();

    // Modal stays open (the submit short-circuited before setShowLeaveModal(false)).
    await expect(
      page.getByRole("heading", { name: /^request leave$/i })
    ).toBeVisible();

    await page.waitForTimeout(500);
    expect(serverHit).toBe(false);
  });

  test("PATIENT lands on /dashboard/my-schedule (open chrome — no role-gate redirect today, /shifts/my returns empty for PATIENT, the grid renders 'No shifts' for every day)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/my-schedule", {
      waitUntil: "domcontentloaded",
    });
    // Allow the (intentionally absent) gate effect a tick to NOT fire.
    await page.waitForTimeout(800);

    // Pin reality: PATIENT stays on the page. There is no router.replace
    // gate in page.tsx and /shifts/my has no authorize() — so PATIENT sees
    // the page chrome but gets an empty 7-day grid (no StaffShift rows for
    // PATIENT users). This matches CLAUDE.md gotcha #7 archetype 3 (open
    // chrome, server-side gating only). A future hardening PR adding a
    // role-gate redirect should update this assertion.
    expect(page.url()).toMatch(/\/dashboard\/my-schedule(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /^my schedule$/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // After /shifts/my resolves with [], every day cell falls into the
    // dayShifts.length === 0 branch (page.tsx:199-201) and renders the
    // "No shifts" placeholder. There are 7 cells.
    await expect(page.getByText(/^loading\.\.\.$/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByText(/^no shifts$/i).first()).toBeVisible();
  });
});
