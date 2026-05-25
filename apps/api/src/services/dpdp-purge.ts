/**
 * DPDP cross-tenant erasure-purge service — Pearl ERP Stage 1 §8.6
 * (gap row 224 closure, 2026-05-23).
 *
 * What / which modules / why:
 *   - Implements `purgePatient(patientId, executedBy, prisma)` which runs
 *     a single Prisma `$transaction` to: (a) hard-delete the patient's
 *     child rows across every patient-linked table in dependency-safe
 *     order, and (b) anonymize the Patient + the backing User row (NULL
 *     out PII, set isActive=false, scramble identifiers) rather than
 *     DELETE so retained `AuditLog` rows + the `DPDPErasureRequest`
 *     audit trail stay referentially intact.
 *   - The function returns an "execution receipt" capturing per-table
 *     purgedRows counts + which tables were anonymized vs retained — this
 *     is persisted on `DPDPErasureRequest.executionReceipt` so a regulator
 *     auditing the request later can verify the action without re-running
 *     it.
 *   - 2026-05-25 widening (Pearl Stage-1 verification audit over-claim #1
 *     closure — `docs/PEARL_STAGE1_VERIFICATION_AUDIT_2026-05-25.md`):
 *     prior `8d7f401` claimed "15 tables" but actually touched 12; this
 *     revision extends coverage to ALL patient-linked tables surfaced by
 *     `grep -nE "patientId\s+String" packages/db/prisma/schema.prisma`
 *     (cross-referenced against `models with @relation … Patient`).
 *     New parent tables added in this pass:
 *       PatientFamilyLink, InsuranceClaim, FamilyHistory, Immunization,
 *       Referral, PackagePurchase, TelemedicineSession, EmergencyCase,
 *       BloodRequest, AmbulanceTrip, AntenatalCase (+ AncVisit,
 *       UltrasoundRecord, Partograph, PostnatalVisit children),
 *       GrowthRecord, PatientFeedback (+ FeedbackSentiment),
 *       Complaint, Visitor, AdvancePayment, WaitlistEntry,
 *       CoordinatedVisit, AdvanceDirective, MedReconciliation,
 *       PaymentPlan (+ PaymentPlanInstallment), PreAuthRequest,
 *       MilestoneRecord, FeedingLog, AITriageSession, AIScribeSession,
 *       AdherenceSchedule (+ AdherenceDoseLog), LabReportExplanation,
 *       AbhaLink, ConsentArtefact, CareContext,
 *       InsuranceClaim2 (+ ClaimDocument + ClaimStatusEvent),
 *       BillExplanation, PrevisitChecklist, SymptomDiaryEntry,
 *       ChronicCarePlan (+ ChronicCareCheckIn + ChronicCareAlert),
 *       PatientDataExport, MedicationIncident, CampaignSend,
 *       WhatsAppConversation (+ WhatsAppMessage), Implant
 *       (Surgery child). Total: 12 → 50+ tables purged. Per-table
 *       counts are encoded in the receipt so a regulator can verify
 *       the action without re-running it.
 *   - Notes on FK choreography:
 *     (a) EmergencyCase.linkedAdmissionId is nullable + NoAction, so we
 *         NULL it before deleting Admissions.
 *     (b) RadiologyStudy.orderId is nullable + SetNull on LabOrder, so
 *         the LabOrder delete just nulls those refs.
 *     (c) MedicationIncident.scribeSessionId is SetNull on AIScribeSession
 *         delete, but MedicationIncident has its own patientId so we
 *         purge it FIRST.
 *     (d) PatientFamilyLink is bidirectional — we match BOTH
 *         `patientId = X` AND `relatedPatientId = X` so the patient's
 *         family graph is fully severed.
 *     (e) ControlledSubstanceEntry is a Drugs and Cosmetics Rules §65
 *         regulator-mandated retention ledger; we NULL the patientId
 *         (sever the PHI link) instead of deleting the row.
 *     (f) IngestLog has no FK relation block (just a String? column),
 *         but contains patient-referencing rows that need purging.
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
    // Surgery family. AnesthesiaRecord + PostOpObservation + Implant are
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

      const impl = await tx.implant.deleteMany({
        where: { surgeryId: { in: surgeryIds } },
      });
      counts.Implant = impl.count;
      purgedTables.push("Implant");

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

    // ════════════════════════════════════════════════════════════════
    // 2026-05-25 EXTENDED COVERAGE (audit over-claim #1 closure).
    // Every remaining patient-linked table. FK-safe leaf→parent order,
    // family-grouped for readability. Empty results short-circuit via
    // `if (count > 0)` to keep the receipt clean.
    // ════════════════════════════════════════════════════════════════

    // ── AntenatalCase family (ANC + postnatal + ultrasound + partograph).
    const ancList = await tx.antenatalCase.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (ancList.length > 0) {
      const ancIds = ancList.map((a) => a.id);
      const av = await tx.ancVisit.deleteMany({
        where: { ancCaseId: { in: ancIds } },
      });
      counts.AncVisit = av.count;
      purgedTables.push("AncVisit");

      const us = await tx.ultrasoundRecord.deleteMany({
        where: { ancCaseId: { in: ancIds } },
      });
      counts.UltrasoundRecord = us.count;
      purgedTables.push("UltrasoundRecord");

      const part = await tx.partograph.deleteMany({
        where: { ancCaseId: { in: ancIds } },
      });
      counts.Partograph = part.count;
      purgedTables.push("Partograph");

      const pnv = await tx.postnatalVisit.deleteMany({
        where: { ancCaseId: { in: ancIds } },
      });
      counts.PostnatalVisit = pnv.count;
      purgedTables.push("PostnatalVisit");

      const anc = await tx.antenatalCase.deleteMany({ where: { patientId } });
      counts.AntenatalCase = anc.count;
      purgedTables.push("AntenatalCase");
    }

    // ── PaymentPlan family.
    const ppList = await tx.paymentPlan.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (ppList.length > 0) {
      const ppIds = ppList.map((p) => p.id);
      const ppi = await tx.paymentPlanInstallment.deleteMany({
        where: { planId: { in: ppIds } },
      });
      counts.PaymentPlanInstallment = ppi.count;
      purgedTables.push("PaymentPlanInstallment");

      const pp = await tx.paymentPlan.deleteMany({ where: { patientId } });
      counts.PaymentPlan = pp.count;
      purgedTables.push("PaymentPlan");
    }

    // ── AdherenceSchedule family (DoseLog also has direct patientId,
    //    deleted as cascade child here for ordering safety).
    const adhList = await tx.adherenceSchedule.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (adhList.length > 0) {
      const adhIds = adhList.map((a) => a.id);
      const adl = await tx.adherenceDoseLog.deleteMany({
        where: { scheduleId: { in: adhIds } },
      });
      counts.AdherenceDoseLog = adl.count;
      purgedTables.push("AdherenceDoseLog");

      const adh = await tx.adherenceSchedule.deleteMany({ where: { patientId } });
      counts.AdherenceSchedule = adh.count;
      purgedTables.push("AdherenceSchedule");
    } else {
      // Defensive: dose-logs by patientId in case any orphaned ones exist
      // (shouldn't, due to FK, but the receipt should reflect coverage).
      const adlOrphan = await tx.adherenceDoseLog.deleteMany({ where: { patientId } });
      if (adlOrphan.count > 0) {
        counts.AdherenceDoseLog = (counts.AdherenceDoseLog ?? 0) + adlOrphan.count;
        if (!purgedTables.includes("AdherenceDoseLog")) purgedTables.push("AdherenceDoseLog");
      }
    }

    // ── InsuranceClaim2 family.
    const ic2List = await tx.insuranceClaim2.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (ic2List.length > 0) {
      const ic2Ids = ic2List.map((c) => c.id);
      const cd = await tx.claimDocument.deleteMany({
        where: { claimId: { in: ic2Ids } },
      });
      counts.ClaimDocument = cd.count;
      purgedTables.push("ClaimDocument");

      const cse = await tx.claimStatusEvent.deleteMany({
        where: { claimId: { in: ic2Ids } },
      });
      counts.ClaimStatusEvent = cse.count;
      purgedTables.push("ClaimStatusEvent");

      const ic2 = await tx.insuranceClaim2.deleteMany({ where: { patientId } });
      counts.InsuranceClaim2 = ic2.count;
      purgedTables.push("InsuranceClaim2");
    }

    // ── ChronicCarePlan family (CheckIn + Alert have direct patientId,
    //    treated as cascade children for FK-safe ordering).
    const ccpList = await tx.chronicCarePlan.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (ccpList.length > 0) {
      const ccpIds = ccpList.map((p) => p.id);
      const cci = await tx.chronicCareCheckIn.deleteMany({
        where: { planId: { in: ccpIds } },
      });
      counts.ChronicCareCheckIn = cci.count;
      purgedTables.push("ChronicCareCheckIn");

      const cca = await tx.chronicCareAlert.deleteMany({
        where: { planId: { in: ccpIds } },
      });
      counts.ChronicCareAlert = cca.count;
      purgedTables.push("ChronicCareAlert");

      const ccp = await tx.chronicCarePlan.deleteMany({ where: { patientId } });
      counts.ChronicCarePlan = ccp.count;
      purgedTables.push("ChronicCarePlan");
    } else {
      // Defensive — patientId-direct rows without a plan FK.
      const cciOrphan = await tx.chronicCareCheckIn.deleteMany({ where: { patientId } });
      if (cciOrphan.count > 0) {
        counts.ChronicCareCheckIn = (counts.ChronicCareCheckIn ?? 0) + cciOrphan.count;
        if (!purgedTables.includes("ChronicCareCheckIn")) purgedTables.push("ChronicCareCheckIn");
      }
      const ccaOrphan = await tx.chronicCareAlert.deleteMany({ where: { patientId } });
      if (ccaOrphan.count > 0) {
        counts.ChronicCareAlert = (counts.ChronicCareAlert ?? 0) + ccaOrphan.count;
        if (!purgedTables.includes("ChronicCareAlert")) purgedTables.push("ChronicCareAlert");
      }
    }

    // ── WhatsApp conversation + messages (delete the convo, cascade-purges
    //    WhatsAppMessage rows). Conversation is keyed by phone — if it
    //    linked to this patient, the whole thread is theirs.
    const waList = await tx.whatsAppConversation.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (waList.length > 0) {
      const waIds = waList.map((w) => w.id);
      const wam = await tx.whatsAppMessage.deleteMany({
        where: { conversationId: { in: waIds } },
      });
      counts.WhatsAppMessage = wam.count;
      purgedTables.push("WhatsAppMessage");

      const wac = await tx.whatsAppConversation.deleteMany({ where: { patientId } });
      counts.WhatsAppConversation = wac.count;
      purgedTables.push("WhatsAppConversation");
    }

    // ── PatientFamilyLink (bidirectional: both sides of the family graph).
    const pfl = await tx.patientFamilyLink.deleteMany({
      where: { OR: [{ patientId }, { relatedPatientId: patientId }] },
    });
    counts.PatientFamilyLink = pfl.count;
    purgedTables.push("PatientFamilyLink");

    // ── Direct patient-linked tables (no FK children). Alphabetised for
    //    review-diff stability.
    const abha = await tx.abhaLink.deleteMany({ where: { patientId } });
    counts.AbhaLink = abha.count;
    purgedTables.push("AbhaLink");

    const advdir = await tx.advanceDirective.deleteMany({ where: { patientId } });
    counts.AdvanceDirective = advdir.count;
    purgedTables.push("AdvanceDirective");

    const advpay = await tx.advancePayment.deleteMany({ where: { patientId } });
    counts.AdvancePayment = advpay.count;
    purgedTables.push("AdvancePayment");

    const ais = await tx.aIScribeSession.deleteMany({ where: { patientId } });
    counts.AIScribeSession = ais.count;
    purgedTables.push("AIScribeSession");

    const ait = await tx.aITriageSession.deleteMany({ where: { patientId } });
    counts.AITriageSession = ait.count;
    purgedTables.push("AITriageSession");

    const amb = await tx.ambulanceTrip.deleteMany({ where: { patientId } });
    counts.AmbulanceTrip = amb.count;
    purgedTables.push("AmbulanceTrip");

    const be = await tx.billExplanation.deleteMany({ where: { patientId } });
    counts.BillExplanation = be.count;
    purgedTables.push("BillExplanation");

    const br = await tx.bloodRequest.deleteMany({ where: { patientId } });
    counts.BloodRequest = br.count;
    purgedTables.push("BloodRequest");

    const cs = await tx.campaignSend.deleteMany({ where: { patientId } });
    counts.CampaignSend = cs.count;
    purgedTables.push("CampaignSend");

    const cctx = await tx.careContext.deleteMany({ where: { patientId } });
    counts.CareContext = cctx.count;
    purgedTables.push("CareContext");

    const comp = await tx.complaint.deleteMany({ where: { patientId } });
    counts.Complaint = comp.count;
    purgedTables.push("Complaint");

    const cons = await tx.consentArtefact.deleteMany({ where: { patientId } });
    counts.ConsentArtefact = cons.count;
    purgedTables.push("ConsentArtefact");

    const cv = await tx.coordinatedVisit.deleteMany({ where: { patientId } });
    counts.CoordinatedVisit = cv.count;
    purgedTables.push("CoordinatedVisit");

    // EmergencyCase — only purge rows linked to THIS patient (others may be
    // unknown/Jane Doe cases with patientId = null).
    const ec = await tx.emergencyCase.deleteMany({ where: { patientId } });
    counts.EmergencyCase = ec.count;
    purgedTables.push("EmergencyCase");

    const fh = await tx.familyHistory.deleteMany({ where: { patientId } });
    counts.FamilyHistory = fh.count;
    purgedTables.push("FamilyHistory");

    const fl = await tx.feedingLog.deleteMany({ where: { patientId } });
    counts.FeedingLog = fl.count;
    purgedTables.push("FeedingLog");

    const gr = await tx.growthRecord.deleteMany({ where: { patientId } });
    counts.GrowthRecord = gr.count;
    purgedTables.push("GrowthRecord");

    const imm = await tx.immunization.deleteMany({ where: { patientId } });
    counts.Immunization = imm.count;
    purgedTables.push("Immunization");

    const il = await tx.ingestLog.deleteMany({ where: { patientId } });
    counts.IngestLog = il.count;
    purgedTables.push("IngestLog");

    const ic1 = await tx.insuranceClaim.deleteMany({ where: { patientId } });
    counts.InsuranceClaim = ic1.count;
    purgedTables.push("InsuranceClaim");

    const lre = await tx.labReportExplanation.deleteMany({ where: { patientId } });
    counts.LabReportExplanation = lre.count;
    purgedTables.push("LabReportExplanation");

    const mr = await tx.medReconciliation.deleteMany({ where: { patientId } });
    counts.MedReconciliation = mr.count;
    purgedTables.push("MedReconciliation");

    // MedicationIncident has scribeSessionId (SetNull on AIScribeSession
    // delete). We've already deleted AIScribeSession above; this drops the
    // patient-linked incident rows themselves.
    const mi = await tx.medicationIncident.deleteMany({ where: { patientId } });
    counts.MedicationIncident = mi.count;
    purgedTables.push("MedicationIncident");

    const mil = await tx.milestoneRecord.deleteMany({ where: { patientId } });
    counts.MilestoneRecord = mil.count;
    purgedTables.push("MilestoneRecord");

    const pkg = await tx.packagePurchase.deleteMany({ where: { patientId } });
    counts.PackagePurchase = pkg.count;
    purgedTables.push("PackagePurchase");

    const pde = await tx.patientDataExport.deleteMany({ where: { patientId } });
    counts.PatientDataExport = pde.count;
    purgedTables.push("PatientDataExport");

    // PatientFeedback — FeedbackSentiment is cascade-fed, but we count it.
    const pfList = await tx.patientFeedback.findMany({
      where: { patientId },
      select: { id: true },
    });
    if (pfList.length > 0) {
      const pfIds = pfList.map((p) => p.id);
      const fs = await tx.feedbackSentiment.deleteMany({
        where: { feedbackId: { in: pfIds } },
      });
      counts.FeedbackSentiment = fs.count;
      purgedTables.push("FeedbackSentiment");
    }
    const pf = await tx.patientFeedback.deleteMany({ where: { patientId } });
    counts.PatientFeedback = pf.count;
    purgedTables.push("PatientFeedback");

    const par = await tx.preAuthRequest.deleteMany({ where: { patientId } });
    counts.PreAuthRequest = par.count;
    purgedTables.push("PreAuthRequest");

    const pvc = await tx.previsitChecklist.deleteMany({ where: { patientId } });
    counts.PrevisitChecklist = pvc.count;
    purgedTables.push("PrevisitChecklist");

    const ref = await tx.referral.deleteMany({ where: { patientId } });
    counts.Referral = ref.count;
    purgedTables.push("Referral");

    const sde = await tx.symptomDiaryEntry.deleteMany({ where: { patientId } });
    counts.SymptomDiaryEntry = sde.count;
    purgedTables.push("SymptomDiaryEntry");

    const tel = await tx.telemedicineSession.deleteMany({ where: { patientId } });
    counts.TelemedicineSession = tel.count;
    purgedTables.push("TelemedicineSession");

    const vis = await tx.visitor.deleteMany({ where: { patientId } });
    counts.Visitor = vis.count;
    purgedTables.push("Visitor");

    const wl = await tx.waitlistEntry.deleteMany({ where: { patientId } });
    counts.WaitlistEntry = wl.count;
    purgedTables.push("WaitlistEntry");

    // ── ControlledSubstanceEntry: Drugs and Cosmetics Rules 1945 §65
    //    regulator-mandated ledger. We NULL the patientId link (sever
    //    PHI association) rather than delete the row — same legal
    //    treatment as AuditLog.
    const csNulled = await tx.controlledSubstanceEntry.updateMany({
      where: { patientId },
      data: { patientId: null },
    });
    counts.ControlledSubstanceEntryNulled = csNulled.count;

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
    retainedTables: [
      "AuditLog",
      "DPDPErasureRequest",
      "ControlledSubstanceEntry (patientId nulled — D&C Rules §65 retention)",
    ],
    notes: `DPDP Act 2023 §17 right-to-erasure. AuditLog + DPDPErasureRequest + ControlledSubstanceEntry (patientId nulled) retained per regulatory requirement. Coverage: ${purgedTables.length} patient-linked tables purged in this run (full Pearl Stage-1 surface as of 2026-05-25 — audit over-claim #1 closure). Static catalogue covers 50+ patient-linked tables including Appointment-tree, Prescription-tree, Invoice-tree, Admission-tree, LabOrder-tree, Surgery-tree (incl. Implant), RadiologyStudy-tree, AntenatalCase-tree (incl. AncVisit/UltrasoundRecord/Partograph/PostnatalVisit), PaymentPlan-tree, AdherenceSchedule-tree, InsuranceClaim2-tree (incl. ClaimDocument/ClaimStatusEvent), ChronicCarePlan-tree (incl. CheckIn/Alert), WhatsAppConversation-tree, PatientFeedback-tree (incl. FeedbackSentiment), and direct-patientId terminals (AbhaLink, AdvanceDirective, AdvancePayment, AIScribeSession, AITriageSession, AmbulanceTrip, BillExplanation, BloodRequest, CampaignSend, CareContext, Complaint, ConsentArtefact, CoordinatedVisit, EmergencyCase, FamilyHistory, FeedingLog, GrowthRecord, Immunization, IngestLog, InsuranceClaim, LabReportExplanation, MedReconciliation, MedicationIncident, MilestoneRecord, PackagePurchase, PatientDataExport, PatientFamilyLink, PatientFeedback, PreAuthRequest, PrevisitChecklist, Referral, SymptomDiaryEntry, TelemedicineSession, Visitor, WaitlistEntry).`,
    executedAt: new Date().toISOString(),
  };
}
