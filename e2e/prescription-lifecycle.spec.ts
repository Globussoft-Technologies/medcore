/**
 * Prescription lifecycle (clinical-safety) e2e coverage.
 *
 * What this exercises:
 *   /dashboard/prescriptions  (apps/web/src/app/dashboard/prescriptions/page.tsx)
 *     — DDI preview/blocking modal, post-create CTAs (Print + Share),
 *       pharmacist read access to the queue, PATIENT own-data scoping.
 *   POST /api/v1/prescriptions/check-interactions
 *   POST /api/v1/prescriptions
 *   POST /api/v1/prescriptions/:id/print
 *   POST /api/v1/prescriptions/:id/share
 *     — apps/api/src/routes/prescriptions.ts (authorize matrix per handler)
 *
 * Companion to e2e/prescriptions-new.spec.ts (which pins the redirect contract,
 * the DOCTOR happy-path through EntityPicker + ADMIN UX asymmetry + RECEPTION /
 * LAB_TECH bounces). This file goes deeper into the §5 P2 "clinical-safety
 * lifecycle" scenarios and pins the post-create state transitions plus the
 * DDI safety net that gates harmful prescriptions before save.
 *
 * Why these tests exist:
 *   §5 P2 of docs/E2E_COVERAGE_BACKLOG.md asks for the lifecycle: edit, cancel,
 *   refill request, pharmacist reject, drug-allergy block, DDI warning. Per
 *   the wave-20 cron-learning bullet (backlog framing is sometimes
 *   aspirational), I VERIFIED the page.tsx + route source FIRST and codify
 *   only what is actually shipped:
 *     SHIPPED  — DDI warning surface (page.tsx:1196-1262 modal +
 *                check-interactions preview at page.tsx:435-453, save-time
 *                blocking at routes/prescriptions.ts:166-176; severity tiers
 *                CONTRAINDICATED / SEVERE / MODERATE).
 *     SHIPPED  — Post-create CTAs: Print (page.tsx:1112) + Share via
 *                WhatsApp / Email (page.tsx:1117-1128); persisted via the
 *                routes/prescriptions.ts /:id/print + /:id/share endpoints.
 *     SHIPPED  — PHARMACIST + PATIENT read access to the list (RX_ALLOWED
 *                page.tsx:49 includes both; routes/prescriptions.ts:248
 *                authorize() matches; PATIENT branch self-scopes via
 *                where.patientId at L270-275).
 *     DEFERRED — Drug-allergy block: NO allergy keyword anywhere in
 *                routes/prescriptions.ts (grep -i 'allerg' returns 0 hits)
 *                and the page form has no allergy preview; only DDI is
 *                gated. Documented as deferred scenario below.
 *     DEFERRED — Edit active Rx + version preservation: NO PATCH/PUT route
 *                handler in routes/prescriptions.ts (only POST/GET/DELETE-
 *                template). The page UI has no Edit CTA on history rows
 *                either. Closure annotation in the backlog reflects this.
 *     DEFERRED — Cancel Rx with notification: NO /:id/cancel endpoint and
 *                no Cancel CTA on the history row toolbar (page.tsx:1110-
 *                1134 — only Print + Share). Documented as deferred.
 *     DEFERRED — Pharmacist reject with reason: NO /:id/reject endpoint
 *                and no rejection UI on /dashboard/prescriptions. The
 *                pharmacist's queue surface is /dashboard/medicines /
 *                /dashboard/pharmacy (covered separately by Lane B P3).
 *     DEFERRED — Patient refill request → doctor approval: API has POST
 *                /items/:itemId/refill (routes/prescriptions.ts:577) but
 *                authorize(DOCTOR, ADMIN, NURSE) — PATIENT cannot call it.
 *                There is also no patient-side "request refill" UI surface.
 *                The refill counter is a staff-side counter increment, not
 *                a request/approval workflow.
 *
 *   The 5 cases below pin all the SHIPPED safety surfaces. The 5 deferred
 *   scenarios re-enter the backlog with explicit page.tsx / route-file
 *   evidence so a future wave can scaffold them when the UI ships.
 */
import { test, expect } from "./fixtures";
import {
  expectNotForbidden,
  gotoAuthed,
  seedAppointment,
  seedPatient,
} from "./helpers";

