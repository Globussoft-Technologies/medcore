/**
 * DPDP cross-tenant erasure-purge service — Pearl ERP Stage 1 §8.6
 * (gap row 224 closure, 2026-05-23).
 *
 * What / which modules / why:
 *   - Implements `purgePatient(patientId, executedBy, prisma)` which runs
 *     a single Prisma `$transaction` to: (a) hard-delete the patient's
 *     child rows in dependency-safe order (PrescriptionItem → Prescription
 *     → InvoiceItem → Payment → Invoice → Vitals → Consultation →
 *     PatientDocument → Appointment) and (b) anonymize the Patient + the
 *     backing User row (NULL out PII, set isActive=false, scramble
 *     identifiers) rather than DELETE so retained `AuditLog` rows + the
 *     `DPDPErasureRequest` audit trail stay referentially intact.
 *   - The function returns an "execution receipt" capturing per-table
 *     purgedRows counts + which tables were anonymized vs retained — this
 *     is persisted on `DPDPErasureRequest.executionReceipt` so a regulator
 *     auditing the request later can verify the action without re-running
 *     it.
 *   - Scope-cut: this is the "known-safe core" set of child tables. The
 *     fuller sweep (Admission, LabOrder, Allergy, ChronicCondition,
 *     Surgery, RadiologyStudy, etc.) is deliberately deferred — those
 *     each carry FK constraints into further sub-tables (LabOrderItems,
 *     AdmissionTransfers, …) and a recursive purge across them needs its
 *     own dependency-order analysis. A follow-up gap ticket will widen
 *     this list. Per-table coverage is fully encoded in the receipt so
 *     a downstream service can extend it idempotently.
 */

import type { PrismaClient } from "@prisma/client";

export interface ExecutionReceipt {
  purgedTables: string[];
  purgedRows: Record<string, number>;
  anonymizedTables: string[];
  retainedTables: string[];
  notes: string;
  executedAt: string;
}

export class DPDPPurgeError extends Error {
  constructor(public readonly receipt: Partial<ExecutionReceipt>, message: string) {
    super(message);
    this.name = "DPDPPurgeError";
  }
}

/**
 * Runs the cross-table purge for one patient. Throws DPDPPurgeError on
 * partial-failure (the route handler maps that to a FAILED request row
 * with the receipt + failureReason persisted).
 */
export async function purgePatient(
  patientId: string,
  executedBy: string,
  prisma: PrismaClient,
): Promise<ExecutionReceipt> {
  // Pre-fetch the Patient + userId so we can anonymize both rows inside
  // the transaction without an extra round-trip.
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { id: true, userId: true, tenantId: true },
  });
  if (!patient) {
    throw new DPDPPurgeError(
      { purgedTables: [], purgedRows: {}, anonymizedTables: [], retainedTables: [] },
      `Patient ${patientId} not found`,
    );
  }

  const counts: Record<string, number> = {};
  const purgedTables: string[] = [];

  // Order is dependency-safe: leaves first, parents last. Each delete is
  // patientId-scoped via Prisma's deleteMany.
  await prisma.$transaction(async (tx) => {
    // PrescriptionItem ← Prescription (FK: prescriptionId)
    const presList = await tx.prescription.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (presList.length > 0) {
      const prescriptionIds = presList.map((p) => p.id);
      const pi = await tx.prescriptionItem.deleteMany({
        where: { prescriptionId: { in: prescriptionIds } },
      });
      counts.PrescriptionItem = pi.count;
      purgedTables.push("PrescriptionItem");
    }

    // InvoiceItem + Payment ← Invoice (FK: invoiceId)
    const invList = await tx.invoice.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (invList.length > 0) {
      const invoiceIds = invList.map((i) => i.id);
      const ii = await tx.invoiceItem.deleteMany({
        where: { invoiceId: { in: invoiceIds } },
      });
      counts.InvoiceItem = ii.count;
      purgedTables.push("InvoiceItem");
      const pay = await tx.payment.deleteMany({
        where: { invoiceId: { in: invoiceIds } },
      });
      counts.Payment = pay.count;
      purgedTables.push("Payment");
    }

    // Parent rows.
    const pres = await tx.prescription.deleteMany({ where: { patientId } });
    counts.Prescription = pres.count;
    purgedTables.push("Prescription");

    const inv = await tx.invoice.deleteMany({ where: { patientId } });
    counts.Invoice = inv.count;
    purgedTables.push("Invoice");

    const vit = await tx.vitals.deleteMany({ where: { patientId } });
    counts.Vitals = vit.count;
    purgedTables.push("Vitals");

    // Consultation has no direct patientId — it's keyed by appointmentId.
    // We delete it via the appointment list below, but Prisma doesn't
    // expose a join-delete: gather appointment ids first.
    const apptList = await tx.appointment.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (apptList.length > 0) {
      const apptIds = apptList.map((a) => a.id);
      const cons = await tx.consultation.deleteMany({
        where: { appointmentId: { in: apptIds } },
      });
      counts.Consultation = cons.count;
      purgedTables.push("Consultation");
    }

    const docs = await tx.patientDocument.deleteMany({ where: { patientId } });
    counts.PatientDocument = docs.count;
    purgedTables.push("PatientDocument");

    const appt = await tx.appointment.deleteMany({ where: { patientId } });
    counts.Appointment = appt.count;
    purgedTables.push("Appointment");

    // Anonymize Patient (keep the row so retained AuditLog + the request
    // row itself stay FK-valid; null out PII).
    const ts = Date.now();
    await tx.patient.update({
      where: { id: patientId },
      data: {
        // mrNumber is @unique — we have to keep a non-empty value, so
        // overwrite with a sentinel that's unique-per-patient.
        mrNumber: `ERASED-${ts}-${patientId.slice(0, 8)}`,
        address: null,
        bloodGroup: null,
        emergencyContactName: null,
        emergencyContactPhone: null,
        emergencyContactRelationship: null,
        insuranceProvider: null,
        insurancePolicyNumber: null,
        maritalStatus: null,
        occupation: null,
        religion: null,
        preferredLanguage: null,
        abhaId: null,
        aadhaarMasked: null,
        photoUrl: null,
      },
    });

    // Anonymize User (null email; scramble phone; null name → "[erased]"
    // since name is NOT NULL in schema; flip isActive=false so the
    // identity can't be reused for login).
    if (patient.userId) {
      await tx.user.update({
        where: { id: patient.userId },
        data: {
          email: null,
          phone: `+91-erased-${ts}-${patient.userId.slice(0, 6)}`,
          name: "[erased]",
          photoUrl: null,
          isActive: false,
          twoFactorEnabled: false,
          twoFactorSecret: null,
          twoFactorBackupCodes: undefined,
          pushToken: null,
        },
      });
    }
  });

  return {
    purgedTables,
    purgedRows: counts,
    anonymizedTables: ["Patient", "User"],
    retainedTables: ["AuditLog", "DPDPErasureRequest"],
    notes:
      "DPDP Act 2023 §17 right-to-erasure. AuditLog retained per regulatory requirement; DPDPErasureRequest retained as compliance trail. Scope-cut: core child tables (Appointment-tree, Prescription-tree, Invoice-tree, Vitals, Consultation, PatientDocument). Wider sweep (Admission/LabOrder/Allergy/etc.) deferred — see TODO Pearl §8.6 follow-up.",
    executedAt: new Date().toISOString(),
  };
}
