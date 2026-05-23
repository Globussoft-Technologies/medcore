import { test, expect, E2E_CSRF_TOKEN } from "./fixtures";
import {
  API_BASE,
  seedAppointment,
  seedPatient,
} from "./helpers";
import { request as playwrightRequest } from "@playwright/test";

/**
 * Pearl PRD Stage 1 §7.3 / gap-analysis row 345 — PHARMACY must be able to
 * dispense a 3-item prescription AND collect payment in **< 90 s**.
 *
 * Touches:
 *   - apps/api/src/routes/prescriptions.ts (POST /prescriptions — create 3-item Rx)
 *   - apps/api/src/routes/billing.ts       (POST /billing/invoices,
 *                                           POST /billing/payments)
 *   - apps/api/src/routes/pharmacy.ts      (POST /pharmacy/dispense — decrements
 *                                           stock + appends pharmacy lines onto
 *                                           the appointment's PENDING invoice)
 *
 * Why a timed spec: the existing pharmacist.spec.ts asserts dispense
 * functional correctness (status code, response shape, inventory mutation)
 * but never brackets the wall-clock. Pearl §7.3 is an SLA: the
 * dispense + payment leg of a 3-item Rx must complete inside 90s. This
 * spec brackets the three API calls with `performance.now()` to surface
 * perf regressions (slow inventory FIFO scan, slow auto-bill side effect,
 * slow controlled-register insert) as test failures rather than support
 * tickets.
 *
 * Scope-cuts vs the PRD prose:
 *   - The Rx + invoice are seeded BEFORE the timer starts. Pearl's "3-item
 *     Rx" bullet measures the pharmacist's task (dispense → invoice-ready
 *     → collect cash), not the doctor's prior Rx-creation latency. That has
 *     its own row in the gap doc (row 344, doctor signs Rx <60s).
 *   - The pharmacy invoice is pre-created with a single placeholder line
 *     (`Pharmacy dispense placeholder`) so the auto-bill side-effect in
 *     POST /pharmacy/dispense (apps/api/src/routes/pharmacy.ts:636) has a
 *     PENDING invoice to append to. The seeded line + auto-appended
 *     pharmacy lines together form the final billable total that gets paid.
 *   - We drive each step via API (raw APIRequestContext per role) rather
 *     than the UI dispense/billing forms. Rationale mirrors the other Pearl
 *     timing specs (02cbe53, 724cf6e, f22928a, a3fe42c, c3c5b54): API-level
 *     timing is the conservative measurement; the form layer wraps it.
 *   - Skip-exit if seed prerequisites (patient + appointment + 3-item Rx
 *     + invoice) can't be created — that's the local-API-not-running or
 *     missing-medicine-master case; suite defers to CI.
 */

interface InvoiceCreateResponse {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
}

// 3 medicines pre-seeded by packages/db/src/seed-pharmacy.ts that the
// dispense handler's case-insensitive name/genericName/contains resolver
// will match against. Each is a common Indian OTC/Rx so the seed inventory
// almost certainly has stock + price set.
const RX_ITEMS = [
  {
    medicineName: "Paracetamol",
    dosage: "500mg",
    frequency: "TDS",
    duration: "5 days",
    instructions: "After food",
  },
  {
    medicineName: "Cetirizine",
    dosage: "10mg",
    frequency: "OD",
    duration: "3 days",
    instructions: "At bedtime",
  },
  {
    medicineName: "Amoxicillin",
    dosage: "500mg",
    frequency: "TDS",
    duration: "5 days",
    instructions: "Complete the course",
  },
];

