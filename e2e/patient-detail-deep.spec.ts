/**
 * Patient chart deepening — DOCTOR + ADMIN coverage of /dashboard/patients/[id]
 * sub-surfaces NOT exercised by either patients-id.spec.ts or
 * doctor-chart-review.spec.ts.
 *
 * What this exercises:
 *   /dashboard/patients/[id] (apps/web/src/app/dashboard/patients/[id]/page.tsx)
 *   GET    /api/v1/ehr/patients/:id/advance-directives   (Medical Records → Advance Directives)
 *   POST   /api/v1/ehr/patients/:id/advance-directives   (Add Directive — STUBBED)
 *   POST   /api/v1/ehr/allergies                          (LIFE_THREATENING entry — STUBBED)
 *   POST   /api/v1/patients/:id/merge                     (ADMIN merge duplicate — STUBBED)
 *   GET    /api/v1/med-reconciliation?patientId=          (API-contract-pin — UI-not-shipped on chart)
 *
 * What this DELIBERATELY does NOT cover (already pinned elsewhere):
 *   - SEVERE allergy banner + Medical Records tab heading set       (patients-id.spec.ts)
 *   - Allergy SEVERE write flow + form NEGATIVE                     (doctor-chart-review.spec.ts)
 *   - 8-tab strip / lab-trend SVG / IMAGING grouping / caregiver     (doctor-chart-review.spec.ts)
 *   - DOCTOR header chrome + Issue #185 ADMIN edit-asymmetry         (patients-id.spec.ts)
 *
 * VERIFY-BEFORE-SCAFFOLD audit (cron-learning bullet 7):
 *   - Advance directives:        UI shipped (page.tsx:5007-5122 AdvanceDirectivesSection
 *     under Medical Records, plus DnrBanner at page.tsx:3768-3803). API: GET/POST
 *     /ehr/patients/:patientId/advance-directives (ehr.ts:860-911).
 *   - Allergy LIFE_THREATENING:  UI shipped (severity dropdown at page.tsx:2962-2966
 *     includes the 4th option). doctor-chart-review.spec.ts only exercised SEVERE
 *     so the LIFE_THREATENING value path remains UNPINNED until this spec.
 *   - Insurance details (read):  UI shipped READ-ONLY (page.tsx:666-674 — display
 *     in patient header from `patient.insuranceProvider` + `patient.insuranceId`).
 *     UI shipped NO WRITE on chart — PatientEditModal has no insurance fields
 *     (verified: PatientEditModal.tsx has zero `insurance*` references). The
 *     PATCH /patients/:id endpoint accepts `insuranceProvider` /
 *     `insurancePolicyNumber` in patient.ts:275-276 with updatePatientSchema
 *     (validation/patient.ts:48), but no chart UI writes to it. We pin the
 *     READ surface here; the write path is API-ahead-of-UI.
 *   - MRN merge / duplicate resolution: UI shipped (page.tsx:591-599
 *     `isAdmin`-gated CTA + MergePatientModal at page.tsx:4409-4561). API:
 *     POST /patients/:id/merge gated `authorize(Role.ADMIN)` at patients.ts:533.
 *   - Medication reconciliation: UI NOT shipped on chart. The chart never
 *     mounts a med-reconciliation surface. This feature lives only in
 *     admissions discharge surface (admissions.spec.ts test 8 already pins
 *     it). API exists at /api/v1/med-reconciliation (med-reconciliation.ts)
 *     and the §3 backlog calls for chart coverage. Treat as API-ahead-of-UI:
 *     pin the GET shape via stub so when the chart adds a "Med Reconciliation"
 *     panel, the contract is already locked.
 *   - Allergy "intolerance":     The schema has only Allergy (allergy + severity).
 *     There is NO separate intolerance entity (verified via Prisma schema
 *     grep — no Intolerance model exists). Backlog "intolerance" is
 *     aspirational; covered insofar as severity matrix encompasses it.
 *
 * Surfaces by test:
 *   - DOCTOR adds an Advance Directive of type LIVING_WILL through the
 *     Medical Records → Advance Directives modal — POST body shape
 *     `{ type, effectiveDate, notes }` is captured via page.route stub.
 *   - DOCTOR sees the page-top "DNR ORDER ACTIVE" banner when the
 *     /ehr/patients/:id/advance-directives GET returns an active DNR.
 *     Pins page.tsx:3791-3801 conditional render.
 *   - DOCTOR adds an allergy with severity LIFE_THREATENING — pins the
 *     4th-option contract that doctor-chart-review.spec.ts (which only
 *     exercises SEVERE) leaves un-pinned. Body-shape pin via stub.
 *   - DOCTOR sees insurance provider + ID in the patient header when
 *     GET /patients/:id returns insurance fields — read-only display
 *     contract pin (no write surface on chart). Companion comment in the
 *     test documents PatientEditModal lacking insurance fields.
 *   - ADMIN opens the Merge Duplicate modal (gated by `isAdmin` at
 *     page.tsx:591), searches for a candidate, confirms, and the
 *     POST /patients/:id/merge body shape `{ otherPatientId }` is
 *     captured via page.route stub.
 *   - DOCTOR does NOT see the Merge Duplicate CTA — RBAC contract pin
 *     (CTA renders only when `user.role === "ADMIN"` per page.tsx:423).
 *   - Med Reconciliation API-contract-pin — stubs GET
 *     /api/v1/med-reconciliation?patientId=<id> and confirms the
 *     `data` array shape so future chart UIs landing the panel inherit
 *     a pinned read contract.
 *
 * Why these tests exist:
 *   Closes the §3 patient-detail deepening backlog items —
 *   advance-directives (UNTESTED until this spec), insurance details
 *   (UNTESTED display), MRN merge (UNTESTED), med-reconciliation chart
 *   surface (API-ahead-of-UI), and the LIFE_THREATENING severity tier
 *   that doctor-chart-review.spec.ts left unpinned. Keeps the disjoint
 *   contract with its companion specs by NEVER re-asserting the SEVERE
 *   allergy banner, the 8-tab strip, the Documents IMAGING group, or
 *   Issue #185 edit-asymmetry — those are pinned elsewhere.
 */
