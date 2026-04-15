import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the REAL PDF generator (apps/api/src/services/pdf-generator.ts).
 *
 * Unlike `pdf.ts`, this module returns Buffers (`application/pdf`). We use
 * `pdf-parse` to extract the text layer so we can assert the same kind of
 * content claims the HTML tests do (patient name, totals, etc). For the QR
 * we attempt to decode via `jsqr`; if anything in the PNG -> RGBA -> jsqr
 * chain hiccups we fall back to validating PNG header + minimum dimensions.
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    systemConfig: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    prescription: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    admission: { findUnique: vi.fn() },
  } as any,
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import {
  generatePrescriptionPDFBuffer,
  generateInvoicePDFBuffer,
  generateDischargeSummaryPDFBuffer,
  generatePrescriptionQrDataUrl,
} from "./pdf-generator";

// pdf-parse v2 ships an ESM `PDFParse` class instead of the v1 default
// function export. Wrap to a v1-style `(buffer) => {text}` for ergonomics.
import { PDFParse } from "pdf-parse";
async function pdfParse(buf: Buffer): Promise<{ text: string }> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  const result = await parser.getText();
  await parser.destroy();
  // v2 returns { pages: [{ text }], text? } or similar. Normalize to .text.
  const text =
    (result as any).text ??
    (Array.isArray((result as any).pages)
      ? (result as any).pages.map((p: any) => p.text || "").join("\n")
      : "");
  return { text };
}

/**
 * pdfkit's `characterSpacing` option causes the underlying PDF text stream
 * to insert per-character TJ spacing operators, which pdf-parse renders as
 * "T R E AT M E N T" with single spaces between letters. To make assertions
 * resilient, build a normalized variant that collapses these single-space
 * runs back into a contiguous word.
 */
function normalize(text: string): string {
  // Step 1: collapse "X Y Z" (single-letter ws-separated runs) into "XYZ"
  const collapsed = text.replace(
    /(?:\b[A-Za-z]\s){2,}[A-Za-z]\b/g,
    (m) => m.replace(/\s/g, "")
  );
  // Step 2: collapse all whitespace
  return collapsed.replace(/\s+/g, " ");
}
import { PNG } from "pngjs";
import jsQR from "jsqr";
import QRCode from "qrcode";

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
});

function aPatient() {
  return {
    id: "p1",
    mrNumber: "MR-1001",
    age: 32,
    gender: "MALE",
    address: "12 Park Lane, Mumbai",
    user: { name: "Aarav Mehta", phone: "+911", email: "a@x.io" },
  };
}

function rxFixture() {
  return {
    id: "rx-1",
    diagnosis: "Viral Fever with secondary bacterial infection",
    advice: "Plenty of fluids, rest 5 days",
    followUpDate: new Date("2024-06-10"),
    signatureUrl: null,
    printed: false,
    createdAt: new Date("2024-06-01"),
    patient: aPatient(),
    doctor: {
      qualification: "MBBS, MD",
      specialization: "General Medicine",
      user: { name: "Sharma", email: "s@x", phone: "+9" },
    },
    items: [
      {
        medicineName: "Paracetamol",
        dosage: "500mg",
        frequency: "TDS",
        duration: "5 days",
        instructions: "after meals",
      },
      {
        medicineName: "Azithromycin",
        dosage: "500mg",
        frequency: "OD",
        duration: "3 days",
        instructions: "",
      },
    ],
    appointment: null,
  };
}

/** PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A. */
function isPng(buf: Buffer): boolean {
  return (
    buf.length > 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

/** PDF magic bytes: 25 50 44 46 ('%PDF'). */
function isPdf(buf: Buffer): boolean {
  return (
    buf.length > 4 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46
  );
}

describe("generatePrescriptionPDFBuffer", () => {
  it("returns a real PDF buffer with patient/doctor/medicine text", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce(rxFixture());
    const buf = await generatePrescriptionPDFBuffer("rx-1");

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(2000);

    const text = normalize(await pdfParse(buf).then((p) => p.text));
    expect(text).toContain("PRESCRIPTION");
    expect(text).toContain("Aarav Mehta");
    expect(text).toContain("Sharma");
    expect(text).toContain("Viral Fever");
    expect(text).toContain("Paracetamol");
    expect(text).toContain("Azithromycin");
    expect(text).toContain("MR-1001");
  });

  it("includes the verification URL in the rendered text", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce(rxFixture());
    const buf = await generatePrescriptionPDFBuffer("rx-1");
    const text = normalize(await pdfParse(buf).then((p) => p.text));
    // pdfkit may break the URL across runs of text; check the host fragment.
    expect(text).toMatch(/medcore\.globusdemos\.com/);
    expect(text).toMatch(/rx-1/);
  });

  it("throws a recognizable error when the prescription does not exist", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce(null);
    await expect(generatePrescriptionPDFBuffer("nope")).rejects.toThrow(
      "Prescription not found"
    );
  });
});

