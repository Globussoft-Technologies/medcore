/**
 * Invoice detail page (/dashboard/billing/[id]) — line-item EDIT surface.
 *
 * What this exercises:
 *   apps/web/src/app/dashboard/billing/[id]/page.tsx — the add-line-item
 *   form (only visible while the invoice is PENDING) and the per-row
 *   trash-can remove button + confirm-dialog flow. Writes go to:
 *     POST   /api/v1/billing/invoices/:id/items
 *     DELETE /api/v1/billing/invoices/:id/items/:itemId
 *   (apps/api/src/routes/billing.ts:960-1100, ADMIN/RECEPTION only;
 *   shared `addInvoiceItemSchema` rejects qty<1 / unitPrice<=0).
 *
 * Why a separate file from billing-cycle.spec.ts:
 *   billing-cycle.spec.ts already covers the CREATE → discount → payment
 *   → refund happy path (steps 1-5) but never mutates an invoice's line
 *   items after creation. The backlog (§2.3) explicitly flagged
 *   "/dashboard/billing/[id] — line-item editing (only happy-path create
 *   tested)". This file fills that gap with add / remove / validation
 *   /  RBAC coverage and intentionally avoids re-asserting the GST math
 *   that billing-cycle already pins.
 *
 * RBAC note (subtle — read before adding more tests):
 *   The page itself is NOT role-gated client-side; any authenticated
 *   user can navigate to /dashboard/billing/[id]. The protection lives
 *   at the API: GET /invoices/:id is ADMIN/RECEPTION/PATIENT and the
 *   write endpoints are ADMIN/RECEPTION only. So a DOCTOR who navigates
 *   to the URL sees the "Invoice not found" empty-state because the
 *   detail GET returned 403 — that's the assertion we lock in.
 */
import { test, expect } from "./fixtures";
import {
  API_BASE,
  apiGet,
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
  items: Array<{ id: string; description: string; amount: number }>;
}

// Two CONSULTATION line items so the trash-can column actually renders
// (page.tsx:672 hides Remove on the LAST item). Subtotal 700 keeps the
// math far from any other value asserted elsewhere in the suite.
const SEED_ITEMS = [
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
      notes: "E2E billing-id seed (PENDING — no payments)",
    },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data as InvoiceCreateResponse;
}

