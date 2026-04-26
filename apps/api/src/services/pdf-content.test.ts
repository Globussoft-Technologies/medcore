import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Content-quality tests for the document generators in `pdf.ts`.
 *
 * IMPORTANT context: Despite the names `generate*PDF`, the helpers in
 * apps/api/src/services/pdf.ts return **HTML strings**, not PDF Buffers
 * (no pdfkit / puppeteer is used – the API ships HTML to the browser
 * which then drives `window.print()`). Therefore `pdf-parse` is N/A.
 *
 * These tests assert that each generator produces well-formed HTML that
 * actually contains the load-bearing fields a real document needs
 * (patient name, doctor, totals, GST split, medicine names, etc.) and
 * that long inputs do not throw or silently drop the data.
 */

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
    overtimeRecord: { findMany: vi.fn(async () => []) },
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
  generateServiceCertificateHTML,
} from "./pdf";

const HOSPITAL_CFG = [
  { key: "hospital_name", value: "MedCore Hospital" },
  { key: "hospital_address", value: "1 Main St, Bengaluru" },
  { key: "hospital_phone", value: "+911111111111" },
  { key: "hospital_email", value: "hr@medcore" },
  { key: "hospital_gstin", value: "07AAAAA0000A1Z5" },
  { key: "hospital_registration", value: "REG-100" },
];

beforeEach(() => {
  for (const group of Object.values(prismaMock)) {
    for (const fn of Object.values(group as any)) {
      (fn as any).mockReset?.();
    }
  }
  prismaMock.systemConfig.findUnique.mockResolvedValue(null);
  prismaMock.systemConfig.findMany.mockResolvedValue(HOSPITAL_CFG);
  prismaMock.staffShift.findMany.mockResolvedValue([]);
  prismaMock.vitals.findMany.mockResolvedValue([]);
  prismaMock.vitals.findFirst.mockResolvedValue(null);
  prismaMock.labResult.findMany.mockResolvedValue([]);
});

// ─── Fixtures ──────────────────────────────────────────────
function aPatient(overrides: Record<string, any> = {}) {
  return {
    id: "p1",
    mrNumber: "MR-1001",
    age: 32,
    gender: "MALE",
    address: "12 Park Lane, Mumbai",
    bloodGroup: "O+",
    emergencyContactPhone: "+9299",
    photoUrl: null,
    user: { name: "Aarav Mehta", phone: "+911", email: "a@x.io" },
    ...overrides,
  };
}

// Exactly 60 characters — validates layout & escaping with a long header.
const LONG_NAME = "Maximillian Aarav Krishnamurthy Subrahmanyam Iyer Junior Sr.";
// length === 60

/** Sanity check: the returned string is a usable HTML5 document. */
function expectWellFormedHtml(html: string) {
  expect(typeof html).toBe("string");
  expect(html.length).toBeGreaterThan(200);
  expect(html.toLowerCase()).toContain("<!doctype html>");
  expect(html).toContain("<html");
  expect(html).toContain("</html>");
  expect(html).toContain("<body");
  expect(html).toContain("</body>");
  // Every <tag> we open should be closable – at minimum the opens & closes match.
  const opens = (html.match(/<(div|table|tr|td|p|h1|h2|h3|html|body|span)\b/g) || []).length;
  const closes = (html.match(/<\/(div|table|tr|td|p|h1|h2|h3|html|body|span)>/g) || []).length;
  // Allow small mismatch (self-closing voids etc.) but must be in same order of magnitude.
  expect(closes).toBeGreaterThan(opens * 0.6);
}

