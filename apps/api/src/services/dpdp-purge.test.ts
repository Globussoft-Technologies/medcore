// Unit tests for the DPDP cross-tenant erasure-purge service — Pearl §12 row
// 224 + OPEN_DECISIONS #5 (2026-05-24 widening).
//
// What / which modules / why:
//   - Validates `purgePatient(patientId, executedBy, prisma)` deletes the
//     correct rows across the full Stage-1 patient surface (15 parent
//     tables), in the right order, and emits a faithful execution receipt
//     listing per-table counts.
//   - Prisma is mocked end-to-end — no DB hit. We assert against the
//     deleteMany call-order + the receipt shape; the actual Prisma engine
//     is exercised by the route-level integration suite separately.
//   - COLOCATED at `services/dpdp-purge.test.ts` so the `test:coverage:unit`
//     glob picks it up (mirrors `dpdp-receipt.test.ts`).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { purgePatient, DPDPPurgeError } from "./dpdp-purge";

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

    // Notes line was rewritten to reflect 15-table coverage (no stale
    // "deferred" wording).
    expect(receipt.notes).toMatch(/15 parent patient-linked tables/);
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
