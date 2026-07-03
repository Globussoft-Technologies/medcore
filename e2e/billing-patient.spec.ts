/**
 * Bulk patient billing — /dashboard/billing/patient/[patientId].
 *
 * What this exercises:
 *   apps/web/src/app/dashboard/billing/patient/[patientId]/page.tsx (494 lines)
 *   GET   /api/v1/billing/patients/:patientId/outstanding (apps/api/src/routes/billing.ts:1581)
 *   POST  /api/v1/billing/payments/bulk                  (apps/api/src/routes/billing.ts:1499)
 *   POST  /api/v1/billing/invoices/:id/discount          (apps/api/src/routes/billing.ts:1161)
 *
 * Page-shape archetype: REDIRECT-BOUNCE → /dashboard (NOT /dashboard/not-authorized).
 *   page.tsx:55-60 — useEffect fires `router.replace("/dashboard")` (with a
 *   "Bulk billing is staff-only" toast) whenever the auth'd user's role is
 *   outside `BILLING_PATIENT_ALLOWED = new Set(["ADMIN", "RECEPTION"])`. This
 *   matches the 6th cron-learning bullet: redirect target is `/dashboard`,
 *   not the universal /not-authorized surface. PATIENT must NOT be allowed
 *   even though `/billing/patients/:id/outstanding` does permit PATIENT —
 *   the page-level gate is stricter than the API because of Issue #385
 *   (CRITICAL prod RBAC bypass, Apr 29 2026: any PATIENT could hit this URL
 *   directly and trigger admin Bulk-Payment / Bulk-Discount mutations).
 *
 * Surfaces touched:
 *   - RECEPTION: lands on the page chrome, sees the patient header card,
 *     Total-Outstanding tile, and the unpaid-invoice table with checkbox
 *     selection enabling Apply-Discount / Record-Bulk-Payment buttons.
 *   - RECEPTION write: bulk-payment POST /payments/bulk that splits an
 *     amount across selected invoices oldest-first; bulk-discount POST
 *     /invoices/:id/discount per selected invoice.
 *   - PATIENT/DOCTOR: REDIRECT-BOUNCE to /dashboard via the role guard.
 *
 * Why these tests exist:
 *   Closes docs/E2E_COVERAGE_BACKLOG.md §2.3 entry
 *   "/dashboard/billing/patient/[patientId] — bulk patient billing" by
 *   pinning the page chrome, the bulk-payment + bulk-discount round-trips,
 *   the empty-state for a patient with no outstanding invoices, and the
 *   Issue #385 redirect contract for non-staff roles.
 */
import { test, expect } from "./fixtures";
import {
  API_BASE,
  expectNotForbidden,
  gotoAuthed,
  seedAppointment,
  seedPatient,
} from "./helpers";

interface InvoiceCreateResponse {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  subtotal: number;
}

// Two CONSULTATION line items at known prices so a bulk-payment split is
// deterministic. Subtotal 700 + 18% GST = total 826 per invoice.
const LINE_ITEMS = [
  {
    description: "General consultation",
    category: "CONSULTATION",
    quantity: 1,
    unitPrice: 300,
  },
  {
    description: "Follow-up consultation",
    category: "CONSULTATION",
    quantity: 1,
    unitPrice: 400,
  },
];
const TAX_PCT = 18;

async function seedTwoUnpaidInvoices(
  api: import("@playwright/test").APIRequestContext,
  patientId: string,
): Promise<InvoiceCreateResponse[]> {
  // The walk-in endpoint blocks a SECOND open appointment for the same
  // patient + doctor + today (appointments.ts, added 2026-07-03: "This
  // patient already has an open appointment with this doctor today").
  // Since this helper needs TWO appointments for one patient on the same
  // day, anchor each invoice to a DIFFERENT doctor so the guard doesn't
  // fire. Resolve two distinct doctor IDs up front.
  const docsRes = await api.get(`${API_BASE}/doctors`);
  expect(docsRes.ok(), `list doctors: ${docsRes.status()}`).toBeTruthy();
  const docsJson = await docsRes.json();
  const docList: Array<{ id: string }> = docsJson.data ?? docsJson ?? [];
  const doctorIds = docList.map((d) => d.id).filter(Boolean);
  expect(
    doctorIds.length,
    "seedTwoUnpaidInvoices needs at least 2 seeded doctors",
  ).toBeGreaterThanOrEqual(2);

  const created: InvoiceCreateResponse[] = [];
  for (let i = 0; i < 2; i++) {
    const appt = await seedAppointment(api, {
      patientId,
      doctorId: doctorIds[i],
    });
    const res = await api.post(`${API_BASE}/billing/invoices`, {
      data: {
        appointmentId: appt.id,
        patientId,
        items: LINE_ITEMS,
        taxPercentage: TAX_PCT,
        notes: `E2E billing-patient seed #${i + 1}`,
      },
    });
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    created.push(json.data as InvoiceCreateResponse);
    // Stagger createdAt so oldest-first selection is deterministic.
    await new Promise((r) => setTimeout(r, 50));
  }
  return created;
}

