import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Snapshot regression tests for PDF / letter / invoice HTML generators.
 *
 * PURPOSE (P9 — TEST_COVERAGE_AUDIT §5):
 *   Lock down the deterministic structural parts of AI-generated letters,
 *   prescriptions, discharge summaries, and invoices so that future template
 *   edits produce reviewable diffs rather than silent format drift.
 *
 * WHAT IS FROZEN:
 *   - HTML <head>, base styles block, page wrapper
 *   - Letterhead (brand colour, GSTIN / Reg. No. lines, double-border divider)
 *   - Document title block (h2.title)
 *   - Patient / bill-to info grid
 *   - Medications / items table headers and row structure
 *   - Totals block layout (CGST, SGST, Balance rows)
 *   - Terms & Conditions text (invoice)
 *   - QR / authenticity-verification section skeleton (prescription)
 *   - Signature block (.signblock / .sig)
 *   - Audit footer (.footer)
 *   - Referral letter prompt template (9-section structural skeleton)
 *
 * WHAT IS NOT FROZEN (intentionally excluded or masked):
 *   - Locale-formatted date/time strings — all dates in fixtures are set to
 *     `null` so they render as the locale-agnostic fallback "—".  This keeps
 *     snapshots portable across Node locales (Windows, macOS, Linux CI).
 *   - QR PNG data URL — mocked to a short fixed stub so the ~12 kB base64
 *     blob does not bloat the snapshot file and never causes a false-positive
 *     diff when the QR library changes its encoding.
 *
 * RUNNING:
 *   npm test -- apps/api/src/services/pdf-snapshot.test.ts
 *
 * UPDATE SNAPSHOTS (after intentional template change):
 *   npm test -- apps/api/src/services/pdf-snapshot.test.ts -u
 */

// ─── Module mocks (must be before any imports) ───────────────────────────────

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    systemConfig: {
      findMany: vi.fn(async () => []),
    },
    prescription: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    admission: { findUnique: vi.fn() },
  } as any,
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

// Stub out the QR generator so the snapshot does not contain a ~12 kB
// base64 blob that would produce massive diffs on unrelated QR lib bumps.
vi.mock("./pdf-generator", () => ({
  generatePrescriptionQrDataUrl: vi.fn(async () => "data:image/png;base64,STUB_QR"),
}));

// Mock the OpenAI/Sarvam client used by letter-generator.
const { llmCreate } = vi.hoisted(() => ({ llmCreate: vi.fn() }));
vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: llmCreate } };
    constructor(_opts: any) {}
  }
  return { default: OpenAI };
});

import {
  generatePrescriptionPDF,
  generateInvoicePDF,
  generateDischargeSummaryHTML,
} from "./pdf";
import { generateReferralLetter } from "./ai/letter-generator";

// ─── Shared hospital config ───────────────────────────────────────────────────

const HOSPITAL_CFG = [
  { key: "hospital_name", value: "MedCore Hospital" },
  { key: "hospital_address", value: "1 Main St, Bengaluru 560001" },
  { key: "hospital_phone", value: "+91 80 1234 5678" },
  { key: "hospital_email", value: "info@medcore.hospital" },
  { key: "hospital_gstin", value: "07AAAAA0000A1Z5" },
  { key: "hospital_registration", value: "REG-KA-2024-001" },
];

// ─── Common fixture helpers ───────────────────────────────────────────────────

/** Dates are intentionally null so they render as "—" (locale-agnostic). */
function aPatient(overrides: Record<string, unknown> = {}) {
  return {
    id: "patient-snap-001",
    mrNumber: "MR-SNAP-001",
    age: 35,
    gender: "FEMALE",
    address: "42 Fixture Lane, Bengaluru",
    bloodGroup: "B+",
    emergencyContactPhone: "+91 99 0000 0001",
    photoUrl: null,
    user: {
      name: "Priya Snapshot",
      phone: "+91 98 0000 0001",
      email: "priya@snapshot.test",
    },
    ...overrides,
  };
}

// ─── beforeEach ──────────────────────────────────────────────────────────────

beforeEach(() => {
  for (const group of Object.values(prismaMock)) {
    for (const fn of Object.values(group as any)) {
      (fn as any).mockReset?.();
    }
  }
  prismaMock.systemConfig.findMany.mockResolvedValue(HOSPITAL_CFG);
  llmCreate.mockReset();
});

// ─── 1. PRESCRIPTION HTML ────────────────────────────────────────────────────

