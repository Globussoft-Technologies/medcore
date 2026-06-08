/**
 * Billing line-items + credit-notes deeper-coverage e2e — REVENUE-CRITICAL.
 *
 * What this exercises:
 *   apps/web/src/app/dashboard/billing/[id]/page.tsx — line-item delete
 *     + add UIs and the per-modal Refund flow (`submitRefund` →
 *     POST /api/v1/billing/refunds at routes/billing.ts:879).
 *   apps/api/src/routes/billing.ts:1807 — POST /credit-notes (no UI surface
 *     in the web app today; exercised here as a pure API contract pin so
 *     paid-invoice credit issuance is locked under e2e).
 *
 * Companion specs (intentionally disjoint — read before extending here):
 *   - e2e/billing-cycle.spec.ts: CREATE → discount → payment → refund happy
 *     path (locks the GST math; we don't re-assert it).
 *   - e2e/billing-id.spec.ts: line-item ADD happy path + add-validation
 *     (qty/price gates) + RECEPTION add-after-PAID = 400 + DOCTOR
 *     not-found empty-state. Already pins POST /items contract.
 *   - e2e/billing-patient.spec.ts: bulk patient billing.
 *   - e2e/refunds-discounts.spec.ts: discount-approval workflow + audit
 *     row for REFUND_CREATE on a fully-paid invoice.
 *
 * What THIS file adds (§5 P1 of docs/E2E_COVERAGE_BACKLOG.md):
 *   1. DELETE line-item via UI → audit row INVOICE_ITEM_DELETE lands tied
 *      to this invoice id (billing-id only asserted the row disappears).
 *   2. Quantity-edit by delete-then-re-add → totals recompute (the API has
 *      NO PATCH /items; quantity-change-as-replace is the actual prod path).
 *   3. PARTIAL refund (amount < net paid) UI flow with the modal: pin the
 *      POST /billing/refunds request body via page.route stub + assert the
 *      Issue Refund button is gated on `amount > 0` + `reason` (the
 *      `disabled=` clause at page.tsx:1138-1143).
 *   4. CREDIT-NOTE issuance against a fully-paid invoice → 201 with the
 *      generated noteNumber + invoice balance is unchanged (credit notes
 *      track separately from refunds; the model has no UI surface yet so
 *      this is API-only — flagged inline).
 *   5. CREDIT-NOTE OVER-credit rejection → POST /credit-notes returns 400
 *      with "Total credit notes cannot exceed invoice total".
 *
 * Deferred — UI not shipped (documented per /medcore-e2e-spec skill):
 *   - "Edit line-item quantity" via dedicated PATCH endpoint: the API has
 *     only POST + DELETE on /items; the UI has no inline-edit affordance.
 *     Replaced by delete-then-re-add coverage (case 2), which is the actual
 *     production path users follow today.
 *   - "Period-locked invoice → edit blocked": no `lockedAt` / period-lock
 *     field exists on the Invoice model. The de-facto edit lock is
 *     `paymentStatus !== "PENDING"` (page.tsx:388 — `isPending`), already
 *     pinned in billing-id.spec.ts as "RECEPTION add-line-item is forbidden
 *     once the invoice is PAID".
 *   - "Overpayment → credit balance carry-forward": no carry-forward
 *     surface in the UI today. Server-side `derivePaymentStatus` in
 *     packages/shared returns REFUNDED-vs-PAID-vs-PARTIAL only — there is
 *     no advance-credit field for excess payment. Backend-only, defer.
 *
 * RBAC anchor: every action below uses RECEPTION (covered by ADMIN +
 * RECEPTION at the API; matches billing-id.spec.ts's role choice).
 */
import { test, expect, type Route } from "./fixtures";
import {
  API_BASE,
  expectNotForbidden,
  gotoDashboard,
  seedAppointment,
  seedPatient,
} from "./helpers";

interface InvoiceCreateResponse {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  paymentStatus: string;
  items: Array<{ id: string; description: string; amount: number; quantity: number }>;
}

// Two distinct TAXABLE line items so the UI Remove column actually renders in
// the main GST line-item table (CONSULTATION lines render in the separate
// consult summary section, not this table). The trash icon hides when only
// one item remains, so two are needed.
const SEED_ITEMS = [
  {
    description: "Cardiology assessment",
    category: "PROCEDURE",
    quantity: 1,
    unitPrice: 800,
  },
  {
    description: "ECG procedure",
    category: "PROCEDURE",
    quantity: 1,
    unitPrice: 600,
  },
];