// ── 1. PRESCRIPTION ──────────────────────────────────────
describe("generatePrescriptionPDF — content quality", () => {
  function rxFixture(patientName = "Aarav Mehta") {
    return {
      id: "rx-1",
      diagnosis: "Viral Fever with secondary bacterial infection",
      advice: "Plenty of fluids, rest 5 days",
      followUpDate: new Date("2024-06-10"),
      signatureUrl: null,
      printed: false,
      createdAt: new Date("2024-06-01"),
      patient: aPatient({ user: { name: patientName, phone: "+1", email: "p@x" } }),
      doctor: {
        qualification: "MBBS, MD",
        specialization: "General Medicine",
        user: { name: "Sharma", email: "s@x", phone: "+9" },
      },
      items: [
        { medicineName: "Paracetamol", dosage: "500mg", frequency: "TDS", duration: "5 days", instructions: "after meals" },
        { medicineName: "Azithromycin", dosage: "500mg", frequency: "OD",  duration: "3 days", instructions: "" },
      ],
      appointment: null,
    };
  }

  it("renders patient, doctor, diagnosis, every medicine + dosage", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce(rxFixture());
    const html = await generatePrescriptionPDF("rx-1");
    expectWellFormedHtml(html);
    expect(html).toContain("Aarav Mehta");
    expect(html).toContain("Dr. Sharma");
    expect(html).toContain("Viral Fever");
    expect(html).toContain("Paracetamol");
    expect(html).toContain("500mg");
    expect(html).toContain("Azithromycin");
    expect(html).toContain("after meals");
  });

  it("embeds verification URL (substituted for QR payload)", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce(rxFixture());
    const html = await generatePrescriptionPDF("rx-1");
    expect(html).toContain("https://medcore.globusdemos.com/verify/rx/rx-1");
    expect(html).toContain("Authenticity Verification");
  });

  it("edge case: 60-char patient name does not crash and is rendered intact", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce(rxFixture(LONG_NAME));
    const html = await generatePrescriptionPDF("rx-1");
    expect(html).toContain(LONG_NAME);
  });
});

// ── 2. DISCHARGE SUMMARY ─────────────────────────────────
describe("generateDischargeSummaryHTML — content quality", () => {
  function admFixture(patientName = "Aarav Mehta") {
    return {
      id: "a1",
      admissionNumber: "ADM-1",
      admittedAt: new Date("2024-05-01"),
      dischargedAt: new Date("2024-05-05"),
      reason: "Cough + fever 4 days",
      finalDiagnosis: "Lobar Pneumonia (Right Middle Lobe)",
      diagnosis: "Pneumonia",
      treatmentGiven: "IV Ceftriaxone, nebulisation",
      dischargeSummary: "Patient improved, afebrile by Day 3",
      dischargeNotes: "",
      conditionAtDischarge: "Stable",
      dischargeMedications: "Amoxiclav 625mg BD x 5d, Paracetamol SOS",
      followUpInstructions: "Review OPD in 1 week with X-ray",
      patient: aPatient({ user: { name: patientName, phone: "+1" } }),
      doctor: { user: { name: "Gupta" } },
      bed: { bedNumber: "B-12", ward: { name: "ICU" } },
      labOrders: [],
      medicationOrders: [],
    };
  }

  it("renders diagnosis, ward, discharge meds, follow-up", async () => {
    prismaMock.admission.findUnique.mockResolvedValueOnce(admFixture());
    const html = await generateDischargeSummaryHTML("a1");
    expectWellFormedHtml(html);
    expect(html).toContain("Lobar Pneumonia");
    expect(html).toContain("ICU");
    expect(html).toContain("B-12");
    expect(html).toContain("Amoxiclav");
    expect(html).toContain("Review OPD in 1 week");
    expect(html).toContain("Dr. Gupta");
  });

  it("edge case: 60-char patient name renders without truncation", async () => {
    prismaMock.admission.findUnique.mockResolvedValueOnce(admFixture(LONG_NAME));
    const html = await generateDischargeSummaryHTML("a1");
    expect(html).toContain(LONG_NAME);
  });
});

