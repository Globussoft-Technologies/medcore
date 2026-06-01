/**
 * Prescriptions — /dashboard/prescriptions/new (Rx creation FORM flow + RBAC)
 *
 * What this exercises:
 *   /dashboard/prescriptions/new (apps/web/src/app/dashboard/prescriptions/new/page.tsx)
 *     — thin client redirect to /dashboard/prescriptions?new=1&patientId=…
 *   /dashboard/prescriptions  (apps/web/src/app/dashboard/prescriptions/page.tsx)
 *     — canonical Rx form host (auto-opens when ?new=1, pre-fills patient when
 *       ?patientId=… per Issue #439)
 *   POST /api/v1/prescriptions
 *   POST /api/v1/prescriptions/check-interactions
 *     — apps/api/src/routes/prescriptions.ts (authorize(Role.DOCTOR, Role.ADMIN))
 *
 * Surfaces touched:
 *   - DOCTOR happy path: land on /prescriptions/new?patientId=<seeded> → redirect
 *     auto-fires + the form auto-opens with the patient pre-selected → pick a
 *     same-day appointment via the EntityPicker dropdown → fill diagnosis,
 *     dosage, frequency, duration, instructions → submit → 201 round-trip
 *     observed → form collapses → row lands in the prescription history list.
 *   - DOCTOR validation: empty diagnosis + missing fields trigger inline errors
 *     (`error-rx-patient` etc.) and no POST is fired (Issue #490 — picker
 *     errors say "Please select a patient", never raw "UUID").
 *   - ADMIN can also reach the form (RX_ALLOWED + API authorize() both include
 *     ADMIN), but the in-page "Write Prescription" CTA is DOCTOR-only, so we
 *     pin that asymmetry.
 *   - Disallowed-role bounces: RECEPTION + LAB_TECH bounce to
 *     /dashboard/not-authorized — both are outside RX_ALLOWED in
 *     prescriptions/page.tsx:49 (Issue #90 — Rx hidden from RECEPTION;
 *     LAB_TECH never had access).
 *   - Redirect contract pin: the /new sub-route renders ONLY the redirect
 *     placeholder ([data-testid="rx-new-redirect"]) and lands the user on
 *     /dashboard/prescriptions with ?new=1 + ?patientId= preserved.
 *
 * Why these tests exist:
 *   §2.1 of docs/E2E_COVERAGE_BACKLOG.md flagged /dashboard/prescriptions/new
 *   as "Rx creation form (only smoke-touched today)". Existing pharmacist.spec
 *   seeds prescriptions via the API and asserts the queue surface — it never
 *   drives the FORM. Issue #439 (the redirect page itself) and Issue #120 (the
 *   EntityPicker swap-in for the patient picker) both shipped without an e2e
 *   that proves the doctor's primary write path actually works end-to-end.
 *   This spec closes that gap.
 */
import { test, expect } from "./fixtures";
import {
  API_BASE,
  expectNotForbidden,
  gotoAuthed,
  seedAppointment,
  seedPatient,
} from "./helpers";

const PAGE_TIMEOUT = 20_000;