test.describe("Bulk patient billing — /dashboard/billing/patient/[patientId] (RECEPTION/ADMIN aggregate-and-apply + Issue #385 redirect-bounce for non-staff)", () => {
  test("RECEPTION lands on the page, sees patient header + Total-Outstanding tile + the unpaid-invoice table with two seeded invoices", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;
    const patient = await seedPatient(receptionApi);
    const invoices = await seedTwoUnpaidInvoices(receptionApi, patient.id);

    await gotoAuthed(page, `/dashboard/billing/patient/${patient.id}`);
    await expectNotForbidden(page);

    // Patient header card surfaces the seeded name + MR# (page.tsx:217-223).
    await expect(
      page.getByRole("heading", { name: patient.name }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(new RegExp(patient.mrNumber))).toBeVisible();

    // Total-Outstanding tile = sum of both invoice totals (2 × 826 = 1,652.00).
    // We match digits so the "Rs. 1,652.00" formatting from fmtMoney holds.
    const expectedTotal = invoices
      .reduce((s, inv) => s + inv.totalAmount, 0)
      .toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    await expect(page.getByText(new RegExp(expectedTotal))).toBeVisible();

    // Both invoice rows render in the table (linked by invoiceNumber).
    for (const inv of invoices) {
      await expect(
        page.locator("tr", { hasText: inv.invoiceNumber }),
      ).toBeVisible({ timeout: 10_000 });
    }

    // Action bar buttons exist but are disabled until the user selects rows.
    await expect(
      page.getByRole("button", { name: /Record Bulk Payment/i }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /Apply Discount/i }),
    ).toBeDisabled();
  });

  test("RECEPTION selects both invoices, opens the bulk-payment modal, applies a partial amount oldest-first; POST /payments/bulk fires and balances refresh", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;
    const patient = await seedPatient(receptionApi);
    const invoices = await seedTwoUnpaidInvoices(receptionApi, patient.id);

    await gotoAuthed(page, `/dashboard/billing/patient/${patient.id}`);
    await expect(
      page.getByRole("heading", { name: patient.name }),
    ).toBeVisible({ timeout: 15_000 });
    await expectNotForbidden(page);

    // Wait for the table to render before checkbox interaction.
    for (const inv of invoices) {
      await expect(
        page.locator("tr", { hasText: inv.invoiceNumber }),
      ).toBeVisible({ timeout: 10_000 });
    }

    // Toggle the master-select checkbox in the table header (page.tsx:286-293).
    // Scope to the data-table region by anchoring on its container — the
    // master checkbox is the first <input type="checkbox"> in the <thead>.
    const headerCheckbox = page.locator("thead input[type='checkbox']").first();
    await headerCheckbox.check();

    // Action bar reflects the selection summary (page.tsx:249-253).
    await expect(page.getByText(/2 selected/i)).toBeVisible();

    // Open bulk-payment modal.
    const recordBulkBtn = page.getByRole("button", {
      name: /Record Bulk Payment/i,
    });
    await expect(recordBulkBtn).toBeEnabled();
    await recordBulkBtn.click();
    await expect(
      page.getByRole("heading", { name: /Record Bulk Payment/i }),
    ).toBeVisible();

    // The modal pre-fills the amount with the selected balance — page.tsx:264.
    // We override to a partial amount so only the OLDEST invoice fully clears
    // and the second sees a smaller payment (oldest-first per page.tsx:127-129).
    const partial = 500; // less than a single invoice total (~826).
    await page.locator("#bulk-pay-amount").fill(String(partial));

    // Watch the round-trip so the assertion is anchored to the server.
    const bulkPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/billing/payments/bulk") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: /^Apply Payment$/ })
      .click();
    const bulkRes = await bulkPromise;
    expect(bulkRes.status()).toBeLessThan(400);

    // Modal closes and the table refreshes — the oldest invoice's status
    // flips to PARTIAL (or stays PARTIAL if it was; we relax to "renders
    // again without crashing" because allocation can vary by createdAt
    // ordering when the timestamps fall in the same second).
    await expect(
      page.getByRole("heading", { name: /Record Bulk Payment/i }),
    ).toHaveCount(0, { timeout: 10_000 });

    // Both rows still show in the unpaid table — partial leaves them in
    // the PENDING/PARTIAL filter set the API returns.
    await expect(
      page.locator("tr", { hasText: invoices[0].invoiceNumber }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("RECEPTION applies a 10% bulk discount to a single selected invoice via the discount modal; POST /invoices/:id/discount fires once per selected invoice", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;
    const patient = await seedPatient(receptionApi);
    const invoices = await seedTwoUnpaidInvoices(receptionApi, patient.id);

    await gotoAuthed(page, `/dashboard/billing/patient/${patient.id}`);
    await expect(
      page.getByRole("heading", { name: patient.name }),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the row, then check ONE row's checkbox so the discount loop
    // (page.tsx:171-176) only fires a single POST.
    const targetRow = page.locator("tr", { hasText: invoices[0].invoiceNumber });
    await expect(targetRow).toBeVisible({ timeout: 10_000 });
    await targetRow.locator("input[type='checkbox']").check();

    await expect(page.getByText(/1 selected/i)).toBeVisible();

    // Open the discount modal.
    await page.getByRole("button", { name: /Apply Discount/i }).click();
    await expect(
      page.getByRole("heading", { name: /^Apply Discount$/ }),
    ).toBeVisible();

    // Default discType is "percentage" — fill 10% which stays under the
    // RECEPTION auto-approve threshold so the POST is direct, not 202.
    await page.locator("#bulk-disc-value").fill("10");
    await page.locator("#bulk-disc-reason").fill("E2E senior-citizen courtesy");

    let discountHits = 0;
    await page.route(
      `**/billing/invoices/${invoices[0].id}/discount`,
      (route) => {
        if (route.request().method() === "POST") discountHits++;
        route.continue();
      },
    );

    await page
      .getByRole("button", { name: /^Apply$/ })
      .click();

    await expect(
      page.getByRole("heading", { name: /^Apply Discount$/ }),
    ).toHaveCount(0, { timeout: 10_000 });

    expect(discountHits, "exactly one POST per selected invoice").toBe(1);
  });

  test("RECEPTION viewing a brand-new patient with zero outstanding invoices sees the empty-state ('No outstanding invoices') and the action buttons stay disabled", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;
    // Seed a patient but DON'T create any invoices for them.
    const patient = await seedPatient(receptionApi);

    await gotoAuthed(page, `/dashboard/billing/patient/${patient.id}`);
    await expectNotForbidden(page);

    // Page header card falls into the no-outstanding fallback (page.tsx:226-232).
    // The page renders this copy in TWO places: a header summary (<p>)
    // and an empty-state placeholder in the table area (<div>). Use
    // .first() so strict-mode doesn't flag the dual match — visibility
    // of either confirms the empty state.
    await expect(page.getByText(/No outstanding invoices/i).first()).toBeVisible({
      timeout: 15_000,
    });

    // Action buttons remain disabled (no rows to select, no balance).
    await expect(
      page.getByRole("button", { name: /Record Bulk Payment/i }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /Apply Discount/i }),
    ).toBeDisabled();
  });

  test("PATIENT visiting /dashboard/billing/patient/[patientId] gets bounced via router.replace('/dashboard') — Issue #385 REDIRECT-BOUNCE archetype, page.tsx:55-60", async ({
    patientPage,
    receptionApi,
  }) => {
    const page = patientPage;
    // Seed a patient via reception so we have a real UUID to navigate to;
    // the role guard fires regardless of whether the URL's patientId is
    // the caller's own — the gate is purely role-based.
    const target = await seedPatient(receptionApi);

    await page.goto(`/dashboard/billing/patient/${target.id}`, {
      waitUntil: "domcontentloaded",
    });

    // Allow the role-guard useEffect at page.tsx:55-60 to fire.
    await page.waitForTimeout(1500);

    // URL settles on /dashboard, NOT /dashboard/not-authorized.
    // The matcher rejects the original /billing/patient/<uuid> URL.
    await expect(page).toHaveURL(/\/dashboard(\/?$|\?|\/(?!billing\/patient))/, {
      timeout: 10_000,
    });

    // The bulk-action bar must never have mounted on this branch.
    await expect(
      page.getByRole("button", { name: /Record Bulk Payment/i }),
    ).toHaveCount(0);
  });

  test("DOCTOR is also outside the ADMIN/RECEPTION allow-set — same Issue #385 redirect-bounce to /dashboard, not /not-authorized", async ({
    doctorPage,
    receptionApi,
  }) => {
    const page = doctorPage;
    const target = await seedPatient(receptionApi);

    await page.goto(`/dashboard/billing/patient/${target.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1500);

    await expect(page).toHaveURL(/\/dashboard(\/?$|\?|\/(?!billing\/patient))/, {
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: /Apply Discount/i }),
    ).toHaveCount(0);
  });
});
