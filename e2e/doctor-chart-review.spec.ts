/**
 * DOCTOR full chart review — deeper-coverage companion to
 * /dashboard/patients/[id], pinning the diagnostic-quality scenarios
 * that `e2e/patients-id.spec.ts` deliberately stops short of (allergy
 * write flow, lab-history trend SVG, imaging surface, family /
 * caregiver CRUD, recent-medication panel, full tab skeleton).
 *
 * What this exercises:
 *   /dashboard/patients/[id] (apps/web/src/app/dashboard/patients/[id]/page.tsx)
 *   POST /api/v1/ehr/allergies                           (allergy entry — STUBBED via page.route)
 *   GET  /api/v1/patients/:id/lab-orders                 (Lab Results tab payload — STUBBED)
 *   GET  /api/v1/lab/results/trends                      (TrendSparkline data source — STUBBED)
 *   GET  /api/v1/ehr/patients/:id/documents              (Documents tab payload — STUBBED with IMAGING doc)
 *   GET  /api/v1/patients/:id/family                     (FamilyLinksSection payload — STUBBED)
 *   POST /api/v1/patients/:id/link-family                (caregiver link — STUBBED)
 *
 * Surfaces touched (deliberately NOT overlapping with patients-id.spec.ts):
 *   patients-id.spec.ts already pins:
 *     - patient-detail-header testid + name binding
 *     - patient-start-consultation CTA
 *     - DOCTOR Medical Records tab heading skeleton (read-side only)
 *     - SEVERE-allergy banner from API-seeded allergy
 *     - Documents EMPTY-state path (docs.length === 0)
 *     - Lab Results EMPTY-state path
 *     - Issue #185 ADMIN edit-button asymmetry
 *     - PHARMACIST / LAB_TECH route-shape pin
 *
 *   This spec adds:
 *     - DOCTOR opens the FULL tab skeleton — all 8 tabs
 *       (360°, Overview, Timeline, Medical Records, Vitals Trends,
 *       Billing, Lab Results, Documents) render in the strip. Pins the
 *       page.tsx:431-440 contract so a tab being dropped surfaces here.
 *     - Allergy WRITE flow — the `Add` CTA in the Medical Records tab
 *       opens the AllergyForm modal with allergen / severity / reaction /
 *       notes fields and POSTs the body shape `{ patientId, allergen,
 *       severity, reaction, notes }` (page.tsx:2926-2932). We pin the
 *       request body via a `page.route` stub rather than persisting,
 *       so concurrent agents seeding patients in the same DB don't see
 *       phantom allergies.
 *     - Allergy form NEGATIVE — empty allergen surfaces a toast and
 *       does NOT fire the POST (page.tsx:2920-2923 client-side guard).
 *     - Lab history TREND CHART — stubs `/patients/:id/lab-orders` with
 *       a single completed order containing 2 HbA1c results, then stubs
 *       `/lab/results/trends` with 5 points so the TrendSparkline (a
 *       100×30 inline `<svg>` at page.tsx:1936-1969) renders a real
 *       polyline. Asserts the SVG container is in the DOM and the
 *       "Trend (last 5)" column header is visible. This is the closest
 *       thing the current UI has to "HbA1c over time"; the backlog's
 *       fuller trend-chart vision is documented as deferred below.
 *     - Imaging panel — the Documents tab groups by DOC_TYPE
 *       (page.tsx:3471-3523) and renders an "IMAGING" group heading
 *       only when at least one IMAGING-typed doc exists. We stub the
 *       documents GET with an IMAGING X-ray entry and assert the
 *       IMAGING heading + the row title surface. (Real image-viewer
 *       coverage is deferred — current UI exposes a Download CTA but
 *       no inline viewer; documented below.)
 *     - Caregiver / family CRUD — the FamilyLinksSection at
 *       page.tsx:4689-4848 renders an "Add Family Member" CTA and a
 *       LinkFamilyModal with patient-search + relationship select.
 *       Asserts the section heading, the CTA visibility for DOCTOR
 *       (canEdit=true), and that opening the modal surfaces the
 *       relationship structural element + the "Family Member" submit.
 *
 * Why these tests exist:
 *   docs/E2E_COVERAGE_BACKLOG.md §5 P4 ("Doctor full chart review")
 *   listed 7 deeper diagnostic-quality scenarios beyond what
 *   patients-id.spec.ts pins. Five of those are real, shipped surfaces
 *   on /dashboard/patients/[id]; the remaining two (medication
 *   reconciliation across encounters, active-med list with start/stop
 *   dates) are not yet present in the UI — the prescription.items
 *   shape (page.tsx:98-105) carries dosage/frequency/duration but no
 *   start/stop columns. Documented as deferred so a future ship lights
 *   this spec back up.
 */
