import { describe, it, expect, vi, beforeEach } from "vitest";

// ── prisma mock (hoisted) ──────────────────────────────
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    systemConfig: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    prescription: { findUnique: vi.fn() },
    admission: { findUnique: vi.fn() },
    labOrder: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    staffShift: { findMany: vi.fn(async () => []) },
    patient: { findUnique: vi.fn() },
    vitals: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    labResult: { findMany: vi.fn(async () => []) },
    antenatalCase: { findUnique: vi.fn() },
    leaveRequest: { findUnique: vi.fn() },
  } as any,
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import {
  generatePrescriptionPDF,
  generateDischargeSummaryHTML,
  generateLabReportHTML,
  generateInvoicePDF,
  generatePaySlipHTML,
  generatePatientIdCardHTML,
  generateVitalsHistoryHTML,
  generateFitnessCertificateHTML,
  generateDeathCertificateHTML,
  generateBirthCertificateHTML,
  generateLeaveLetterHTML,
} from "./pdf";

beforeEach(() => {
  for (const group of Object.values(prismaMock)) {
    for (const fn of Object.values(group as any)) {
      (fn as any).mockReset?.();
    }
  }
  prismaMock.systemConfig.findUnique.mockResolvedValue(null);
  prismaMock.systemConfig.findMany.mockResolvedValue([
    { key: "hospital_name", value: "MedCore Hospital" },
    { key: "hospital_address", value: "1 Main St" },
    { key: "hospital_phone", value: "+911111111111" },
    { key: "hospital_email", value: "hr@medcore" },
    { key: "hospital_gstin", value: "07AAAAA0000A1Z5" },
    { key: "hospital_registration", value: "REG-100" },
  ]);
  prismaMock.staffShift.findMany.mockResolvedValue([]);
  prismaMock.vitals.findMany.mockResolvedValue([]);
  prismaMock.vitals.findFirst.mockResolvedValue(null);
  prismaMock.labResult.findMany.mockResolvedValue([]);
});

// ── Fixture helpers ────────────────────────────────────
function aPatient() {
  return {
    id: "p1",
    mrNumber: "MR-1001",
    age: 30,
    gender: "MALE",
    address: "Addr",
    bloodGroup: "O+",
    emergencyContactPhone: "+9299",
    photoUrl: null,
    user: { name: "Aarav Mehta", phone: "+911", email: "a@x.io" },
  };
}

describe("generatePrescriptionPDF", () => {
  it("renders patient, doctor, diagnosis and medication rows", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce({
      id: "rx-1",
      diagnosis: "Viral Fever",
      advice: "Rest",
      followUpDate: new Date("2024-06-10"),
      signatureUrl: null,
      printed: false,
      createdAt: new Date("2024-06-01"),
      patient: aPatient(),
      doctor: {
        qualification: "MBBS",
        specialization: "GP",
        user: { name: "Gupta", email: "g@x", phone: "+9" },
      },
      items: [
        {
          medicineName: "Paracetamol",
          dosage: "500mg",
          frequency: "TDS",
          duration: "5d",
          instructions: "after meals",
        },
      ],
      appointment: null,
    });
    const html = await generatePrescriptionPDF("rx-1");
    expect(html).toContain("Aarav Mehta");
    expect(html).toContain("Viral Fever");
    expect(html).toContain("Paracetamol");
    expect(html).toContain("Dr. Gupta");
    expect(html).toContain("Authenticity Verification");
  });

  it("throws when prescription is not found", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce(null);
    await expect(generatePrescriptionPDF("missing")).rejects.toThrow(
      /not found/i
    );
  });
});

describe("generateDischargeSummaryHTML", () => {
  it("includes diagnosis, meds and follow-up", async () => {
    prismaMock.admission.findUnique.mockResolvedValueOnce({
      id: "a1",
      admissionNumber: "ADM-1",
      admittedAt: new Date("2024-05-01"),
      dischargedAt: new Date("2024-05-05"),
      reason: "Pneumonia",
      finalDiagnosis: "Lobar Pneumonia",
      diagnosis: "Pneumonia",
      treatmentGiven: "IV Antibiotics",
      dischargeSummary: "Recovered",
      dischargeNotes: "",
      conditionAtDischarge: "Stable",
      dischargeMedications: "Amoxicillin 500mg BD x 5d",
      followUpInstructions: "Come back in 1 week",
      patient: aPatient(),
      doctor: { user: { name: "Gupta" } },
      bed: { bedNumber: "B-1", ward: { name: "ICU" } },
      labOrders: [],
      medicationOrders: [],
    });
    const html = await generateDischargeSummaryHTML("a1");
    expect(html).toContain("Lobar Pneumonia");
    expect(html).toContain("Amoxicillin 500mg BD x 5d");
    expect(html).toContain("Come back in 1 week");
  });
});

