import { test, expect } from "./fixtures";
import { API_BASE, seedAppointment, seedPatient } from "./helpers";

/**
 * Pearl PRD Stage 1 §4.5 / gap-analysis row 331 — RECEPTION must be able to
 * create an invoice, record payment, and print the receipt in **< 60 s**.
 *
 * Touches:
 *   - apps/api/src/routes/billing.ts (POST /billing/invoices, POST /billing/payments,
 *     GET /billing/invoices/:id/pdf?format=pdf)
 *   - apps/api/src/services/pdf-generator.ts (generateInvoicePDFBuffer)
 *
 * Why a timed spec: the existing billing-cycle spec asserts functional
 * correctness (GST math, partial-payment balance, refund + audit row) but
 * never brackets the wall-clock. Pearl §4.5 is an SLA: invoice → payment →
 * receipt must complete inside 60s end-to-end. This spec brackets the
 * three API calls with `performance.now()` to surface perf regressions
 * (slow PDF generation, slow Prisma writes, slow tax compute) as test
 * failures rather than support tickets.
 *
 * Scope-cuts vs the PRD prose:
 *   - The PRD says "receipt print"; the production receipt is rendered
 *     via GET /billing/invoices/:id/pdf?format=pdf which streams an
 *     application/pdf buffer. We assert the Content-Type + non-empty body
 *     instead of opening a browser print dialog — the wall-clock budget is
 *     about server-side end-to-end, not native-OS print dialog latency.
 *   - We drive the three steps via API (request.post / receptionApi) rather
 *     than the UI new-invoice form. Rationale: the new-invoice form's
 *     EntityPicker debounce + slot-grid hydration adds 2-5s of UI noise
 *     that the Pearl SLA budget is NOT meant to police (the SLA is about
 *     the underlying booking-payment-receipt path, mirrored by the form).
 *     API-level timing is the conservative measurement; the form layer
 *     wraps it.
 *   - Skip-exit (matching appointment-booking-timed.spec.ts §02cbe53) if
 *     seed prerequisites (patient + appointment) can't be created — that's
 *     the local-API-not-running case; suite defers to CI.
 */

interface InvoiceCreateResponse {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
}

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
const TAX_PCT = 18;

test.describe("Pearl §4.5 — RECEPTION creates invoice + records payment + prints receipt in <60s", () => {
  test("clock-bracketed flow: POST invoice → POST payment → GET receipt.pdf (Content-Type application/pdf)", async ({
    receptionApi,
  }) => {
    // ─── Pre-flight: seed patient + appointment (NOT counted toward the 60s). ──
    // These prerequisites must exist BEFORE the receptionist starts the
    // billing task; seeding them is not part of the invoice-creation SLA.
    let patient: { id: string; name: string } | null = null;
    let appt: { id: string } | null = null;
    try {
      patient = await seedPatient(receptionApi, { name: "Rohan Mehta" });
      appt = await seedAppointment(receptionApi, { patientId: patient.id });
    } catch (err) {
      test.skip(
        true,
        `Pre-flight seed failed (${err instanceof Error ? err.message : String(err)}) — ` +
          "Pearl <60s SLA can't be measured without a patient + appointment anchor."
      );
    }
    expect(patient!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(appt!.id).toMatch(/^[0-9a-f-]{36}$/);

    // ─── START TIMER ────────────────────────────────────────────────────────
    const t0 = performance.now();

    // 1. Create invoice (multi-line with GST). Mirrors the new-invoice form's
    //    POST shape (see billing-cycle.spec.ts test #1).
    const createRes = await receptionApi.post(`${API_BASE}/billing/invoices`, {
      data: {
        appointmentId: appt!.id,
        patientId: patient!.id,
        items: LINE_ITEMS,
        taxPercentage: TAX_PCT,
        notes: "Pearl §4.5 timed-flow invoice",
      },
    });
    expect(
      createRes.ok(),
      `invoice create failed: ${createRes.status()} ${(await createRes.text()).slice(0, 200)}`
    ).toBeTruthy();
    const created = (await createRes.json()).data as InvoiceCreateResponse;
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.totalAmount).toBeGreaterThan(0);

    // 2. Record full payment via CASH so the invoice closes to PAID (the
    //    receipt PDF carries a paid-stamp downstream). Mirrors the
    //    /billing/payments POST shape.
    const payRes = await receptionApi.post(`${API_BASE}/billing/payments`, {
      data: {
        invoiceId: created.id,
        amount: created.totalAmount,
        mode: "CASH",
      },
    });
    expect(
      payRes.ok(),
      `payment failed: ${payRes.status()} ${(await payRes.text()).slice(0, 200)}`
    ).toBeTruthy();

    // 3. Print receipt = stream the PDF buffer. The handler at
    //    apps/api/src/routes/billing.ts:2956 returns application/pdf when
    //    `?format=pdf`. Anything else is the HTML print-view fallback and
    //    isn't what a real receipt-print workflow uses.
    const pdfRes = await receptionApi.get(
      `${API_BASE}/billing/invoices/${created.id}/pdf?format=pdf`
    );
    expect(
      pdfRes.ok(),
      `receipt pdf failed: ${pdfRes.status()} ${(await pdfRes.text()).slice(0, 200)}`
    ).toBeTruthy();
    expect(pdfRes.headers()["content-type"] ?? "").toMatch(/application\/pdf/i);
    const pdfBuf = await pdfRes.body();
    // Sanity: a real PDF buffer starts with "%PDF-" (5 bytes); empty / HTML
    // fallback bodies would silently pass the Content-Type check otherwise.
    expect(pdfBuf.length).toBeGreaterThan(1024);
    expect(pdfBuf.subarray(0, 5).toString("utf8")).toBe("%PDF-");

    // ─── STOP TIMER + ASSERT 60s SLA ────────────────────────────────────────
    const t1 = performance.now();
    const elapsedMs = Math.round(t1 - t0);
    // eslint-disable-next-line no-console
    console.log(
      `[Pearl §4.5 row 331] invoice→payment→receipt in ${elapsedMs} ms (budget: 60000 ms)`
    );
    expect(
      elapsedMs,
      `Pearl §4.5 SLA: invoice + payment + receipt-pdf must complete in < 60 s. Observed ${elapsedMs} ms.`
    ).toBeLessThan(60_000);
  });
});
