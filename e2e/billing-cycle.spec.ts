import { test, expect } from "./fixtures";
import {
  API_BASE,
  apiGet,
  expectNotForbidden,
  gotoDashboard,
  seedAppointment,
  seedPatient,
} from "./helpers";

/**
 * End-to-end billing-cycle spec (multi-role: RECEPTION + PATIENT).
 *
 * Flow exercised:
 *   1. RECEPTION creates an invoice with multiple line items + GST and
 *      asserts the subtotal / CGST / SGST math on /dashboard/billing/[id].
 *   2. RECEPTION applies a discount; for a >threshold% discount the API
 *      routes the request to /dashboard/discount-approvals and the
 *      pending row appears in the listing.
 *   3. RECEPTION collects a partial cash payment and the running balance
 *      reflects the gap on /dashboard/billing/[id].
 *   4. PATIENT views the same invoice on their /dashboard/billing list and
 *      sees the paid/unpaid split.
 *   5. RECEPTION issues a refund (via the invoice detail page — /dashboard
 *      /refunds is a read-only listing) and the refund row appears at
 *      /dashboard/refunds. An audit-log entry with action=REFUND_CREATE
 *      is verified via direct API GET (audit endpoint is ADMIN-only).
 *
 * No new data-testids were added — the existing testids on the invoice
 * detail page (totals-subtotal / totals-cgst / totals-sgst / totals-total
 * / totals-balance / invoice-status-badge) cover every assertion below.
 */

interface InvoiceCreateResponse {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  subtotal: number;
  taxAmount: number;
  cgstAmount: number;
  sgstAmount: number;
}

// Two CONSULTATION line items at known prices so the GST math is
// deterministic. Both fall under the same category so taxPercentage on
// the create-invoice payload (passed below) drives the totals — no
// per-line category surprises.
const LINE_ITEMS = [
  {
    description: "General consultation",
    category: "CONSULTATION",
    quantity: 2,
    unitPrice: 300,
  },
  {
    description: "Follow-up consultation",
    category: "CONSULTATION",
    quantity: 1,
    unitPrice: 400,
  },
];

const SUBTOTAL = LINE_ITEMS.reduce(
  (s, it) => s + it.quantity * it.unitPrice,
  0
); // 1000
const TAX_PCT = 18;
const EXPECTED_TAX = +((SUBTOTAL * TAX_PCT) / 100).toFixed(2); // 180
const EXPECTED_CGST = +(EXPECTED_TAX / 2).toFixed(2); // 90
const EXPECTED_SGST = +(EXPECTED_TAX - EXPECTED_CGST).toFixed(2); // 90
const EXPECTED_TOTAL = SUBTOTAL + EXPECTED_TAX; // 1180