describe("generatePrescriptionPDF — HTML snapshot", () => {
  /**
   * Minimal fixture: no medications, no advice, no follow-up, no signature.
   * Freezes the empty-state skeleton: letterhead, title, patient/doctor
   * grid, empty medications table, QR section, footer.
   */
  it("snapshot: empty / default prescription", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce({
      id: "rx-snap-empty",
      diagnosis: "Observation",
      advice: null,
      followUpDate: null,
      signatureUrl: null,
      printed: false,
      createdAt: null, // null → "—" (locale-safe)
      patient: aPatient(),
      doctor: {
        qualification: "MBBS",
        specialization: null,
        user: { name: "Dr Snapshot", email: "d@s.test", phone: "+1" },
      },
      items: [],
      appointment: null,
    });

    const html = await generatePrescriptionPDF("rx-snap-empty");
    expect(html).toMatchSnapshot();
  });

  /**
   * Populated fixture: two medications, advice, follow-up.
   * Freezes the full document structure including the medications table,
   * advice section, follow-up box, and QR authenticity block.
   */
  it("snapshot: populated prescription with two medications", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce({
      id: "rx-snap-full",
      diagnosis: "Acute Viral Pharyngitis with secondary rhinitis",
      advice: "Rest for 3 days. Avoid cold drinks. Increase fluid intake.",
      followUpDate: null, // null → "—"
      signatureUrl: null,
      printed: false,
      createdAt: null,
      patient: aPatient(),
      doctor: {
        qualification: "MBBS, MD (Internal Medicine)",
        specialization: "General Medicine",
        user: { name: "Ramesh Kumar", email: "rk@medcore.test", phone: "+91" },
      },
      items: [
        {
          medicineName: "Amoxicillin",
          dosage: "500 mg",
          frequency: "TDS",
          duration: "7 days",
          instructions: "After meals",
        },
        {
          medicineName: "Cetirizine",
          dosage: "10 mg",
          frequency: "OD at night",
          duration: "5 days",
          instructions: "",
        },
      ],
      appointment: null,
    });

    const html = await generatePrescriptionPDF("rx-snap-full");
    expect(html).toMatchSnapshot();
  });
});

// ─── 2. INVOICE HTML ─────────────────────────────────────────────────────────

describe("generateInvoicePDF — HTML snapshot", () => {
  function baseInvoice(overrides: Record<string, unknown> = {}) {
    return {
      id: "inv-snap-001",
      invoiceNumber: "INV-SNAP-0001",
      createdAt: null, // null → "—"
      dueDate: null,
      paymentStatus: "PENDING",
      subtotal: 1000,
      taxAmount: 180,
      cgstAmount: 90,
      sgstAmount: 90,
      discountAmount: 0,
      packageDiscount: 0,
      lateFeeAmount: 0,
      totalAmount: 1180,
      advanceApplied: 0,
      patient: aPatient(),
      items: [
        {
          description: "General Consultation",
          category: "OPD",
          quantity: 1,
          unitPrice: 1000,
          amount: 1000,
        },
      ],
      payments: [],
      ...overrides,
    };
  }

  /**
   * Minimal invoice: single OPD line item, no payments, PENDING status.
   * Freezes: letterhead, TAX INVOICE title, Bill-To block, items table
   * header and row structure, totals breakdown, amount-in-words box,
   * terms & conditions block, authorised signatory block.
   */
  it("snapshot: minimal single-item invoice", async () => {
    prismaMock.invoice.findUnique.mockResolvedValueOnce(baseInvoice());
    const html = await generateInvoicePDF("inv-snap-001");
    expect(html).toMatchSnapshot();
  });

  /**
   * Multi-item invoice with two categories, a discount, and a payment.
   * Freezes the payment history table rows and the Balance row colour.
   */
  it("snapshot: multi-item invoice with discount and partial payment", async () => {
    prismaMock.invoice.findUnique.mockResolvedValueOnce(
      baseInvoice({
        id: "inv-snap-002",
        invoiceNumber: "INV-SNAP-0002",
        paymentStatus: "PARTIAL",
        subtotal: 2000,
        taxAmount: 180,
        cgstAmount: 90,
        sgstAmount: 90,
        discountAmount: 200,
        totalAmount: 1980,
        items: [
          {
            description: "General Consultation",
            category: "OPD",
            quantity: 1,
            unitPrice: 1000,
            amount: 1000,
          },
          {
            description: "Complete Blood Count",
            category: "LAB",
            quantity: 1,
            unitPrice: 1000,
            amount: 1000,
          },
        ],
        payments: [
          {
            paidAt: null, // null → "—"
            mode: "UPI",
            transactionId: "SNAP-TXN-001",
            amount: 1000,
          },
        ],
      })
    );
    const html = await generateInvoicePDF("inv-snap-002");
    expect(html).toMatchSnapshot();
  });
});

// ─── 3. DISCHARGE SUMMARY HTML ───────────────────────────────────────────────

