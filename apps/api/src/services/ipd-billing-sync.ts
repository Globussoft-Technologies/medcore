// IPD running-bill DB sync.
//
// IPD invoices are created at admit time with totalAmount = 0 (see
// routes/admissions.ts POST /). The real running bill has THREE components:
//   1. Bed charges    = max(1, ceil(durationDays)) × bed.dailyRate
//   2. Pharmacy total = Σ over each ADMINISTERED dose of
//                       medication.medicine.mrp
//   3. Lab total      = Σ over each COMPLETED lab-order item of
//                       labOrderItem.test.price
// Rather than overlay live math in every reader, this helper walks every
// PENDING IPD invoice whose admission is still ADMITTED and persists the
// current total (bed + pharmacy + lab) to the DB. Once persisted, every
// downstream query (billing list, KPI cards, outstanding report,
// getOutstanding service, discharge-readiness, discharge-handler
// outstanding-bill guard) sees the same fresh value without per-endpoint
// overlay logic.
//
// Pharmacy formula matches routes/admissions.ts GET /:id/bill exactly —
// keep them in sync if the pricing rule changes (e.g. switch from
// Medicine.mrp to InventoryItem.sellingPrice for per-batch accuracy).
//
// Idempotency: rows whose total already matches the computed target are
// skipped, so calling this on every read is safe and won't churn the DB
// log when nothing has drifted.
//
// Called from:
//   - routes/billing.ts                 (GET /invoices, GET /reports/outstanding,
//                                        GET /patients/:patientId/outstanding)
//   - routes/admissions.ts              (GET /:id/discharge-readiness,
//                                        PATCH /:id/discharge guard)
//   - any future cron / report job needing fresh IPD totals
//
// Extracted from routes/billing.ts on 2026-05-25 when the second
// non-billing caller (discharge handlers) needed the same freshness
// contract. Extended to include pharmacy total later the same day so
// the Outstanding-bills readiness check correctly reflects medicines.