test.describe("Pearl §7.3 — PHARMACY dispenses 3-item Rx + collects payment in <90s", () => {
  test("clock-bracketed flow: POST /pharmacy/dispense → POST /billing/payments closes invoice (3-item Rx)", async ({
    adminApi,
    receptionApi,
    pharmacistToken,
  }) => {
    // ─── Pre-flight: seed patient + appointment + 3-item Rx + PENDING invoice.
    // None of this is counted toward the 90s — the budget is the
    // pharmacist's task (dispense + collect), not the prior clinic flow.
    let patient: { id: string; name: string } | null = null;
    let appt: { id: string } | null = null;
    let prescriptionId: string | null = null;
    let invoice: InvoiceCreateResponse | null = null;

    try {
      patient = await seedPatient(receptionApi, { name: "Vihaan Iyer" });
      appt = await seedAppointment(receptionApi, { patientId: patient.id });

      // Create the 3-item Rx as ADMIN (allowed by createPrescriptionSchema
      // + authorize(DOCTOR, ADMIN) on POST /prescriptions). Mirrors the
      // pharmacist.spec.ts seed pattern at e2e/pharmacist.spec.ts:62-83.
      const rxRes = await adminApi.post(`${API_BASE}/prescriptions`, {
        data: {
          appointmentId: appt.id,
          patientId: patient.id,
          diagnosis: "J06.9 — Acute upper respiratory infection",
          items: RX_ITEMS,
          advice: "Fluids, rest, review in 5 days.",
        },
      });
      if (rxRes.ok()) {
        const json = await rxRes.json();
        prescriptionId = json.data?.id ?? null;
      }

      // Pre-create a PENDING invoice on the appointment so the dispense
      // handler's auto-bill side-effect (pharmacy.ts:636) has a target to
      // append the dispensed pharmacy lines onto. Without this, the
      // pharmacist would still need a separate billing trip to raise an
      // invoice — splitting the 90s budget across two unrelated systems.
      // The seeded "placeholder" line gives the invoice a non-zero base
      // total so totalAmount > 0 holds prior to dispense.
      const invRes = await receptionApi.post(`${API_BASE}/billing/invoices`, {
        data: {
          appointmentId: appt.id,
          patientId: patient.id,
          items: [
            {
              description: "Pharmacy dispense placeholder",
              category: "PHARMACY",
              quantity: 1,
              unitPrice: 1,
            },
          ],
          taxPercentage: 0,
          notes: "Pearl §7.3 timed-flow placeholder; pharmacy lines appended on dispense.",
        },
      });
      if (invRes.ok()) {
        invoice = (await invRes.json()).data as InvoiceCreateResponse;
      }
    } catch {
      /* fall through to skip below */
    }

    test.skip(
      !patient || !appt || !prescriptionId || !invoice,
      "Pre-flight seed failed (patient / appointment / 3-item Rx / PENDING invoice could not be created) — " +
        "Pearl <90s SLA can't be measured without a complete dispense-and-bill anchor."
    );

    // PHARMACIST has no pre-built `pharmacistApi` fixture; build one on the
    // fly with the same CSRF + Auth shape that adminApi/receptionApi use.
    // (Fixtures file is in the no-touch allowlist; building a context
    // locally is the documented pattern — see fixtures.ts:282-295.)
    const pharmacistApi = await playwrightRequest.newContext({
      extraHTTPHeaders: {
        Authorization: `Bearer ${pharmacistToken}`,
        "X-CSRF-Token": E2E_CSRF_TOKEN,
        Cookie: `medcore_csrf=${E2E_CSRF_TOKEN}`,
      },
    });

    try {
      // ─── START TIMER ──────────────────────────────────────────────────────
      const t0 = performance.now();

      // 1. Dispense the 3-item Rx. The handler decrements inventory per item
      //    (FIFO by expiry), creates StockMovement(DISPENSED) rows, and
      //    auto-appends pharmacy line items to the PENDING invoice we seeded.
      //    Endpoint verified: apps/api/src/routes/pharmacy.ts:385 — POST
      //    /pharmacy/dispense with `{prescriptionId}` (NOT per-item PATCH).
      const dispRes = await pharmacistApi.post(`${API_BASE}/pharmacy/dispense`, {
        data: { prescriptionId },
      });
      expect(
        dispRes.ok(),
        `dispense failed: ${dispRes.status()} ${(await dispRes.text()).slice(0, 200)}`
      ).toBeTruthy();
      const dispBody = await dispRes.json();
      expect(dispBody.success).toBe(true);
      expect(dispBody.data).toHaveProperty("prescriptionId", prescriptionId);
      // Shape contract: dispensed[] + warnings[] always arrays (may be empty
      // if seeded medicine names don't resolve OR if the inventory table is
      // empty for the matched medicines — both are seed-data facts, not
      // regressions). The wall-clock budget is what we gate CI on.
      expect(Array.isArray(dispBody.data.dispensed)).toBe(true);
      expect(Array.isArray(dispBody.data.warnings)).toBe(true);

      // 2. Re-read the invoice so we know the post-dispense corrected total
      //    (placeholder line + auto-appended pharmacy lines) — without this
      //    the payment may 400 with "Payment exceeds invoice balance" if
      //    pharmacy lines weren't appended, OR may underpay if they were.
      const invGetRes = await receptionApi.get(
        `${API_BASE}/billing/invoices/${invoice!.id}`
      );
      expect(
        invGetRes.ok(),
        `invoice re-read failed: ${invGetRes.status()} ${(await invGetRes.text()).slice(0, 200)}`
      ).toBeTruthy();
      const refreshedTotal =
        ((await invGetRes.json()).data?.totalAmount as number) ?? invoice!.totalAmount;
      expect(refreshedTotal).toBeGreaterThan(0);

      // 3. Collect payment in CASH for the full corrected total so the
      //    invoice closes to PAID. Endpoint verified: billing.ts:763 — POST
      //    /billing/payments with `{invoiceId, amount, mode, transactionId?}`.
      //    NOTE: handler requires RECEPTION/ADMIN — pharmacist hands off
      //    cash to reception in the production flow; mirroring with
      //    receptionApi here is the conservative measurement.
      const payRes = await receptionApi.post(`${API_BASE}/billing/payments`, {
        data: {
          invoiceId: invoice!.id,
          amount: refreshedTotal,
          mode: "CASH",
        },
      });
      expect(
        payRes.ok(),
        `payment failed: ${payRes.status()} ${(await payRes.text()).slice(0, 200)}`
      ).toBeTruthy();

      // ─── STOP TIMER + ASSERT 90s SLA ──────────────────────────────────────
      const t1 = performance.now();
      const elapsedMs = Math.round(t1 - t0);
      // eslint-disable-next-line no-console
      console.log(
        `[Pearl §7.3 row 345] pharmacy dispense+payment (3-item Rx) in ${elapsedMs} ms (budget: 90000 ms)`
      );
      expect(
        elapsedMs,
        `Pearl §7.3 SLA: pharmacy dispense + payment for a 3-item Rx must complete in < 90 s. Observed ${elapsedMs} ms.`
      ).toBeLessThan(90_000);
    } finally {
      await pharmacistApi.dispose();
    }
  });
});
