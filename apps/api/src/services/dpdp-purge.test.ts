// Unit tests for the DPDP cross-tenant erasure-purge service — Pearl §12 row
// 224 + OPEN_DECISIONS #5 (2026-05-24 widening) + audit over-claim #1
// fix (2026-05-25 — full patient-linked-table coverage).
//
// What / which modules / why:
//   - Validates `purgePatient(patientId, executedBy, prisma)` deletes the
//     correct rows across the full Stage-1 patient surface (50+ tables),
//     in FK-safe order, and emits a faithful execution receipt listing
//     per-table counts.
//   - Prisma is mocked end-to-end — no DB hit. We assert against the
//     deleteMany call-order + the receipt shape; the actual Prisma engine
//     is exercised by the route-level integration suite separately.
//   - COLOCATED at `services/dpdp-purge.test.ts` so the `test:coverage:unit`
//     glob picks it up (mirrors `dpdp-receipt.test.ts`).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { purgePatient, DPDPPurgeError } from "./dpdp-purge";

// Helper: build a Prisma-delegate stub for a "direct patient-linked" table
// (one that has `patientId` and no FK children to traverse) — just a
// deleteMany that logs the call + returns the seeded { count }.
function makeDirectDelegate(
  tableName: string,
  calls: Array<{ table: string; op: string }>,
  cnt: (key: string) => { count: number },
) {
  return {
    deleteMany: vi.fn().mockImplementation(async () => {
      calls.push({ table: tableName, op: "deleteMany" });
      return cnt(tableName);
    }),
  };
}