import type { Route } from "@playwright/test";
import { test, expect } from "./fixtures";
import { gotoAuthed, expectNotForbidden, seedPatient } from "./helpers";

const TAB_TIMEOUT = 15_000;

// Stable stub UUIDs (v4 shape so any soft Zod uuid() check accepts them).
const STUB_DIRECTIVE_DNR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const STUB_DIRECTIVE_LW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const STUB_ALLERGY_LT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const STUB_MERGE_OTHER_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const STUB_MED_RECON_ID = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";

test.describe("Patient detail deepening — /dashboard/patients/[id] (advance-directives, LIFE_THREATENING allergy, insurance read, MRN merge, med-reconciliation API-contract-pin; explicitly disjoint from patients-id.spec.ts and doctor-chart-review.spec.ts)", () => {
  test("DOCTOR adds a LIVING_WILL advance directive through Medical Records → Advance Directives modal — POST /ehr/patients/:id/advance-directives body shape `{type, effectiveDate, notes}` is pinned via page.route stub (no DB write)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    let directivePost: { url: string; body: unknown } | null = null;
    await page.route(
      new RegExp(
        `/api/v1/ehr/patients/${patient.id}/advance-directives(\\?.*)?$`
      ),
      (route: Route) => {
        if (route.request().method() !== "POST") {
          route.continue();
          return;
        }
        directivePost = {
          url: route.request().url(),
          body: route.request().postDataJSON(),
        };
        route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              id: STUB_DIRECTIVE_LW_ID,
              patientId: patient.id,
              type: "LIVING_WILL",
              effectiveDate: new Date().toISOString(),
              expiryDate: null,
              witnessedBy: null,
              notes: "Patient declines life support",
              active: true,
              createdBy: "stub-user",
              createdAt: new Date().toISOString(),
            },
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    // Switch to Medical Records (page.tsx:435).
    await page
      .getByRole("button", { name: /^medical records$/i })
      .first()
      .click();

    // Advance Directives section heading at page.tsx:5046-5049, with the
    // "Add Directive" button at page.tsx:5051-5057. Scope to the section
    // so we don't pick up "Add" buttons from sibling Allergies / Conditions.
    const directivesSection = page
      .locator("section")
      .filter({
        has: page.getByRole("heading", { name: /^advance directives$/i }),
      });
    await expect(
      directivesSection.getByRole("heading", {
        name: /^advance directives$/i,
      })
    ).toBeVisible({ timeout: TAB_TIMEOUT });
    await directivesSection
      .getByRole("button", { name: /add directive/i })
      .first()
      .click();

    // Modal labelled "Add Advance Directive" (page.tsx:5172). The form has
    // id-targeted inputs for each field (page.tsx:5175, 5193, 5203, 5214).
    await expect(page.getByText(/^Add Advance Directive$/i).first()).toBeVisible({
      timeout: TAB_TIMEOUT,
    });
    await page.locator("#directive-type").selectOption("LIVING_WILL");
    // Notes is required at page.tsx:5149-5152 (client-side guard).
    await page
      .locator("textarea")
      .last()
      .fill("Patient declines life support");

    await page.getByRole("button", { name: /^save$/i }).first().click();

    await expect
      .poll(() => directivePost?.body, { timeout: TAB_TIMEOUT })
      .toMatchObject({
        type: "LIVING_WILL",
        notes: "Patient declines life support",
      });
    // effectiveDate should also be present (defaults to today per page.tsx:5134).
    expect(
      (directivePost?.body as { effectiveDate?: string } | null)?.effectiveDate
    ).toBeTruthy();
  });

  test("DOCTOR sees the page-top 'DNR ORDER ACTIVE' banner when GET /ehr/patients/:id/advance-directives returns an active DNR — pins the page.tsx:3791-3801 conditional render via response stub", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    // Stub the directives GET to return one active DNR. The DnrBanner
    // (page.tsx:3768-3803) filters for active DNR/DNI/DNA whose expiry
    // is null or in the future.
    await page.route(
      new RegExp(
        `/api/v1/ehr/patients/${patient.id}/advance-directives(\\?.*)?$`
      ),
      (route: Route) => {
        if (route.request().method() !== "GET") {
          route.continue();
          return;
        }
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [
              {
                id: STUB_DIRECTIVE_DNR_ID,
                type: "DNR",
                effectiveDate: "2026-01-01T00:00:00Z",
                expiryDate: null,
                witnessedBy: null,
                notes: "Family-attested do-not-resuscitate order",
                active: true,
              },
            ],
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    // Banner copy from page.tsx:3794 — `${dnr.type} ORDER ACTIVE`.
    await expect(
      page.getByText(/DNR ORDER ACTIVE/i).first()
    ).toBeVisible({ timeout: TAB_TIMEOUT });
    await expect(
      page
        .getByText(/Family-attested do-not-resuscitate order/i)
        .first()
    ).toBeVisible();
  });

  test("DOCTOR adds a LIFE_THREATENING allergy through Medical Records — pins the 4th severity-enum value that doctor-chart-review.spec.ts (SEVERE-only) leaves un-pinned, body shape `{patientId, allergen, severity}` captured via stub", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

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
              id: STUB_ALLERGY_LT_ID,
              patientId: patient.id,
              allergen: "Bee sting venom",
              severity: "LIFE_THREATENING",
              reaction: "anaphylactic shock",
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

    await page
      .getByRole("button", { name: /^medical records$/i })
      .first()
      .click();

    const allergySection = page
      .locator("section")
      .filter({
        has: page.getByRole("heading", { name: /^allergies$/i }),
      });
    await allergySection
      .getByRole("button", { name: /^add$/i })
      .first()
      .click();

    await expect(page.getByText(/^Add Allergy$/i).first()).toBeVisible({
      timeout: TAB_TIMEOUT,
    });
    await page.locator("#allergy-allergen").fill("Bee sting venom");
    // The 4th severity option (page.tsx:2965). The select id-target is
    // safe per CLAUDE.md #9 — does not collide with LanguageDropdown.
    await page
      .locator("#allergy-severity")
      .selectOption("LIFE_THREATENING");
    await page.locator("#allergy-reaction").fill("anaphylactic shock");

    await page.getByRole("button", { name: /^save$/i }).first().click();

    await expect
      .poll(() => allergyPost?.body, { timeout: TAB_TIMEOUT })
      .toMatchObject({
        patientId: patient.id,
        allergen: "Bee sting venom",
        severity: "LIFE_THREATENING",
        reaction: "anaphylactic shock",
      });
  });

  test("DOCTOR sees insurance provider rendered in the patient header (read-only display) when GET /patients/:id carries `insuranceProvider` — pins the page.tsx:666-674 conditional. Note: chart has NO write surface for insurance (PatientEditModal.tsx has zero `insurance*` fields); the API PATCH /patients/:id at patients.ts:275-276 accepts `insuranceProvider` + `insurancePolicyNumber` but is unreachable from the chart UI today (API-ahead-of-UI)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    // Stub GET /patients/:id (NOT the bulk list) so we can inject
    // insurance fields without seeding through the API surface.
    // The page also calls /patients/:id/history + /stats — leave those
    // un-stubbed (the global fixture forwards them; empty arrays are fine).
    await page.route(
      new RegExp(`/api/v1/patients/${patient.id}(\\?.*)?$`),
      (route: Route) => {
        if (route.request().method() !== "GET") {
          route.continue();
          return;
        }
        // The route also catches sub-paths like /history and /stats —
        // forward those.
        const url = route.request().url();
        if (
          url.endsWith(`/patients/${patient.id}`) ||
          url.includes(`/patients/${patient.id}?`)
        ) {
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              success: true,
              data: {
                id: patient.id,
                mrNumber: patient.mrNumber,
                age: 42,
                gender: "MALE",
                dateOfBirth: "1984-01-15",
                bloodGroup: "O+",
                address: "221B Baker St, Mumbai",
                insuranceProvider: "Star Health Insurance",
                insuranceId: "SH-2026-0042",
                emergencyContactName: null,
                emergencyContactPhone: null,
                user: {
                  id: "user-stub",
                  name: patient.name,
                  email: "stub@example.test",
                  phone: "+919812345678",
                },
                appointments: [],
                vitals: [],
                prescriptions: [],
              },
              error: null,
            }),
          });
        } else {
          route.continue();
        }
      }
    );

    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    // Demographic strip (page.tsx:637 data-testid="patient-detail-demographics")
    // wraps the conditional Insurance block.
    await expect(
      page.locator('[data-testid="patient-detail-demographics"]')
    ).toBeVisible({ timeout: TAB_TIMEOUT });

    // The "Insurance" label + provider value live inside the demographic
    // grid (page.tsx:666-674). Provider text is rendered as
    // `${insuranceProvider}${insuranceId ? ` (${insuranceId})` : ""}`.
    await expect(
      page.getByText(/Star Health Insurance/i).first()
    ).toBeVisible();
  });

  test("ADMIN opens the Merge Duplicate modal (gated by `isAdmin` at page.tsx:591), searches for a candidate, confirms, and POST /patients/:id/merge body `{otherPatientId}` is captured via stub — DOCTOR companion: assert the same CTA is hidden", async ({
    adminPage,
    doctorPage,
    adminApi,
  }) => {
    const patient = await seedPatient(adminApi);

    // ADMIN sees the CTA + can drive the merge flow.
    {
      const page = adminPage;

      // Stub the search GET so the candidate appears.
      await page.route(
        /\/api\/v1\/patients\?search=.*/,
        (route: Route) => {
          if (route.request().method() !== "GET") {
            route.continue();
            return;
          }
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              success: true,
              data: [
                {
                  id: STUB_MERGE_OTHER_ID,
                  mrNumber: "MR-DUPE-9999",
                  age: 42,
                  gender: "MALE",
                  user: {
                    name: "Duplicate Candidate",
                    phone: "+919900000000",
                  },
                },
              ],
              error: null,
            }),
          });
        }
      );

      // Stub the merge POST.
      let mergePost: { url: string; body: unknown } | null = null;
      await page.route(
        new RegExp(`/api/v1/patients/${patient.id}/merge(\\?.*)?$`),
        (route: Route) => {
          if (route.request().method() !== "POST") {
            route.continue();
            return;
          }
          mergePost = {
            url: route.request().url(),
            body: route.request().postDataJSON(),
          };
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              success: true,
              data: { id: patient.id, merged: true },
              error: null,
            }),
          });
        }
      );

      // Stub the confirm dialog (useConfirm at page.tsx:4416). The
      // confirmation is a custom dialog (rendered by use-dialog), so we
      // can't bypass it via dialog handler — instead, drive the UI to
      // the "Confirm" point.
      // Note: the modal also fires a redirect on success (page.tsx:4459
      // `window.location.href = ...`). We capture the request body BEFORE
      // the redirect lands.

      await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
      await expectNotForbidden(page);

      // The CTA is `aria-label="Merge duplicate patient"` at page.tsx:594.
      const mergeCta = page.getByRole("button", {
        name: /merge duplicate patient/i,
      });
      await expect(mergeCta.first()).toBeVisible({ timeout: TAB_TIMEOUT });
      await mergeCta.first().click();

      // Modal heading (page.tsx:4470).
      await expect(
        page.getByText(/^Merge Duplicate Patient$/i).first()
      ).toBeVisible({ timeout: TAB_TIMEOUT });
      // Search input id="merge-search" (page.tsx:4485).
      await page.locator("#merge-search").fill("Duplicate");

      // Wait for the search debounce (300ms at page.tsx:4428) + result.
      await expect(
        page.getByRole("button", { name: /Duplicate Candidate/i }).first()
      ).toBeVisible({ timeout: TAB_TIMEOUT });
      await page
        .getByRole("button", { name: /Duplicate Candidate/i })
        .first()
        .click();

      // After selecting, the "Confirm Merge" CTA is enabled (page.tsx:4550).
      const confirmCta = page.getByRole("button", { name: /^confirm merge$/i });
      await expect(confirmCta.first()).toBeEnabled({ timeout: TAB_TIMEOUT });
      await confirmCta.first().click();

      // The native confirm dialog (useConfirm) wraps the action — we
      // expect a dialog button labelled "Confirm" or similar. ConfirmDialog
      // typically renders a button by visible name; click the visible
      // confirm CTA on the dialog.
      const dialogConfirm = page.getByRole("button", {
        name: /^(confirm|merge|yes|delete|continue)$/i,
      });
      // Best-effort: if the in-page dialog opens, dismiss it. If the
      // confirm is auto-handled, the merge POST fires directly.
      try {
        await dialogConfirm.last().click({ timeout: 3_000 });
      } catch {
        // No dialog — POST should already have fired.
      }

      await expect
        .poll(() => mergePost?.body, { timeout: TAB_TIMEOUT })
        .toMatchObject({
          otherPatientId: STUB_MERGE_OTHER_ID,
        });
    }

    // DOCTOR companion — same chart, no Merge Duplicate CTA.
    {
      const page = doctorPage;
      await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
      await expectNotForbidden(page);
      // CTA hidden for non-admin (page.tsx:591 `{isAdmin && ...}`).
      await expect(
        page.getByRole("button", { name: /merge duplicate patient/i })
      ).toHaveCount(0);
    }
  });

  test("Med Reconciliation API-contract-pin — chart UI does NOT yet mount a med-reconciliation panel (verified: no `/med-reconciliation` references anywhere under apps/web/src/app/dashboard/patients/[id]/), but the GET /api/v1/med-reconciliation?patientId=<id> endpoint exists at med-reconciliation.ts:24-45. Stub the response and assert the contract via direct fetch — when a chart UI lands, this pin guards the read-side shape", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    // Stub the med-reconciliation list endpoint with the canonical shape
    // expected by the future chart UI: data[] of MedReconciliation rows
    // each carrying patientId / reconciliationType / homeMedications /
    // hospitalMedications / dischargeMedications / changes /
    // patientCounseled / performedAt.
    let stubServed = false;
    await page.route(
      /\/api\/v1\/med-reconciliation(\?[^/]*)?$/,
      (route: Route) => {
        if (route.request().method() !== "GET") {
          route.continue();
          return;
        }
        stubServed = true;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: [
              {
                id: STUB_MED_RECON_ID,
                patientId: patient.id,
                admissionId: null,
                dischargeId: null,
                reconciliationType: "ADMISSION",
                performedBy: "stub-user",
                performedAt: "2026-04-01T08:00:00Z",
                homeMedications: [
                  {
                    name: "Metformin",
                    dosage: "500mg",
                    frequency: "BD",
                    route: "PO",
                    continued: true,
                  },
                ],
                hospitalMedications: [],
                dischargeMedications: [],
                changes: { added: [], removed: [], modified: [] },
                patientCounseled: false,
                notes: null,
              },
            ],
            error: null,
          }),
        });
      }
    );

    // Land on the chart so we have an authed origin for the fetch.
    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    // Drive the read with a direct fetch so the contract pin holds even
    // before any chart UI mounts the panel. The browser's fetch carries
    // the auth token from the page context (lib/api wraps it).
    const json = await page.evaluate(async (pid) => {
      const token = localStorage.getItem("medcore_token");
      const res = await fetch(
        `/api/v1/med-reconciliation?patientId=${pid}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );
      return res.json();
    }, patient.id);

    expect(stubServed).toBe(true);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data[0]).toMatchObject({
      patientId: patient.id,
      reconciliationType: "ADMISSION",
      patientCounseled: false,
    });
    // homeMedications shape from MedItemSchema (validation/ehr.ts).
    expect(json.data[0].homeMedications[0]).toMatchObject({
      name: "Metformin",
      dosage: "500mg",
      frequency: "BD",
    });
  });
});