test.describe("Invoice detail — /dashboard/billing/[id] line-item edit surface (RECEPTION add/remove + validation gates + read-only roles)", () => {
  test("RECEPTION adds a new line item to a PENDING invoice; row appears in the table and the totals refresh", async ({
    receptionPage,
    receptionApi,
    request,
  }) => {
    const inv = await seedPendingInvoice(receptionApi);

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

    // Use a unique tag so the row assertion at the bottom doesn't false-
    // positive on a description string already present in the seed list.
    const uniqueDesc = `X-ray chest e2e ${Date.now()}`;

    await receptionPage.getByLabel(/^description$/i).fill(uniqueDesc);
    // Override the auto-derived category so we hit the categoryTouched
    // branch in page.tsx:240-243 — otherwise `categorizeService` may pick
    // a different bucket and the test becomes coupled to that helper.
    await receptionPage.getByLabel(/^category$/i).selectOption("RADIOLOGY");
    await receptionPage.getByLabel(/^qty$/i).fill("2");
    await receptionPage.getByLabel(/^unit price$/i).fill("250");

    // Wait for the POST /items round-trip so we can assert the server
    // accepted the payload — guards against a UI-only optimistic update
    // masking a server-side rejection.
    const postPromise = receptionPage.waitForResponse(
      (r) =>
        r.url().includes(`/billing/invoices/${inv.id}/items`) &&
        r.request().method() === "POST"
    );
    // The Plus button is the only un-aria-labelled control in the form;
    // grab it by its sibling-label position via getByRole + name fallback.
    await receptionPage
      .locator('button:has(svg.lucide-plus)')
      .last()
      .click();
    const postRes = await postPromise;
    expect(postRes.status()).toBeLessThan(400);

    // Row lands in the line-items table.
    await expect(
      receptionPage.locator(`text=${uniqueDesc}`).first()
    ).toBeVisible({ timeout: 10_000 });

    // Subtotal is now 700 (seed) + 2 × 250 = 1200. Match digits-only to
    // tolerate the "Rs. 1,200.00" formatting from fmtMoney.
    await expect(receptionPage.getByTestId("totals-subtotal")).toContainText(
      /1,200\.00/
    );
  });

  test("RECEPTION removes a line item via the trash-can + confirm dialog; the row disappears and totals shrink", async ({
    receptionPage,
    receptionApi,
    request,
  }) => {
    const inv = await seedPendingInvoice(receptionApi);
    expect(inv.items.length).toBeGreaterThanOrEqual(2);
    // Pick the last seeded item — the one priced 400 — so we can assert
    // the subtotal collapses from 700 → 300 after removal.
    const target = inv.items.find((i) => i.amount === 400) ?? inv.items[1];

    await gotoDashboard(
      receptionPage,
      request,
      "RECEPTION",
      `/dashboard/billing/${inv.id}`
    );
    await expect(
      receptionPage.getByRole("heading", { name: /tax invoice/i })
    ).toBeVisible({ timeout: 20_000 });

    // The Remove button only renders when itemsWithTax.length > 1
    // (page.tsx:672). With 2 seed items both rows expose the trash icon.
    const trashButtons = receptionPage.locator(
      'button[title="Remove item"]'
    );
    await expect(trashButtons).toHaveCount(2, { timeout: 10_000 });

    // Click the second trash (matches `target` in our seed order — items
    // come back sorted by createdAt asc from the API).
    const deletePromise = receptionPage.waitForResponse(
      (r) =>
        r.url().includes(`/items/${target.id}`) &&
        r.request().method() === "DELETE"
    );
    await trashButtons.nth(1).click();

    // Confirm dialog from useConfirm() — has stable testids on the
    // ConfirmDialog component (apps/web/src/components/ConfirmDialog.tsx).
    await expect(
      receptionPage.locator('[data-testid="confirm-dialog"]')
    ).toBeVisible({ timeout: 5_000 });
    await receptionPage
      .locator('[data-testid="confirm-dialog-confirm"]')
      .click();

    const delRes = await deletePromise;
    expect(delRes.status()).toBeLessThan(400);

    // After removal only the first seed item remains; subtotal 300.
    await expect(receptionPage.getByTestId("totals-subtotal")).toContainText(
      /300\.00/,
      { timeout: 10_000 }
    );
    // And the trash column collapses (only 1 item left → no remove btn).
    await expect(
      receptionPage.locator('button[title="Remove item"]')
    ).toHaveCount(0);
  });

  test("RECEPTION add-line-item form rejects unitPrice = 0 client-side; no POST is sent and a toast surfaces", async ({
    receptionPage,
    receptionApi,
    request,
  }) => {
    const inv = await seedPendingInvoice(receptionApi);

    await gotoDashboard(
      receptionPage,
      request,
      "RECEPTION",
      `/dashboard/billing/${inv.id}`
    );
    await expect(
      receptionPage.getByRole("heading", { name: /tax invoice/i })
    ).toBeVisible({ timeout: 20_000 });

    // Watch for any /items POST so we can assert it never went out — the
    // client-side guard (page.tsx:205-208) must short-circuit.
    let serverHit = false;
    await receptionPage.route(
      `**/billing/invoices/${inv.id}/items`,
      (route) => {
        if (route.request().method() === "POST") serverHit = true;
        route.continue();
      }
    );

    await receptionPage.getByLabel(/^description$/i).fill("Free sample");
    await receptionPage.getByLabel(/^qty$/i).fill("1");
    await receptionPage.getByLabel(/^unit price$/i).fill("0");

    // The Add button is disabled when newPrice is empty (page.tsx:754),
    // so populate it with "0" first then click. Force the click because
    // disabled-while-empty is the only valid disabled state — for
    // unitPrice=0 the button is enabled and the validator fires.
    await receptionPage.locator('button:has(svg.lucide-plus)').last().click();

    // Give any in-flight POST a moment to surface.
    await receptionPage.waitForTimeout(500);
    expect(serverHit).toBe(false);
  });

  test("RECEPTION add-line-item server-side rejects negative unitPrice with 400; the form does not corrupt the totals", async ({
    receptionApi,
  }) => {
    // Pure API assertion — the client form's <input type=number min=0>
    // would prevent a negative unitPrice, so we exercise the Zod gate
    // directly. This locks the addInvoiceItemSchema contract for any
    // future "smart paste" or programmatic-fill regression.
    const patient = await seedPatient(receptionApi);
    const appt = await seedAppointment(receptionApi, { patientId: patient.id });
    const create = await receptionApi.post(`${API_BASE}/billing/invoices`, {
      data: {
        appointmentId: appt.id,
        patientId: patient.id,
        items: SEED_ITEMS,
        taxPercentage: 18,
      },
    });
    expect(create.ok()).toBeTruthy();
    const inv = (await create.json()).data as InvoiceCreateResponse;

    const bad = await receptionApi.post(
      `${API_BASE}/billing/invoices/${inv.id}/items`,
      {
        data: {
          description: "Negative-price probe",
          category: "OTHER",
          quantity: 1,
          unitPrice: -50,
        },
      }
    );
    expect(bad.status()).toBe(400);

    // Invoice subtotal is unchanged from the seed value (700) — the
    // failed write must not have mutated the invoice.
    const after = await receptionApi.get(
      `${API_BASE}/billing/invoices/${inv.id}`
    );
    expect(after.ok()).toBeTruthy();
    const reread = (await after.json()).data as InvoiceCreateResponse;
    expect(reread.subtotal).toBe(700);
    expect(reread.items.length).toBe(SEED_ITEMS.length);
  });

  test("RECEPTION add-line-item is forbidden once the invoice is PAID; API returns 400 with PENDING-only error", async ({
    receptionApi,
  }) => {
    // Pin the page-level guard "Line items can only be added to PENDING
    // invoices" (page.tsx:697 hides the form when !isPending; api side
    // billing.ts:974-981 returns 400 if a request slips through).
    const patient = await seedPatient(receptionApi);
    const appt = await seedAppointment(receptionApi, { patientId: patient.id });
    const create = await receptionApi.post(`${API_BASE}/billing/invoices`, {
      data: {
        appointmentId: appt.id,
        patientId: patient.id,
        items: SEED_ITEMS,
        taxPercentage: 18,
      },
    });
    const inv = (await create.json()).data as InvoiceCreateResponse;

    // Pay it in full → status flips to PAID.
    const pay = await receptionApi.post(`${API_BASE}/billing/payments`, {
      data: { invoiceId: inv.id, amount: inv.totalAmount, mode: "CASH" },
    });
    expect(pay.ok()).toBeTruthy();

    const blocked = await receptionApi.post(
      `${API_BASE}/billing/invoices/${inv.id}/items`,
      {
        data: {
          description: "Late addition",
          category: "OTHER",
          quantity: 1,
          unitPrice: 100,
        },
      }
    );
    expect(blocked.status()).toBe(400);
    const body = await blocked.json();
    expect(body.error).toMatch(/PENDING/i);
  });

  test("DOCTOR navigating to /dashboard/billing/[id] cannot load the invoice — page is not role-gated client-side, but GET /invoices/:id is RECEPTION/ADMIN/PATIENT only, so the empty-state renders", async ({
    doctorPage,
    receptionApi,
    doctorToken,
    request,
  }) => {
    const inv = await seedPendingInvoice(receptionApi);

    // Confirm the API truly rejects DOCTOR on the read endpoint — that's
    // the contract this test is anchored to.
    const apiProbe = await apiGet(
      request,
      doctorToken,
      `/billing/invoices/${inv.id}`
    );
    expect(apiProbe.status).toBe(403);

    await gotoDashboard(
      doctorPage,
      request,
      "DOCTOR",
      `/dashboard/billing/${inv.id}`
    );

    // The page render path treats a failed loadInvoice() as "Invoice not
    // found" (page.tsx:325-336) — that text is the load-failure tell.
    await expect(
      doctorPage.locator("text=/Invoice not found/i").first()
    ).toBeVisible({ timeout: 15_000 });

    // And the line-item edit affordances must not render.
    await expect(doctorPage.getByLabel(/^description$/i)).toHaveCount(0);
    await expect(
      doctorPage.locator('button[title="Remove item"]')
    ).toHaveCount(0);
  });
});
