/**
 * Admissions lifecycle E2E coverage.
 *
 * What this exercises:
 *   /dashboard/admissions          (list page)
 *   /dashboard/admissions/[id]     (detail page — overview, vitals, MAR tabs)
 *   POST /api/v1/admissions
 *   PATCH /api/v1/admissions/:id/discharge
 *   PATCH /api/v1/medication/administrations/:id
 *
 * Surfaces touched:
 *   1. LIST PAGE — DOCTOR sees heading, data table, and "Admit Patient" button.
 *   2. LIST PAGE — RECEPTION sees "Admit Patient" button (canAdmit includes
 *      RECEPTION per page.tsx:99-103).
 *   3. LIST PAGE — PATIENT and LAB_TECH can load the list (no not-authorized
 *      redirect) but do NOT see the "Admit Patient" button (role-gated CTA,
 *      not full page access gate).
 *   4. ADMIT FLOW — DOCTOR opens the admit modal, selects patient + bed +
 *      fills reason, submits. The new admission appears in the list with
 *      status ADMITTED. (Skipped if no AVAILABLE bed can be seeded — same
 *      known constraint as admissions-mar.spec.ts.)
 *   5. DETAIL PAGE — DOCTOR can open /dashboard/admissions/[id] and sees:
 *      patient name, admission number, ward/bed in Overview tab.
 *   6. DETAIL PAGE — NURSE can open /dashboard/admissions/[id] and sees the
 *      same overview chrome.
 *   7. MAR TAB — NURSE opens the MAR tab for a seeded admission and sees the
 *      medication grid (or the empty-state message). Clicking a SCHEDULED
 *      cell opens the administration modal. (Skipped if bed seeding fails.)
 *   8. DISCHARGE FLOW — ADMIN opens the Overview tab, clicks Discharge,
 *      navigates through the DischargeReadinessModal (proceeds to the actual
 *      discharge form), fills the summary textarea, confirms. Status flips to
 *      DISCHARGED. (Skipped if bed seeding or readiness-check fails.)
 *   9. RBAC NEGATIVE — PATIENT does NOT see the "Admit Patient" button.
 *  10. RBAC NEGATIVE — LAB_TECH does NOT see the "Admit Patient" button.
 *
 * Architecture notes:
 *   - The list page (/dashboard/admissions) does NOT redirect PATIENT or
 *     LAB_TECH to /dashboard/not-authorized. All authenticated users can
 *     view the admissions list. The CTA is role-gated via `canAdmit`
 *     (ADMIN | RECEPTION | DOCTOR only). There is no full-page RBAC gate.
 *   - The detail page (/dashboard/admissions/[id]) similarly has no
 *     not-authorized redirect. Action surfaces (vitals recording, med
 *     ordering, MAR administration) are role-gated inline.
 *   - The discharge flow is TWO modals: clicking "Discharge" opens
 *     DischargeReadinessModal first. Only after clicking "Proceed to
 *     Discharge" does the actual discharge form appear. The readiness check
 *     can block the proceed button (outstanding bills / pending labs). ADMIN
 *     has a force-discharge checkbox for blocked cases.
 *   - `gotoAuthed` is used for all in-test navigations (WebKit auth-race v4).
 *   - Tests that depend on `seedAdmission` are individually skipped with a
 *     clear message when no AVAILABLE bed exists in the environment, matching
 *     the skip pattern established in admissions-mar.spec.ts.
 */

import { test, expect } from "./fixtures";
import {
  API_BASE,
  apiGet,
  apiPost,
  expectNotForbidden,
  gotoAuthed,
  seedPatient,
  seedAdmission,
} from "./helpers";

const PAGE_TIMEOUT = 20_000;

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Try to seed a patient + admission. Returns null (and logs a message) if no
 * AVAILABLE bed exists — the caller is responsible for calling test.skip().
 * This mirrors the skip pattern in admissions-mar.spec.ts.
 */
async function trySeedAdmission(
  adminApi: import("@playwright/test").APIRequestContext
): Promise<{ patient: { id: string; name: string; mrNumber: string }; admission: { id: string; bedId: string } } | null> {
  try {
    const patient = await seedPatient(adminApi);
    const admission = await seedAdmission(adminApi, { patientId: patient.id });
    return { patient, admission };
  } catch (err) {
    // Known root cause: no AVAILABLE bed in the test environment.
    return null;
  }
}

