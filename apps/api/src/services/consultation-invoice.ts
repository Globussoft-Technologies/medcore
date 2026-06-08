import { tenantScopedPrisma as prisma } from "./tenant-prisma";
import { INVOICE_NUMBER_PREFIX } from "@medcore/shared";
import { tenantConfigKey } from "./tenant-provisioning";

// Coerce a Prisma.Decimal / number / string to a JS number (consultationFee
// is DECIMAL(10,2) → Prisma.Decimal). Mirrors the `dec()` helper in billing.ts.
function dec(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const anyV = v as { toNumber?: () => number };
  return typeof anyV.toNumber === "function" ? anyV.toNumber() : Number(v);
}

// Read a numeric SystemConfig value, preferring the tenant-namespaced key
// (what Settings → Billing writes via `tenantConfigKey`) and falling back to
// a bare global key for single-tenant / unscoped deploys. Returns null when
// neither exists or the value isn't a finite number.
async function readConfigNumber(
  key: string,
  tenantId: string | null,
): Promise<number | null> {
  const keys = tenantId ? [tenantConfigKey(tenantId, key), key] : [key];
  for (const k of keys) {
    const row = await prisma.systemConfig.findUnique({ where: { key: k } });
    if (row) {
      const n = Number(row.value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export interface ConsultationInvoiceResult {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  patientId: string;
  created: boolean;
}

/**
 * Create (or return the existing) consultation-fee invoice for an appointment.
 * The fee is the per-doctor `Doctor.consultationFee` (set on the doctor page,
 * ADMIN / SUPER_ADMIN only). When the doctor has no fee (null / 0) nothing is
 * billed and this returns null. Consultations are GST-exempt — the invoice
 * carries the fee only, with no tax line.
 */
export async function createConsultationInvoiceForAppointment(
  appointmentId: string,
): Promise<ConsultationInvoiceResult | null> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      patientId: true,
      tenantId: true,
      branchId: true,
      doctor: { select: { consultationFee: true, user: { select: { name: true } } } },
    },
  });
  if (!appt) return null;

  // If the patient is currently admitted (IPD), the consult is part of the
  // running admission bill — NOT a separate appointment invoice. Skip here;
  // the IPD running-bill sync itemises each in-stay consult per doctor on the
  // admission invoice instead (see services/ipd-billing-sync.ts).
  const activeAdmission = await prisma.admission.findFirst({
    where: { patientId: appt.patientId, status: "ADMITTED" },
    select: { id: true },
  });
  if (activeAdmission) return null;

  // Idempotency — Invoice.appointmentId is @unique, so a consult invoice may
  // already exist (re-flip to COMPLETED, retried request). Don't double-bill.
  const existing = await prisma.invoice.findUnique({
    where: { appointmentId },
    select: { id: true, invoiceNumber: true, totalAmount: true, patientId: true },
  });
  if (existing) {
    return {
      id: existing.id,
      invoiceNumber: existing.invoiceNumber,
      totalAmount: dec(existing.totalAmount),
      patientId: existing.patientId,
      created: false,
    };
  }

  // Fee = the per-doctor consultation fee. No fee set → nothing to bill.
  const fee = +dec(appt.doctor?.consultationFee).toFixed(2);
  if (fee <= 0) return null;

  // Consultations are GST-exempt — no tax line.
  const totalAmount = fee;

  const doctorName = appt.doctor?.user?.name;
  const description = doctorName
    ? `Consultation — ${doctorName}`
    : "Consultation fee";

  // Due date: createdAt + invoice_default_due_days (default 14), matching the
  // manual billing path so receivables age consistently.
  const dueDays = (await readConfigNumber("invoice_default_due_days", appt.tenantId)) ?? 14;
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (Number.isFinite(dueDays) ? dueDays : 14));

  const invoice = await prisma.$transaction(async (tx) => {
    // Invoice number sequence (global @unique). SystemConfig is not a
    // tenant-scoped model, so this read/increment is unscoped — same as
    // routes/billing.ts.
    const config = await tx.systemConfig.findUnique({
      where: { key: "next_invoice_number" },
    });
    const invSeq = config ? parseInt(config.value, 10) || 1 : 1;
    const invoiceNumber = `${INVOICE_NUMBER_PREFIX}${String(invSeq).padStart(6, "0")}`;

    const inv = await tx.invoice.create({
      data: {
        invoiceNumber,
        appointmentId: appt.id,
        patientId: appt.patientId,
        branchId: appt.branchId ?? undefined,
        subtotal: fee,
        taxableAmount: fee,
        totalAmount,
        dueDate,
        paymentStatus: "PENDING",
        notes: "Auto-generated consultation fee on consult completion",
        items: {
          create: [
            {
              description,
              category: "CONSULTATION",
              quantity: 1,
              unitPrice: fee,
              amount: fee,
              cgst: 0,
              sgst: 0,
              gstRate: 0,
              hsnSac: "9993",
            },
          ],
        },
      },
      select: { id: true, invoiceNumber: true, totalAmount: true, patientId: true },
    });

    if (config) {
      await tx.systemConfig.update({
        where: { key: "next_invoice_number" },
        data: { value: String(invSeq + 1) },
      });
    } else {
      await tx.systemConfig.create({
        data: { key: "next_invoice_number", value: String(invSeq + 1) },
      });
    }

    return inv;
  });

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    totalAmount: dec(invoice.totalAmount),
    patientId: invoice.patientId,
    created: true,
  };
}
