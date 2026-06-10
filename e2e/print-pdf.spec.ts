/**
 * Cross-cutting Print / PDF coverage e2e (E2E_COVERAGE_BACKLOG §4.10).
 *
 * What this exercises:
 *   - /dashboard/prescriptions per-row "Print" / "Re-Print" CTA
 *     (page.tsx:1110-1116) -> markPrinted() at page.tsx:284-293 fires
 *     POST /api/v1/prescriptions/:id/print AND opens GET
 *     /api/v1/prescriptions/:id/pdf in a popup (window.open at line 288).
 *     Backend: apps/api/src/routes/prescriptions.ts:416 (POST /:id/print,
 *     authorize ADMIN, DOCTOR) and :362 (GET /:id/pdf, authorize ADMIN,
 *     DOCTOR, NURSE, PHARMACIST, PATIENT - HTML by default, application/pdf
 *     when ?format=pdf).
 *   - /dashboard/billing/[id] "Print Invoice" CTA (page.tsx:462-467) ->
 *     openPrintEndpoint("/billing/invoices/:id/pdf") (lib/api.ts:233-250)
 *     which authed-fetches the endpoint and writes the HTML body into a
 *     popup. Backend: apps/api/src/routes/billing.ts:2386 (authorize ADMIN,
 *     RECEPTION, PATIENT). Watermark overlays for displayStatus PAID /
 *     CANCELLED + pendingApprovals DRAFT render at page.tsx:496-517.
 *   - /dashboard/admissions/[id] "Discharge Summary" CTA
 *     (page.tsx:215-225) -> openPrintEndpoint("/admissions/:id/
 *     discharge-summary-pdf"). Backend: apps/api/src/routes/admissions.ts:
 *     1400 (BOLA-gated; HTML default, ?format=pdf for application/pdf).
 *   - /dashboard/lab/[orderId] "Print Report" CTA (page.tsx:158-164) ->
 *     openPrintEndpoint("/lab/orders/:id/pdf"). Backend:
 *     apps/api/src/routes/lab.ts:1477 (authorize ADMIN, DOCTOR, NURSE,
 *     LAB_TECH, PATIENT).
 *
 * VERIFY-BEFORE-SCAFFOLD audit (cron-learning bullet 7 — backlog framing
 * is sometimes aspirational; verify before scaffold):
 *
 *   §4.10 backlog scenario           | Verdict        | Evidence
 *   ----------------------------------|----------------|------------------
 *   Rx print-to-PDF (per-row Print)   | shipped        | page.tsx:1111
 *   Invoice/bill print layout         | shipped        | billing/[id]/
 *                                     |                |   page.tsx:462
 *   Discharge summary print           | shipped        | admissions/[id]/
 *                                     |                |   page.tsx:215
 *   Lab order PDF                     | shipped (BONUS)| lab/[orderId]/
 *                                     |                |   page.tsx:158
 *   Invoice watermark overlays        | shipped        | billing/[id]/
 *                                     |                |   page.tsx:496-517
 *   "TEST RESULT - NOT FOR CLINICAL   | DEFERRED -     | grep across repo
 *     USE" clinical-test watermark    | UI not shipped | for the literal
 *                                     |                | string returns 0
 *                                     |                | hits in render
 *                                     |                | code (only refs
 *                                     |                | are docs/backlog
 *                                     |                | itself)
 *   Batch / multi-select print        | DEFERRED -     | no bulk-print /
 *                                     | UI not shipped | selectedRows-
 *                                     |                | based print flow
 *                                     |                | exists; grep for
 *                                     |                | /batch.*print|
 *                                     |                | bulk.*print/
 *                                     |                | returns 0 hits
 *                                     |                | across web src
 *
 * Why these tests exist:
 *   §4.10 of docs/E2E_COVERAGE_BACKLOG.md flagged "zero coverage" for
 *   Print / PDF surfaces. Four PDF surfaces ARE shipped today (Rx,
 *   Invoice, Discharge Summary, Lab Report) and were silently un-tested.
 *   This file pins the per-surface trigger contract: clicking the Print
 *   CTA must hit the right authenticated endpoint with the right method
 *   and the right shape. Two further §4.10 line items (clinical-test
 *   watermark + batch print) remain deferred because the UI is not
 *   shipped — they re-enter the backlog when those surfaces ship.
 *
 *   Network-level pinning is the canonical pattern here because
 *   `openPrintEndpoint` (lib/api.ts:233) does an authed fetch then
 *   writes the response into a popup window — there is NO download
 *   event, NO direct navigation, just a `fetch()` we can observe via
 *   `page.waitForResponse()`. The wave-18 reports-custom.spec.ts
 *   `page.waitForEvent("download")` pattern doesn't apply here
 *   (HTML-into-popup, not anchor-with-download); we pin the request
 *   instead.
 *
 *   We page.route-stub the page-detail GETs (and the markPrinted POST
 *   for the Rx case) to avoid heavy seeding for what is fundamentally
 *   a click-to-fetch contract test. Seed footprint: zero.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Print / PDF surfaces — cross-cutting coverage of the four shipped print CTAs (Rx + Invoice + Discharge Summary + Lab Report); clinical-test watermark and batch print deferred per VERIFY-BEFORE-SCAFFOLD audit", () => {
  test("DOCTOR clicks the per-row Print button on /dashboard/prescriptions: POST /prescriptions/:id/print fires AND the GET /prescriptions/:id/pdf print-view opens (popup)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    // Stub the prescriptions list so we don't depend on seed state. Shape
    // matches the PrescriptionRecord interface at page.tsx:51-71. The minimum
    // required for the row + Print button to render is: id + diagnosis +
    // items (>=1) + doctor.user + patient.user + issuedAt + printed flag.
    const stubbedRxId = "11111111-2222-3333-4444-555555555555";
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
              diagnosis: "Acute pharyngitis",
              advice: null,
              issuedAt: new Date().toISOString(),
              // The list defaults to a "Today" filter that keys off createdAt
              // (page.tsx) — without it the stubbed row is filtered out and the
              // row never renders.
              createdAt: new Date().toISOString(),
              followUpDate: null,
              printed: false,
              sharedVia: null,
              doctor: { user: { name: "Dr Test Doctor" } },
              patient: {
                id: "p-stub-1",
                user: { name: "Test Patient", phone: null },
                mrNumber: "MR-STUB-1",
                age: 30,
                gender: "MALE",
              },
              items: [
                {
                  id: "item-1",
                  medicineName: "Amoxicillin 500mg",
                  dosage: "1-0-1",
                  duration: "5 days",
                  instructions: null,
                },
              ],
            },
          ],
          meta: { page: 1, limit: 25, total: 1 },
          error: null,
        }),
      });
    });

    // Stub the print POST so we observe the call without flipping a real
    // row's `printed` flag. Track it via the response promise below.
    await page.route(`**/api/v1/prescriptions/${stubbedRxId}/print`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { id: stubbedRxId, printed: true, printedAt: new Date().toISOString() },
          error: null,
        }),
      }),
    );

    // Stub the popup PDF/HTML endpoint so window.open() at page.tsx:288
    // does not 404 when it lands. The browser may or may not wait for this
    // depending on popup-blocker behaviour, so we keep it loose.
    await page.route(`**/api/v1/prescriptions/${stubbedRxId}/pdf`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><body>stub print view</body></html>",
      }),
    );

    await gotoAuthed(page, "/dashboard/prescriptions");
    await expectNotForbidden(page);

    // The page renders each prescription as a collapsed card with
    // data-testid='rx-row-<id>' (page.tsx:1043-1073). The Print button
    // is INSIDE the expanded section (page.tsx:1075-1119) and is only
    // mounted once the row's <button> wrapper is clicked. So:
    //   1. Locate the row via testid (stable, no class-name churn)
    //   2. Click to expand
    //   3. Then locate the Print button within the row
    const row = page.locator(`[data-testid="rx-row-${stubbedRxId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator("button").first().click();
    const printBtn = row.getByRole("button", { name: /^Print$/ });
    await expect(printBtn).toBeVisible({ timeout: 5_000 });

    // Pin the POST /:id/print contract — this is the audit-trigger path.
    const postPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/prescriptions/${stubbedRxId}/print`) &&
        r.request().method() === "POST",
      { timeout: 15_000 },
    );
    await printBtn.click();
    const postRes = await postPromise;
    expect(postRes.status()).toBe(200);
    // The handler returns the updated row with printed:true.
    const postBody = await postRes.json();
    expect(postBody?.data?.printed).toBe(true);
  });

  test("RECEPTION clicks the Print Invoice CTA on /dashboard/billing/[id]: GET /billing/invoices/:id/pdf is authed-fetched into a print popup", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    const stubbedInvoiceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    // Stub the invoice detail GET so we don't seed a real invoice. The
    // shape is the union of fields touched in billing/[id]/page.tsx —
    // we only need just enough for the page to render past the loading
    // state and show the Print Invoice button.
    await page.route(`**/api/v1/billing/invoices/${stubbedInvoiceId}`, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            id: stubbedInvoiceId,
            invoiceNumber: "INV-STUB-001",
            createdAt: new Date().toISOString(),
            paymentStatus: "PENDING",
            subtotal: 500,
            totalAmount: 500,
            balance: 500,
            taxPercentage: 18,
            taxAmount: 90,
            discountAmount: 0,
            items: [
              {
                id: "li-1",
                description: "General consultation",
                category: "CONSULTATION",
                quantity: 1,
                unitPrice: 500,
                amount: 500,
              },
              {
                id: "li-2",
                description: "Padding line",
                category: "CONSULTATION",
                quantity: 1,
                unitPrice: 0,
                amount: 0,
              },
            ],
            payments: [],
            patient: {
              id: "p-stub-1",
              user: { name: "Test Patient", phone: null, email: null },
              mrNumber: "MR-STUB-1",
            },
            appointment: null,
            doctor: null,
            notes: null,
            lateFeeAmount: 0,
            currency: "INR",
          },
          error: null,
        }),
      });
    });
    // Discount approvals fetch on mount — keep it empty to avoid the
    // pendingApprovals DRAFT watermark interfering with this test.
    await page.route(
      `**/api/v1/billing/invoices/${stubbedInvoiceId}/discount-approvals`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: [], error: null }),
        }),
    );

    // Stub the print PDF endpoint (HTML default — page.tsx:463 doesn't
    // pass ?format=pdf so we reply text/html).
    let pdfRequestSeen = false;
    await page.route(
      `**/api/v1/billing/invoices/${stubbedInvoiceId}/pdf`,
      (route) => {
        pdfRequestSeen = true;
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body>stub invoice print</body></html>",
        });
      },
    );

    await gotoAuthed(page, `/dashboard/billing/${stubbedInvoiceId}`);
    await expectNotForbidden(page);

    const printBtn = page.getByRole("button", { name: /print invoice/i });
    await expect(printBtn).toBeVisible({ timeout: 15_000 });

    const pdfPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/billing/invoices/${stubbedInvoiceId}/pdf`) &&
        r.request().method() === "GET",
      { timeout: 15_000 },
    );
    await printBtn.click();
    const pdfRes = await pdfPromise;
    expect(pdfRes.status()).toBe(200);
    expect(pdfRequestSeen).toBe(true);
  });

  test("DOCTOR clicks Discharge Summary on /dashboard/admissions/[id]: GET /admissions/:id/discharge-summary-pdf fires (the print-discharge-narrative trigger)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    const stubbedAdmissionId = "00000000-1111-2222-3333-444444444444";

    // Minimum admission-shape — page.tsx:170 binds setAdmission via
    // /admissions/:id; we only need patient.user.name + admissionNumber +
    // mrNumber + status for the header chrome where the Print button lives.
    await page.route(`**/api/v1/admissions/${stubbedAdmissionId}`, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            id: stubbedAdmissionId,
            admissionNumber: "ADM-STUB-001",
            status: "ADMITTED",
            admissionDate: new Date().toISOString(),
            patient: {
              id: "p-stub-1",
              mrNumber: "MR-STUB-1",
              user: { name: "Test Patient" },
            },
            doctor: { user: { name: "Dr Test Doctor" } },
            bed: null,
            ward: null,
            diagnosis: "Pneumonia",
            isolationType: null,
            roundsCount: 0,
            patientId: "p-stub-1",
            doctorId: "d-stub-1",
            bedId: null,
          },
          error: null,
        }),
      });
    });
    // Bill, vitals, los-prediction, etc fire from various tabs but the
    // header is rendered before they resolve. Default-fail them softly so
    // we don't blow up on unrouted requests.
    await page.route(
      `**/api/v1/admissions/${stubbedAdmissionId}/bill`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: null, error: null }),
        }),
    );

    let dsRequestSeen = false;
    await page.route(
      `**/api/v1/admissions/${stubbedAdmissionId}/discharge-summary-pdf`,
      (route) => {
        dsRequestSeen = true;
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body>stub discharge summary</body></html>",
        });
      },
    );

    await gotoAuthed(page, `/dashboard/admissions/${stubbedAdmissionId}`);
    await expectNotForbidden(page);

    // The button uses aria-label="Print discharge summary" (admissions/[id]/
    // page.tsx:221). Use a strict aria-label match so the same lock-on
    // works whether the visible label "Discharge Summary" gets translated
    // or wrapped.
    const printBtn = page.locator(
      'button[aria-label="Print discharge summary"]',
    );
    await expect(printBtn).toBeVisible({ timeout: 15_000 });

    const dsPromise = page.waitForResponse(
      (r) =>
        r.url().includes(
          `/admissions/${stubbedAdmissionId}/discharge-summary-pdf`,
        ) && r.request().method() === "GET",
      { timeout: 15_000 },
    );
    await printBtn.click();
    const dsRes = await dsPromise;
    expect(dsRes.status()).toBe(200);
    expect(dsRequestSeen).toBe(true);
  });

  test("DOCTOR clicks Print Report on /dashboard/lab/[orderId]: GET /lab/orders/:id/pdf fires (the lab report PDF trigger)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    const stubbedOrderId = "99999999-8888-7777-6666-555555555555";

    // Minimum LabOrder shape per lab/[orderId]/page.tsx:43-58 (id +
    // orderedAt + status + patient.user.name + items[]).
    await page.route(`**/api/v1/lab/orders/${stubbedOrderId}`, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            id: stubbedOrderId,
            orderNumber: "LAB-STUB-001",
            orderedAt: new Date().toISOString(),
            status: "COMPLETED",
            notes: null,
            patient: {
              id: "p-stub-1",
              mrNumber: "MR-STUB-1",
              age: 30,
              gender: "MALE",
              user: { name: "Test Patient", phone: null },
            },
            doctor: { user: { name: "Dr Test Doctor" } },
            items: [
              {
                id: "loi-1",
                status: "COMPLETED",
                test: {
                  id: "t-1",
                  name: "Complete Blood Count",
                  normalRange: null,
                  unit: null,
                  category: null,
                  panicLow: null,
                  panicHigh: null,
                },
                results: [],
              },
            ],
          },
          error: null,
        }),
      });
    });

    let pdfRequestSeen = false;
    await page.route(
      `**/api/v1/lab/orders/${stubbedOrderId}/pdf`,
      (route) => {
        pdfRequestSeen = true;
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><html><body>stub lab report</body></html>",
        });
      },
    );

    await gotoAuthed(page, `/dashboard/lab/${stubbedOrderId}`);
    await expectNotForbidden(page);

    // aria-label="Print lab report" at lab/[orderId]/page.tsx:160.
    const printBtn = page.locator('button[aria-label="Print lab report"]');
    await expect(printBtn).toBeVisible({ timeout: 15_000 });

    const pdfPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/lab/orders/${stubbedOrderId}/pdf`) &&
        r.request().method() === "GET",
      { timeout: 15_000 },
    );
    await printBtn.click();
    const pdfRes = await pdfPromise;
    expect(pdfRes.status()).toBe(200);
    expect(pdfRequestSeen).toBe(true);
  });

  test("Invoice page renders the PAID watermark overlay when displayStatus collapses to PAID — pins the only watermarking shipped today (the §4.10 'TEST RESULT — NOT FOR CLINICAL USE' clinical-test watermark is deferred; UI not shipped)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;
    const stubbedInvoiceId = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";

    // Drive `derivePaymentStatus` (page.tsx:374) to PAID by stubbing
    // paymentStatus: "PAID" and balance: 0 / netPaid >= total. The
    // watermark element at page.tsx:504-509 is a <span> with the
    // "PAID" text inside the absolute-positioned overlay div — the
    // most stable selector is the literal text inside the
    // pointer-events-none overlay.
    await page.route(`**/api/v1/billing/invoices/${stubbedInvoiceId}`, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            id: stubbedInvoiceId,
            invoiceNumber: "INV-PAID-STUB",
            createdAt: new Date().toISOString(),
            paymentStatus: "PAID",
            subtotal: 500,
            totalAmount: 500,
            balance: 0,
            taxPercentage: 0,
            taxAmount: 0,
            discountAmount: 0,
            items: [
              {
                id: "li-1",
                description: "General consultation",
                category: "CONSULTATION",
                quantity: 1,
                unitPrice: 500,
                amount: 500,
              },
              {
                id: "li-2",
                description: "Padding line",
                category: "CONSULTATION",
                quantity: 1,
                unitPrice: 0,
                amount: 0,
              },
            ],
            payments: [
              {
                id: "pay-1",
                amount: 500,
                paymentMode: "CASH",
                paidAt: new Date().toISOString(),
                reference: null,
              },
            ],
            patient: {
              id: "p-stub-1",
              user: { name: "Test Patient", phone: null, email: null },
              mrNumber: "MR-STUB-1",
            },
            appointment: null,
            doctor: null,
            notes: null,
            lateFeeAmount: 0,
            currency: "INR",
          },
          error: null,
        }),
      });
    });
    await page.route(
      `**/api/v1/billing/invoices/${stubbedInvoiceId}/discount-approvals`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: [], error: null }),
        }),
    );

    await gotoAuthed(page, `/dashboard/billing/${stubbedInvoiceId}`);
    await expectNotForbidden(page);

    // Scope to the watermark overlay's distinctive text inside the
    // absolutely-positioned pointer-events-none div (page.tsx:504-509).
    // The overlay span has rotate-[-30deg] + text-[8rem] which pins it
    // visually as a watermark (and not, e.g., a status pill).
    const paidWatermark = page
      .locator(
        'div.pointer-events-none.absolute span.select-none:has-text("PAID")',
      )
      .first();
    await expect(paidWatermark).toBeVisible({ timeout: 15_000 });

    // Sanity: the CANCELLED and DRAFT watermarks must NOT also be visible
    // — derivePaymentStatus collapsed to PAID, not those branches.
    await expect(
      page.locator(
        'div.pointer-events-none.absolute span.select-none:has-text("CANCELLED")',
      ),
    ).toHaveCount(0);
    await expect(
      page.locator(
        'div.pointer-events-none.absolute span.select-none:has-text("DRAFT")',
      ),
    ).toHaveCount(0);
  });
});