// ── 3. LAB REPORT ────────────────────────────────────────
describe("generateLabReportHTML — content quality", () => {
  function labFixture(patientName = "Aarav Mehta") {
    return {
      id: "o1",
      orderNumber: "LO-2024-007",
      orderedAt: new Date("2024-06-01"),
      collectedAt: new Date("2024-06-01"),
      completedAt: new Date("2024-06-02"),
      status: "COMPLETED",
      patient: aPatient({ user: { name: patientName, phone: "+1" } }),
      doctor: { user: { name: "Iyer" } },
      items: [
        {
          test: { name: "Complete Blood Count", code: "CBC", category: "Hematology", sampleType: "Blood", normalRange: "" },
          results: [
            { parameter: "Hemoglobin", value: "8.2", unit: "g/dL", flag: "LOW",      normalRange: "12-16" },
            { parameter: "WBC",        value: "25000", unit: "/uL", flag: "CRITICAL", normalRange: "4-11k" },
          ],
        },
      ],
    };
  }

  it("renders test name, parameter, result value and flag", async () => {
    prismaMock.labOrder.findUnique.mockResolvedValueOnce(labFixture());
    const html = await generateLabReportHTML("o1");
    expectWellFormedHtml(html);
    expect(html).toContain("LO-2024-007");
    expect(html).toContain("Complete Blood Count");
    expect(html).toContain("Hemoglobin");
    expect(html).toContain("8.2");
    expect(html).toContain("CRITICAL");
    expect(html).toContain("Dr. Iyer");
  });

  it("edge case: 60-char patient name doesn't break layout", async () => {
    prismaMock.labOrder.findUnique.mockResolvedValueOnce(labFixture(LONG_NAME));
    const html = await generateLabReportHTML("o1");
    expect(html).toContain(LONG_NAME);
  });
});

// ── 4. INVOICE ───────────────────────────────────────────
describe("generateInvoicePDF — content quality", () => {
  function invFixture(patientName = "Aarav Mehta") {
    return {
      id: "inv-1",
      invoiceNumber: "INV-2024-0042",
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
      patient: aPatient({ user: { name: patientName, phone: "+1", email: "p@x" } }),
      items: [
        { description: "Consultation - Cardiology", category: "OPD", quantity: 1, unitPrice: 1000, amount: 1000 },
      ],
      payments: [],
    };
  }

  it("includes invoice #, line item, GST split (CGST + SGST), total and amount in words", async () => {
    prismaMock.invoice.findUnique.mockResolvedValueOnce(invFixture());
    const html = await generateInvoicePDF("inv-1");
    expectWellFormedHtml(html);
    expect(html).toContain("INV-2024-0042");
    expect(html).toContain("Consultation - Cardiology");
    // GST breakdown both lines present
    expect(html).toContain(">CGST<");
    expect(html).toContain(">SGST<");
    expect(html).toContain("90.00"); // CGST/SGST amount
    // Total amount appears
    expect(html).toContain("1180.00");
    // Amount in words
    expect(html).toMatch(/Amount in Words/);
    expect(html).toMatch(/Thousand/);
    expect(html).toMatch(/Rupees Only/);
  });

  it("edge case: 60-char patient name fits inside the Bill-To block", async () => {
    prismaMock.invoice.findUnique.mockResolvedValueOnce(invFixture(LONG_NAME));
    const html = await generateInvoicePDF("inv-1");
    expect(html).toContain(LONG_NAME);
  });
});

// ── 5. PAY SLIP ──────────────────────────────────────────
describe("generatePaySlipHTML — content quality", () => {
  function userFixture(name = "Alice Nightingale") {
    return {
      id: "u1",
      name,
      email: "a@x",
      role: "NURSE",
      createdAt: new Date("2022-01-01"),
      isActive: true,
    };
  }

  it("contains basic pay, gross, and net salary amounts", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(userFixture());
    prismaMock.staffShift.findMany.mockResolvedValueOnce([
      { status: "PRESENT" }, { status: "PRESENT" }, { status: "LEAVE" },
    ]);
    const html = await generatePaySlipHTML("u1", "2024-05", {
      basicSalary: 30000,
      allowances: 17850,
    });
    expectWellFormedHtml(html);
    expect(html).toContain("Salary Slip");
    expect(html).toContain("Alice Nightingale");
    expect(html).toContain("30000.00"); // basic
    expect(html).toContain("47850.00"); // gross
    // Issue #74: ESI = 0 above ₹21,000 ceiling → Net = 47850 - 3600 PF = 44250.
    expect(html).toContain("44250.00"); // net
    expect(html).toMatch(/Forty Four Thousand/i);
    // Provident Fund and ESI lines
    expect(html).toContain("Provident Fund");
    expect(html).toContain("ESI");
  });

  it("edge case: 60-char employee name", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(userFixture(LONG_NAME));
    const html = await generatePaySlipHTML("u1", "2024-05");
    expect(html).toContain(LONG_NAME);
  });
});

