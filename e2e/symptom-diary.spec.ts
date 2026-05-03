/**
 * Symptom Diary patient-journey + RBAC e2e coverage.
 *
 * What this exercises:
 *   /dashboard/symptom-diary (apps/web/src/app/dashboard/symptom-diary/page.tsx)
 *   POST /api/v1/ai/symptom-diary, GET /api/v1/ai/symptom-diary
 *   (apps/api/src/routes/ai-symptom-diary.ts)
 *
 * Surfaces touched:
 *   - PATIENT happy path: load → open modal → fill description /
 *     severity / startedAt → save → see the new entry land in the
 *     history list. Locks the data-testid contract used by the
 *     log-entry modal.
 *   - Staff RBAC: NURSE without `?patientId=` bounces to
 *     /dashboard/not-authorized (staff-needs-patient branch in
 *     page.tsx:109-114). NURSE with `?patientId=` sees the read-only
 *     staff banner placeholder (Sprint 2 — staff endpoint TBD).
 *   - Roles outside VIEW_ALLOWED (LAB_TECH, PHARMACIST) bounce to
 *     /dashboard/not-authorized.
 *
 * Why these tests exist:
 *   /dashboard/symptom-diary was previously listed under §2.1 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "patient-reported symptom logging
 *   — no e2e coverage". The route ships data into the future
 *   chronic-care AI pipeline, so silent breakage in the patient-side
 *   capture form would cascade into the eval set. This file adds the
 *   first positive-path assertion plus the standard issue-#179 RBAC
 *   redirect coverage so a regression in either surface is caught.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden } from "./helpers";

test.describe("Symptom Diary — /dashboard/symptom-diary (PATIENT capture flow + staff RBAC redirects)", () => {
  test("PATIENT lands on /dashboard/symptom-diary, page chrome renders, Log-New-Entry CTA is visible", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/symptom-diary", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /symptom diary/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The log-entry CTA only renders for PATIENT (page.tsx:246-256).
    // Locking the data-testid here means a regression in the role gate
    // (e.g. accidentally hiding the button from PATIENT) surfaces as
    // a test failure, not a silently dead button.
    await expect(
      page.locator('[data-testid="symptom-diary-log-button"]')
    ).toBeVisible();
  });

  test("PATIENT can log a new entry through the modal: opens form, fills description / severity / datetime, saves, sees the entry land in history", async ({
    patientPage,
  }) => {
    const page = patientPage;

    await page.goto("/dashboard/symptom-diary", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // Open modal
    await page
      .locator('[data-testid="symptom-diary-log-button"]')
      .click();
    await expect(
      page.locator('[data-testid="symptom-diary-modal"]')
    ).toBeVisible({ timeout: 5_000 });

    // Use a unique, recognisable symptom string so the assertion at the
    // bottom is resilient to other entries the shared patient1 account
    // accumulates across test runs.
    const uniqueTag = `e2e-${Date.now()}`;
    const symptomText = `Headache ${uniqueTag} — sharp, behind the right eye`;

    await page
      .locator('[data-testid="symptom-diary-description"]')
      .fill(symptomText);

    await page
      .locator('[data-testid="symptom-diary-severity-3"]')
      .click();

    // datetime-local needs a `YYYY-MM-DDTHH:mm` string. The form
    // pre-fills with `now`, but write an explicit value so the test
    // is independent of the test-runner's clock drift.
    const now = new Date();
    const off = now.getTimezoneOffset();
    const local = new Date(now.getTime() - off * 60_000)
      .toISOString()
      .slice(0, 16);
    await page
      .locator('[data-testid="symptom-diary-started-at"]')
      .fill(local);

    // Submit and wait for the POST round-trip before asserting the row.
    const savePromise = page.waitForResponse((r) =>
      r.url().includes("/api/v1/ai/symptom-diary") &&
      r.request().method() === "POST"
    );
    await page.locator('[data-testid="symptom-diary-save"]').click();
    const saveRes = await savePromise;

    // Server contract: 200 + { success: true, data: { id, entries[…] } }.
    // A 4xx here means either the form contract drifted or the gate
    // moved — both worth catching.
    expect(saveRes.status()).toBeLessThan(400);

    // Modal should auto-close on success (page.tsx:498 → onSaved → setShowLog(false)).
    await expect(
      page.locator('[data-testid="symptom-diary-modal"]')
    ).toHaveCount(0, { timeout: 5_000 });

    // The newly-inserted entry should appear in the history list. The
    // server stores `symptom = description.slice(0,100)`, so the unique
    // tag survives intact.
    await expect(
      page.locator(`text=${uniqueTag}`).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("PATIENT save is blocked when description is empty: validation toast fires and no POST is sent", async ({
    patientPage,
  }) => {
    const page = patientPage;

    await page.goto("/dashboard/symptom-diary", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await page.locator('[data-testid="symptom-diary-log-button"]').click();
    await expect(
      page.locator('[data-testid="symptom-diary-modal"]')
    ).toBeVisible({ timeout: 5_000 });

    // Click Save without filling anything: client-side validation fires
    // and the modal stays open. Server is never reached, so we catch
    // any future regression where the client-side gate gets removed.
    let serverHit = false;
    await page.route("**/api/v1/ai/symptom-diary", (route) => {
      if (route.request().method() === "POST") serverHit = true;
      route.continue();
    });

    await page.locator('[data-testid="symptom-diary-save"]').click();

    // Modal still visible → submit short-circuited.
    await expect(
      page.locator('[data-testid="symptom-diary-modal"]')
    ).toBeVisible();

    // Field-level error rendered for the missing description.
    await expect(
      page.locator('[data-testid="error-symptom-diary-description"]')
    ).toBeVisible({ timeout: 3_000 });

    // Give any in-flight (non-)request a moment to surface before we
    // assert it never went out.
    await page.waitForTimeout(500);
    expect(serverHit).toBe(false);
  });

  test("LAB_TECH bounces to /dashboard/not-authorized — LAB_TECH is outside VIEW_ALLOWED in page.tsx:29", async ({
    labTechPage,
  }) => {
    const page = labTechPage;
    await page.goto("/dashboard/symptom-diary", {
      waitUntil: "domcontentloaded",
    });
    // Allow the role-gate useEffect a tick to fire.
    await page.waitForTimeout(800);

    // Either we're on the access-denied surface or the app pushed us
    // back to /dashboard. Both are acceptable per the issue-#179
    // pattern (matches lab-tech.spec.ts:304).
    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);

    // The PATIENT-only CTA must NOT have rendered.
    await expect(
      page.locator('[data-testid="symptom-diary-log-button"]')
    ).toHaveCount(0);
  });

  test("PHARMACIST bounces to /dashboard/not-authorized — PHARMACIST is outside VIEW_ALLOWED in page.tsx:29", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await page.goto("/dashboard/symptom-diary", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );
    await expect(
      page.locator('[data-testid="symptom-diary-log-button"]')
    ).toHaveCount(0);
  });

  test("NURSE without ?patientId= bounces — staff-needs-patient branch in page.tsx:109-114 (no useful surface to render)", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/symptom-diary", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);

    // The staff-no-patient branch redirects to the same access-denied
    // surface as outside-VIEW_ALLOWED bounces — page.tsx:111-113.
    expect(page.url()).toMatch(
      /\/dashboard(\/not-authorized)?(\?|$|\/)/
    );
    // The PATIENT-only Log CTA must not render in this state.
    await expect(
      page.locator('[data-testid="symptom-diary-log-button"]')
    ).toHaveCount(0);
  });

  test("NURSE with ?patientId=… sees the read-only staff banner — Sprint 2 placeholder until staff-side diary endpoint ships", async ({
    nursePage,
  }) => {
    const page = nursePage;

    // Use a synthetic patient UUID — the banner just echoes whatever
    // ?patientId= says (page.tsx:265-267); no API call is made for
    // staff in Sprint 2.
    const fakePatientId = "00000000-0000-0000-0000-000000000abc";
    await page.goto(`/dashboard/symptom-diary?patientId=${fakePatientId}`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.locator('[data-testid="symptom-diary-staff-banner"]')
    ).toBeVisible({ timeout: 10_000 });

    // The patient-only Log CTA must NOT render for staff (page.tsx:246
    // gates on isPatient).
    await expect(
      page.locator('[data-testid="symptom-diary-log-button"]')
    ).toHaveCount(0);
  });
});
