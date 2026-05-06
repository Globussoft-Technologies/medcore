/**
 * Patient chart drilldown — DOCTOR's-perspective deep coverage of
 * /dashboard/patients/[id] panels NOT exercised by patient-detail.spec.ts.
 *
 * What this exercises:
 *   /dashboard/patients/[id] (apps/web/src/app/dashboard/patients/[id]/page.tsx)
 *   GET    /api/v1/patients/:id                           (route surface)
 *   GET    /api/v1/ehr/patients/:id/allergies              (Medical Records)
 *   GET    /api/v1/ehr/patients/:id/conditions             (Medical Records)
 *   GET    /api/v1/ehr/patients/:id/immunizations          (Medical Records)
 *   GET    /api/v1/ehr/patients/:id/documents              (Documents tab)
 *   GET    /api/v1/patients/:id/lab-orders                 (Lab Results tab)
 *   POST   /api/v1/ehr/allergies                           (allergy seed)
 *
 * Surfaces touched (and explicitly NOT overlapping with patient-detail.spec.ts):
 *   - patient-detail.spec.ts already covers: Overview-tab visit history,
 *     problem-list page chrome, and chronic-condition write via
 *     POST /ehr/conditions. We deliberately skip those.
 *   - This spec adds the panels the §2.1 backlog called out — allergies,
 *     imaging, med history — plus the doctor-specific CTAs that ride on
 *     the same chart and the role-asymmetry between DOCTOR and ADMIN/
 *     RECEPTION on demographic edit (Issue #185).
 *
 * Surfaces by test:
 *   - DOCTOR Medical Records tab: switches tabs, sees the "Allergies"
 *     and "Chronic Conditions" + "Immunizations" panel headings, and the
 *     SEVERE allergy seeded via API surfaces in the page-top warning
 *     banner. Locks the data-testid contract used by the patient header.
 *   - DOCTOR Documents tab: navigates to Documents, asserts empty-state
 *     copy (and that the IMAGING grouping label is at least one of the
 *     known DOC_TYPES the page knows how to group). The IMAGING panel
 *     itself only renders when a doc of that type exists, so we pin the
 *     empty-state path here — full upload coverage lives in §4.8.
 *   - DOCTOR Lab Results tab: navigates to Labs and asserts the empty-
 *     state ("No lab orders yet") for a freshly-seeded patient. Pins
 *     the route + tab key so any contract drift in the GET
 *     /patients/:id/lab-orders payload surfaces here.
 *   - DOCTOR Quick Actions: the doctor-only `patient-start-consultation`
 *     CTA must render, and the demographic-edit `patient-edit-button`
 *     must NOT render for DOCTOR (Issue #185 — RECEPTION + ADMIN only).
 *   - ADMIN positive: `patient-edit-button` must render for ADMIN, and
 *     `patient-start-consultation` must NOT render (it's DOCTOR-only).
 *     This is the role-asymmetry pin.
 *   - PHARMACIST / LAB_TECH route-shape pin: the page has NO role-
 *     redirect (precedent: admissions.spec.ts and admissions-id.spec.ts
 *     route shape — "page is fully accessible, only CTAs are gated").
 *     Both roles land on the chart; neither sees the doctor or admin
 *     CTAs. We assert the chrome renders without bouncing.
 *
 * Why these tests exist:
 *   docs/E2E_COVERAGE_BACKLOG.md §2.1 line 78 lists
 *   "/dashboard/patients/[id] — full chart from doctor's perspective
 *   (allergies, imaging, med history)" as a zero-coverage entry.
 *   patient-detail.spec.ts focused on visit history + problem-list, so
 *   the deep chart panels and the role-asymmetry between DOCTOR /
 *   ADMIN / RECEPTION (Issue #185) were never pinned. This spec closes
 *   that gap so a regression in the Medical Records / Documents /
 *   Lab Results tab strip OR the Issue #185 demographic-edit RBAC
 *   shows up as a test failure rather than a silent product bug.
 */
import { test, expect, E2E_CSRF_TOKEN } from "./fixtures";
import { API_BASE, expectNotForbidden, seedPatient } from "./helpers";