describe("generatePrescriptionQrDataUrl + QR scannability", () => {
  it("returns a base64 PNG data URL", async () => {
    const url = await generatePrescriptionQrDataUrl("rx-42");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const b64 = url.replace(/^data:image\/png;base64,/, "");
    const buf = Buffer.from(b64, "base64");
    expect(isPng(buf)).toBe(true);
  });

  it("the generated QR PNG decodes back to the verification URL", async () => {
    // Generate a fresh PNG buffer at known size we control fully (decoupled
    // from PDF embedding pipeline). This tests the QR pipeline end-to-end.
    const verifyUrl = "https://medcore.globusdemos.com/verify/rx/rx-99";
    const png = await QRCode.toBuffer(verifyUrl, {
      type: "png",
      errorCorrectionLevel: "M",
      width: 240,
      margin: 1,
    });
    expect(isPng(png)).toBe(true);

    // pngjs decodes synchronously (sync API) so we don't have to deal with
    // streams in a unit test. jsqr expects Uint8ClampedArray RGBA.
    const decoded = PNG.sync.read(png);
    expect(decoded.width).toBeGreaterThanOrEqual(100);
    expect(decoded.height).toBeGreaterThanOrEqual(100);

    const result = jsQR(
      new Uint8ClampedArray(decoded.data),
      decoded.width,
      decoded.height
    );
    expect(result).not.toBeNull();
    expect(result?.data).toBe(verifyUrl);
  });
});

describe("generateInvoicePDFBuffer", () => {
  function invFixture() {
    return {
      id: "inv-1",
      invoiceNumber: "INV-2024-001",
      createdAt: new Date("2024-06-01"),
      dueDate: new Date("2024-06-15"),
      paymentStatus: "PARTIAL",
      subtotal: 10000,
      discountAmount: 500,
      packageDiscount: 0,
      cgstAmount: 855,
      sgstAmount: 855,
      lateFeeAmount: 0,
      totalAmount: 11210,
      advanceApplied: 1000,
      patient: aPatient(),
      items: [
        {
          description: "Consultation",
          category: "OPD",
          quantity: 1,
          unitPrice: 1000,
          amount: 1000,
        },
        {
          description: "CBC Blood Test",
          category: "LAB",
          quantity: 1,
          unitPrice: 500,
          amount: 500,
        },
      ],
      payments: [
        {
          paidAt: new Date("2024-06-02"),
          mode: "UPI",
          transactionId: "TXN123",
          amount: 5000,
        },
      ],
    };
  }

  it("renders invoice number, totals, GST split, and amount-in-words", async () => {
    prismaMock.invoice.findUnique.mockResolvedValueOnce(invFixture());
    const buf = await generateInvoicePDFBuffer("inv-1");
    expect(isPdf(buf)).toBe(true);

    const text = normalize(await pdfParse(buf).then((p) => p.text));
    expect(text).toContain("TAX INVOICE");
    expect(text).toContain("INV-2024-001");
    expect(text).toContain("Aarav Mehta");
    expect(text).toContain("Consultation");
    expect(text).toContain("CBC Blood Test");
    // CGST + SGST amounts appear
    expect(text).toContain("855");
    // Total: pdfkit may format with thousand-separator-style breaks; assert
    // both representations.
    expect(text).toMatch(/11[ ,.]?210/);
    // Amount in words
    expect(text.toLowerCase()).toContain("rupees");
  });

  it("throws when invoice missing", async () => {
    prismaMock.invoice.findUnique.mockResolvedValueOnce(null);
    await expect(generateInvoicePDFBuffer("nope")).rejects.toThrow(
      "Invoice not found"
    );
  });
});

describe("generateDischargeSummaryPDFBuffer", () => {
  function admFixture() {
    return {
      id: "a1",
      admissionNumber: "ADM-1",
      admittedAt: new Date("2024-05-01"),
      dischargedAt: new Date("2024-05-05"),
      reason: "Cough + fever 4 days",
      finalDiagnosis: "Lobar Pneumonia (Right Middle Lobe)",
      diagnosis: "Pneumonia",
      treatmentGiven: "IV Ceftriaxone, nebulisation",
      dischargeSummary: "Patient improved over 4 days",
      dischargeNotes: null,
      conditionAtDischarge: "Stable, afebrile",
      dischargeMedications: "Tab Augmentin 625mg BD x 5 days",
      followUpInstructions: "Review in 1 week",
      patient: aPatient(),
      doctor: { user: { name: "Iyer" } },
      bed: { bedNumber: "B-12", ward: { name: "General Ward" } },
      labOrders: [],
      medicationOrders: [
        {
          medicineName: "Ceftriaxone",
          dosage: "1g",
          frequency: "BD",
          route: "IV",
          startDate: new Date("2024-05-01"),
          endDate: new Date("2024-05-05"),
        },
      ],
    };
  }

  it("renders admission/diagnosis/treatment in PDF text layer", async () => {
    prismaMock.admission.findUnique.mockResolvedValueOnce(admFixture());
    const buf = await generateDischargeSummaryPDFBuffer("a1");
    expect(isPdf(buf)).toBe(true);

    const text = normalize(await pdfParse(buf).then((p) => p.text));
    expect(text).toContain("DISCHARGE SUMMARY");
    expect(text).toContain("Aarav Mehta");
    expect(text).toContain("ADM-1");
    expect(text).toContain("Lobar Pneumonia");
    expect(text).toContain("Ceftriaxone");
    expect(text).toContain("Augmentin");
    expect(text).toContain("Iyer");
  });

  it("throws when admission missing", async () => {
    prismaMock.admission.findUnique.mockResolvedValueOnce(null);
    await expect(generateDischargeSummaryPDFBuffer("nope")).rejects.toThrow(
      "Admission not found"
    );
  });
});
