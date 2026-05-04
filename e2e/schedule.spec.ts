/**
 * Staff schedule management ADMIN/DOCTOR-flow + access-shape e2e coverage.
 *
 * What this exercises:
 *   /dashboard/schedule (apps/web/src/app/dashboard/schedule/page.tsx)
 *   GET  /api/v1/doctors/:id/schedule       (authorize ADMIN, DOCTOR, RECEPTION, NURSE)
 *   GET  /api/v1/doctors/:id/overrides      (authorize ADMIN, DOCTOR, RECEPTION, NURSE)
 *   POST /api/v1/doctors/:id/schedule       (authorize ADMIN, DOCTOR)
 *   POST /api/v1/doctors/:id/override       (authorize ADMIN, DOCTOR, RECEPTION)
 *   (apps/api/src/routes/doctors.ts:32-289)
 *
 * Surfaces touched:
 *   - ADMIN happy path: page chrome renders + doctor selector populates from
 *     /doctors + Add-Slot + Add-Override CTAs are visible. The doctor-selector
 *     branch (page.tsx:256-274) is ADMIN-only — locking its visibility for
 *     ADMIN and absence for DOCTOR catches regressions in the `isAdmin` gate.
 *   - DOCTOR happy path: page renders without the doctor-selector (DOCTOR
 *     resolves their own profile via loadOwnDoctorId at page.tsx:110-125).
 *     The two CTAs still render — the page is fully accessible.
 *   - ADMIN Add-Slot client validation: with Start ≥ End, the issue-#178
 *     guard at page.tsx:159-162 fires a toast and blocks the POST (locking
 *     the pre-flight gate so a future "trust the server" refactor can't
 *     silently send invalid bodies and burn a 400 round-trip).
 *   - ADMIN Add-Override "modify hours" mode reveals start/end time inputs
 *     (page.tsx:470-507) — locks the conditional-render contract used by
 *     the half-day override flow.
 *   - Access shape (no redirect): the page has NO router.replace gate.
 *     NURSE / RECEPTION / PATIENT all land on the page chrome with the
 *     same heading; the role differentiation is purely server-side
 *     (POST /schedule rejects NURSE + RECEPTION + PATIENT) and selector
 *     visibility (only ADMIN sees the picker). This is the
 *     /dashboard/admissions-shape behaviour called out in
 *     SKILL.md / commit 65b5e0a — pin reality, don't fabricate a redirect.
 *   - PATIENT access shape: PATIENT also lands on the page (no role-gate
 *     redirect) but cannot resolve any doctor profile of their own, so the
 *     grid is empty. This is the surprising current behaviour — flagged in
 *     the closure note rather than papered over.
 *
 * Why these tests exist:
 *   /dashboard/schedule was listed under §2.4 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "staff schedule — no e2e coverage".
 *   The page is the only ADMIN-side surface for setting weekly availability
 *   + per-day overrides that drive every appointment booking + slot search,
 *   so a silent regression (e.g. role-gate drift, modal contract change,
 *   client-side validation removed) cascades into appointments + queue.
 *   This spec adds the first positive-path assertions plus the
 *   access-shape pinning (no redirect — page is open chrome, only POST
 *   gates are server-side).
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Schedule — /dashboard/schedule (ADMIN/DOCTOR weekly-availability mgmt + access-shape pinning, no role-gate redirect)", () => {
  test("ADMIN lands on /dashboard/schedule, page chrome renders, doctor-selector populates and Add-Slot + Add-Override CTAs are visible", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/schedule", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /schedule management/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Both CTAs render unconditionally (page.tsx:240-251) — no role gate.
    await expect(
      page.getByRole("button", { name: /add slot/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /add override/i })
    ).toBeVisible();

    // The doctor selector is ADMIN-only (page.tsx:256 — isAdmin && doctors.length > 0).
    // It only renders once /doctors resolves, so wait on the labelled control.
    await expect(
      page.getByLabel(/select doctor/i)
    ).toBeVisible({ timeout: 15_000 });
  });

  test("DOCTOR lands on /dashboard/schedule, sees the page chrome + Add-Slot CTA, the ADMIN-only doctor selector is absent", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/schedule", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /schedule management/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Add-Slot CTA renders for DOCTOR (POST /doctors/:id/schedule allows
    // DOCTOR per doctors.ts:222) so the button must be live.
    await expect(
      page.getByRole("button", { name: /add slot/i })
    ).toBeVisible();

    // Give the doctors fetch + resolveOwnDoctor effect a beat to settle so we
    // assert the *final* DOM, not a transient pre-fetch state.
    await page.waitForTimeout(800);

    // The "Select Doctor" label/select is gated on isAdmin (page.tsx:256), so
    // DOCTOR must NOT see it. A regression flipping that gate to !isAdmin would
    // surface here.
    await expect(
      page.getByLabel(/select doctor/i)
    ).toHaveCount(0);
  });

  test("ADMIN Add-Slot form blocks submission when start ≥ end — issue-#178 client guard fires toast and the POST never goes out", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/schedule", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // Wait for the doctor selector to populate so selectedDoctorId is set;
    // otherwise handleAddSchedule resolves to POST /doctors//schedule (404).
    await expect(
      page.getByLabel(/select doctor/i)
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /add slot/i }).click();

    // Modal heading confirms the form rendered (page.tsx:284).
    await expect(
      page.getByRole("heading", { name: /add schedule slot/i })
    ).toBeVisible({ timeout: 5_000 });

    // Set Start = 14:00, End = 13:00 — reverse order. The page-level guard at
    // page.tsx:159-162 should short-circuit before any /schedule POST.
    await page.getByLabel(/start time/i).fill("14:00");
    await page.getByLabel(/end time/i).fill("13:00");

    let serverHit = false;
    await page.route("**/api/v1/doctors/*/schedule", (route) => {
      if (route.request().method() === "POST") serverHit = true;
      route.continue();
    });

    await page.getByRole("button", { name: /save slot/i }).click();

    // Form stays open — submit short-circuited.
    await expect(
      page.getByRole("heading", { name: /add schedule slot/i })
    ).toBeVisible();

    await page.waitForTimeout(500);
    expect(serverHit).toBe(false);
  });

  test("ADMIN Add-Override 'Modify Hours' mode reveals the conditional start/end time inputs — locks the page.tsx:470-507 toggle contract", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/schedule", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByLabel(/select doctor/i)
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /add override/i }).click();

    await expect(
      page.getByRole("heading", { name: /schedule override/i })
    ).toBeVisible({ timeout: 5_000 });

    // In the default "Block Entire Day" mode the start/end time inputs are
    // hidden (page.tsx:470 wraps them in `!overrideForm.isBlocked`).
    await expect(page.getByLabel(/^start time$/i)).toHaveCount(0);
    await expect(page.getByLabel(/^end time$/i)).toHaveCount(0);

    // Flip to "Modify Hours" — the two inputs should mount.
    await page.getByLabel(/^type$/i).selectOption("modify");

    await expect(page.getByLabel(/^start time$/i)).toBeVisible({
      timeout: 3_000,
    });
    await expect(page.getByLabel(/^end time$/i)).toBeVisible({
      timeout: 3_000,
    });
  });

  test("NURSE lands on /dashboard/schedule (page is fully accessible — no role-gate redirect, only the doctor-selector + write CTAs are role-gated server-side)", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/schedule", {
      waitUntil: "domcontentloaded",
    });
    // Allow the (intentionally absent) role-gate effect a tick to NOT fire.
    await page.waitForTimeout(800);

    // Pin reality: NURSE stays on /dashboard/schedule. The page has no
    // router.replace; the API rejects POST /schedule for NURSE
    // (doctors.ts:222 — authorize(ADMIN, DOCTOR)) but the page chrome is
    // open. This matches the /dashboard/admissions shape (commit 65b5e0a).
    expect(page.url()).toMatch(/\/dashboard\/schedule(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /schedule management/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The ADMIN-only doctor selector must NOT render for NURSE (page.tsx:256).
    await expect(
      page.getByLabel(/select doctor/i)
    ).toHaveCount(0);
  });

  test("RECEPTION lands on /dashboard/schedule with the same open chrome — RECEPTION can POST overrides (doctors.ts:259) but not slots, no UI redirect", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await page.goto("/dashboard/schedule", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard\/schedule(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /schedule management/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // ADMIN-only selector still hidden for RECEPTION.
    await expect(
      page.getByLabel(/select doctor/i)
    ).toHaveCount(0);
  });

  test("PATIENT lands on /dashboard/schedule (no redirect today — surface is unguarded by the page; flagged behaviour, see closure note in E2E_COVERAGE_BACKLOG §2.4)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/schedule", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    // The page renders for PATIENT too — there's no `if (role === ...)
    // router.replace(...)` gate in page.tsx. PATIENT has no doctor profile
    // so the grid stays empty + the doctor selector stays hidden, but the
    // chrome is visible. Pinning this lets a future hardening PR (adding a
    // role-gate redirect) see the regression here and update the test.
    expect(page.url()).toMatch(/\/dashboard\/schedule(\?|$|\/)/);
    await expect(
      page.getByRole("heading", { name: /schedule management/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByLabel(/select doctor/i)
    ).toHaveCount(0);
  });
});