describe("generateDischargeSummaryHTML — HTML snapshot", () => {
  function baseAdmission(overrides: Record<string, unknown> = {}) {
    return {
      id: "adm-snap-001",
      admissionNumber: "ADM-SNAP-001",
      admittedAt: null, // null → "—"
      dischargedAt: null,
      reason: "Fever and cough for 3 days",
      finalDiagnosis: "Community Acquired Pneumonia",
      diagnosis: "Pneumonia",
      treatmentGiven: null,
      dischargeSummary: "Patient responded to antibiotics. Afebrile by Day 3.",
      dischargeNotes: null,
      conditionAtDischarge: "Stable, ready for discharge",
      dischargeMedications: null,
      followUpInstructions: null,
      patient: aPatient(),
      doctor: { user: { name: "Sunita Rao" } },
      bed: { bedNumber: "W4-B02", ward: { name: "General Ward 4" } },
      labOrders: [],
      medicationOrders: [],
      ...overrides,
    };
  }

  /**
   * Minimal discharge summary: no lab orders, no medication orders, no
   * discharge meds or follow-up.  Freezes the core structural skeleton:
   * letterhead, DISCHARGE SUMMARY title, patient/admission grid, ward/doctor
   * row, final diagnosis box, reason section, course-in-hospital section,
   * condition-at-discharge box, signature block, audit footer.
   */
  it("snapshot: minimal discharge summary", async () => {
    prismaMock.admission.findUnique.mockResolvedValueOnce(baseAdmission());
    const html = await generateDischargeSummaryHTML("adm-snap-001");
    expect(html).toMatchSnapshot();
  });

  /**
   * Full discharge summary: medication orders, discharge medications,
   * follow-up instructions.  Freezes the optional sections so their
   * presence and structure is locked.
   */
  it("snapshot: full discharge summary with medication orders and follow-up", async () => {
    prismaMock.admission.findUnique.mockResolvedValueOnce(
      baseAdmission({
        id: "adm-snap-002",
        admissionNumber: "ADM-SNAP-002",
        treatmentGiven: "IV Ceftriaxone 1g BD, Nebulisation QID",
        dischargeMedications:
          "Tab Augmentin 625mg BD x 5d\nTab Paracetamol 500mg SOS",
        followUpInstructions:
          "OPD review in 1 week. Chest X-ray on follow-up.",
        medicationOrders: [
          {
            medicineName: "Ceftriaxone",
            dosage: "1 g",
            frequency: "BD",
            route: "IV",
            startDate: null,
            endDate: null,
          },
          {
            medicineName: "Salbutamol",
            dosage: "2.5 mg",
            frequency: "QID",
            route: "Nebulisation",
            startDate: null,
            endDate: null,
          },
        ],
      })
    );
    const html = await generateDischargeSummaryHTML("adm-snap-002");
    expect(html).toMatchSnapshot();
  });
});

// ─── 4. REFERRAL LETTER PROMPT TEMPLATE ──────────────────────────────────────

describe("generateReferralLetter — prompt template snapshot", () => {
  /**
   * The referral letter is LLM-driven, but the *prompt construction* that
   * precedes the LLM call is a deterministic 9-section template.  We snapshot
   * the userPrompt string passed to the model so that structural changes to
   * the template (e.g. removing a section, reordering, changing field labels)
   * are caught immediately.
   *
   * The LLM response itself is not snapshotted — it is mocked to a fixed
   * string.  Only the userPrompt (messages[1].content) is the snapshot target.
   */
  it("snapshot: referral letter prompt — ROUTINE urgency with toDoctorName", async () => {
    llmCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "STUB LETTER OUTPUT" } }],
    });

    await generateReferralLetter({
      patientName: "Vikram Snapshot",
      patientAge: 45,
      patientGender: "Male",
      fromDoctorName: "Anita Sharma",
      fromHospital: "MedCore Hospital",
      toSpecialty: "Cardiology",
      toDoctorName: "Rajesh Patel",
      clinicalSummary:
        "Chest pain on exertion for 2 weeks. Resting ECG shows ST changes.",
      relevantHistory: "Hypertension on Amlodipine. Diabetic on Metformin.",
      currentMedications: ["Amlodipine 5mg OD", "Metformin 500mg BD"],
      urgency: "ROUTINE",
      date: "2024-06-01",
    });

    const userPrompt: string = llmCreate.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toMatchSnapshot();
  });

  it("snapshot: referral letter prompt — EMERGENCY urgency, no toDoctorName, empty medications", async () => {
    llmCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "STUB LETTER OUTPUT" } }],
    });

    await generateReferralLetter({
      patientName: "Meera Snapshot",
      fromDoctorName: "Suresh Iyer",
      fromHospital: "MedCore Hospital",
      toSpecialty: "Neurology",
      clinicalSummary: "Sudden onset right-sided weakness and aphasia.",
      relevantHistory: "No prior neurological history.",
      currentMedications: [],
      urgency: "EMERGENCY",
      date: "2024-06-15",
    });

    const userPrompt: string = llmCreate.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toMatchSnapshot();
  });
});