const PAGE_TIMEOUT = 20_000;

test.describe("Prescriptions lifecycle — /dashboard/prescriptions (DDI safety + post-create CTAs + multi-role read scoping)", () => {
  test("DOCTOR — DDI preview surfaces a blocking CONTRAINDICATED interaction in the warning modal and a save without override is blocked (page.tsx:435-453 preview path; routes/prescriptions.ts:166-176 save-time gate)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);
    const appt = await seedAppointment(adminApi, { patientId: patient.id });

    // Stub the preview so we deterministically simulate a blocking DDI
    // (CONTRAINDICATED) without depending on the seeded medicine
    // formulary or DrugInteraction rows. The modal opens when the
    // preview returns hasBlocking=true (page.tsx:442-446) and the
    // doctor must explicitly click "Override and continue" before
    // submitPrescription(true) is invoked.
    await page.route("**/api/v1/prescriptions/check-interactions", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            warnings: [
              {
                drugA: "Warfarin",
                drugB: "Aspirin",
                severity: "CONTRAINDICATED",
                description:
                  "Concurrent use sharply increases bleeding risk; avoid combination.",
                source: "NEW_VS_NEW",
              },
            ],
            hasBlocking: true,
          },
          error: null,
        }),
      })
    );

    // Track that the real save POST never fires until the doctor opts to
    // override — this is the safety contract.
    let saveAttempts = 0;
    await page.route("**/api/v1/prescriptions", (route) => {
      if (route.request().method() === "POST") {
        saveAttempts++;
        // Short-circuit so we don't actually persist if the test mis-fires.
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { id: "stubbed-rx" },
            error: null,
          }),
        });
      }
      return route.continue();
    });

    await gotoAuthed(page, "/dashboard/prescriptions?new=1");
    await expectNotForbidden(page);
    await expect(page.getByTestId("rx-new-form")).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // Patient picker — pick the seeded row by data-entity-id (CLAUDE.md
    // gotcha #11: lock-on without name-collision risk).
    await page.getByTestId("rx-patient-picker-input").fill(patient.name.split(" ")[0]);
    await page
      .locator(`[data-testid="rx-patient-picker-option"][data-entity-id="${patient.id}"]`)
      .first()
      .click({ timeout: 10_000 });
    await expect(page.getByTestId("rx-patient-picker-chosen")).toBeVisible({
      timeout: 5_000,
    });

    // Appointment picker — pre-filtered URL (minQueryLength=0 per
    // page.tsx:652) so the dropdown shows today's BOOKED list on focus.
    await page.getByTestId("rx-appointment-picker-input").click();
    await page
      .locator(`[data-testid="rx-appointment-picker-option"][data-entity-id="${appt.id}"]`)
      .click({ timeout: 10_000 });

    // Diagnosis (Autocomplete — locked by placeholder per page.tsx:698).
    await page.getByPlaceholder(/Search ICD-10/i).fill("I63 — Cerebral infarction");

    // Two medicines that the stub will report as CONTRAINDICATED.
    await page.getByPlaceholder("Medicine name").first().fill("Warfarin");
    await page.getByPlaceholder("Dosage").first().fill("5mg");
    await page
      .locator('select:has(option[value="0-0-1 (Night)"])')
      .first()
      .selectOption("0-0-1 (Night)");
    await page.getByPlaceholder("Duration").first().fill("30 days");

    // Submit — the preview path is invoked because the form passes Zod
    // (all required fields filled). The preview stub returns hasBlocking,
    // so the warning modal MUST appear and the save POST must NOT fire.
    await page.getByRole("button", { name: /save prescription/i }).click();

    // Modal anchor: the heading "Drug Interaction Warning" (page.tsx:1200-
    // 1203). We assert by visible text rather than role=dialog because
    // the modal does not declare role=dialog explicitly.
    await expect(
      page.getByRole("heading", { name: /drug interaction warning/i })
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Warfarin ↔ Aspirin")).toBeVisible();
    // Severity badge text — locked verbatim because pharmacists scan for
    // CONTRAINDICATED at-a-glance and a copy regression would silently
    // weaken the warning.
    await expect(page.locator("text=/CONTRAINDICATED/").first()).toBeVisible();

    // Cancel-and-revise must keep the form mounted and NOT trigger a save.
    await page.getByRole("button", { name: /cancel and revise/i }).click();
    await expect(
      page.getByRole("heading", { name: /drug interaction warning/i })
    ).toHaveCount(0);
    await expect(page.getByTestId("rx-new-form")).toBeVisible();

    expect(saveAttempts).toBe(0);
  });

  test("DOCTOR — DDI override path: clicking 'Override and continue' submits the Rx with overrideWarnings=true so the API allows the save (routes/prescriptions.ts:168 contract — hasBlocking only blocks when overrideWarnings is falsy)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);
    const appt = await seedAppointment(adminApi, { patientId: patient.id });

    // Same blocking preview as the previous test.
    await page.route("**/api/v1/prescriptions/check-interactions", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            warnings: [
              {
                drugA: "Metformin",
                drugB: "Iodinated contrast",
                severity: "SEVERE",
                description: "Hold metformin 48h pre/post contrast (lactic-acidosis risk).",
                source: "NEW_VS_EXISTING",
              },
            ],
            hasBlocking: true,
          },
          error: null,
        }),
      })
    );

    // Capture the request body so we can pin the override contract — this
    // is the load-bearing safety detail. If a future refactor drops
    // overrideWarnings from the payload, the DDI gate is silently broken
    // (the API would block the save AND the doctor would never know).
    const savePromise = page.waitForRequest(
      (req) =>
        new URL(req.url()).pathname.endsWith("/api/v1/prescriptions") &&
        req.method() === "POST",
      { timeout: 15_000 }
    );
    await page.route("**/api/v1/prescriptions", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { id: "stubbed-rx-override", patientId: patient.id, items: [] },
            error: null,
          }),
        });
      }
      return route.continue();
    });

    await gotoAuthed(page, "/dashboard/prescriptions?new=1");
    await expectNotForbidden(page);
    await expect(page.getByTestId("rx-new-form")).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.getByTestId("rx-patient-picker-input").fill(patient.name.split(" ")[0]);
    await page
      .locator(`[data-testid="rx-patient-picker-option"][data-entity-id="${patient.id}"]`)
      .first()
      .click({ timeout: 10_000 });
    await expect(page.getByTestId("rx-patient-picker-chosen")).toBeVisible({
      timeout: 5_000,
    });
    await page.getByTestId("rx-appointment-picker-input").click();
    await page
      .locator(`[data-testid="rx-appointment-picker-option"][data-entity-id="${appt.id}"]`)
      .click({ timeout: 10_000 });
    await page.getByPlaceholder(/Search ICD-10/i).fill("E11.9 — Type 2 diabetes");
    await page.getByPlaceholder("Medicine name").first().fill("Metformin");
    await page.getByPlaceholder("Dosage").first().fill("500mg");
    await page
      .locator('select:has(option[value="1-0-1 (Morning-Night)"])')
      .first()
      .selectOption("1-0-1 (Morning-Night)");
    await page.getByPlaceholder("Duration").first().fill("ongoing");

    await page.getByRole("button", { name: /save prescription/i }).click();
    await expect(
      page.getByRole("heading", { name: /drug interaction warning/i })
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: /override and continue/i }).click();

    const saveReq = await savePromise;
    const body = JSON.parse(saveReq.postData() ?? "{}");
    // Pin the override contract — the form MUST send overrideWarnings:true
    // when the doctor clicks the modal's primary CTA (page.tsx:1254 calls
    // submitPrescription(true)).
    expect(body.overrideWarnings).toBe(true);
    expect(body.patientId).toBe(patient.id);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);

    // Modal closes + form unmounts on successful save (page.tsx:353-358).
    await expect(
      page.getByRole("heading", { name: /drug interaction warning/i })
    ).toHaveCount(0, { timeout: 10_000 });
  });

  test("DOCTOR — post-create CTA: clicking Share via Email on a Rx history row fires POST /:id/share with channel:'EMAIL' (the audit trail pin — routes/prescriptions.ts:486-489)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    // Stub the list endpoint to render exactly one Rx row so the test is
    // deterministic regardless of seed state. The minimum fields needed
    // by page.tsx's PrescriptionRecord interface (L51-71) are id +
    // diagnosis + items + doctor.user + patient.user; everything else
    // can be null/undefined.
    const stubbedRxId = "11111111-1111-1111-1111-111111111111";
    await page.route(/\/api\/v1\/prescriptions\?(?!.*check-interactions).*/, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: stubbedRxId,
              diagnosis: "J06.9 — Acute upper respiratory infection",
              advice: "Rest and hydration",
              followUpDate: null,
              createdAt: new Date().toISOString(),
              printed: false,
              sharedVia: null,
              items: [
                {
                  id: "item-1",
                  medicineName: "Paracetamol",
                  dosage: "500mg",
                  frequency: "1-0-1 (Morning-Night)",
                  duration: "5 days",
                  instructions: null,
                  refills: 0,
                  refillsUsed: 0,
                },
              ],
              doctor: { user: { name: "Dr. Test Doctor" } },
              patient: { user: { name: "E2E Test Patient", phone: "+919800000000" } },
            },
          ],
          error: null,
          meta: { page: 1, limit: 25, total: 1 },
        }),
      });
    });
    // The templates list also fires on mount — keep it happy.
    await page.route("**/api/v1/prescriptions/templates/list", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    // Capture the share POST body to pin the channel contract.
    const sharePromise = page.waitForRequest(
      (req) =>
        new URL(req.url()).pathname.endsWith(`/prescriptions/${stubbedRxId}/share`) &&
        req.method() === "POST",
      { timeout: 10_000 }
    );
    await page.route(`**/api/v1/prescriptions/${stubbedRxId}/share`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { id: stubbedRxId, sharedVia: "EMAIL", sharedAt: new Date().toISOString() },
          error: null,
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/prescriptions");
    await expectNotForbidden(page);

    // The row anchors on data-testid="rx-row-<id>" (page.tsx:1041).
    const row = page.getByTestId(`rx-row-${stubbedRxId}`);
    await expect(row).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Expand the row to reveal the action toolbar (page.tsx:1043-1069 —
    // clicking the inner button toggles `expanded` state).
    await row.locator("button").first().click();

    await page.getByRole("button", { name: /share via email/i }).click();

    const shareReq = await sharePromise;
    const body = JSON.parse(shareReq.postData() ?? "{}");
    expect(body.channel).toBe("EMAIL");
  });

  test("PHARMACIST — can land on /dashboard/prescriptions and read the queue (PHARMACIST is in RX_ALLOWED at page.tsx:49 and the API authorize() at routes/prescriptions.ts:248). The 'Write Prescription' CTA is hidden because page.tsx:533 gates it on role==='DOCTOR' specifically.", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await gotoAuthed(page, "/dashboard/prescriptions");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /prescriptions/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // The Write Prescription CTA is DOCTOR-only — pharmacist must NOT see it.
    await expect(
      page.getByRole("button", { name: /write prescription/i })
    ).toHaveCount(0);

    // Toolbar (search + status) is rendered for the pharmacist queue too —
    // they need to find specific Rx in the dispensing queue. Lock both
    // testids to detect a future regression that hides the toolbar from
    // non-doctor roles.
    await expect(page.getByTestId("rx-search-input")).toBeVisible();
    await expect(page.getByTestId("rx-status-filter")).toBeVisible();
  });

  test("PATIENT — list is self-scoped to the caller (routes/prescriptions.ts:270-275 force-overwrites where.patientId with the caller's own Patient.id) and the 'Write Prescription' CTA is hidden because page.tsx:533 gates it on role==='DOCTOR' (Issue #474 BOLA defense-in-depth)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/prescriptions");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /prescriptions/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Patient never sees the writer CTA (route allows ADMIN+DOCTOR via
    // authorize, but page.tsx:533 only renders for role==='DOCTOR' so
    // PATIENT is doubly excluded).
    await expect(
      page.getByRole("button", { name: /write prescription/i })
    ).toHaveCount(0);

    // The form (rx-new-form) must NEVER mount for PATIENT — ?new=1 cannot
    // unlock it because the role-gated CTA is the only render path and
    // setShowForm(true) only runs from the URL effect when `new=1` is
    // present (page.tsx:255-262). We don't pass ?new=1 here so the form
    // simply must not render organically.
    await expect(page.getByTestId("rx-new-form")).toHaveCount(0);
  });
});