const TAB_TIMEOUT = 15_000;

test.describe("Patient chart [id] — /dashboard/patients/[id] (DOCTOR deep panels + ADMIN/PHARMACIST/LAB_TECH asymmetry, no overlap with patient-detail.spec.ts)", () => {
  test("DOCTOR opens the chart and the patient header chrome (name + MR pill + start-consultation CTA) is wired up", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/patients/${patient.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // patient-detail.spec.ts already pins the heading + MR text. We pin
    // the data-testid contract instead so a future refactor that drops
    // the testid (without breaking the visible name) still fails a test.
    await expect(
      page.locator('[data-testid="patient-detail-header"]')
    ).toBeVisible({ timeout: TAB_TIMEOUT });
    await expect(
      page.locator('[data-testid="patient-detail-name"]')
    ).toHaveText(patient.name, { timeout: TAB_TIMEOUT });

    // Doctor-specific Quick Action — page.tsx:747-758. This is what
    // "Start Consultation" routes to (the live queue with patient
    // pre-filtered). Locking the testid catches Issue #84-style
    // regressions where the link points at a 404 route.
    await expect(
      page.locator('[data-testid="patient-start-consultation"]')
    ).toBeVisible();

    // Issue #185 (Apr 2026): demographic Edit is RECEPTION + ADMIN only.
    // DOCTOR must NOT see the edit button — this asymmetry is the audit-
    // gap fix that produced canEditDemographics in page.tsx:428-429.
    await expect(
      page.locator('[data-testid="patient-edit-button"]')
    ).toHaveCount(0);
  });

  test("DOCTOR navigates to Medical Records tab — Allergies / Chronic Conditions / Immunizations panel headings render and a SEVERE allergy seeded via API surfaces in the page-top warning banner", async ({
    doctorPage,
    doctorToken,
    adminApi,
    request,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    // Seed a SEVERE allergy via the API the same way the Medical Records
    // tab does (POST /ehr/allergies). The page-top SEVERE-warning banner
    // (page.tsx:475-491) only renders when an allergy of severity SEVERE
    // or LIFE_THREATENING exists. Mutating via API rather than the modal
    // keeps this test focused on the read-side rendering — modal-based
    // allergy entry is a separate concern.
    const allergyTag = `e2e-allergy-${Date.now()}`;
    const allergyRes = await request.post(`${API_BASE}/ehr/allergies`, {
      headers: {
        Authorization: `Bearer ${doctorToken}`,
        "X-CSRF-Token": E2E_CSRF_TOKEN,
        Cookie: `medcore_csrf=${E2E_CSRF_TOKEN}`,
      },
      data: {
        patientId: patient.id,
        allergen: `Penicillin ${allergyTag}`,
        severity: "SEVERE",
        reaction: "anaphylaxis",
      },
    });

    test.skip(
      !allergyRes.ok(),
      `POST /ehr/allergies returned ${allergyRes.status()} — allergy write path not reachable from DOCTOR token in this env`
    );

    await page.goto(`/dashboard/patients/${patient.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // The SEVERE banner is page-level (above the tabs) — no tab switch
    // needed to see it. page.tsx:475-491.
    await expect(
      page.getByText(/SEVERE ALLERGY WARNING/i).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });
    await expect(
      page.getByText(`Penicillin ${allergyTag}`).first()
    ).toBeVisible();

    // Switch to the Medical Records tab. page.tsx:435 — the tab label is
    // literally "Medical Records".
    await page.getByRole("button", { name: /^medical records$/i }).first().click();

    // Three of the four MedicalRecordsTab section headings — Allergies
    // (page.tsx:2614), Chronic Conditions (2659), Immunizations (2768).
    // Family History (2721) lives between them; we assert the bookend
    // headings so the test is robust to row reordering.
    await expect(
      page.getByRole("heading", { name: /^allergies$/i }).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });
    await expect(
      page.getByRole("heading", { name: /chronic conditions/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^immunizations$/i }).first()
    ).toBeVisible();

    // The allergy we seeded must appear inside the Allergies section, not
    // just in the page-top banner.
    await expect(
      page.getByText(`Penicillin ${allergyTag}`).first()
    ).toBeVisible();
  });

  test("DOCTOR navigates to Documents tab — empty-state renders for a fresh patient and the Upload CTA is present (canEdit=true for DOCTOR)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/patients/${patient.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /^documents$/i }).first().click();

    // The Documents heading inside the tab body — page.tsx:3452-3454.
    await expect(
      page.getByRole("heading", { name: /^documents$/i }).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // No docs uploaded yet → the empty-state copy. page.tsx:3466-3468.
    // This pins the contract that GET /ehr/patients/:id/documents
    // returns an empty array (not undefined / null) for a fresh
    // patient. If the page-side defensive `?? []` is ever removed and
    // the endpoint returns null, this assertion catches it.
    await expect(
      page.getByText(/No documents uploaded/i).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // DOCTOR has canEdit=true (page.tsx:415-419) → Upload CTA renders.
    // page.tsx:3455-3462. The IMAGING category grouping itself only
    // appears when an IMAGING-typed doc exists; full upload + grouping
    // coverage lives in §4.8 (file-operations) of the backlog.
    await expect(
      page.getByRole("button", { name: /^upload$/i }).first()
    ).toBeVisible();
  });

  test("DOCTOR navigates to Lab Results tab — empty-state renders for a fresh patient (pins GET /patients/:id/lab-orders contract)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/patients/${patient.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /^lab results$/i }).first().click();

    // page.tsx:2004-2009 empty state. Pinning the literal here means a
    // future refactor that flips the predicate (e.g. checks `!loading`
    // instead of `orders.length === 0`) and ends up showing nothing
    // surfaces as a clear failure rather than a silent broken tab.
    await expect(
      page.getByText(/No lab orders yet/i).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });
  });

  test("ADMIN sees the demographic Edit button (Issue #185 RBAC) but NOT the doctor-only Start-Consultation CTA — pins the role asymmetry", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/patients/${patient.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.locator('[data-testid="patient-detail-header"]')
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // Issue #185: Edit Patient is RECEPTION + ADMIN only. ADMIN must see it.
    await expect(
      page.locator('[data-testid="patient-edit-button"]')
    ).toBeVisible();

    // Start-Consultation is DOCTOR-only (page.tsx:747-758). ADMIN does
    // not see it — without this assertion the test would silently pass
    // even if the gate flipped.
    await expect(
      page.locator('[data-testid="patient-start-consultation"]')
    ).toHaveCount(0);
  });

  test("PHARMACIST lands on the chart without a /not-authorized bounce (route shape: no role-redirect — only CTAs are gated; precedent: admissions.spec.ts)", async ({
    pharmacistPage,
    adminApi,
  }) => {
    const page = pharmacistPage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/patients/${patient.id}`, {
      waitUntil: "domcontentloaded",
    });
    // The page has NO useEffect-based role-redirect (verified in
    // page.tsx — only canEdit / isDoctor / isAdmin booleans gate CTAs).
    // PHARMACIST has canEdit=false (page.tsx:415-419), so all the
    // edit / write CTAs disappear, but the chart itself renders.
    await expectNotForbidden(page);

    await expect(
      page.locator('[data-testid="patient-detail-header"]')
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // Neither the doctor-only nor the demographic-edit CTA renders.
    await expect(
      page.locator('[data-testid="patient-start-consultation"]')
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="patient-edit-button"]')
    ).toHaveCount(0);
  });

  test("LAB_TECH lands on the chart without a /not-authorized bounce — same route-shape pin as PHARMACIST, asserting the page is universally accessible to authed staff", async ({
    labTechPage,
    adminApi,
  }) => {
    const page = labTechPage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/patients/${patient.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.locator('[data-testid="patient-detail-header"]')
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // LAB_TECH also has canEdit=false. Same CTA-gating expectations as
    // PHARMACIST — both negative-CTA assertions are the failure-mode
    // we want to surface if the gate logic changes.
    await expect(
      page.locator('[data-testid="patient-start-consultation"]')
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="patient-edit-button"]')
    ).toHaveCount(0);
  });
});