async function seedPendingInvoice(
  api: import("@playwright/test").APIRequestContext
): Promise<InvoiceCreateResponse> {
  const patient = await seedPatient(api);
  const appt = await seedAppointment(api, { patientId: patient.id });
  const res = await api.post(`${API_BASE}/billing/invoices`, {
    data: {
      appointmentId: appt.id,
      patientId: patient.id,
      items: SEED_ITEMS,
      taxPercentage: 18,
      notes: "E2E billing-line-items seed (PENDING — no payments)",
    },
  });
  expect(res.ok(), `seed invoice: ${res.status()}`).toBeTruthy();
  return (await res.json()).data as InvoiceCreateResponse;
}

async function seedPaidInvoice(
  api: import("@playwright/test").APIRequestContext
): Promise<InvoiceCreateResponse> {
  const inv = await seedPendingInvoice(api);
  const pay = await api.post(`${API_BASE}/billing/payments`, {
    data: { invoiceId: inv.id, amount: inv.totalAmount, mode: "CASH" },
  });
  expect(pay.ok(), `seed payment: ${pay.status()}`).toBeTruthy();
  // Re-read so the caller sees the updated paymentStatus + payments[].
  const after = await api.get(`${API_BASE}/billing/invoices/${inv.id}`);
  return (await after.json()).data as InvoiceCreateResponse;
}