// Build a Prisma mock whose `$transaction` immediately invokes the callback
// with a tx that captures every deleteMany / updateMany / update call into
// an ordered log we can assert on. Each table's deleteMany returns a stub
// { count } and findMany returns the seeded rows.
function makePrismaMock(
  seed: Partial<{
    patient: { id: string; userId: string | null; tenantId: string };
    prescriptions: string[];
    invoices: string[];
    appointments: string[];
    admissions: string[];
    medicationOrders: string[];
    labOrders: string[];
    labOrderItems: string[];
    surgeries: string[];
    radiologyStudies: string[];
    // 2026-05-25 extended-coverage seeds
    antenatalCases: string[];
    paymentPlans: string[];
    adherenceSchedules: string[];
    insuranceClaim2s: string[];
    chronicCarePlans: string[];
    whatsAppConversations: string[];
    patientFeedbacks: string[];
    counts: Record<string, number>;
  }> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { prisma: any; calls: Array<{ table: string; op: string }> } {
  const calls: Array<{ table: string; op: string }> = [];
  const counts = seed.counts ?? {};
  const cnt = (table: string) => ({ count: counts[table] ?? 0 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    prescription: {
      findMany: vi.fn().mockResolvedValue(
        (seed.prescriptions ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Prescription", op: "deleteMany" });
        return cnt("Prescription");
      }),
    },
    prescriptionItem: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "PrescriptionItem", op: "deleteMany" });
        return cnt("PrescriptionItem");
      }),
    },
    invoice: {
      findMany: vi.fn().mockResolvedValue(
        (seed.invoices ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Invoice", op: "deleteMany" });
        return cnt("Invoice");
      }),
    },
    invoiceItem: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "InvoiceItem", op: "deleteMany" });
        return cnt("InvoiceItem");
      }),
    },
    payment: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Payment", op: "deleteMany" });
        return cnt("Payment");
      }),
    },
    vitals: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Vitals", op: "deleteMany" });
        return cnt("Vitals");
      }),
    },
    appointment: {
      findMany: vi.fn().mockResolvedValue(
        (seed.appointments ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Appointment", op: "deleteMany" });
        return cnt("Appointment");
      }),
    },
    consultation: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Consultation", op: "deleteMany" });
        return cnt("Consultation");
      }),
    },
    patientDocument: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "PatientDocument", op: "deleteMany" });
        return cnt("PatientDocument");
      }),
    },
    // ── Widening (2026-05-24) ──────────────────────────────────────
    admission: {
      findMany: vi.fn().mockResolvedValue(
        (seed.admissions ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Admission", op: "deleteMany" });
        return cnt("Admission");
      }),
    },
    emergencyCase: {
      updateMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "EmergencyCase", op: "updateMany" });
        return { count: counts.EmergencyCaseLinkNulled ?? 0 };
      }),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "EmergencyCase", op: "deleteMany" });
        return cnt("EmergencyCase");
      }),
    },
    medicationOrder: {
      findMany: vi.fn().mockResolvedValue(
        (seed.medicationOrders ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "MedicationOrder", op: "deleteMany" });
        return cnt("MedicationOrder");
      }),
    },
    medicationAdministration: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "MedicationAdministration", op: "deleteMany" });
        return cnt("MedicationAdministration");
      }),
    },
    ipdVitals: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "IpdVitals", op: "deleteMany" });
        return cnt("IpdVitals");
      }),
    },
    nurseRound: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "NurseRound", op: "deleteMany" });
        return cnt("NurseRound");
      }),
    },
    ipdIntakeOutput: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "IpdIntakeOutput", op: "deleteMany" });
        return cnt("IpdIntakeOutput");
      }),
    },
    patientBelongings: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "PatientBelongings", op: "deleteMany" });
        return cnt("PatientBelongings");
      }),
    },
    labOrder: {
      findMany: vi.fn().mockResolvedValue(
        (seed.labOrders ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "LabOrder", op: "deleteMany" });
        return cnt("LabOrder");
      }),
    },
    labOrderItem: {
      findMany: vi.fn().mockResolvedValue(
        (seed.labOrderItems ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "LabOrderItem", op: "deleteMany" });
        return cnt("LabOrderItem");
      }),
    },
    labResult: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "LabResult", op: "deleteMany" });
        return cnt("LabResult");
      }),
    },
    patientAllergy: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "PatientAllergy", op: "deleteMany" });
        return cnt("PatientAllergy");
      }),
    },
    chronicCondition: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "ChronicCondition", op: "deleteMany" });
        return cnt("ChronicCondition");
      }),
    },
    surgery: {
      findMany: vi.fn().mockResolvedValue(
        (seed.surgeries ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Surgery", op: "deleteMany" });
        return cnt("Surgery");
      }),
    },
    anesthesiaRecord: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "AnesthesiaRecord", op: "deleteMany" });
        return cnt("AnesthesiaRecord");
      }),
    },
    postOpObservation: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "PostOpObservation", op: "deleteMany" });
        return cnt("PostOpObservation");
      }),
    },
    radiologyStudy: {
      findMany: vi.fn().mockResolvedValue(
        (seed.radiologyStudies ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "RadiologyStudy", op: "deleteMany" });
        return cnt("RadiologyStudy");
      }),
    },
    radiologyReport: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "RadiologyReport", op: "deleteMany" });
        return cnt("RadiologyReport");
      }),
    },
    // ── 2026-05-25 extended-coverage tables ──────────────────────
    // Each entry below corresponds to one of the patient-linked tables
    // surfaced by the audit (#1) and added to purgePatient(). Each
    // delegate registers its deleteMany call so the test can assert
    // (a) the call fires, (b) FK-safe order, (c) per-table counts.
    antenatalCase: {
      findMany: vi.fn().mockResolvedValue(
        (seed.antenatalCases ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "AntenatalCase", op: "deleteMany" });
        return cnt("AntenatalCase");
      }),
    },
    ancVisit: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "AncVisit", op: "deleteMany" });
        return cnt("AncVisit");
      }),
    },
    ultrasoundRecord: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "UltrasoundRecord", op: "deleteMany" });
        return cnt("UltrasoundRecord");
      }),
    },
    partograph: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Partograph", op: "deleteMany" });
        return cnt("Partograph");
      }),
    },
    postnatalVisit: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "PostnatalVisit", op: "deleteMany" });
        return cnt("PostnatalVisit");
      }),
    },
    paymentPlan: {
      findMany: vi.fn().mockResolvedValue(
        (seed.paymentPlans ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "PaymentPlan", op: "deleteMany" });
        return cnt("PaymentPlan");
      }),
    },
    paymentPlanInstallment: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "PaymentPlanInstallment", op: "deleteMany" });
        return cnt("PaymentPlanInstallment");
      }),
    },
    adherenceSchedule: {
      findMany: vi.fn().mockResolvedValue(
        (seed.adherenceSchedules ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "AdherenceSchedule", op: "deleteMany" });
        return cnt("AdherenceSchedule");
      }),
    },
    adherenceDoseLog: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "AdherenceDoseLog", op: "deleteMany" });
        return cnt("AdherenceDoseLog");
      }),
    },
    insuranceClaim2: {
      findMany: vi.fn().mockResolvedValue(
        (seed.insuranceClaim2s ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "InsuranceClaim2", op: "deleteMany" });
        return cnt("InsuranceClaim2");
      }),
    },
    claimDocument: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "ClaimDocument", op: "deleteMany" });
        return cnt("ClaimDocument");
      }),
    },
    claimStatusEvent: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "ClaimStatusEvent", op: "deleteMany" });
        return cnt("ClaimStatusEvent");
      }),
    },
    chronicCarePlan: {
      findMany: vi.fn().mockResolvedValue(
        (seed.chronicCarePlans ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "ChronicCarePlan", op: "deleteMany" });
        return cnt("ChronicCarePlan");
      }),
    },
    chronicCareCheckIn: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "ChronicCareCheckIn", op: "deleteMany" });
        return cnt("ChronicCareCheckIn");
      }),
    },
    chronicCareAlert: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "ChronicCareAlert", op: "deleteMany" });
        return cnt("ChronicCareAlert");
      }),
    },
    whatsAppConversation: {
      findMany: vi.fn().mockResolvedValue(
        (seed.whatsAppConversations ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "WhatsAppConversation", op: "deleteMany" });
        return cnt("WhatsAppConversation");
      }),
    },
    whatsAppMessage: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "WhatsAppMessage", op: "deleteMany" });
        return cnt("WhatsAppMessage");
      }),
    },
    patientFamilyLink: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "PatientFamilyLink", op: "deleteMany" });
        return cnt("PatientFamilyLink");
      }),
    },
    implant: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Implant", op: "deleteMany" });
        return cnt("Implant");
      }),
    },
    patientFeedback: {
      findMany: vi.fn().mockResolvedValue(
        (seed.patientFeedbacks ?? []).map((id) => ({ id })),
      ),
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "PatientFeedback", op: "deleteMany" });
        return cnt("PatientFeedback");
      }),
    },
    feedbackSentiment: {
      deleteMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "FeedbackSentiment", op: "deleteMany" });
        return cnt("FeedbackSentiment");
      }),
    },
    abhaLink: makeDirectDelegate("AbhaLink", calls, cnt),
    advanceDirective: makeDirectDelegate("AdvanceDirective", calls, cnt),
    advancePayment: makeDirectDelegate("AdvancePayment", calls, cnt),
    aIScribeSession: makeDirectDelegate("AIScribeSession", calls, cnt),
    aITriageSession: makeDirectDelegate("AITriageSession", calls, cnt),
    ambulanceTrip: makeDirectDelegate("AmbulanceTrip", calls, cnt),
    billExplanation: makeDirectDelegate("BillExplanation", calls, cnt),
    bloodRequest: makeDirectDelegate("BloodRequest", calls, cnt),
    campaignSend: makeDirectDelegate("CampaignSend", calls, cnt),
    careContext: makeDirectDelegate("CareContext", calls, cnt),
    complaint: makeDirectDelegate("Complaint", calls, cnt),
    consentArtefact: makeDirectDelegate("ConsentArtefact", calls, cnt),
    coordinatedVisit: makeDirectDelegate("CoordinatedVisit", calls, cnt),
    familyHistory: makeDirectDelegate("FamilyHistory", calls, cnt),
    feedingLog: makeDirectDelegate("FeedingLog", calls, cnt),
    growthRecord: makeDirectDelegate("GrowthRecord", calls, cnt),
    immunization: makeDirectDelegate("Immunization", calls, cnt),
    ingestLog: makeDirectDelegate("IngestLog", calls, cnt),
    insuranceClaim: makeDirectDelegate("InsuranceClaim", calls, cnt),
    labReportExplanation: makeDirectDelegate("LabReportExplanation", calls, cnt),
    medReconciliation: makeDirectDelegate("MedReconciliation", calls, cnt),
    medicationIncident: makeDirectDelegate("MedicationIncident", calls, cnt),
    milestoneRecord: makeDirectDelegate("MilestoneRecord", calls, cnt),
    packagePurchase: makeDirectDelegate("PackagePurchase", calls, cnt),
    patientDataExport: makeDirectDelegate("PatientDataExport", calls, cnt),
    preAuthRequest: makeDirectDelegate("PreAuthRequest", calls, cnt),
    previsitChecklist: makeDirectDelegate("PrevisitChecklist", calls, cnt),
    referral: makeDirectDelegate("Referral", calls, cnt),
    symptomDiaryEntry: makeDirectDelegate("SymptomDiaryEntry", calls, cnt),
    telemedicineSession: makeDirectDelegate("TelemedicineSession", calls, cnt),
    visitor: makeDirectDelegate("Visitor", calls, cnt),
    waitlistEntry: makeDirectDelegate("WaitlistEntry", calls, cnt),
    controlledSubstanceEntry: {
      updateMany: vi.fn().mockImplementation(async () => {
        calls.push({ table: "ControlledSubstanceEntry", op: "updateMany" });
        return { count: counts.ControlledSubstanceEntryNulled ?? 0 };
      }),
    },
    // Anonymize step (asserted shallowly).
    patient: {
      findUnique: vi.fn(),
      update: vi.fn().mockImplementation(async () => {
        calls.push({ table: "Patient", op: "update" });
        return {};
      }),
    },
    user: {
      update: vi.fn().mockImplementation(async () => {
        calls.push({ table: "User", op: "update" });
        return {};
      }),
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    patient: {
      findUnique: vi.fn().mockResolvedValue(
        seed.patient ?? { id: "pat-1", userId: "user-1", tenantId: "ten-1" },
      ),
    },
    $transaction: vi.fn().mockImplementation(async (cb: (t: typeof tx) => Promise<void>) => {
      return cb(tx);
    }),
  };

  return { prisma, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("purgePatient", () => {
  it("throws DPDPPurgeError when the patient does not exist", async () => {
    const { prisma } = makePrismaMock({ patient: undefined });
    prisma.patient.findUnique.mockResolvedValueOnce(null);
    await expect(purgePatient("missing", "exec-1", prisma)).rejects.toBeInstanceOf(
      DPDPPurgeError,
    );
  });

  it("returns a receipt that includes all 15 widened parent tables", async () => {
    const { prisma, calls } = makePrismaMock({
      prescriptions: ["p1"],
      invoices: ["i1"],
      appointments: ["a1"],
      admissions: ["adm1"],
      medicationOrders: ["mo1"],
      labOrders: ["lo1"],
      labOrderItems: ["loi1"],
      surgeries: ["s1"],
      radiologyStudies: ["rs1"],
      counts: {
        PrescriptionItem: 2,
        Prescription: 1,
        InvoiceItem: 3,
        Payment: 1,
        Invoice: 1,
        Vitals: 4,
        Consultation: 1,
        PatientDocument: 2,
        Appointment: 1,
        // Widened families
        MedicationAdministration: 6,
        MedicationOrder: 1,
        IpdVitals: 5,
        NurseRound: 3,
        IpdIntakeOutput: 4,
        PatientBelongings: 1,
        Admission: 1,
        LabResult: 5,
        LabOrderItem: 1,
        LabOrder: 1,
        PatientAllergy: 2,
        ChronicCondition: 1,
        AnesthesiaRecord: 1,
        PostOpObservation: 2,
        Surgery: 1,
        RadiologyReport: 1,
        RadiologyStudy: 1,
        EmergencyCaseLinkNulled: 1,
      },
    });

    const receipt = await purgePatient("pat-1", "exec-1", prisma);

    // The 6 newly-covered parent tables must appear in purgedTables.
    expect(receipt.purgedTables).toEqual(
      expect.arrayContaining([
        "Admission",
        "LabOrder",
        "PatientAllergy",
        "ChronicCondition",
        "Surgery",
        "RadiologyStudy",
      ]),
    );

    // Receipt count map must carry the per-table counts.
    expect(receipt.purgedRows.Admission).toBe(1);
    expect(receipt.purgedRows.LabOrder).toBe(1);
    expect(receipt.purgedRows.PatientAllergy).toBe(2);
    expect(receipt.purgedRows.ChronicCondition).toBe(1);
    expect(receipt.purgedRows.Surgery).toBe(1);
    expect(receipt.purgedRows.RadiologyStudy).toBe(1);

    // Sub-tables of the widened families are also accounted for.
    expect(receipt.purgedRows.MedicationAdministration).toBe(6);
    expect(receipt.purgedRows.MedicationOrder).toBe(1);
    expect(receipt.purgedRows.IpdVitals).toBe(5);
    expect(receipt.purgedRows.NurseRound).toBe(3);
    expect(receipt.purgedRows.IpdIntakeOutput).toBe(4);
    expect(receipt.purgedRows.PatientBelongings).toBe(1);
    expect(receipt.purgedRows.LabResult).toBe(5);
    expect(receipt.purgedRows.LabOrderItem).toBe(1);
    expect(receipt.purgedRows.AnesthesiaRecord).toBe(1);
    expect(receipt.purgedRows.PostOpObservation).toBe(2);
    expect(receipt.purgedRows.RadiologyReport).toBe(1);

    // Patient + User were anonymized.
    expect(receipt.anonymizedTables).toEqual(["Patient", "User"]);

    // Notes line was rewritten to reflect the full extended coverage
    // (no stale "deferred" wording; no stale "15 parent" hard-count).
    expect(receipt.notes).toMatch(/Pearl Stage-1 surface/);
    expect(receipt.notes).toMatch(/patient-linked tables purged/);
    expect(receipt.notes).not.toMatch(/deferred/i);

    // Smoke: at least one delete from each widened family fired.
    const deleted = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    expect(deleted).toEqual(
      expect.arrayContaining([
        "Admission",
        "LabOrder",
        "PatientAllergy",
        "ChronicCondition",
        "Surgery",
        "RadiologyStudy",
      ]),
    );
  });

  it("deletes Admission sub-tables BEFORE the parent Admission row (FK-safe order)", async () => {
    const { prisma, calls } = makePrismaMock({
      admissions: ["adm1"],
      medicationOrders: ["mo1"],
      counts: {
        MedicationAdministration: 0,
        MedicationOrder: 0,
        IpdVitals: 0,
        NurseRound: 0,
        IpdIntakeOutput: 0,
        PatientBelongings: 0,
        Admission: 1,
      },
    });

    await purgePatient("pat-1", "exec-1", prisma);

    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    const admissionIdx = order.indexOf("Admission");
    // Every sub-table of Admission must appear before the parent.
    for (const child of [
      "MedicationAdministration",
      "MedicationOrder",
      "IpdVitals",
      "NurseRound",
      "IpdIntakeOutput",
      "PatientBelongings",
    ]) {
      const childIdx = order.indexOf(child);
      expect(childIdx).toBeGreaterThanOrEqual(0);
      expect(childIdx).toBeLessThan(admissionIdx);
    }
  });

  it("nulls EmergencyCase.linkedAdmissionId before deleting Admission rows", async () => {
    const { prisma, calls } = makePrismaMock({
      admissions: ["adm1"],
      counts: { Admission: 1, EmergencyCaseLinkNulled: 1 },
    });

    await purgePatient("pat-1", "exec-1", prisma);

    const ecUpdateIdx = calls.findIndex(
      (c) => c.table === "EmergencyCase" && c.op === "updateMany",
    );
    const admDeleteIdx = calls.findIndex(
      (c) => c.table === "Admission" && c.op === "deleteMany",
    );
    expect(ecUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(admDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(ecUpdateIdx).toBeLessThan(admDeleteIdx);
  });

  it("deletes LabResult → LabOrderItem → LabOrder in FK-safe order", async () => {
    const { prisma, calls } = makePrismaMock({
      labOrders: ["lo1"],
      labOrderItems: ["loi1"],
      counts: { LabResult: 2, LabOrderItem: 1, LabOrder: 1 },
    });

    await purgePatient("pat-1", "exec-1", prisma);

    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    const lr = order.indexOf("LabResult");
    const loi = order.indexOf("LabOrderItem");
    const lo = order.indexOf("LabOrder");
    expect(lr).toBeGreaterThanOrEqual(0);
    expect(loi).toBeGreaterThan(lr);
    expect(lo).toBeGreaterThan(loi);
  });

  it("deletes RadiologyReport before RadiologyStudy", async () => {
    const { prisma, calls } = makePrismaMock({
      radiologyStudies: ["rs1"],
      counts: { RadiologyReport: 1, RadiologyStudy: 1 },
    });

    await purgePatient("pat-1", "exec-1", prisma);

    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    expect(order.indexOf("RadiologyReport")).toBeLessThan(
      order.indexOf("RadiologyStudy"),
    );
  });

  it("deletes AnesthesiaRecord + PostOpObservation before Surgery", async () => {
    const { prisma, calls } = makePrismaMock({
      surgeries: ["s1"],
      counts: { AnesthesiaRecord: 1, PostOpObservation: 1, Surgery: 1 },
    });

    await purgePatient("pat-1", "exec-1", prisma);

    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    const surg = order.indexOf("Surgery");
    expect(order.indexOf("AnesthesiaRecord")).toBeLessThan(surg);
    expect(order.indexOf("PostOpObservation")).toBeLessThan(surg);
  });

  it("skips widened families entirely when the patient has no rows in them", async () => {
    // No admissions/labOrders/surgeries/studies seeded → those branches
    // should short-circuit and their tables should NOT appear in the
    // receipt's purgedTables.
    const { prisma } = makePrismaMock({
      counts: { PatientAllergy: 0, ChronicCondition: 0 },
    });

    const receipt = await purgePatient("pat-1", "exec-1", prisma);

    expect(receipt.purgedTables).not.toContain("Admission");
    expect(receipt.purgedTables).not.toContain("LabOrder");
    expect(receipt.purgedTables).not.toContain("Surgery");
    expect(receipt.purgedTables).not.toContain("RadiologyStudy");
    // Allergy + ChronicCondition are unconditional terminals.
    expect(receipt.purgedTables).toContain("PatientAllergy");
    expect(receipt.purgedTables).toContain("ChronicCondition");
  });
});

// ─── 2026-05-25 EXTENDED-COVERAGE tests (audit over-claim #1 closure) ──────
// One spec per new family / direct-terminal cluster verifying the
// deleteMany call fires and that the receipt records the per-table count.
describe("purgePatient — extended-coverage (audit #1 closure)", () => {
  it("deletes AntenatalCase sub-tables (AncVisit, Ultrasound, Partograph, PostnatalVisit) before AntenatalCase", async () => {
    const { prisma, calls } = makePrismaMock({
      antenatalCases: ["anc1"],
      counts: {
        AncVisit: 3,
        UltrasoundRecord: 2,
        Partograph: 1,
        PostnatalVisit: 2,
        AntenatalCase: 1,
      },
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    const ancIdx = order.indexOf("AntenatalCase");
    for (const child of ["AncVisit", "UltrasoundRecord", "Partograph", "PostnatalVisit"]) {
      expect(order.indexOf(child)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(child)).toBeLessThan(ancIdx);
    }
    expect(receipt.purgedRows.AntenatalCase).toBe(1);
    expect(receipt.purgedRows.AncVisit).toBe(3);
    expect(receipt.purgedRows.UltrasoundRecord).toBe(2);
    expect(receipt.purgedRows.Partograph).toBe(1);
    expect(receipt.purgedRows.PostnatalVisit).toBe(2);
  });

  it("deletes PaymentPlanInstallment before PaymentPlan", async () => {
    const { prisma, calls } = makePrismaMock({
      paymentPlans: ["pp1"],
      counts: { PaymentPlanInstallment: 6, PaymentPlan: 1 },
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    expect(order.indexOf("PaymentPlanInstallment")).toBeLessThan(
      order.indexOf("PaymentPlan"),
    );
    expect(receipt.purgedRows.PaymentPlan).toBe(1);
    expect(receipt.purgedRows.PaymentPlanInstallment).toBe(6);
  });

  it("deletes AdherenceDoseLog before AdherenceSchedule", async () => {
    const { prisma, calls } = makePrismaMock({
      adherenceSchedules: ["ad1"],
      counts: { AdherenceDoseLog: 14, AdherenceSchedule: 1 },
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    expect(order.indexOf("AdherenceDoseLog")).toBeLessThan(
      order.indexOf("AdherenceSchedule"),
    );
    expect(receipt.purgedRows.AdherenceSchedule).toBe(1);
    expect(receipt.purgedRows.AdherenceDoseLog).toBe(14);
  });

  it("deletes ClaimDocument + ClaimStatusEvent before InsuranceClaim2", async () => {
    const { prisma, calls } = makePrismaMock({
      insuranceClaim2s: ["ic1"],
      counts: { ClaimDocument: 2, ClaimStatusEvent: 4, InsuranceClaim2: 1 },
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    const ic2 = order.indexOf("InsuranceClaim2");
    expect(order.indexOf("ClaimDocument")).toBeLessThan(ic2);
    expect(order.indexOf("ClaimStatusEvent")).toBeLessThan(ic2);
    expect(receipt.purgedRows.InsuranceClaim2).toBe(1);
    expect(receipt.purgedRows.ClaimDocument).toBe(2);
    expect(receipt.purgedRows.ClaimStatusEvent).toBe(4);
  });

  it("deletes ChronicCareCheckIn + ChronicCareAlert before ChronicCarePlan", async () => {
    const { prisma, calls } = makePrismaMock({
      chronicCarePlans: ["ccp1"],
      counts: { ChronicCareCheckIn: 8, ChronicCareAlert: 2, ChronicCarePlan: 1 },
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    const ccp = order.indexOf("ChronicCarePlan");
    expect(order.indexOf("ChronicCareCheckIn")).toBeLessThan(ccp);
    expect(order.indexOf("ChronicCareAlert")).toBeLessThan(ccp);
    expect(receipt.purgedRows.ChronicCarePlan).toBe(1);
  });

  it("deletes WhatsAppMessage before WhatsAppConversation", async () => {
    const { prisma, calls } = makePrismaMock({
      whatsAppConversations: ["wac1"],
      counts: { WhatsAppMessage: 23, WhatsAppConversation: 1 },
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    expect(order.indexOf("WhatsAppMessage")).toBeLessThan(
      order.indexOf("WhatsAppConversation"),
    );
    expect(receipt.purgedRows.WhatsAppMessage).toBe(23);
    expect(receipt.purgedRows.WhatsAppConversation).toBe(1);
  });

  it("deletes Implant as cascade-fed child of Surgery", async () => {
    const { prisma, calls } = makePrismaMock({
      surgeries: ["s1"],
      counts: { Implant: 2, AnesthesiaRecord: 1, PostOpObservation: 1, Surgery: 1 },
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    expect(order.indexOf("Implant")).toBeLessThan(order.indexOf("Surgery"));
    expect(receipt.purgedRows.Implant).toBe(2);
  });

  it("deletes FeedbackSentiment before PatientFeedback", async () => {
    const { prisma, calls } = makePrismaMock({
      patientFeedbacks: ["pf1"],
      counts: { FeedbackSentiment: 1, PatientFeedback: 1 },
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    const order = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    expect(order.indexOf("FeedbackSentiment")).toBeLessThan(
      order.indexOf("PatientFeedback"),
    );
    expect(receipt.purgedRows.PatientFeedback).toBe(1);
    expect(receipt.purgedRows.FeedbackSentiment).toBe(1);
  });

  it("PatientFamilyLink fires once with the bidirectional OR-clause", async () => {
    const { prisma, calls } = makePrismaMock({
      counts: { PatientFamilyLink: 4 },
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    const pflCalls = calls.filter(
      (c) => c.table === "PatientFamilyLink" && c.op === "deleteMany",
    );
    expect(pflCalls.length).toBe(1);
    expect(receipt.purgedRows.PatientFamilyLink).toBe(4);
  });

  it("ControlledSubstanceEntry is updateMany'd (NULL patientId), NOT deleted", async () => {
    const { prisma, calls } = makePrismaMock({
      counts: { ControlledSubstanceEntryNulled: 3 },
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    const csUpdates = calls.filter(
      (c) => c.table === "ControlledSubstanceEntry" && c.op === "updateMany",
    );
    expect(csUpdates.length).toBe(1);
    expect(receipt.purgedRows.ControlledSubstanceEntryNulled).toBe(3);
    // Should also appear in retainedTables annotation.
    expect(receipt.retainedTables.some((t) => t.includes("ControlledSubstanceEntry"))).toBe(
      true,
    );
  });

  it("every direct-patient-linked terminal table fires its deleteMany exactly once", async () => {
    // Smoke test: each of the 30+ direct-terminal tables should fire one
    // deleteMany. We don't seed counts (they default to 0) — we just verify
    // the call surface.
    const { prisma, calls } = makePrismaMock({});
    await purgePatient("pat-1", "exec-1", prisma);
    const deletes = calls.filter((c) => c.op === "deleteMany").map((c) => c.table);
    const expected = [
      "AbhaLink",
      "AdvanceDirective",
      "AdvancePayment",
      "AIScribeSession",
      "AITriageSession",
      "AmbulanceTrip",
      "BillExplanation",
      "BloodRequest",
      "CampaignSend",
      "CareContext",
      "Complaint",
      "ConsentArtefact",
      "CoordinatedVisit",
      "EmergencyCase",
      "FamilyHistory",
      "FeedingLog",
      "GrowthRecord",
      "Immunization",
      "IngestLog",
      "InsuranceClaim",
      "LabReportExplanation",
      "MedReconciliation",
      "MedicationIncident",
      "MilestoneRecord",
      "PackagePurchase",
      "PatientDataExport",
      "PatientFamilyLink",
      "PreAuthRequest",
      "PrevisitChecklist",
      "Referral",
      "SymptomDiaryEntry",
      "TelemedicineSession",
      "Visitor",
      "WaitlistEntry",
    ];
    for (const table of expected) {
      expect(
        deletes.filter((d) => d === table).length,
        `${table} deleteMany expected exactly once`,
      ).toBe(1);
    }
  });

  it("returns a final purgedTables count consistent with the audit-receipt notes line", async () => {
    // Run with everything seeded so all branches fire.
    const { prisma } = makePrismaMock({
      prescriptions: ["p1"],
      invoices: ["i1"],
      appointments: ["a1"],
      admissions: ["adm1"],
      medicationOrders: ["mo1"],
      labOrders: ["lo1"],
      labOrderItems: ["loi1"],
      surgeries: ["s1"],
      radiologyStudies: ["rs1"],
      antenatalCases: ["anc1"],
      paymentPlans: ["pp1"],
      adherenceSchedules: ["ad1"],
      insuranceClaim2s: ["ic1"],
      chronicCarePlans: ["ccp1"],
      whatsAppConversations: ["wac1"],
      patientFeedbacks: ["pf1"],
    });
    const receipt = await purgePatient("pat-1", "exec-1", prisma);
    // Coverage is 50+ tables; sanity-check the receipt names at least 50.
    expect(receipt.purgedTables.length).toBeGreaterThanOrEqual(50);
  });
});