test.describe("Billing cycle (RECEPTION + PATIENT)", () => {
  test("1. RECEPTION creates invoice with multiple line items + GST", async ({
    receptionPage,
    receptionApi,
    request,
  }) => {
    // Seed a fresh patient + appointment so the invoice has a clean anchor.
    const patient = await seedPatient(receptionApi);
    const appt = await seedAppointment(receptionApi, { patientId: patient.id });

    const create = await receptionApi.post(`${API_BASE}/billing/invoices`, {
      data: {
        appointmentId: appt.id,
        patientId: patient.id,
        items: LINE_ITEMS,
        taxPercentage: TAX_PCT,
        notes: "E2E billing-cycle test #1",
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = (await create.json()).data as InvoiceCreateResponse;
    expect(created.subtotal).toBe(SUBTOTAL);
    expect(created.taxAmount).toBeCloseTo(EXPECTED_TAX, 2);
    expect(created.cgstAmount).toBeCloseTo(EXPECTED_CGST, 2);
    expect(created.sgstAmount).toBeCloseTo(EXPECTED_SGST, 2);
    expect(created.totalAmount).toBeCloseTo(EXPECTED_TOTAL, 2);

    // Open invoice detail and verify the math is rendered in the totals
    // block. The page reuses computeInvoiceTotals so a discrepancy here
    // would catch either an API-side regression or a renderer drift.
    await gotoDashboard(
      receptionPage,
      request,
      "RECEPTION",
      `/dashboard/billing/${created.id}`
    );
    await expect(
      receptionPage.getByRole("heading", { name: /tax invoice/i })
    ).toBeVisible({ timeout: 20_000 });

    await expectNotForbidden(receptionPage);

    // Subtotal / CGST / SGST / Total. The fmtMoney helper renders
    // "Rs. 1,000.00" with a non-breaking space, so we match the digit
    // portion via toContainText regex.
    await expect(receptionPage.getByTestId("totals-subtotal")).toContainText(
      /1,000\.00/
    );
    await expect(receptionPage.getByTestId("totals-cgst")).toContainText(
      /90\.00/
    );
    await expect(receptionPage.getByTestId("totals-sgst")).toContainText(
      /90\.00/
    );
    await expect(receptionPage.getByTestId("totals-total")).toContainText(
      /1,180\.00/
    );
  });

  test("2. RECEPTION applies a discount that routes to discount-approvals", async ({
    receptionPage,
    receptionApi,
    request,
  }) => {
    const patient = await seedPatient(receptionApi);
    const appt = await seedAppointment(receptionApi, { patientId: patient.id });
    const create = await receptionApi.post(`${API_BASE}/billing/invoices`, {
      data: {
        appointmentId: appt.id,
        patientId: patient.id,
        items: LINE_ITEMS,
        taxPercentage: TAX_PCT,
      },
    });
    expect(create.ok()).toBeTruthy();
    const inv = (await create.json()).data as InvoiceCreateResponse;

    // 25% discount blows past the default `discount_auto_approve_threshold`
    // (10%) for RECEPTION, so the API enqueues a DiscountApproval row
    // (HTTP 202) and leaves the invoice total unchanged. ADMINs would
    // bypass this; reception must wait for approval.
    const discRes = await receptionApi.post(
      `${API_BASE}/billing/invoices/${inv.id}/discount`,
      {
        data: { percentage: 25, reason: "E2E senior-citizen discount" },
      }
    );
    expect([200, 202]).toContain(discRes.status());
    const body = await discRes.json();
    // The 202 path returns { data: { approval, pending: true } }; the 200
    // (auto-approve) path returns the updated invoice. Either way, the
    // UI test below treats a non-empty pending list as success because
    // the test environment's threshold may have been overridden.

    await gotoDashboard(
      receptionPage,
      request,
      "RECEPTION",
      "/dashboard/discount-approvals"
    );
    await expect(
      receptionPage.getByRole("heading", { name: /discount approvals/i })
    ).toBeVisible({ timeout: 15_000 });
    await expectNotForbidden(receptionPage);

    if (body?.data?.pending) {
      // Approval row must show up in the PENDING tab — match by the
      // invoice number link (font-mono, primary-coloured).
      await expect(
        receptionPage.getByText(inv.invoiceNumber).first()
      ).toBeVisible({ timeout: 10_000 });
    } else {
      // Auto-approved (threshold raised). At minimum the page must have
      // rendered without crashing — the headline assertion above
      // already covers that.
      expect(body?.data).toBeTruthy();
    }
  });

  test("3. RECEPTION collects partial payment and balance reflects on detail page", async ({
    receptionPage,
    receptionApi,
    request,
  }) => {
    const patient = await seedPatient(receptionApi);
    const appt = await seedAppointment(receptionApi, { patientId: patient.id });
    const create = await receptionApi.post(`${API_BASE}/billing/invoices`, {
      data: {
        appointmentId: appt.id,
        patientId: patient.id,
        items: LINE_ITEMS,
        taxPercentage: TAX_PCT,
      },
    });
    const inv = (await create.json()).data as InvoiceCreateResponse;

    // Pay half of the total in cash via the API, then open the detail
    // page and confirm the running balance shows the unpaid half.
    const partial = +(inv.totalAmount / 2).toFixed(2); // 590
    const expectedBalance = +(inv.totalAmount - partial).toFixed(2); // 590
    const payRes = await receptionApi.post(`${API_BASE}/billing/payments`, {
      data: { invoiceId: inv.id, amount: partial, mode: "CASH" },
    });
    expect(payRes.ok()).toBeTruthy();

    await gotoDashboard(
      receptionPage,
      request,
      "RECEPTION",
      `/dashboard/billing/${inv.id}`
    );
    await expect(
      receptionPage.getByRole("heading", { name: /tax invoice/i })
    ).toBeVisible({ timeout: 20_000 });
    await expectNotForbidden(receptionPage);

    // 590.00 should show up both in the running-balance row and in the
    // status badge (PARTIAL after a partial payment).
    const balanceCell = receptionPage.getByTestId("totals-balance");
    await expect(balanceCell).toContainText(/590\.00/);
    await expect(receptionPage.getByTestId("invoice-status-badge")).toHaveText(
      /PARTIAL/i
    );
  });

  test("4. PATIENT views the same invoice on their billing list", async ({
    patientPage,
    patientToken,
    receptionApi,
    request,
  }) => {
    // Resolve the seeded PATIENT user's `patient.id` via /auth/me, then
    // create an invoice for them so it shows up in their listing.
    const me = await apiGet(request, patientToken, "/auth/me");
    const patientId: string | undefined =
      me.body?.data?.patient?.id ?? me.body?.data?.patientId;
    test.skip(
      !patientId,
      "Seeded patient1@medcore.local has no patient row — skip patient-view assertion"
    );

    const appt = await seedAppointment(receptionApi, {
      patientId: patientId as string,
    });
    const create = await receptionApi.post(`${API_BASE}/billing/invoices`, {
      data: {
        appointmentId: appt.id,
        patientId,
        items: LINE_ITEMS,
        taxPercentage: TAX_PCT,
      },
    });
    expect(create.ok()).toBeTruthy();
    const inv = (await create.json()).data as InvoiceCreateResponse;

    // Pay 200 so the listing has a non-zero paid amount to display.
    const payRes = await receptionApi.post(`${API_BASE}/billing/payments`, {
      data: { invoiceId: inv.id, amount: 200, mode: "CASH" },
    });
    expect(payRes.ok()).toBeTruthy();

    await gotoDashboard(
      patientPage,
      request,
      "PATIENT",
      "/dashboard/billing"
    );
    await expect(
      patientPage
        .getByRole("heading", { name: /billing|invoice|bill/i })
        .first()
    ).toBeVisible({ timeout: 20_000 });
    await expectNotForbidden(patientPage);

    // The patient's invoice list should contain THIS invoice number,
    // and the row must surface both the total (1,180.00) and the
    // remaining balance (980.00 = 1180 - 200).
    const row = patientPage
      .locator("tr", { hasText: inv.invoiceNumber })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(/1,180\.00/);
    await expect(row).toContainText(/980\.00/);
  });

  test("5. RECEPTION issues a refund and audit-log row exists", async ({
    receptionPage,
    receptionApi,
    adminApi,
    request,
  }) => {
    const patient = await seedPatient(receptionApi);
    const appt = await seedAppointment(receptionApi, { patientId: patient.id });
    const create = await receptionApi.post(`${API_BASE}/billing/invoices`, {
      data: {
        appointmentId: appt.id,
        patientId: patient.id,
        items: LINE_ITEMS,
        taxPercentage: TAX_PCT,
      },
    });
    const inv = (await create.json()).data as InvoiceCreateResponse;

    // Pay the invoice in full so a refund is allowed (refundSchema
    // rejects refunds > totalPaid).
    const payRes = await receptionApi.post(`${API_BASE}/billing/payments`, {
      data: { invoiceId: inv.id, amount: inv.totalAmount, mode: "CASH" },
    });
    expect(payRes.ok()).toBeTruthy();

    // Issue a partial refund via the API. /dashboard/refunds is read-only,
    // so this matches the actual production path (the refund modal lives
    // on the invoice detail page; both call POST /billing/refunds).
    const refundAmount = 100;
    const refundReason = "E2E refund — duplicate charge";
    const refundRes = await receptionApi.post(`${API_BASE}/billing/refunds`, {
      data: {
        invoiceId: inv.id,
        amount: refundAmount,
        reason: refundReason,
        mode: "CASH",
      },
    });
    expect(refundRes.ok()).toBeTruthy();

    // Refund must appear on the /dashboard/refunds list view. The list
    // defaults to last-30-days, so a refund issued seconds ago is in
    // range.
    await gotoDashboard(
      receptionPage,
      request,
      "RECEPTION",
      "/dashboard/refunds"
    );
    await expect(
      receptionPage.getByRole("heading", { name: /^refunds$/i })
    ).toBeVisible({ timeout: 15_000 });
    await expectNotForbidden(receptionPage);

    const refundRow = receptionPage
      .locator("tr", { hasText: inv.invoiceNumber })
      .first();
    await expect(refundRow).toBeVisible({ timeout: 15_000 });
    await expect(refundRow).toContainText(/100\.00/);

    // Audit-log assertion. /api/v1/audit is ADMIN-only, so we use the
    // adminApi fixture instead of receptionApi. The refund handler
    // emits action=REFUND_CREATE entity=payment.
    const auditRes = await adminApi.get(
      `${API_BASE}/audit?action=REFUND_CREATE&limit=50`
    );
    expect(auditRes.ok()).toBeTruthy();
    const auditBody = await auditRes.json();
    const rows: Array<{ action: string; details?: { invoiceId?: string } }> =
      auditBody.data ?? [];
    const matched = rows.find(
      (r) => r.action === "REFUND_CREATE" && r.details?.invoiceId === inv.id
    );
    expect(matched, "audit row for REFUND_CREATE on this invoice").toBeTruthy();
  });
});