test.describe("Invoice line-items + credit notes — /dashboard/billing/[id] revenue-critical deeper coverage (RECEPTION delete-with-audit + qty-replace + partial-refund stub + credit-note API)", () => {
  test("RECEPTION removes a line item via the UI; the INVOICE_ITEM_DELETE audit row lands tied to this invoice id (billing-id only pinned the row disappearance — this case anchors the audit-side contract)", async ({
    receptionPage,
    receptionApi,
    adminApi,
    request,
  }) => {
    const inv = await seedPendingInvoice(receptionApi);
    expect(inv.items.length).toBe(2);
    // Pick the second seed item (ECG procedure, amount 600) so we can
    // separately assert which item the audit row references.
    const target = inv.items.find((i) => i.amount === 600) ?? inv.items[1];

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

    const trashButtons = receptionPage.locator(
      'button[title="Remove item"]'
    );
    await expect(trashButtons).toHaveCount(2, { timeout: 10_000 });

    const deletePromise = receptionPage.waitForResponse(
      (r) =>
        r.url().includes(`/items/${target.id}`) &&
        r.request().method() === "DELETE"
    );
    await trashButtons.nth(1).click();
    await expect(
      receptionPage.locator('[data-testid="confirm-dialog"]')
    ).toBeVisible({ timeout: 5_000 });
    await receptionPage
      .locator('[data-testid="confirm-dialog-confirm"]')
      .click();
    const delRes = await deletePromise;
    expect(delRes.status()).toBeLessThan(400);

    // Now the new bit — the audit table must carry an INVOICE_ITEM_DELETE
    // row tagged with this invoice + the deleted itemId in its details
    // payload (routes/billing.ts:1149). Use ADMIN's API context because
    // the audit GET is ADMIN-only on most envs.
    const auditRes = await adminApi.get(
      `${API_BASE}/audit?action=INVOICE_ITEM_DELETE&limit=50`
    );
    expect(auditRes.ok()).toBeTruthy();
    const rows: Array<{
      action: string;
      entity?: string;
      entityId?: string;
      details?: { itemId?: string };
    }> = (await auditRes.json()).data ?? [];
    const match = rows.find(
      (r) =>
        r.action === "INVOICE_ITEM_DELETE" &&
        r.entityId === inv.id &&
        r.details?.itemId === target.id
    );
    expect(
      match,
      "audit row INVOICE_ITEM_DELETE must reference the invoice + the deleted item id"
    ).toBeTruthy();
  });

  test("RECEPTION changes a line-item quantity by deleting + re-adding (the only production path — there is no PATCH /items endpoint); subtotal collapses then grows back to the new value", async ({
    receptionPage,
    receptionApi,
    request,
  }) => {
    const inv = await seedPendingInvoice(receptionApi);
    // Subtotal at seed = 800 + 600 = 1400. We will replace the ECG row
    // (qty 1 × 600) with a qty-3 version (3 × 600 = 1800), netting 800 +
    // 1800 = 2600. Doing it as delete-then-re-add is the actual prod path.
    const target = inv.items.find((i) => i.amount === 600) ?? inv.items[1];

    await gotoDashboard(
      receptionPage,
      request,
      "RECEPTION",
      `/dashboard/billing/${inv.id}`
    );
    await expect(
      receptionPage.getByRole("heading", { name: /tax invoice/i })
    ).toBeVisible({ timeout: 20_000 });
    await expect(receptionPage.getByTestId("totals-subtotal")).toContainText(
      /1,400\.00/
    );

    // Step 1: delete the ECG row.
    const deletePromise = receptionPage.waitForResponse(
      (r) =>
        r.url().includes(`/items/${target.id}`) &&
        r.request().method() === "DELETE"
    );
    await receptionPage
      .locator('button[title="Remove item"]')
      .nth(1)
      .click();
    await receptionPage
      .locator('[data-testid="confirm-dialog-confirm"]')
      .click();
    await deletePromise;

    // Subtotal collapses to just the remaining item (800).
    await expect(receptionPage.getByTestId("totals-subtotal")).toContainText(
      /800\.00/,
      { timeout: 10_000 }
    );

    // Step 2: re-add ECG with quantity = 3.
    const postPromise = receptionPage.waitForResponse(
      (r) =>
        r.url().includes(`/billing/invoices/${inv.id}/items`) &&
        r.request().method() === "POST"
    );
    await receptionPage
      .getByLabel(/^description$/i)
      .fill("ECG procedure (3 leads)");
    // Override the auto-derived category — categorizeService may bucket
    // "ECG" elsewhere; pin it explicitly so the recompute is deterministic.
    await receptionPage.getByLabel(/^category$/i).selectOption("PROCEDURE");
    await receptionPage.getByLabel(/^qty$/i).fill("3");
    await receptionPage.getByLabel(/^unit price$/i).fill("600");
    await receptionPage.locator('button:has(svg.lucide-plus)').last().click();
    const postRes = await postPromise;
    expect(postRes.status()).toBeLessThan(400);

    // Subtotal lands at 800 + 1800 = 2600 — the recomputed total.
    await expect(receptionPage.getByTestId("totals-subtotal")).toContainText(
      /2,600\.00/,
      { timeout: 10_000 }
    );
  });

  test("RECEPTION issues a partial refund through the modal: POST /billing/refunds request body shape `{invoiceId, amount, reason, mode}` is pinned via page.route stub, the Issue Refund CTA is disabled while reason is empty (page.tsx:1138-1143), and `amount < netPaid` is the modal's working contract", async ({
    receptionPage,
    receptionApi,
    request,
  }) => {
    const inv = await seedPaidInvoice(receptionApi);
    expect(inv.paymentStatus).toBe("PAID");
    // Pick a partial-refund amount strictly less than what was paid.
    const partial = Math.round(inv.totalAmount * 0.25);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(inv.totalAmount);

    await gotoDashboard(
      receptionPage,
      request,
      "RECEPTION",
      `/dashboard/billing/${inv.id}`
    );
    await expect(
      receptionPage.getByRole("heading", { name: /tax invoice/i })
    ).toBeVisible({ timeout: 20_000 });

    // Stub the POST /refunds round-trip — we want the request-body shape
    // pin without persisting (refunds spawn a real Payment row + flip
    // paymentStatus). Register BEFORE clicking so the most-recently-
    // registered handler wins per Playwright's ordering.
    let refundPost: { url: string; body: unknown } | null = null;
    await receptionPage.route(
      /\/api\/v1\/billing\/refunds(\?.*)?$/,
      (route: Route) => {
        if (route.request().method() !== "POST") {
          route.continue();
          return;
        }
        refundPost = {
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
              invoiceId: inv.id,
              amount: -partial,
              mode: "CASH",
              transactionId: "REFUND:Stub-only — partial refund flow",
              paidAt: new Date().toISOString(),
            },
            error: null,
          }),
        });
      }
    );

    // Open the Refund modal.
    await receptionPage
      .getByRole("button", { name: /record refund/i })
      .click();
    await expect(
      receptionPage.getByRole("heading", { name: /issue refund/i })
    ).toBeVisible({ timeout: 5_000 });

    // Issue Refund CTA must be disabled while the reason is empty.
    const issueBtn = receptionPage.getByRole("button", {
      name: /issue refund/i,
    });
    await expect(issueBtn).toBeDisabled();

    // Lock the partial amount (override the page-default of `netPaid`).
    await receptionPage
      .locator("#invoice-refund-amount")
      .fill(String(partial));
    // Adding a reason satisfies the second branch of the `disabled` clause.
    await receptionPage
      .locator("#invoice-refund-reason")
      .fill("E2E partial refund — duplicate ECG charge billed");

    await expect(issueBtn).toBeEnabled();
    await issueBtn.click();

    await expect.poll(() => refundPost?.body, { timeout: 10_000 }).toMatchObject({
      invoiceId: inv.id,
      amount: partial,
      reason: "E2E partial refund — duplicate ECG charge billed",
      mode: "CASH",
    });
  });

  test("RECEPTION POST /billing/credit-notes against a PAID invoice: 201 with a generated CN- noteNumber and the invoice's totalAmount is unchanged (credit notes track separately from refunds; backlog called this 'balance updates' but the persisted column is the credit-notes ledger, not Invoice.totalAmount)", async ({
    receptionApi,
  }) => {
    // Pure API assertion — there is no /dashboard/credit-notes UI in the
    // web app today (grep of apps/web/src returned no matches). This case
    // pins the contract so the next person who builds the UI has a green
    // baseline to integrate against.
    const inv = await seedPaidInvoice(receptionApi);
    const beforeTotal = inv.totalAmount;

    const creditAmount = Math.round(beforeTotal * 0.5);
    const cnRes = await receptionApi.post(
      `${API_BASE}/billing/credit-notes`,
      {
        data: {
          invoiceId: inv.id,
          amount: creditAmount,
          reason: "E2E credit note — service not rendered as billed",
        },
      }
    );
    expect(
      cnRes.ok(),
      `POST /credit-notes: ${cnRes.status()} ${(await cnRes.text()).slice(0, 200)}`
    ).toBeTruthy();
    const cnBody = await cnRes.json();
    expect(cnBody.data).toBeTruthy();
    expect(cnBody.data.noteNumber).toMatch(/^CN-?/i);
    expect(cnBody.data.amount).toBe(creditAmount);
    expect(cnBody.data.invoiceId).toBe(inv.id);

    // The Invoice row's totalAmount must NOT have moved — credit notes
    // accumulate in their own `creditNotes` relation; they are NOT
    // subtracted from totalAmount (routes/billing.ts:1816-1851 only
    // INSERTs into prisma.creditNote, never UPDATEs Invoice).
    const after = await receptionApi.get(
      `${API_BASE}/billing/invoices/${inv.id}`
    );
    const afterInv = (await after.json()).data as InvoiceCreateResponse;
    expect(afterInv.totalAmount).toBe(beforeTotal);
  });

  test("RECEPTION POST /billing/credit-notes that would push (alreadyCredited + amount) past invoice.totalAmount returns 400 — pins the over-credit guard at routes/billing.ts:1825-1832", async ({
    receptionApi,
  }) => {
    const inv = await seedPaidInvoice(receptionApi);

    // First credit note covers most of the invoice.
    const ok = await receptionApi.post(`${API_BASE}/billing/credit-notes`, {
      data: {
        invoiceId: inv.id,
        amount: inv.totalAmount - 100,
        reason: "E2E first partial credit note",
      },
    });
    expect(ok.ok()).toBeTruthy();

    // Second credit note tries to over-credit (asks for full total — would
    // push the cumulative far past invoice.totalAmount).
    const overflow = await receptionApi.post(
      `${API_BASE}/billing/credit-notes`,
      {
        data: {
          invoiceId: inv.id,
          amount: inv.totalAmount,
          reason: "E2E over-credit attempt",
        },
      }
    );
    expect(overflow.status()).toBe(400);
    const errBody = await overflow.json();
    expect(errBody.error).toMatch(/cannot exceed invoice total/i);
  });
});