describe("generateLabReportHTML", () => {
  it("colour-codes CRITICAL / HIGH / LOW flags", async () => {
    prismaMock.labOrder.findUnique.mockResolvedValueOnce({
      id: "o1",
      orderNumber: "LO-1",
      orderedAt: new Date(),
      collectedAt: new Date(),
      completedAt: new Date(),
      status: "COMPLETED",
      patient: aPatient(),
      doctor: { user: { name: "Gupta" } },
      items: [
        {
          test: { name: "CBC", code: "CBC", category: "Hematology", sampleType: "Blood", normalRange: "" },
          results: [
            { parameter: "Hb", value: "8.0", unit: "g/dL", flag: "LOW", normalRange: "12-16" },
            { parameter: "WBC", value: "25000", unit: "/uL", flag: "CRITICAL", normalRange: "4-11k" },
            { parameter: "Platelets", value: "600k", unit: "/uL", flag: "HIGH", normalRange: "150-400k" },
          ],
        },
      ],
    });
    const html = await generateLabReportHTML("o1");
    // CRITICAL uses red palette
    expect(html).toMatch(/#991b1b/);
    // HIGH / LOW use amber palette
    expect(html).toMatch(/#92400e/);
    expect(html).toContain("CBC");
  });
});

describe("generateInvoicePDF", () => {
  it("renders CGST + SGST split and amount-in-words", async () => {
    prismaMock.invoice.findUnique.mockResolvedValueOnce({
      id: "inv-1",
      invoiceNumber: "INV-001",
      subtotal: 1000,
      discountAmount: 0,
      packageDiscount: 0,
      cgstAmount: 90,
      sgstAmount: 90,
      lateFeeAmount: 0,
      totalAmount: 1180,
      advanceApplied: 0,
      dueDate: new Date("2024-07-01"),
      paymentStatus: "PENDING",
      createdAt: new Date("2024-06-01"),
      patient: aPatient(),
      items: [
        { description: "Consultation", category: "OPD", quantity: 1, unitPrice: 1000, amount: 1000 },
      ],
      payments: [],
    });
    const html = await generateInvoicePDF("inv-1");
    expect(html).toContain("INV-001");
    expect(html).toContain("CGST");
    expect(html).toContain("SGST");
    // Amount in words: 1180 Rupees → contains "One Thousand" + "Eighty"
    expect(html).toMatch(/Amount in Words/);
    expect(html).toMatch(/Thousand/);
  });
});

describe("generatePaySlipHTML", () => {
  it("computes net pay = gross earnings − PF − ESI", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "u1",
      name: "Alice",
      email: "a@x",
      role: "NURSE",
      createdAt: new Date("2022-01-01"),
      isActive: true,
    });
    prismaMock.staffShift.findMany.mockResolvedValueOnce([
      { status: "PRESENT" },
      { status: "PRESENT" },
      { status: "LEAVE" },
    ]);
    const html = await generatePaySlipHTML("u1", "2024-05");
    expect(html).toContain("Salary Slip");
    // Basic 30000, HRA 12000, DA 3000, Med 1250, Trans 1600 → Gross 47850
    // PF = 0.12 * 30000 = 3600 ; ESI = 0.0075 * 47850 = 359 ; Net = 47850 - 3959 = 43891
    // Gross 47850, PF 3600 + ESI 359 = 3959; Net = 43891
    expect(html).toContain("43891.00");
    expect(html).toMatch(/Forty Three Thousand/i);
  });
});

describe("generatePatientIdCardHTML", () => {
  it("includes MR number and a QR/barcode block", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(aPatient());
    const html = await generatePatientIdCardHTML("p1");
    expect(html).toContain("MR-1001");
    expect(html).toContain("PATIENT ID CARD");
    // QR placeholder uses repeating-linear-gradient (barcode stand-in)
    expect(html).toContain("repeating-linear-gradient");
  });
});

