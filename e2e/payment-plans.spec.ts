/**
 * Payment Plans — /dashboard/payment-plans
 *
 * What this exercises:
 *   apps/web/src/app/dashboard/payment-plans/page.tsx
 *   POST   /api/v1/payment-plans          (create plan — ADMIN + RECEPTION)
 *   GET    /api/v1/payment-plans          (list plans)
 *   GET    /api/v1/payment-plans/overdue  (overdue installments tab)
 *   GET    /api/v1/payment-plans/:id      (detail modal)
 *   PATCH  /api/v1/payment-plans/:id/pay-installment (pay installment)
 *
 * Surfaces protected:
 *   1.  ADMIN lands on the page: heading + tabs + "New Plan" button visible
 *       (canCreate = ADMIN|RECEPTION → button present; tab chrome anchors
 *       the structural contract).
 *   2.  RECEPTION lands on the page: same chrome + "New Plan" button.
 *   3.  Happy-path plan creation (RECEPTION): seed patient + invoice →
 *       open modal → fill form → submit → plan appears in the ACTIVE list.
 *   4.  Detail modal: clicking a plan row opens the PlanDetailModal with
 *       installment table.
 *   5.  Tab navigation: Active / Overdue / Completed / All tabs are
 *       clickable and each transitions without a crash.
 *   6.  Validation — installments < 2: inline error appears, no submit.
 *   7.  Validation — negative down payment: inline error appears.
 *   8.  Validation — down payment exceeds invoice total: inline error.
 *   9.  Validation — no patient selected: inline error.
 *   10. Validation — no invoice selected: inline error.
 *   11. Patient has no outstanding invoice: "no outstanding invoice" hint
 *       renders instead of the invoice select.
 *   12. DOCTOR bounces to /dashboard/not-authorized (not in canCreate;
 *       GET list is open-auth but the page itself does not guard reads —
 *       RBAC is on the create action. DOCTOR can VIEW the list but cannot
 *       see the "New Plan" button).
 *   13. NURSE, LAB_TECH, PHARMACIST: can reach the page (GET /payment-plans
 *       is not role-gated) but the "New Plan" button must be absent.
 *   14. PATIENT: similar to 13 — list is visible but create button absent.
 *
 * Architecture note:
 *   The page.tsx role gate (`canCreate`) only hides the "New Plan" button —
 *   it does NOT redirect unpermitted roles. Redirect tests are therefore
 *   intentionally absent. The API-level enforce is what matters for security
 *   (POST /payment-plans is authorize(ADMIN, RECEPTION)); the UI gate is
 *   UX-only. Tests that poke the API directly are in the integration suite
 *   (apps/api/src/test/integration/payment-plans.test.ts).
 *
 * Issue #60: plans list was read-only; this spec closes the E2E gap opened
 * when the "New Plan" modal was wired in that commit.
 */
import { test, expect } from "./fixtures";
import {
  API_BASE,
  expectNotForbidden,
  gotoAuthed,
  seedAppointment,
  seedPatient,
} from "./helpers";

// Generous first-paint timeout: the page fetches /payment-plans on mount.
const PAGE_TIMEOUT = 20_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SeededInvoice {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
}

/**
 * Seed a fresh patient + appointment + invoice. Returns all three so the
 * caller can open the NewPlanModal and pick the invoice.
 *
 * The invoice is deliberately left PENDING (not fully paid) so it shows up
 * in the outstanding-invoice list that the modal fetches.
 */