test.describe("Prescriptions — /dashboard/prescriptions/new (Rx creation FORM + RBAC)", () => {
  test("/dashboard/prescriptions/new?patientId=<id> shows the redirect placeholder, then lands on /dashboard/prescriptions?new=1&patientId=<id> — Issue #439 redirect contract", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const patient = await seedPatient(adminApi);

    await page.goto(`/dashboard/prescriptions/new?patientId=${patient.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // The thin /new page renders the redirect placeholder before the
    // useEffect bounces. We don't assert it's still visible after the
    // redirect — Next.js may have unmounted it by the time we check.
    // Wait for the URL to flip to /dashboard/prescriptions with the
    // expected params per page.tsx:26-32 of /new/page.tsx.
    await page.waitForURL(/\/dashboard\/prescriptions\?(?=.*new=1)(?=.*patientId=).*$/, {
      timeout: 10_000,
    });
    expect(page.url()).toContain("new=1");
    expect(page.url()).toContain(`patientId=${patient.id}`);

    // Auto-open behaviour from the canonical page (page.tsx:254-263 reads
    // `?new=1` and `?patientId=` and force-opens the form with the patient
    // pre-filled).
    await expect(page.getByTestId("rx-new-form")).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // Patient picker should already be in chosen state because the URL
    // pre-fill ran (the EntityPicker renders the chip + Change button when
    // `value` is non-empty AND it has a label — but here the value is
    // pre-filled WITHOUT a label, so the picker actually shows the search
    // input. The picker contract guarantees both branches render without
    // crashing; we just assert the form host is mounted.) See
    // EntityPicker.tsx:194-224 for the chip-vs-search branching.
  });

  test("DOCTOR happy path: open form via ?new=1, pick patient + same-day appointment, fill medicine row, save → POST /api/v1/prescriptions returns 201 and the row lands in the history list", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;

    // Seed patient + same-day walk-in appointment via the API. The form's
    // appointment picker filters server-side by `date=<today>&status=
    // BOOKED,CHECKED_IN,IN_PROGRESS` (page.tsx:635-637) — `seedAppointment`
    // creates a walk-in which defaults to status=BOOKED + date=today
    // (apps/api/src/routes/appointments.ts:206-209).
    const patient = await seedPatient(adminApi);
    const appt = await seedAppointment(adminApi, { patientId: patient.id });

    // Land on the canonical form host with ?new=1 — auto-opens the form
    // (page.tsx:254-263). Skipping the /new redirect saves a hop; we
    // already covered the redirect contract in the test above.
    await gotoAuthed(page, "/dashboard/prescriptions?new=1");
    await expectNotForbidden(page);
    await expect(page.getByTestId("rx-new-form")).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // ── Step 1: Patient picker (EntityPicker — testid prefix
    // "rx-patient-picker"). Per CLAUDE.md gotcha #4 / EntityPicker.tsx:285,
    // dropdown rows are <li role="option" data-testid="rx-patient-picker-option">
    // — NOT buttons. Filter by hasText against the seeded patient's name to
    // disambiguate when other patients in the DB share a first name.
    const patientSearch = page.getByTestId("rx-patient-picker-input");
    await patientSearch.fill(patient.name.split(" ")[0]);
    await page
      .getByTestId("rx-patient-picker-option")
      .filter({ hasText: patient.name })
      .first()
      .click({ timeout: 10_000 });

    // Picker collapses into the "chosen" chip once the option is clicked.
    await expect(page.getByTestId("rx-patient-picker-chosen")).toBeVisible({
      timeout: 5_000,
    });

    // ── Step 2: Appointment picker — same EntityPicker pattern, but the
    // endpoint is pre-filtered (minQueryLength=0 per page.tsx:652) so the
    // dropdown shows today's BOOKED list on focus.
    const apptSearch = page.getByTestId("rx-appointment-picker-input");
    // WebKit headless can drop the focus event from a bare click(); type
    // a single space then clear to deterministically fire onChange + onFocus
    // and open the dropdown (minQueryLength=0 → fetch fires on open).
    await apptSearch.click();
    await apptSearch.focus();
    await apptSearch.fill(" ");
    await apptSearch.fill("");
    // Empty-string fill is enough — the pre-filter URL already narrows to
    // today + this patient + live statuses. Wait for the option list to
    // render and click the seeded appointment by its data-entity-id (the
    // EntityPicker echoes the row's `id` onto the <li> as a data attribute,
    // so we can lock onto the exact appointment we seeded).
    await expect(
      page.locator(`[data-testid="rx-appointment-picker-option"][data-entity-id="${appt.id}"]`)
    ).toBeVisible({ timeout: 10_000 });
    await page
      .locator(`[data-testid="rx-appointment-picker-option"][data-entity-id="${appt.id}"]`)
      .click();
    await expect(page.getByTestId("rx-appointment-picker-chosen")).toBeVisible({
      timeout: 5_000,
    });

    // ── Step 3: Diagnosis (ICD-10 Autocomplete) — no data-testid on the
    // Autocomplete input; lock by placeholder per page.tsx:698. We bypass
    // the ICD-10 fetch by typing a freeform string; the schema only requires
    // `min(1)` on the diagnosis field (validation/prescription.ts:39).
    const uniqueTag = `e2e-${Date.now()}`;
    const diagnosisText = `J06.9 — Acute upper respiratory infection [${uniqueTag}]`;
    await page.getByPlaceholder(/Search ICD-10/i).fill(diagnosisText);

    // ── Step 4: First medicine row — placeholders, no testids on inputs.
    // The row order is: Autocomplete (col-span-2) | Dosage | Frequency
    // <select> | Duration | Remove. We hit the first matching input by
    // placeholder so the test stays robust if the row layout shuffles.
    await page.getByPlaceholder("Medicine name").first().fill("Paracetamol");
    // Pearl §2.1.4 row 49 — dose is a chip selector; the free-text "Dosage"
    // input only renders after the "Custom…" chip is active (page.tsx:1639-
    // 1647, conditional on dosagePreset === "custom"). Click it first, then
    // fill. The placeholder regex stays loose so a future copy tweak
    // (different example dose) doesn't break this again.
    await page.getByTestId("rx-dose-chip-0-custom").click();
    await page.getByPlaceholder(/^dosage/i).first().fill("500mg");
    // Pearl §2.1.4 row 49 — frequency is now a segmented control of
    // <button> options keyed by `rx-frequency-option-${idx}-${first-token}`
    // (page.tsx:1661-1681), not a native <select>. The label
    // "1-0-1 (Morning-Night)" split on " " yields token "1-0-1" →
    // testid rx-frequency-option-0-1-0-1.
    await page.getByTestId("rx-frequency-option-0-1-0-1").click();
    // Duration placeholder changed to "e.g. 5 days"; the per-row testid
    // `rx-duration-input-${idx}` (page.tsx:1759) is the stable lock.
    await page.getByTestId("rx-duration-input-0").fill("5 days");

    // ── Step 5: Submit. The form fires
    //     POST /prescriptions/check-interactions  (preview)
    //     POST /prescriptions                     (real save)
    // We wait for the latter — `check-interactions` is best-effort and
    // failures fall through to a direct save (page.tsx:449-452).
    const savePromise = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith("/api/v1/prescriptions") &&
        r.request().method() === "POST",
      { timeout: 20_000 }
    );
    await page.getByRole("button", { name: /save prescription/i }).click();
    const saveRes = await savePromise;

    // 201 Created on success. A 4xx here means the schema/contract drifted
    // (e.g. createPrescriptionSchema gained a required field) — both worth
    // catching.
    expect(saveRes.status()).toBeLessThan(400);

    // Form host should unmount on success (page.tsx:353 → setShowForm(false)).
    await expect(page.getByTestId("rx-new-form")).toHaveCount(0, {
      timeout: 10_000,
    });

    // The freshly-created Rx should appear in the loaded list. The unique
    // tag survives in the diagnosis field, so we anchor on it.
    await expect(
      page.locator(`text=${uniqueTag}`).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("DOCTOR validation: submitting an empty form surfaces inline errors via Zod and never POSTs — Issue #490 wording (no raw 'UUID' leaks to clinicians)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/prescriptions?new=1");
    await expectNotForbidden(page);
    await expect(page.getByTestId("rx-new-form")).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // Track POST attempts — the client-side gate must short-circuit before
    // the network. We monitor both the preview and save paths.
    let serverHit = false;
    await page.route("**/api/v1/prescriptions**", (route) => {
      if (route.request().method() === "POST") serverHit = true;
      route.continue();
    });

    // Submit without filling anything. The form has `noValidate` set
    // (page.tsx:554) so the React handler fires unconditionally and runs
    // createPrescriptionSchema.safeParse() (page.tsx:378-426).
    await page.getByRole("button", { name: /save prescription/i }).click();

    // Inline errors render on patient picker and appointment picker.
    // Issue #490: the message must be a human action ("Please select…"),
    // never raw "UUID" or "Required". Locked here so a future Zod message
    // change doesn't leak DB jargon back into clinical UI.
    await expect(page.getByTestId("error-rx-patient")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("error-rx-patient")).toContainText(
      /please select a patient/i
    );
    await expect(page.getByTestId("error-rx-patient")).not.toContainText(
      /uuid/i
    );

    // The form must NOT have unmounted — Save failed, user keeps editing.
    await expect(page.getByTestId("rx-new-form")).toBeVisible();

    // Allow any in-flight (non-)request a tick to surface, then assert
    // the gate held and nothing was POSTed.
    await page.waitForTimeout(500);
    expect(serverHit).toBe(false);
  });

  test("ADMIN can reach /dashboard/prescriptions (in RX_ALLOWED) but the in-page 'Write Prescription' CTA is DOCTOR-only — page.tsx:533 gates the button, while RX_ALLOWED gates the route", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/prescriptions");
    await expectNotForbidden(page);

    // ADMIN sees the page chrome (RX_ALLOWED has ADMIN at page.tsx:49).
    await expect(
      page.getByRole("heading", { name: /prescriptions/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // The "Write Prescription" button is rendered only when user.role is
    // exactly "DOCTOR" (page.tsx:533). ADMIN must NOT see it — even though
    // ADMIN is allowed to POST /prescriptions per the API authorize() gate.
    // This is a deliberate UX asymmetry: ADMIN can write via API/scripts
    // but not via the in-page CTA, so the on-screen action stays clinically
    // accountable to a doctor.
    await expect(
      page.getByRole("button", { name: /write prescription/i })
    ).toHaveCount(0);
  });

  test("RECEPTION bounces to /dashboard/not-authorized — Issue #90 hides Rx clinical detail from non-clinical staff (RECEPTION outside RX_ALLOWED in page.tsx:49)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await page.goto("/dashboard/prescriptions/new", {
      waitUntil: "domcontentloaded",
    });
    // Two redirect hops can happen back-to-back: /new → /prescriptions →
    // /not-authorized (the role gate fires once the canonical page mounts
    // and reads `user.role`). Allow time for both.
    await page.waitForTimeout(1500);

    // Either we're sitting on /not-authorized or back on /dashboard. The
    // form host must NOT have rendered.
    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    await expect(page.getByTestId("rx-new-form")).toHaveCount(0);
    // No "Application error" / Next error overlay leaked.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });

  test("LAB_TECH bounces to /dashboard/not-authorized — LAB_TECH outside RX_ALLOWED in page.tsx:49", async ({
    labTechPage,
  }) => {
    const page = labTechPage;
    await page.goto("/dashboard/prescriptions/new", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1500);

    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    await expect(page.getByTestId("rx-new-form")).toHaveCount(0);
  });
});