import { prisma as rawPrisma } from "@medcore/db";
import { INVOICE_NUMBER_PREFIX } from "@medcore/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function syncIpdInvoiceTotals(): Promise<number> {
  // ── Step 1: Lazy-create invoices for ADMITTED admissions that don't
  //    have one. Happens for admissions created BEFORE the auto-create-
  //    on-admit logic landed in admissions.ts POST /, or if an admit
  //    transaction partially succeeded and missed the invoice insert.
  //    Idempotent — admissionId is @unique so a P2002 from a concurrent
  //    caller is harmless and skipped.
  const orphanAdmissions = await rawPrisma.admission.findMany({
    where: { status: "ADMITTED", invoice: null },
    select: { id: true, patientId: true, admissionNumber: true },
  });
  for (const a of orphanAdmissions) {
    try {
      await rawPrisma.$transaction(async (tx) => {
        const cfg = await tx.systemConfig.findUnique({
          where: { key: "next_invoice_number" },
        });
        const seq = cfg ? parseInt(cfg.value) : 1;
        const invoiceNumber = `${INVOICE_NUMBER_PREFIX}${String(seq).padStart(6, "0")}`;
        await tx.invoice.create({
          data: {
            invoiceNumber,
            admissionId: a.id,
            patientId: a.patientId,
            subtotal: 0,
            totalAmount: 0,
            paymentStatus: "PENDING",
            notes: `IPD admission ${a.admissionNumber} — backfilled by sync (admission predates auto-create)`,
          },
        });
        if (cfg) {
          await tx.systemConfig.update({
            where: { key: "next_invoice_number" },
            data: { value: String(seq + 1) },
          });
        } else {
          await tx.systemConfig.create({
            data: { key: "next_invoice_number", value: String(seq + 1) },
          });
        }
      });
    } catch (err) {
      // P2002 = unique constraint hit (concurrent sync created it first).
      // Any other DB error: log and continue — one orphan failing
      // shouldn't block the rest of the sync.
      const code = (err as { code?: string } | null)?.code;
      if (code !== "P2002") {
        console.warn(
          `[ipd-billing-sync] failed to backfill invoice for admission ${a.admissionNumber}:`,
          (err as Error)?.message ?? err,
        );
      }
    }
  }

  // ── Step 2: Resync totals + re-derive paymentStatus for every active-
  //    admission invoice, regardless of current paymentStatus. The
  //    earlier PENDING-only filter was wrong: invoices stuck in
  //    REFUNDED (e.g. payment + refund recorded mid-stay) wouldn't get
  //    re-totalled as new bed-days / doses accrued, so the readiness
  //    check incorrectly read 0 outstanding.
  //
  //    Source of truth for paymentStatus is now derived data:
  //      netPaid = Σ payments (refunds are stored as negative amounts)
  //      netPaid <= 0      → PENDING
  //      0 < netPaid < tot → PARTIAL
  //      netPaid >= tot    → PAID
  //    Discharged admissions are skipped — they're frozen by design.
  const invoices = await rawPrisma.invoice.findMany({
    where: {
      admissionId: { not: null },
      admission: { status: "ADMITTED" },
    },
    select: {
      id: true,
      totalAmount: true,
      paymentStatus: true,
      payments: { select: { amount: true } },
      admission: {
        select: {
          admittedAt: true,
          dischargedAt: true,
          bed: { select: { dailyRate: true } },
          medicationOrders: {
            select: {
              medicine: { select: { mrp: true } },
              administrations: {
                where: { status: "ADMINISTERED" },
                select: { id: true },
              },
            },
          },
          labOrders: {
            select: {
              items: {
                where: { status: "COMPLETED" },
                select: {
                  test: { select: { price: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  let updated = 0;
  for (const inv of invoices) {
    if (!inv.admission) continue;
    const startMs = new Date(inv.admission.admittedAt).getTime();
    const endMs = inv.admission.dischargedAt
      ? new Date(inv.admission.dischargedAt).getTime()
      : Date.now();
    const days = Math.max(1, Math.ceil((endMs - startMs) / DAY_MS));
    const dailyRate = inv.admission.bed?.dailyRate ?? 0;
    const bedCharges = dailyRate * days;

    // Pharmacy total: every administered dose × the linked Medicine's
    // MRP. Orders with no administered doses contribute 0. Medicines
    // without an MRP (catalog entry hasn't been priced yet) also
    // contribute 0 — they still appear in the breakdown but at ₹0.
    let pharmacyTotal = 0;
    for (const o of inv.admission.medicationOrders) {
      const doseCount = o.administrations.length;
      if (doseCount === 0) continue;
      const mrp = o.medicine?.mrp ?? 0;
      pharmacyTotal += doseCount * mrp;
    }

    // Lab total: every COMPLETED lab-order item × LabTest.price. Orders
    // still in ORDERED / SAMPLE_COLLECTED / IN_PROGRESS aren't billed
    // until the result is delivered (same "results-on-record" rule as
    // pharmacy uses for ADMINISTERED).
    let labTotal = 0;
    for (const order of inv.admission.labOrders) {
      for (const item of order.items) {
        labTotal += item.test?.price ?? 0;
      }
    }

    const target = bedCharges + pharmacyTotal + labTotal;

    // Net paid (refunds stored as negative amounts cancel out earlier
    // payments). Clamp at 0 — we never want negative paid in arithmetic
    // (the patient can't owe negative money on a positive bill).
    const netPaid = Math.max(
      0,
      inv.payments.reduce((s, p) => s + (p.amount ?? 0), 0),
    );
    const derivedStatus: "PENDING" | "PARTIAL" | "PAID" =
      netPaid <= 0
        ? "PENDING"
        : netPaid >= target
          ? "PAID"
          : "PARTIAL";

    if (
      Number(inv.totalAmount) === target &&
      inv.paymentStatus === derivedStatus
    ) {
      continue;
    }
    await rawPrisma.invoice.update({
      where: { id: inv.id },
      data: {
        subtotal: target,
        totalAmount: target,
        paymentStatus: derivedStatus,
      },
    });
    updated++;
  }
  return updated;
}
