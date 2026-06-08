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

// Short, patient-readable consult date (e.g. "08 Jun 2026"), formatted in UTC
// so the @db.Date day doesn't drift by a timezone.
function fmtConsultDay(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

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
      patientId: true,
      totalAmount: true,
      paymentStatus: true,
      payments: { select: { amount: true } },
      items: {
        select: {
          description: true,
          category: true,
          quantity: true,
          unitPrice: true,
          amount: true,
        },
      },
      admission: {
        select: {
          admittedAt: true,
          dischargedAt: true,
          bed: {
            select: {
              dailyRate: true,
              bedNumber: true,
              ward: { select: { name: true } },
            },
          },
          medicationOrders: {
            select: {
              medicineName: true,
              dosage: true,
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
                  test: { select: { name: true, price: true } },
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

    // Build the itemised lines (mirrors routes/admissions.ts GET /:id/bill)
    // so the IPD invoice shows the SAME breakdown the admission page does —
    // bed charge + every administered dose + every completed lab — and stays
    // in sync as the admission accrues more days / doses / results.
    const desiredItems: Array<{
      description: string;
      category: string;
      quantity: number;
      unitPrice: number;
      amount: number;
    }> = [
      {
        description: `Bed Charges (${inv.admission.bed?.ward?.name ?? "Ward"} / ${inv.admission.bed?.bedNumber ?? "-"})`,
        category: "ROOM_CHARGE",
        quantity: days,
        unitPrice: dailyRate,
        amount: bedCharges,
      },
    ];

    // Pharmacy total: every administered dose × the linked Medicine's
    // MRP. Orders with no administered doses contribute 0. Medicines
    // without an MRP (catalog entry hasn't been priced yet) also
    // contribute 0 — they still appear in the breakdown but at ₹0.
    let pharmacyTotal = 0;
    for (const o of inv.admission.medicationOrders) {
      const doseCount = o.administrations.length;
      if (doseCount === 0) continue;
      const mrp = o.medicine?.mrp ?? 0;
      const amount = doseCount * mrp;
      pharmacyTotal += amount;
      desiredItems.push({
        description: `${o.medicineName}${o.dosage ? ` (${o.dosage})` : ""}`,
        category: "PHARMACY",
        quantity: doseCount,
        unitPrice: mrp,
        amount,
      });
    }

    // Lab total: every COMPLETED lab-order item × LabTest.price. Orders
    // still in ORDERED / SAMPLE_COLLECTED / IN_PROGRESS aren't billed
    // until the result is delivered (same "results-on-record" rule as
    // pharmacy uses for ADMINISTERED).
    let labTotal = 0;
    for (const order of inv.admission.labOrders) {
      for (const item of order.items) {
        const price = item.test?.price ?? 0;
        labTotal += price;
        desiredItems.push({
          description: `Lab: ${item.test?.name ?? "—"}`,
          category: "LAB",
          quantity: 1,
          unitPrice: price,
          amount: price,
        });
      }
    }

    // Consultation charges (2026-06-08): an admitted patient's consults are
    // billed on the admission invoice — itemised per doctor — instead of as
    // separate appointment invoices. Source = the patient's COMPLETED
    // appointments dated within the admission window, each charged the
    // doctor's consultationFee. The standalone consult-invoice path skips
    // admitted patients (see services/consultation-invoice.ts), so this is
    // the single place those charges land.
    let consultTotal = 0;
    // Match on the precise consult-completion TIME (`consultationEndedAt`),
    // not the appointment date, and require it to fall strictly between THIS
    // admission's admit time and its discharge time (or now). This prevents a
    // prior admission's consult — or a same-day OPD consult after discharge —
    // from leaking onto a re-admission's bill. A consult booked while the
    // patient is NOT admitted is billed as its own invoice instead.
    const admitTime = new Date(inv.admission.admittedAt);
    const endTime = inv.admission.dischargedAt
      ? new Date(inv.admission.dischargedAt)
      : new Date(endMs);
    const consultAppts = await rawPrisma.appointment.findMany({
      where: {
        patientId: inv.patientId,
        status: "COMPLETED",
        consultationEndedAt: { gte: admitTime, lte: endTime },
      },
      select: {
        date: true,
        consultationEndedAt: true,
        doctor: {
          select: {
            consultationFee: true,
            user: { select: { name: true } },
          },
        },
      },
    });
    for (const a of consultAppts) {
      const fee = a.doctor?.consultationFee ? Number(a.doctor.consultationFee) : 0;
      if (fee <= 0) continue;
      consultTotal += fee;
      // Bake the consult date into the line so the patient can verify each
      // charge date-wise on screen and on the printed invoice.
      const when = a.consultationEndedAt ?? a.date;
      const dayLabel = when ? ` · ${fmtConsultDay(new Date(when))}` : "";
      desiredItems.push({
        description: `Consultation — ${a.doctor?.user?.name ?? "Doctor"}${dayLabel}`,
        category: "CONSULTATION",
        quantity: 1,
        unitPrice: fee,
        amount: fee,
      });
    }

    const target = bedCharges + pharmacyTotal + labTotal + consultTotal;

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

    const totalChanged = Number(inv.totalAmount) !== target;
    const statusChanged = inv.paymentStatus !== derivedStatus;
    // Detect a line-item drift even when the total is unchanged — e.g. a
    // description tweak (consult date added, doctor renamed) or a swap of
    // equal-value lines. This lets the itemised lines self-heal on the next
    // view without waiting for the total to move. Guarded to target>0 so a
    // ₹0 admission (no charges yet) doesn't churn.
    const itemSig = (
      arr: Array<{
        description: string;
        category: string;
        quantity: number;
        unitPrice: unknown;
        amount: unknown;
      }>,
    ) =>
      arr
        .map(
          (d) =>
            `${d.description}|${d.category}|${d.quantity}|${Number(d.unitPrice)}|${Number(d.amount)}`,
        )
        .sort()
        .join("§");
    const itemsDiffer =
      target > 0 && itemSig(inv.items ?? []) !== itemSig(desiredItems);
    if (!totalChanged && !statusChanged && !itemsDiffer) {
      continue;
    }
    // When the total moved OR the itemised lines drifted, rewrite the lines so
    // the invoice mirrors the admission. A pure status flip (payment recorded,
    // nothing else changed) just updates the header.
    await rawPrisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          subtotal: target,
          taxableAmount: target,
          totalAmount: target,
          paymentStatus: derivedStatus,
        },
      });
      if (totalChanged || itemsDiffer) {
        await tx.invoiceItem.deleteMany({ where: { invoiceId: inv.id } });
        await tx.invoiceItem.createMany({
          data: desiredItems.map((d) => ({ invoiceId: inv.id, ...d })),
        });
      }
    });
    updated++;
  }
  return updated;
}