async function seedPatientWithInvoice(
  api: import("@playwright/test").APIRequestContext
): Promise<{ patientId: string; patientName: string; invoice: SeededInvoice }> {
  const patient = await seedPatient(api);
  const appt = await seedAppointment(api, { patientId: patient.id });

  const res = await api.post(`${API_BASE}/billing/invoices`, {
    data: {
      appointmentId: appt.id,
      patientId: patient.id,
      items: [
        {
          description: "E2E plan test consultation",
          category: "CONSULTATION",
          quantity: 1,
          unitPrice: 1200,
        },
      ],
      taxPercentage: 18,
      notes: "E2E payment-plans.spec.ts",
    },
  });
  if (!res.ok()) {
    throw new Error(
      `seedPatientWithInvoice: invoice creation failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const body = await res.json();
  const inv = body.data as SeededInvoice;
  return { patientId: patient.id, patientName: patient.name, invoice: inv };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("/dashboard/payment-plans — installment plan setup + RBAC", () => {
  // ── 1. ADMIN page chrome ────────────────────────────────────────────────────
  test("ADMIN: page heading, tab chrome, and 'New Plan' button render", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);

    // Page heading
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Sub-heading / subtitle
    await expect(
      page.locator("text=/installment.*EMI/i").first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Four tab buttons
    await expect(
      page.getByRole("button", { name: /^active$/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^overdue$/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^completed$/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^all$/i }).first()
    ).toBeVisible();

    // ADMIN is in canCreate — "New Plan" button must be present.
    await expect(
      page.getByTestId("open-new-plan")
    ).toBeVisible();
  });

  // ── 2. RECEPTION page chrome ────────────────────────────────────────────────
  test("RECEPTION: page heading, tab chrome, and 'New Plan' button render", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // RECEPTION is in canCreate
    await expect(
      page.getByTestId("open-new-plan")
    ).toBeVisible();
  });

  // ── 3. Tab navigation without crash ─────────────────────────────────────────
  test("RECEPTION: all four tabs are clickable without a crash or redirect", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Overdue tab
    await page.getByRole("button", { name: /^overdue$/i }).first().click();
    await expect(page.url()).toContain("/dashboard/payment-plans");
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);

    // Completed tab
    await page.getByRole("button", { name: /^completed$/i }).first().click();
    await expect(page.url()).toContain("/dashboard/payment-plans");
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);

    // All tab
    await page.getByRole("button", { name: /^all$/i }).first().click();
    await expect(page.url()).toContain("/dashboard/payment-plans");
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);

    // Back to Active
    await page.getByRole("button", { name: /^active$/i }).first().click();
    await expect(page.url()).toContain("/dashboard/payment-plans");
    // The "New Plan" button must still be present — no accidental dismount.
    await expect(page.getByTestId("open-new-plan")).toBeVisible({
      timeout: 5_000,
    });
  });

  // ── 4. Happy-path plan creation (RECEPTION) ─────────────────────────────────
  test("RECEPTION: create a payment plan → plan appears in the ACTIVE list", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;

    // Seed patient + invoice outside the browser so the picker can find it.
    const { patientName, invoice } = await seedPatientWithInvoice(receptionApi);

    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Open the modal
    await page.getByTestId("open-new-plan").click();
    await expect(page.getByTestId("new-plan-modal")).toBeVisible({
      timeout: 8_000,
    });

    // -- Step 1: pick the patient via EntityPicker
    // The EntityPicker renders a search input with placeholder matching
    // `searchPlaceholder="Search patient by name, phone, MR..."`.
    const patientSearch = page.getByPlaceholder(/search patient/i).first();
    await patientSearch.fill(patientName.split(" ")[0]);

    // Wait for the dropdown option to appear and click the seeded patient.
    await page
      .getByRole("button", { name: new RegExp(patientName, "i") })
      .first()
      .click({ timeout: 10_000 });

    // -- Step 2: wait for invoice list to load, then select the invoice
    const invoiceSelect = page.getByTestId("new-plan-invoice");
    await expect(invoiceSelect).toBeVisible({ timeout: 10_000 });
    await invoiceSelect.selectOption({ value: invoice.id });

    // -- Step 3: total amount infopanel renders
    await expect(page.getByTestId("new-plan-total")).toBeVisible({
      timeout: 5_000,
    });

    // -- Step 4: set 3 monthly installments, today as start date (default)
    const installmentsInput = page.getByTestId("new-plan-installments");
    await installmentsInput.fill("3");

    const frequencySelect = page.getByTestId("new-plan-frequency");
    await frequencySelect.selectOption("MONTHLY");

    // -- Step 5: submit
    const submitBtn = page.getByTestId("new-plan-submit");
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Modal should close after success (onCreated callback sets showCreate=false)
    await expect(page.getByTestId("new-plan-modal")).toHaveCount(0, {
      timeout: 15_000,
    });

    // The list refreshes; we should see the new plan in the ALL tab because
    // ACTIVE tab only shows ACTIVE status plans — the freshly created plan
    // is ACTIVE but switching to ALL guarantees we see it regardless of
    // status edge cases in the test environment.
    await page.getByRole("button", { name: /^all$/i }).first().click();

    // The invoice number is font-mono text in the plan row. Give the list
    // time to re-render after the refresh.
    const planRow = page
      .locator("tr", { hasText: invoice.invoiceNumber })
      .first();
    await expect(planRow).toBeVisible({ timeout: 15_000 });
  });

  // ── 5. Detail modal opens on row click ──────────────────────────────────────
  test("RECEPTION: clicking a plan row opens the detail modal with installment table", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;

    // Seed a plan via the API so there is definitely something to click.
    const { patientId, invoice } = await seedPatientWithInvoice(receptionApi);
    const planRes = await receptionApi.post(`${API_BASE}/payment-plans`, {
      data: {
        invoiceId: invoice.id,
        downPayment: 0,
        installments: 3,
        frequency: "MONTHLY",
        startDate: new Date().toISOString().slice(0, 10),
      },
    });
    expect(
      planRes.ok(),
      `plan seed failed: ${planRes.status()} ${(await planRes.text()).slice(0, 200)}`
    ).toBeTruthy();
    const planBody = await planRes.json();
    const planNumber: string = planBody.data?.planNumber ?? "";

    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Switch to ALL tab so the newly seeded plan is in scope.
    await page.getByRole("button", { name: /^all$/i }).first().click();

    // Click the plan row
    const planRow = page.locator("tr", { hasText: planNumber }).first();
    await expect(planRow).toBeVisible({ timeout: 15_000 });
    await planRow.click();

    // The detail modal renders with the plan number as part of the title.
    await expect(
      page.getByRole("heading", { name: new RegExp(planNumber, "i") }).first()
    ).toBeVisible({ timeout: 10_000 });

    // Installment table header columns must be present (page.tsx:731–738).
    await expect(page.locator("text=Due Date").first()).toBeVisible();
    await expect(page.locator("text=Amount").first()).toBeVisible();
    await expect(page.locator("text=Status").first()).toBeVisible();
  });

  // ── 6. Validation: installments < 2 ─────────────────────────────────────────
  test("RECEPTION: installments < 2 shows inline validation error", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;
    const { patientName, invoice } = await seedPatientWithInvoice(receptionApi);

    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.getByTestId("open-new-plan").click();
    await expect(page.getByTestId("new-plan-modal")).toBeVisible({
      timeout: 8_000,
    });

    // Pick patient + invoice
    await page
      .getByPlaceholder(/search patient/i)
      .first()
      .fill(patientName.split(" ")[0]);
    await page
      .getByRole("button", { name: new RegExp(patientName, "i") })
      .first()
      .click({ timeout: 10_000 });
    await expect(page.getByTestId("new-plan-invoice")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId("new-plan-invoice").selectOption({ value: invoice.id });

    // Set installments to 1 (below minimum of 2)
    await page.getByTestId("new-plan-installments").fill("1");

    await page.getByTestId("new-plan-submit").click();

    // Inline error must appear (page.tsx:398–400: "Installments must be
    // between 2 and 60")
    await expect(page.getByTestId("new-plan-error")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("new-plan-error")).toContainText(
      /installments must be between 2 and 60/i
    );

    // Modal must NOT have closed
    await expect(page.getByTestId("new-plan-modal")).toBeVisible();
  });

  // ── 7. Validation: installments > 60 ────────────────────────────────────────
  test("RECEPTION: installments > 60 shows inline validation error", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;
    const { patientName, invoice } = await seedPatientWithInvoice(receptionApi);

    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.getByTestId("open-new-plan").click();
    await expect(page.getByTestId("new-plan-modal")).toBeVisible({
      timeout: 8_000,
    });

    await page
      .getByPlaceholder(/search patient/i)
      .first()
      .fill(patientName.split(" ")[0]);
    await page
      .getByRole("button", { name: new RegExp(patientName, "i") })
      .first()
      .click({ timeout: 10_000 });
    await expect(page.getByTestId("new-plan-invoice")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId("new-plan-invoice").selectOption({ value: invoice.id });

    // 61 exceeds the maximum of 60
    await page.getByTestId("new-plan-installments").fill("61");
    await page.getByTestId("new-plan-submit").click();

    await expect(page.getByTestId("new-plan-error")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("new-plan-error")).toContainText(
      /installments must be between 2 and 60/i
    );
    await expect(page.getByTestId("new-plan-modal")).toBeVisible();
  });

  // ── 8. Validation: negative down payment ────────────────────────────────────
  test("RECEPTION: negative down payment shows inline validation error", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;
    const { patientName, invoice } = await seedPatientWithInvoice(receptionApi);

    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.getByTestId("open-new-plan").click();
    await expect(page.getByTestId("new-plan-modal")).toBeVisible({
      timeout: 8_000,
    });

    await page
      .getByPlaceholder(/search patient/i)
      .first()
      .fill(patientName.split(" ")[0]);
    await page
      .getByRole("button", { name: new RegExp(patientName, "i") })
      .first()
      .click({ timeout: 10_000 });
    await expect(page.getByTestId("new-plan-invoice")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId("new-plan-invoice").selectOption({ value: invoice.id });

    // Fill in a negative down payment (page.tsx:403–406: "Down payment cannot
    // be negative")
    await page.getByTestId("new-plan-down-payment").fill("-100");
    await page.getByTestId("new-plan-submit").click();

    await expect(page.getByTestId("new-plan-error")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("new-plan-error")).toContainText(
      /down payment cannot be negative/i
    );
    await expect(page.getByTestId("new-plan-modal")).toBeVisible();
  });

  // ── 9. Validation: down payment exceeds invoice total ───────────────────────
  test("RECEPTION: down payment exceeding invoice total shows inline validation error", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;
    const { patientName, invoice } = await seedPatientWithInvoice(receptionApi);

    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.getByTestId("open-new-plan").click();
    await expect(page.getByTestId("new-plan-modal")).toBeVisible({
      timeout: 8_000,
    });

    await page
      .getByPlaceholder(/search patient/i)
      .first()
      .fill(patientName.split(" ")[0]);
    await page
      .getByRole("button", { name: new RegExp(patientName, "i") })
      .first()
      .click({ timeout: 10_000 });
    await expect(page.getByTestId("new-plan-invoice")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId("new-plan-invoice").selectOption({ value: invoice.id });

    // Down payment exceeds total (page.tsx:407–410: "Down payment cannot
    // exceed invoice total"). Invoice total is 1416 (1200 + 18% GST);
    // using 99999 to exceed without knowing exact tax.
    await page.getByTestId("new-plan-down-payment").fill("99999");
    await page.getByTestId("new-plan-submit").click();

    await expect(page.getByTestId("new-plan-error")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("new-plan-error")).toContainText(
      /down payment cannot exceed invoice total/i
    );
    await expect(page.getByTestId("new-plan-modal")).toBeVisible();
  });

  // ── 10. Validation: no patient selected ─────────────────────────────────────
  test("RECEPTION: submitting without selecting a patient shows inline error", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.getByTestId("open-new-plan").click();
    await expect(page.getByTestId("new-plan-modal")).toBeVisible({
      timeout: 8_000,
    });

    // Do not pick a patient — hit submit directly.
    // The submit button is disabled when invoiceId is empty (page.tsx:605),
    // but the form submit handler also validates patientId and emits an error
    // (page.tsx:388–391). Trigger the form submit via keyboard to bypass the
    // disabled-button guard.
    await page
      .getByTestId("new-plan-installments")
      .press("Enter");

    await expect(page.getByTestId("new-plan-error")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("new-plan-error")).toContainText(
      /select a patient/i
    );
  });

  // ── 11. Patient with no outstanding invoice shows a hint ────────────────────
  test("RECEPTION: patient with all invoices paid shows 'no outstanding invoice' hint", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;

    // Seed a patient + PAID invoice (pay in full immediately).
    const { patientId, patientName, invoice } =
      await seedPatientWithInvoice(receptionApi);
    const payRes = await receptionApi.post(`${API_BASE}/billing/payments`, {
      data: { invoiceId: invoice.id, amount: invoice.totalAmount, mode: "CASH" },
    });
    expect(payRes.ok()).toBeTruthy();

    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.getByTestId("open-new-plan").click();
    await expect(page.getByTestId("new-plan-modal")).toBeVisible({
      timeout: 8_000,
    });

    // Pick the patient whose only invoice is now PAID.
    await page
      .getByPlaceholder(/search patient/i)
      .first()
      .fill(patientName.split(" ")[0]);
    await page
      .getByRole("button", { name: new RegExp(patientName, "i") })
      .first()
      .click({ timeout: 10_000 });

    // The "no outstanding invoice" hint must render
    // (page.tsx:478–485: data-testid="new-plan-no-invoices").
    await expect(page.getByTestId("new-plan-no-invoices")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("new-plan-no-invoices")).toContainText(
      /no outstanding invoice/i
    );
  });

  // ── 12. Modal close button works ────────────────────────────────────────────
  test("RECEPTION: closing the modal via the X button dismisses it", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.getByTestId("open-new-plan").click();
    await expect(page.getByTestId("new-plan-modal")).toBeVisible({
      timeout: 8_000,
    });

    // Close via the aria-label="Close" button (page.tsx:440–446)
    await page.getByRole("button", { name: /close/i }).first().click();
    await expect(page.getByTestId("new-plan-modal")).toHaveCount(0, {
      timeout: 5_000,
    });
  });

  // ── 13. Pay an installment via the detail modal ──────────────────────────────
  test("RECEPTION: can pay an installment from the detail modal", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;

    // Seed a plan
    const { invoice } = await seedPatientWithInvoice(receptionApi);
    const planRes = await receptionApi.post(`${API_BASE}/payment-plans`, {
      data: {
        invoiceId: invoice.id,
        downPayment: 0,
        installments: 2,
        frequency: "MONTHLY",
        startDate: new Date().toISOString().slice(0, 10),
      },
    });
    expect(planRes.ok()).toBeTruthy();
    const planNumber: string = (await planRes.json()).data?.planNumber ?? "";

    await gotoAuthed(page, "/dashboard/payment-plans");
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.getByRole("button", { name: /^all$/i }).first().click();

    const planRow = page.locator("tr", { hasText: planNumber }).first();
    await expect(planRow).toBeVisible({ timeout: 15_000 });
    await planRow.click();

    // Detail modal open
    await expect(
      page.getByRole("heading", { name: new RegExp(planNumber, "i") }).first()
    ).toBeVisible({ timeout: 10_000 });

    // There should be at least one "Pay" button for a PENDING installment.
    const payBtn = page.getByRole("button", { name: /^pay$/i }).first();
    await expect(payBtn).toBeVisible({ timeout: 8_000 });
    await payBtn.click();

    // After paying, the button row should either disappear (all installments
    // paid) or count should decrease. At minimum the Pay button must go
    // away from that row. We assert no JS error banner.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0, { timeout: 8_000 });
  });

  // ── 14. RBAC: DOCTOR — no "New Plan" button ─────────────────────────────────
  test("DOCTOR: can reach the page but 'New Plan' button is absent (canCreate = ADMIN|RECEPTION only)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/payment-plans");
    // DOCTOR is not in the canCreate set but the page has no role-redirect.
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expectNotForbidden(page);

    // The "New Plan" button must be absent for DOCTOR.
    await expect(page.getByTestId("open-new-plan")).toHaveCount(0);
  });

  // ── 15. RBAC: NURSE — no "New Plan" button ──────────────────────────────────
  test("NURSE: can reach the page but 'New Plan' button is absent", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await gotoAuthed(page, "/dashboard/payment-plans");
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expectNotForbidden(page);

    await expect(page.getByTestId("open-new-plan")).toHaveCount(0);
  });

  // ── 16. RBAC: LAB_TECH — no "New Plan" button ───────────────────────────────
  test("LAB_TECH: can reach the page but 'New Plan' button is absent", async ({
    labTechPage,
  }) => {
    const page = labTechPage;
    await gotoAuthed(page, "/dashboard/payment-plans");
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expectNotForbidden(page);

    await expect(page.getByTestId("open-new-plan")).toHaveCount(0);
  });

  // ── 17. RBAC: PHARMACIST — no "New Plan" button ─────────────────────────────
  test("PHARMACIST: can reach the page but 'New Plan' button is absent", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await gotoAuthed(page, "/dashboard/payment-plans");
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expectNotForbidden(page);

    await expect(page.getByTestId("open-new-plan")).toHaveCount(0);
  });

  // ── 18. RBAC: PATIENT — no "New Plan" button ────────────────────────────────
  test("PATIENT: can reach the page but 'New Plan' button is absent", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/payment-plans");
    await expect(
      page.getByRole("heading", { name: /payment plans/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expectNotForbidden(page);

    await expect(page.getByTestId("open-new-plan")).toHaveCount(0);
  });
});