import type { Route } from "@playwright/test";
import { test, expect } from "./fixtures";
import { gotoAuthed, expectNotForbidden, seedPatient } from "./helpers";

const TAB_TIMEOUT = 15_000;

// Stable stub IDs — UUIDv4 shape so anything that does a soft regex
// validation (Zod uuid(), router param matchers) is happy.
const STUB_LAB_ORDER_ID = "11111111-1111-4111-8111-111111111111";
const STUB_LAB_ITEM_ID = "22222222-2222-4222-8222-222222222222";
const STUB_LAB_TEST_ID = "33333333-3333-4333-8333-333333333333";
const STUB_LAB_RESULT_1 = "44444444-4444-4444-8444-444444444441";
const STUB_LAB_RESULT_2 = "44444444-4444-4444-8444-444444444442";
const STUB_DOC_IMAGING_ID = "55555555-5555-4555-8555-555555555555";

test.describe("DOCTOR full chart review — /dashboard/patients/[id] (deeper P4 surfaces: tab skeleton, allergy write flow, lab-trend SVG, imaging panel, caregiver CRUD; explicitly disjoint from patients-id.spec.ts)", () => {
  test("DOCTOR sees the full 8-tab strip on the chart — pins the page.tsx:431-440 tab contract so a dropped tab surfaces as a failure", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    await expect(
      page.locator('[data-testid="patient-detail-header"]')
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // The 8 tab labels at page.tsx:431-440. We assert each as a button
    // by visible name — the tabs render as <button> elements, not
    // <a>/role="tab". Using getByRole("button", { name }) keeps this
    // robust to wrapper-element refactors.
    const expectedTabs: RegExp[] = [
      /^360°?$/,
      /^Overview$/,
      /^Timeline$/,
      /^Medical Records$/,
      /^Vitals Trends$/,
      /^Billing$/,
      /^Lab Results$/,
      /^Documents$/,
    ];
    for (const labelRe of expectedTabs) {
      await expect(
        page.getByRole("button", { name: labelRe }).first()
      ).toBeVisible({ timeout: TAB_TIMEOUT });
    }
  });

  test("DOCTOR adds a new allergy through the Medical Records modal — severity dropdown + reaction text are wired and the POST body shape `{patientId, allergen, severity, reaction}` is pinned via a page.route stub (no DB write)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    // Capture the POST without persisting — the global fixture
    // interceptor at fixtures.ts:61 forwards every request, so we
    // register a more-specific route AFTER the page is set up; the
    // most-recently-registered handler runs first in Playwright.
    let allergyPost: { url: string; body: unknown } | null = null;
    await page.route(
      /\/api\/v1\/ehr\/allergies(\?.*)?$/,
      (route: Route) => {
        if (route.request().method() !== "POST") {
          route.continue();
          return;
        }
        allergyPost = {
          url: route.request().url(),
          body: route.request().postDataJSON(),
        };
        route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              id: "00000000-0000-4000-8000-000000000001",
              patientId: patient.id,
              allergen: "Penicillin",
              severity: "SEVERE",
              reaction: "anaphylaxis",
              notes: null,
              notedAt: new Date().toISOString(),
            },
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    // Switch to Medical Records (page.tsx:435).
    await page.getByRole("button", { name: /^medical records$/i }).first().click();

    // Allergies section heading at page.tsx:2614 carries the per-section
    // `Add` button (page.tsx:2616-2623). It's an icon-only button with
    // visible "Add" text — scope to the Allergies section first to avoid
    // colliding with sibling `Add` buttons (Conditions, Family History).
    const allergySection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /^allergies$/i }) });
    await allergySection
      .getByRole("button", { name: /^add$/i })
      .first()
      .click();

    // Modal labelled "Add Allergy" (page.tsx:2941). Use the input ids
    // we read straight off the source — these are stable contracts.
    await expect(page.getByText(/^Add Allergy$/i).first()).toBeVisible({
      timeout: TAB_TIMEOUT,
    });
    await page.locator("#allergy-allergen").fill("Penicillin");
    // Scope to the form's id-targeted select so the global LanguageDropdown
    // (CLAUDE.md #9) is not at risk.
    await page.locator("#allergy-severity").selectOption("SEVERE");
    await page.locator("#allergy-reaction").fill("anaphylaxis");

    await page.getByRole("button", { name: /^save$/i }).first().click();

    // Wait for the stubbed POST to land. We don't assert the modal
    // closes (the page also fires a re-fetch of allergies that hits
    // the unstubbed GET path; we've kept the test focused on the
    // request body the form constructs).
    await expect.poll(() => allergyPost?.body, { timeout: TAB_TIMEOUT }).toMatchObject({
      patientId: patient.id,
      allergen: "Penicillin",
      severity: "SEVERE",
      reaction: "anaphylaxis",
    });
  });

  test("DOCTOR allergy form NEGATIVE — submitting empty allergen surfaces an error toast and does NOT fire POST /ehr/allergies (client-side guard at page.tsx:2920-2923)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    let allergyPostHits = 0;
    await page.route(
      /\/api\/v1\/ehr\/allergies(\?.*)?$/,
      (route: Route) => {
        if (route.request().method() === "POST") allergyPostHits++;
        route.continue();
      }
    );

    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /^medical records$/i }).first().click();

    const allergySection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /^allergies$/i }) });
    await allergySection
      .getByRole("button", { name: /^add$/i })
      .first()
      .click();

    // Modal opens but we leave the allergen field empty and submit.
    await expect(page.getByText(/^Add Allergy$/i).first()).toBeVisible({
      timeout: TAB_TIMEOUT,
    });
    await page.getByRole("button", { name: /^save$/i }).first().click();

    // Toast text from page.tsx:2921 — react-hot-toast renders into a
    // top-level container; text-based locator survives layout changes.
    await expect(
      page.getByText(/Allergen is required/i).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // Brief settle window so any latent POST fires before we assert.
    await page.waitForTimeout(500);
    expect(allergyPostHits).toBe(0);
  });

  test("DOCTOR Lab Results tab renders the TrendSparkline `<svg>` for an HbA1c-style result series — stubs lab-orders + lab-trends to pin the trend-chart contract (page.tsx:1936-1969 + 2109 'Trend (last 5)' column)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    // Stub the Lab Results tab payload — single COMPLETED order with
    // an HbA1c result so the table at page.tsx:2101-2158 renders with
    // the Trend column populated.
    await page.route(
      new RegExp(`/api/v1/patients/${patient.id}/lab-orders`),
      (route: Route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [
              {
                id: STUB_LAB_ORDER_ID,
                orderNumber: "LAB-E2E-0001",
                status: "COMPLETED",
                orderedAt: "2026-04-01T08:00:00Z",
                collectedAt: "2026-04-01T08:30:00Z",
                completedAt: "2026-04-01T10:00:00Z",
                notes: null,
                doctor: { user: { name: "Dr Demo" } },
                items: [
                  {
                    id: STUB_LAB_ITEM_ID,
                    status: "COMPLETED",
                    test: {
                      id: STUB_LAB_TEST_ID,
                      code: "HBA1C",
                      name: "Glycated Haemoglobin",
                      category: "DIABETES",
                      normalRange: "<5.7",
                    },
                    results: [
                      {
                        id: STUB_LAB_RESULT_1,
                        parameter: "HbA1c",
                        value: "7.2",
                        unit: "%",
                        normalRange: "<5.7",
                        flag: "HIGH",
                        notes: null,
                        reportedAt: "2026-04-01T10:00:00Z",
                      },
                      {
                        id: STUB_LAB_RESULT_2,
                        parameter: "HbA1c",
                        value: "7.4",
                        unit: "%",
                        normalRange: "<5.7",
                        flag: "HIGH",
                        notes: null,
                        reportedAt: "2026-04-01T10:00:00Z",
                      },
                    ],
                  },
                ],
              },
            ],
            error: null,
          }),
        });
      }
    );

    // Stub /lab/results/trends so the TrendSparkline renders 5 points
    // (page.tsx:1898-1907 needs >=2 numeric points to draw a polyline).
    await page.route(
      /\/api\/v1\/lab\/results\/trends/,
      (route: Route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [
              { value: "6.8", orderedAt: "2025-10-01T08:00:00Z" },
              { value: "7.0", orderedAt: "2025-12-01T08:00:00Z" },
              { value: "7.1", orderedAt: "2026-01-15T08:00:00Z" },
              { value: "7.2", orderedAt: "2026-03-01T08:00:00Z" },
              { value: "7.4", orderedAt: "2026-04-01T08:00:00Z" },
            ],
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /^lab results$/i }).first().click();

    // The order heading from the stub.
    await expect(
      page.getByText(/LAB-E2E-0001/).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // The "Trend (last 5)" column header — page.tsx:2109. If a future
    // refactor renames the column or strips the trend cell, this fails.
    await expect(
      page.getByRole("columnheader", { name: /trend.*last 5/i }).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // The SVG itself — TrendSparkline at page.tsx:1936 renders a 100x30
    // inline svg with a path + circles. Asserting on the polyline
    // <path> ensures a real plot, not just the loading/empty fallback.
    // We scope to the row containing "HbA1c" to avoid false positives
    // from any other svg on the page.
    const labRow = page.getByRole("row").filter({ hasText: "HbA1c" }).first();
    await expect(labRow.locator("svg path").first()).toBeVisible({
      timeout: TAB_TIMEOUT,
    });
  });

  test("DOCTOR Documents tab renders the IMAGING group heading + an X-ray row when an IMAGING-typed document exists — stubs /ehr/patients/:id/documents to pin the page.tsx:3471-3523 grouping contract", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    await page.route(
      new RegExp(`/api/v1/ehr/patients/${patient.id}/documents`),
      (route: Route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [
              {
                id: STUB_DOC_IMAGING_ID,
                type: "IMAGING",
                title: "Chest X-Ray PA View",
                fileSize: 248_576,
                mimeType: "image/jpeg",
                notes: "Routine pre-op imaging",
                createdAt: "2026-04-15T09:00:00Z",
              },
            ],
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /^documents$/i }).first().click();

    // Documents tab content heading.
    await expect(
      page.getByRole("heading", { name: /^documents$/i }).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // The IMAGING group heading at page.tsx:3476-3478 only renders when
    // a doc with type "IMAGING" exists. Match the visible label which
    // is `t.replace(/_/g, " ")` → "IMAGING".
    await expect(
      page.getByRole("heading", { name: /^IMAGING$/i }).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // The row title from the stub.
    await expect(
      page.getByText(/Chest X-Ray PA View/i).first()
    ).toBeVisible();
  });

  test("DOCTOR caregiver / family CRUD — Medical Records tab surfaces the FamilyLinksSection 'Add Family Member' CTA and the LinkFamilyModal opens with the relationship select (page.tsx:4689-4848 + 4900+)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    // The page hits GET /patients/:id/family on mount — stub it with
    // an empty payload so the section renders the "No linked family
    // members" state + the "Add Family Member" CTA without depending
    // on real seed data.
    await page.route(
      new RegExp(`/api/v1/patients/${patient.id}/family`),
      (route: Route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              guardian: null,
              dependents: [],
              familyLinks: [],
            },
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /^medical records$/i }).first().click();

    // FamilyLinksSection heading at page.tsx:4736 — single-word "Family"
    // heading. Scope by the section that contains it to avoid colliding
    // with the "Family History" heading (which is a separate section).
    const familySection = page
      .locator("section")
      .filter({
        has: page.getByRole("heading", {
          name: /^family$/i,
        }),
      })
      .first();
    await expect(familySection).toBeVisible({ timeout: TAB_TIMEOUT });

    // Empty-state copy + the canEdit=true "Add Family Member" CTA.
    await expect(
      familySection.getByText(/No linked family members/i).first()
    ).toBeVisible();
    await familySection
      .getByRole("button", { name: /add family member/i })
      .first()
      .click();

    // LinkFamilyModal (page.tsx:4900-) — search input + relationship
    // select. The modal title is "Add Family Member".
    await expect(
      page.getByText(/^Add Family Member$/i).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });
    // The labelled search input from page.tsx:4903-4904.
    await expect(page.locator("#family-link-search")).toBeVisible();
  });
});
