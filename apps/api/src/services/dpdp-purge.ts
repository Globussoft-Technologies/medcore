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
 *   - 2026-05-24 widening (OPEN_DECISIONS #5 closure): the original
 *     "known-safe core" (9 tables) is now extended with the Admission,
 *     LabOrder, PatientAllergy, ChronicCondition, Surgery, and
 *     RadiologyStudy families (+ their FK-dependent sub-tables) for full
 *     DPDP Act §17 erasure-right coverage of the Stage-1 patient surface.
 *     Total per-table coverage = 15 parent tables, plus the cascade-fed
 *     sub-tables (IpdVitals, MedicationOrder→MedicationAdministration,
 *     NurseRound, IpdIntakeOutput, PatientBelongings, LabOrderItem,
 *     LabResult, AnesthesiaRecord, PostOpObservation, RadiologyReport).
 *     Per-table counts are encoded in the receipt so a regulator can
 *     verify the action without re-running it.
 *   - Notes on FK choreography: (a) EmergencyCase.linkedAdmissionId is
 *     nullable + NoAction, so we NULL it before deleting Admissions;
 *     (b) RadiologyStudy.orderId is nullable + SetNull on LabOrder, so
 *     the LabOrder delete that precedes it just nulls those refs (then
 *     RadiologyStudy is itself deleted by patientId).
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

    // ────────────────────────────────────────────────────────────────
    // 2026-05-24 widening — Admission family.
    // EmergencyCase.linkedAdmissionId has NO cascade, so null those
    // refs first to avoid FK violation on Admission delete. We then
    // explicitly deleteMany on each Admission sub-table (even though
    // some cascade) so the receipt captures per-table counts. Order:
    // leaves → parent.
    // ────────────────────────────────────────────────────────────────
    const admList = await tx.admission.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (admList.length > 0) {
      const admissionIds = admList.map((a) => a.id);

      // Null EmergencyCase → Admission link (nullable, no cascade).
      await tx.emergencyCase.updateMany({
        where: { linkedAdmissionId: { in: admissionIds } },
        data: { linkedAdmissionId: null },
      });

      // MedicationAdministration ← MedicationOrder (cascade), but we
      // delete explicitly to count.
      const moList = await tx.medicationOrder.findMany({
        where: { admissionId: { in: admissionIds } },
        select: { id: true },
      });
      if (moList.length > 0) {
        const moIds = moList.map((m) => m.id);
        const ma = await tx.medicationAdministration.deleteMany({
          where: { medicationOrderId: { in: moIds } },
        });
        counts.MedicationAdministration = ma.count;
        purgedTables.push("MedicationAdministration");
      }

      const mo = await tx.medicationOrder.deleteMany({
        where: { admissionId: { in: admissionIds } },
      });
      counts.MedicationOrder = mo.count;
      purgedTables.push("MedicationOrder");

      const ipv = await tx.ipdVitals.deleteMany({
        where: { admissionId: { in: admissionIds } },
      });
      counts.IpdVitals = ipv.count;
      purgedTables.push("IpdVitals");

      const nr = await tx.nurseRound.deleteMany({
        where: { admissionId: { in: admissionIds } },
      });
      counts.NurseRound = nr.count;
      purgedTables.push("NurseRound");

      const iio = await tx.ipdIntakeOutput.deleteMany({
        where: { admissionId: { in: admissionIds } },
      });
      counts.IpdIntakeOutput = iio.count;
      purgedTables.push("IpdIntakeOutput");

      const pb = await tx.patientBelongings.deleteMany({
        where: { admissionId: { in: admissionIds } },
      });
      counts.PatientBelongings = pb.count;
      purgedTables.push("PatientBelongings");

      const adm = await tx.admission.deleteMany({ where: { patientId } });
      counts.Admission = adm.count;
      purgedTables.push("Admission");
    }

    // ────────────────────────────────────────────────────────────────
    // LabOrder family. LabResult ← LabOrderItem (cascade) ← LabOrder
    // (cascade). We explicitly count each. RadiologyStudy.orderId is
    // nullable + SetNull on LabOrder delete, so the radiology rows
    // we delete a few lines down won't have a dangling FK after this.
    // ────────────────────────────────────────────────────────────────
    const loList = await tx.labOrder.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (loList.length > 0) {
      const labOrderIds = loList.map((l) => l.id);
      const loiList = await tx.labOrderItem.findMany({
        where: { orderId: { in: labOrderIds } },
        select: { id: true },
      });
      if (loiList.length > 0) {
        const orderItemIds = loiList.map((i) => i.id);
        const lr = await tx.labResult.deleteMany({
          where: { orderItemId: { in: orderItemIds } },
        });
        counts.LabResult = lr.count;
        purgedTables.push("LabResult");
      }
      const loi = await tx.labOrderItem.deleteMany({
        where: { orderId: { in: labOrderIds } },
      });
      counts.LabOrderItem = loi.count;
      purgedTables.push("LabOrderItem");
      const lo = await tx.labOrder.deleteMany({ where: { patientId } });
      counts.LabOrder = lo.count;
      purgedTables.push("LabOrder");
    }

    // ────────────────────────────────────────────────────────────────
    // EHR profile rows (terminal — no sub-tables).
    // ────────────────────────────────────────────────────────────────
    const allg = await tx.patientAllergy.deleteMany({ where: { patientId } });
    counts.PatientAllergy = allg.count;
    purgedTables.push("PatientAllergy");

    const cc = await tx.chronicCondition.deleteMany({ where: { patientId } });
    counts.ChronicCondition = cc.count;
    purgedTables.push("ChronicCondition");

    // ────────────────────────────────────────────────────────────────
    // Surgery family. AnesthesiaRecord + PostOpObservation are
    // cascade-fed; we count them explicitly.
    // ────────────────────────────────────────────────────────────────
    const sList = await tx.surgery.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (sList.length > 0) {
      const surgeryIds = sList.map((s) => s.id);
      const ar = await tx.anesthesiaRecord.deleteMany({
        where: { surgeryId: { in: surgeryIds } },
      });
      counts.AnesthesiaRecord = ar.count;
      purgedTables.push("AnesthesiaRecord");

      const poo = await tx.postOpObservation.deleteMany({
        where: { surgeryId: { in: surgeryIds } },
      });
      counts.PostOpObservation = poo.count;
      purgedTables.push("PostOpObservation");

      const surg = await tx.surgery.deleteMany({ where: { patientId } });
      counts.Surgery = surg.count;
      purgedTables.push("Surgery");
    }

    // ────────────────────────────────────────────────────────────────
    // Radiology family. RadiologyReport ← RadiologyStudy (cascade).
    // ────────────────────────────────────────────────────────────────
    const rsList = await tx.radiologyStudy.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (rsList.length > 0) {
      const studyIds = rsList.map((r) => r.id);
      const rr = await tx.radiologyReport.deleteMany({
        where: { studyId: { in: studyIds } },
      });
      counts.RadiologyReport = rr.count;
      purgedTables.push("RadiologyReport");

      const rs = await tx.radiologyStudy.deleteMany({ where: { patientId } });
      counts.RadiologyStudy = rs.count;
      purgedTables.push("RadiologyStudy");
    }

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
      "DPDP Act 2023 §17 right-to-erasure. AuditLog retained per regulatory requirement; DPDPErasureRequest retained as compliance trail. Coverage: 15 parent patient-linked tables (Appointment-tree, Prescription-tree, Invoice-tree, Vitals, Consultation, PatientDocument, Admission-tree, LabOrder-tree, PatientAllergy, ChronicCondition, Surgery-tree, RadiologyStudy-tree) — full Pearl Stage-1 surface as of 2026-05-24.",
    executedAt: new Date().toISOString(),
  };
}