describe("generateVitalsHistoryHTML", () => {
  it("renders an inline SVG trend chart and table", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(aPatient());
    prismaMock.vitals.findMany.mockResolvedValueOnce([
      {
        recordedAt: new Date("2024-05-01"),
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 80,
        pulseRate: 72,
        spO2: 98,
        temperature: 98.6,
        temperatureUnit: "F",
        respiratoryRate: 14,
        weight: 65,
        height: 170,
        bmi: 22.5,
        isAbnormal: false,
        abnormalFlags: "",
      },
    ]);
    const html = await generateVitalsHistoryHTML("p1");
    expect(html).toContain("Vitals History Report");
    expect(html).toContain("<svg");
    expect(html).toContain("120/80");
  });
});

describe("generateFitnessCertificateHTML", () => {
  it("includes the purpose string", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce({
      ...aPatient(),
      user: { name: "Bob" },
    });
    const html = await generateFitnessCertificateHTML(
      "p1",
      "Overseas employment visa"
    );
    expect(html).toContain("Overseas employment visa");
    expect(html).toContain("FIT");
  });
});

describe("generateDeathCertificateHTML", () => {
  it("uses India Form 4 layout with manner checkbox set", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce({
      ...aPatient(),
      admissions: [{ admittedAt: new Date("2024-05-01") }],
      user: { name: "Deceased One" },
    });
    const html = await generateDeathCertificateHTML(
      "p1",
      "Myocardial Infarction",
      "2024-05-10",
      "14:30",
      "NATURAL",
      "Atherosclerosis",
      "Diabetes"
    );
    expect(html).toContain("India — Form 4");
    // Manner shown as checked for NATURAL and unchecked for ACCIDENTAL
    expect(html).toMatch(/☑ NATURAL/);
    expect(html).toMatch(/☐ ACCIDENTAL/);
    expect(html).toContain("Myocardial Infarction");
  });
});

describe("generateBirthCertificateHTML", () => {
  it("throws when delivery has not been recorded", async () => {
    prismaMock.antenatalCase.findUnique.mockResolvedValueOnce({
      id: "anc-1",
      caseNumber: "ANC-1",
      deliveredAt: null,
      patient: { user: { name: "Mother" }, mrNumber: "MR-2", age: 28 },
      doctor: { user: { name: "OB" } },
    });
    await expect(generateBirthCertificateHTML("anc-1")).rejects.toThrow(
      /delivery has not been recorded/i
    );
  });

  it("renders baby + mother details when deliveredAt is set", async () => {
    prismaMock.antenatalCase.findUnique.mockResolvedValueOnce({
      id: "anc-1",
      caseNumber: "ANC-1",
      deliveredAt: new Date("2024-06-01T12:00:00Z"),
      babyGender: "FEMALE",
      babyWeight: 3.1,
      deliveryType: "VAGINAL",
      bloodGroup: "O+",
      outcomeNotes: "Healthy",
      patient: { user: { name: "Mother" }, mrNumber: "MR-2", age: 28 },
      doctor: { user: { name: "OB" } },
    });
    const html = await generateBirthCertificateHTML("anc-1");
    expect(html).toContain("Birth Certificate");
    expect(html).toContain("FEMALE");
    expect(html).toContain("Mother");
  });
});

describe("generateLeaveLetterHTML", () => {
  it("uses APPROVED wording for approved requests", async () => {
    prismaMock.leaveRequest.findUnique.mockResolvedValueOnce({
      id: "lr-1",
      type: "CASUAL",
      fromDate: new Date("2024-05-01"),
      toDate: new Date("2024-05-03"),
      totalDays: 3,
      reason: "Personal",
      status: "APPROVED",
      approvedAt: new Date("2024-04-30"),
      updatedAt: new Date("2024-04-30"),
      rejectionReason: null,
      user: { name: "Alice", role: "NURSE", email: "a@x" },
      approver: { name: "Manager" },
    });
    const html = await generateLeaveLetterHTML("lr-1");
    expect(html).toContain("Leave Approval Letter");
    expect(html).toContain("APPROVED");
  });

  it("uses REJECTION wording and shows the reason for rejected requests", async () => {
    prismaMock.leaveRequest.findUnique.mockResolvedValueOnce({
      id: "lr-2",
      type: "SICK",
      fromDate: new Date("2024-05-01"),
      toDate: new Date("2024-05-02"),
      totalDays: 2,
      reason: "Flu",
      status: "REJECTED",
      approvedAt: null,
      updatedAt: new Date(),
      rejectionReason: "Insufficient notice",
      user: { name: "Bob", role: "DOCTOR", email: "b@x" },
      approver: { name: "Manager" },
    });
    const html = await generateLeaveLetterHTML("lr-2");
    expect(html).toContain("Leave Rejection Letter");
    expect(html).toContain("Insufficient notice");
  });
});