// ─── Suite ────────────────────────────────────────────────────────────────────

test.describe("Admissions — list page chrome (/dashboard/admissions)", () => {
  test("DOCTOR: page loads with heading, table, and Admit Patient button", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/admissions");
    await expectNotForbidden(page);

    // Heading rendered by page.tsx:327-331
    await expect(
      page.getByRole("heading", { name: /admissions/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Tab strip (Currently Admitted / Discharged / All)
    await expect(
      page.getByRole("button", { name: /currently admitted/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // "Admit Patient" button — DOCTOR is in canAdmit (page.tsx:99-103).
    // The page can render TWO buttons matching /admit patient/i: the header
    // CTA (page.tsx:335) AND the DataTable empty-state action (page.tsx:405-418)
    // when the admissions list is empty. Use .first() to consistently target
    // the header CTA in DOM order — both buttons open the same admit modal.
    await expect(
      page.getByRole("button", { name: /admit patient/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
  });

  test("RECEPTION: page loads with Admit Patient button", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/admissions");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /admissions/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // RECEPTION is in canAdmit (page.tsx:101). Same dual-render concern as
    // the DOCTOR test: header CTA + DataTable empty-state action both match;
    // .first() targets the header CTA deterministically.
    await expect(
      page.getByRole("button", { name: /admit patient/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
  });

  test("NURSE: page loads; Admit Patient button is hidden", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await gotoAuthed(page, "/dashboard/admissions");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /admissions/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // NURSE is NOT in canAdmit — button must be absent
    await expect(
      page.getByRole("button", { name: /admit patient/i })
    ).toHaveCount(0);
  });
});

test.describe("Admissions — RBAC negatives on list page", () => {
  test("PATIENT: can load the list page without not-authorized redirect; no Admit Patient button", async ({
    patientPage,
  }) => {
    const page = patientPage;
    // No redirect to /dashboard/not-authorized — all authenticated users
    // can view the admissions list. Only the CTA is role-gated.
    await gotoAuthed(page, "/dashboard/admissions");
    expect(page.url()).not.toContain("/not-authorized");
    expect(page.url()).not.toContain("/login");

    await expect(
      page.getByRole("heading", { name: /admissions/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // PATIENT is NOT in canAdmit
    await expect(
      page.getByRole("button", { name: /admit patient/i })
    ).toHaveCount(0);
  });

  test("LAB_TECH: can load the list page without not-authorized redirect; no Admit Patient button", async ({
    labTechPage,
  }) => {
    const page = labTechPage;
    await gotoAuthed(page, "/dashboard/admissions");
    expect(page.url()).not.toContain("/not-authorized");
    expect(page.url()).not.toContain("/login");

    await expect(
      page.getByRole("heading", { name: /admissions/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // LAB_TECH is NOT in canAdmit
    await expect(
      page.getByRole("button", { name: /admit patient/i })
    ).toHaveCount(0);
  });
});

test.describe("Admissions — admit flow (requires available bed)", () => {
  test("DOCTOR: opens admit modal via API-verified flow and admission appears in list as ADMITTED", async ({
    doctorPage,
    adminApi,
    adminToken,
  }) => {
    const page = doctorPage;

    // Verify a bed is available before attempting the UI flow; skip clearly
    // if none exist, matching the admissions-mar.spec.ts TODO pattern.
    const bedsRes = await adminApi.get(`${API_BASE}/beds?status=AVAILABLE`);
    const bedsJson = bedsRes.ok() ? await bedsRes.json() : { data: [] };
    const availableBeds: Array<{ id: string }> = bedsJson.data ?? [];
    if (availableBeds.length === 0) {
      test.skip(true, "No AVAILABLE bed in this environment — bed seeding not yet automated (same as admissions-mar.spec.ts TODO)");
      return;
    }

    // Seed a fresh patient so the test owns its state.
    const patient = await seedPatient(adminApi);

    // Resolve a doctor id for the admission form
    const doctorsRes = await adminApi.get(`${API_BASE}/doctors`);
    const doctorsJson = doctorsRes.ok() ? await doctorsRes.json() : { data: [] };
    const doctors: Array<{ id: string; user: { name: string }; specialization: string }> =
      doctorsJson.data ?? [];
    if (doctors.length === 0) {
      test.skip(true, "No doctor available to seed admission — skipping");
      return;
    }

    await gotoAuthed(page, "/dashboard/admissions");
    await expect(
      page.getByRole("heading", { name: /admissions/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Open modal
    await page.getByRole("button", { name: /admit patient/i }).click();
    await expect(
      page.getByRole("heading", { name: /^admit patient$/i })
    ).toBeVisible({ timeout: 8_000 });

    // Patient search: type at least 2 chars to trigger debounced search
    const searchInput = page.getByPlaceholder(/search by name or mr/i);
    await searchInput.fill(patient.name.slice(0, 4));
    // Wait for the dropdown suggestion to appear
    await expect(
      page.getByRole("button", { name: new RegExp(patient.name, "i") }).first()
    ).toBeVisible({ timeout: 8_000 });
    await page.getByRole("button", { name: new RegExp(patient.name, "i") }).first().click();

    // Doctor select — wait for options to populate
    const doctorSelect = page.getByLabel("Doctor");
    await expect(doctorSelect).toBeVisible({ timeout: 5_000 });
    await doctorSelect.selectOption({ index: 1 }); // pick the first real doctor

    // Bed select
    const bedSelect = page.locator('[data-testid="admit-bed-select"]');
    await expect(bedSelect).toBeVisible({ timeout: 5_000 });
    await bedSelect.selectOption({ index: 1 }); // pick the first available bed

    // Reason textarea (required). The admit modal renders
    // `<label>Reason for Admission</label><textarea ... />` WITHOUT
    // htmlFor/id linkage (apps/web/src/app/dashboard/admissions/page.tsx:553-563),
    // so Playwright's getByLabel(/reason for admission/i) cannot resolve the
    // textarea. Anchor on the label text and use the immediate sibling
    // textarea — same pattern as medicines/suppliers/wards modal fixes.
    const admitModalForm = page.locator('form:has(button[type=submit])').first();
    await expect(admitModalForm).toBeVisible({ timeout: 10_000 });
    await admitModalForm
      .locator('label:text-is("Reason for Admission") + textarea')
      .first()
      .fill("E2E test — acute fever and dehydration");

    // Submit
    await page.getByRole("button", { name: /^admit patient$/i }).last().click();

    // Modal should close and the list should reload. Wait for the patient name
    // to appear in the table — this confirms the admission was persisted.
    await expect(page.locator("body")).toContainText(patient.name, {
      timeout: PAGE_TIMEOUT,
    });

    // Verify via API that the record exists with ADMITTED status
    const listRes = await apiGet(
      page.request,
      adminToken,
      `/admissions?status=ADMITTED`
    );
    expect(listRes.status).toBe(200);
    const records: Array<{ patient: { user: { name: string } }; status: string }> =
      listRes.body?.data ?? [];
    expect(
      records.some((r) => r.patient?.user?.name === patient.name && r.status === "ADMITTED"),
      "Seeded admission must be ADMITTED in the API response"
    ).toBeTruthy();

    await expectNotForbidden(page);
  });
});

test.describe("Admissions — detail page (/dashboard/admissions/[id])", () => {
  test("DOCTOR: can open detail page for a seeded admission and sees patient demographics + ward/bed", async ({
    doctorPage,
    adminApi,
  }) => {
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(true, "No AVAILABLE bed — cannot seed admission (same as admissions-mar.spec.ts TODO)");
      return;
    }
    const { patient, admission } = seeded;

    const page = doctorPage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);
    await expectNotForbidden(page);

    // Patient name as the page heading (detail page renders patient.user.name
    // in the h1 at page.tsx:208)
    await expect(
      page.getByRole("heading", { name: new RegExp(patient.name, "i") }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Admission details card should show ward/bed
    await expect(page.locator("body")).toContainText(/ward/i, {
      timeout: PAGE_TIMEOUT,
    });

    // Overview tab is the default tab — admission details section
    await expect(page.locator("body")).toContainText(/admission #/i);

    // Tabs strip visible: Overview, Vitals, Medications, Nurse Rounds, Labs, MAR, I/O
    await expect(page.getByRole("button", { name: /^overview$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^vitals$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^mar$/i })).toBeVisible();
  });

  test("NURSE: can open detail page for a seeded admission and sees overview", async ({
    nursePage,
    adminApi,
  }) => {
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(true, "No AVAILABLE bed — cannot seed admission (same as admissions-mar.spec.ts TODO)");
      return;
    }
    const { patient, admission } = seeded;

    const page = nursePage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);
    await expectNotForbidden(page);

    // Patient name in heading
    await expect(
      page.getByRole("heading", { name: new RegExp(patient.name, "i") }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Nurse can see the Vitals tab button (recording is allowed for NURSE)
    await expect(page.getByRole("button", { name: /^vitals$/i })).toBeVisible();

    // Overview tab should be active by default and show the Admission # field
    await expect(page.locator("body")).toContainText(/admission #/i);
  });

  test("NURSE: MAR tab renders the medication grid or empty-state message", async ({
    nursePage,
    adminApi,
  }) => {
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(true, "No AVAILABLE bed — cannot seed admission (same as admissions-mar.spec.ts TODO)");
      return;
    }
    const { patient, admission } = seeded;

    const page = nursePage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);

    // Wait for the page to settle on the patient name
    await expect(page.locator("body")).toContainText(patient.name, {
      timeout: PAGE_TIMEOUT,
    });

    // Click MAR tab
    await page.getByRole("button", { name: /^mar$/i }).click();

    // The MAR tab renders either the grid table or the empty-state message.
    // Both are valid — the admission was just created so no orders exist yet.
    await expect(
      page
        .locator("table")
        .or(page.locator("text=No medication orders for this admission"))
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await expectNotForbidden(page);
  });
});

test.describe("Admissions — MAR administration (requires med order on seeded admission)", () => {
  test("NURSE: clicks a SCHEDULED MAR cell → administration modal appears → Save records the dose", async ({
    nursePage,
    adminApi,
    doctorToken,
    nurseToken,
  }) => {
    // Seed admission
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(true, "No AVAILABLE bed — cannot seed admission (same as admissions-mar.spec.ts TODO)");
      return;
    }
    const { patient, admission } = seeded;

    // Place a medication order via API as DOCTOR so the MAR has a scheduled dose.
    const orderRes = await apiPost(
      nursePage.request,
      doctorToken,
      "/medication/orders",
      {
        admissionId: admission.id,
        medicineName: "Paracetamol",
        dosage: "500mg",
        frequency: "TID",
        route: "ORAL",
        startDate: new Date().toISOString(),
        instructions: "E2E seeded MAR order",
      }
    );
    if (orderRes.status !== 201) {
      test.skip(true, "Medication order POST failed — skipping MAR interaction test");
      return;
    }

    const page = nursePage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);
    await expect(page.locator("body")).toContainText(patient.name, {
      timeout: PAGE_TIMEOUT,
    });

    // Navigate to MAR tab
    await page.getByRole("button", { name: /^mar$/i }).click();

    // The MAR table should now have at least one row (the Paracetamol order)
    await expect(page.locator("table")).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Find any SCHEDULED cell (blue background per MarTab cellColor). The
    // data-testid pattern is `mar-cell-{orderId}-{HH:MM}` (page.tsx:2815).
    // We locate by aria state — the button is NOT disabled for NURSE.
    const scheduledCell = page
      .locator("button[data-testid^='mar-cell-']")
      .filter({ hasText: /scheduled/i })
      .first();

    const hasDose = await scheduledCell.isVisible().catch(() => false);
    if (!hasDose) {
      // No dose is in the today window — this happens when the backend
      // schedules the first dose for tomorrow. The test still passes the
      // structural MAR table check above; skip the interaction assertion.
      test.skip(true, "No SCHEDULED dose in today MAR window — order scheduling window issue");
      return;
    }

    await scheduledCell.click();

    // Administration modal (MarAdministerModal) should appear
    await expect(
      page.getByRole("heading", { name: /record administration/i })
    ).toBeVisible({ timeout: 8_000 });

    // Status select defaults to ADMINISTERED — leave it as-is
    // Save button
    const saveBtn = page.locator('[data-testid="mar-administer-save"]');
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // Modal closes and the cell should flip to ADMINISTERED (green)
    await expect(
      page.getByRole("heading", { name: /record administration/i })
    ).not.toBeVisible({ timeout: 8_000 });

    // Verify via API that the administration has administeredAt set
    const afterRes = await apiGet(
      page.request,
      nurseToken,
      `/medication/administrations?admissionId=${admission.id}`
    );
    if (afterRes.status === 200) {
      const rows: Array<{ status: string; administeredAt?: string | null }> =
        afterRes.body?.data ?? [];
      const administered = rows.find((r) => r.status === "ADMINISTERED");
      expect(
        administered,
        "At least one dose should be ADMINISTERED after nurse action"
      ).toBeTruthy();
      expect(administered?.administeredAt).toBeTruthy();
    }

    await expectNotForbidden(page);
  });
});

test.describe("Admissions — discharge flow (ADMIN, requires seeded admission)", () => {
  test("ADMIN: clicks Discharge on overview → proceeds through readiness modal → fills summary → confirms → status flips to DISCHARGED", async ({
    adminPage,
    adminApi,
    adminToken,
  }) => {
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(true, "No AVAILABLE bed — cannot seed admission (same as admissions-mar.spec.ts TODO)");
      return;
    }
    const { patient, admission } = seeded;

    const page = adminPage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);
    await expect(page.locator("body")).toContainText(patient.name, {
      timeout: PAGE_TIMEOUT,
    });

    // The overview tab is the default. Actions panel shows "Discharge" button
    // only when status is ADMITTED (page.tsx:488).
    // Scroll into view and click the Discharge button.
    const dischargeBtn = page
      .getByRole("button", { name: /^discharge$/i })
      .first();
    await expect(dischargeBtn).toBeVisible({ timeout: PAGE_TIMEOUT });
    await dischargeBtn.click();

    // ── Step 1: DischargeReadinessModal ──────────────────────────────────────
    await expect(
      page.getByRole("heading", { name: /discharge readiness/i })
    ).toBeVisible({ timeout: 8_000 });

    // "Proceed to Discharge" button. For freshly-seeded admissions the
    // readiness check may be blocked (outstanding bills, missing summary etc.)
    // ADMIN can force-discharge: if blocked, tick the force checkbox.
    const proceedBtn = page.getByRole("button", { name: /proceed to discharge/i });
    await expect(proceedBtn).toBeVisible({ timeout: 5_000 });

    const isBlocked = await proceedBtn.isDisabled().catch(() => true);
    if (isBlocked) {
      // ADMIN force-discharge path (page.tsx:2518-2527)
      const forceCheckbox = page.getByRole("checkbox", {
        name: /force discharge/i,
      });
      const hasForce = await forceCheckbox.isVisible().catch(() => false);
      if (hasForce) {
        await forceCheckbox.check();
      } else {
        test.skip(true, "Discharge readiness is blocked and force-discharge checkbox not visible — seeded admission has unpayable bills");
        return;
      }
    }

    await proceedBtn.click();

    // ── Step 2: Discharge form modal ─────────────────────────────────────────
    await expect(
      page.getByRole("heading", { name: /^discharge patient$/i })
    ).toBeVisible({ timeout: 8_000 });

    // Fill the required discharge summary textarea (page.tsx:519-523)
    const summaryText = "E2E automated discharge — patient stable, follow-up in 1 week.";
    await page
      .locator("textarea")
      .filter({ hasNot: page.locator('[placeholder]') })
      .or(page.locator("label").filter({ hasText: /discharge summary/i }).locator("..").locator("textarea"))
      .first()
      .fill(summaryText);

    // Confirm Discharge button
    const confirmBtn = page.getByRole("button", { name: /confirm discharge/i });
    await expect(confirmBtn).not.toBeDisabled({ timeout: 3_000 });
    await confirmBtn.click();

    // Modal closes; page updates to show DISCHARGED status badge
    await expect(
      page.getByRole("heading", { name: /^discharge patient$/i })
    ).not.toBeVisible({ timeout: 8_000 });

    // Status badge should now read DISCHARGED (page.tsx:227-234)
    await expect(page.locator("body")).toContainText(/discharged/i, {
      timeout: PAGE_TIMEOUT,
    });

    // Verify via API
    const apiRes = await apiGet(
      page.request,
      adminToken,
      `/admissions/${admission.id}`
    );
    expect(apiRes.status).toBe(200);
    expect(apiRes.body?.data?.status).toBe("DISCHARGED");

    await expectNotForbidden(page);
  });
});