// ── 6. PATIENT ID CARD ───────────────────────────────────
describe("generatePatientIdCardHTML — content quality", () => {
  it("includes hospital name, MR number and patient name", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(aPatient());
    const html = await generatePatientIdCardHTML("p1");
    expectWellFormedHtml(html);
    expect(html).toContain("MR-1001");
    expect(html).toContain("Aarav Mehta");
    expect(html).toContain("PATIENT ID CARD");
    expect(html).toContain("MedCore Hospital");
  });

  it("edge case: 60-char patient name (id-card is tiny — must not be silently dropped)", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(
      aPatient({ user: { name: LONG_NAME, phone: "+1" } })
    );
    const html = await generatePatientIdCardHTML("p1");
    expect(html).toContain(LONG_NAME);
  });
});

// ── 7. VITALS HISTORY ────────────────────────────────────
describe("generateVitalsHistoryHTML — content quality", () => {
  function vitalsRow() {
    return {
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
    };
  }

  it("includes patient name and vitals row data", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(aPatient());
    prismaMock.vitals.findMany.mockResolvedValueOnce([vitalsRow()]);
    const html = await generateVitalsHistoryHTML("p1");
    expectWellFormedHtml(html);
    expect(html).toContain("Aarav Mehta");
    expect(html).toContain("Vitals History Report");
    expect(html).toContain("120/80");
    expect(html).toContain("<svg");
  });

  it("edge case: 60-char patient name", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(
      aPatient({ user: { name: LONG_NAME, phone: "+1" } })
    );
    prismaMock.vitals.findMany.mockResolvedValueOnce([vitalsRow()]);
    const html = await generateVitalsHistoryHTML("p1");
    expect(html).toContain(LONG_NAME);
  });
});

// ── 8. FITNESS CERTIFICATE ───────────────────────────────
describe("generateFitnessCertificateHTML — content quality", () => {
  it("renders patient name, purpose and FIT verdict", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(
      aPatient({ user: { name: "Bob Andrews" } })
    );
    const html = await generateFitnessCertificateHTML("p1", "Overseas employment visa");
    expectWellFormedHtml(html);
    expect(html).toContain("Bob Andrews");
    expect(html).toContain("Overseas employment visa");
    expect(html).toContain("FIT");
    expect(html).toContain("Medical Fitness Certificate");
  });

  it("edge case: 60-char patient name", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(
      aPatient({ user: { name: LONG_NAME } })
    );
    const html = await generateFitnessCertificateHTML("p1", "Visa");
    expect(html).toContain(LONG_NAME);
  });
});

// ── 9. DEATH CERTIFICATE ─────────────────────────────────
describe("generateDeathCertificateHTML — content quality", () => {
  function deathFixture(name = "Deceased One") {
    return {
      ...aPatient({ user: { name } }),
      admissions: [{ admittedAt: new Date("2024-05-01") }],
    };
  }

  it("renders deceased name, cause, manner checkbox, India Form 4 layout", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(deathFixture());
    const html = await generateDeathCertificateHTML(
      "p1",
      "Myocardial Infarction",
      "2024-05-10",
      "14:30",
      "NATURAL",
      "Atherosclerosis",
      "Diabetes Mellitus"
    );
    expectWellFormedHtml(html);
    expect(html).toContain("Deceased One");
    expect(html).toContain("Myocardial Infarction");
    expect(html).toContain("Atherosclerosis");
    expect(html).toContain("Diabetes Mellitus");
    expect(html).toContain("India — Form 4");
    expect(html).toMatch(/☑ NATURAL/);
    expect(html).toMatch(/☐ ACCIDENTAL/);
  });

  it("edge case: 60-char deceased name", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(deathFixture(LONG_NAME));
    const html = await generateDeathCertificateHTML(
      "p1", "MI", "2024-05-10", "14:30", "NATURAL", "", ""
    );
    expect(html).toContain(LONG_NAME);
  });
});

// ── 10. BIRTH CERTIFICATE ────────────────────────────────
describe("generateBirthCertificateHTML — content quality", () => {
  function ancFixture(motherName = "Sita Devi") {
    return {
      id: "anc-1",
      caseNumber: "ANC-2024-005",
      deliveredAt: new Date("2024-06-01T12:00:00Z"),
      babyGender: "FEMALE",
      babyWeight: 3.1,
      deliveryType: "VAGINAL",
      bloodGroup: "O+",
      outcomeNotes: "Healthy baby, mother stable",
      patient: { user: { name: motherName }, mrNumber: "MR-2", age: 28 },
      doctor: { user: { name: "OB-Singh" } },
    };
  }

  it("renders mother name, baby gender, delivery type, ANC #", async () => {
    prismaMock.antenatalCase.findUnique.mockResolvedValueOnce(ancFixture());
    const html = await generateBirthCertificateHTML("anc-1");
    expectWellFormedHtml(html);
    expect(html).toContain("Birth Certificate");
    expect(html).toContain("Sita Devi");
    expect(html).toContain("FEMALE");
    expect(html).toContain("VAGINAL");
    expect(html).toContain("ANC-2024-005");
    expect(html).toContain("3.1 kg");
    expect(html).toContain("Dr. OB-Singh");
  });

  it("edge case: 60-char mother name", async () => {
    prismaMock.antenatalCase.findUnique.mockResolvedValueOnce(ancFixture(LONG_NAME));
    const html = await generateBirthCertificateHTML("anc-1");
    expect(html).toContain(LONG_NAME);
  });
});

// ── 11. LEAVE LETTER ─────────────────────────────────────
describe("generateLeaveLetterHTML — content quality", () => {
  function leaveFixture(name = "Alice", status: "APPROVED" | "REJECTED" = "APPROVED") {
    return {
      id: "lr-1",
      type: "CASUAL",
      fromDate: new Date("2024-05-01"),
      toDate: new Date("2024-05-03"),
      totalDays: 3,
      reason: "Personal work",
      status,
      approvedAt: new Date("2024-04-30"),
      updatedAt: new Date("2024-04-30"),
      rejectionReason: status === "REJECTED" ? "Insufficient notice" : null,
      user: { name, role: "NURSE", email: "a@x" },
      approver: { name: "HR Manager" },
    };
  }

  it("renders employee name, leave dates and APPROVED status", async () => {
    prismaMock.leaveRequest.findUnique.mockResolvedValueOnce(leaveFixture());
    const html = await generateLeaveLetterHTML("lr-1");
    expectWellFormedHtml(html);
    expect(html).toContain("Alice");
    expect(html).toContain("Leave Approval Letter");
    expect(html).toContain("APPROVED");
    expect(html).toContain("3 day(s)");
    expect(html).toContain("HR Manager");
  });

  it("edge case: 60-char employee name", async () => {
    prismaMock.leaveRequest.findUnique.mockResolvedValueOnce(leaveFixture(LONG_NAME));
    const html = await generateLeaveLetterHTML("lr-1");
    expect(html).toContain(LONG_NAME);
  });
});

// ── 12. SERVICE CERTIFICATE ──────────────────────────────
describe("generateServiceCertificateHTML — content quality", () => {
  function userFixture(name = "Charlie Brown") {
    return {
      id: "u1",
      name,
      email: "c@x",
      role: "DOCTOR",
      createdAt: new Date("2020-01-01"),
      isActive: true,
    };
  }

  it("renders employee name, role, joining date, conduct", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(userFixture());
    const html = await generateServiceCertificateHTML("u1", "exemplary");
    expectWellFormedHtml(html);
    expect(html).toContain("Charlie Brown");
    expect(html).toContain("DOCTOR");
    expect(html).toContain("exemplary");
    expect(html).toContain("Service Certificate");
    expect(html).toContain("TO WHOMSOEVER IT MAY CONCERN");
  });

  it("edge case: 60-char employee name", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(userFixture(LONG_NAME));
    const html = await generateServiceCertificateHTML("u1");
    expect(html).toContain(LONG_NAME);
  });
});
