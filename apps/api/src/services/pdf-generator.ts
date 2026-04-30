/**
 * Server-side PDF generation using pdfkit.
 *
 * This module produces ACTUAL `application/pdf` Buffer output (as opposed to
 * `pdf.ts`, which returns HTML strings designed for browser print). The two
 * services intentionally co-exist: callers pick HTML or PDF per route via a
 * `?format=pdf` query parameter so the legacy print-view flow keeps working.
 *
 * Currently implemented:
 *   - generatePrescriptionPDFBuffer (with embedded scannable QR)
 *   - generateInvoicePDFBuffer
 *   - generateDischargeSummaryPDFBuffer
 *
 * Follow-up: the remaining 9 generators in pdf.ts (pay slip, ID card, vitals,
 * fitness/death/birth/leave/service certs, lab report) still emit HTML only.
 */
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { prisma } from "@medcore/db";
import {
  computeInvoiceTotals,
  computeLineItemTax,
  derivePaymentStatus,
} from "@medcore/shared";

// ─── Shared helpers ─────────────────────────────────────────

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "-";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "-";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleString("en-IN");
}

interface HospitalInfo {
  name: string;
  address: string;
  phone: string;
  email: string;
  gstin: string;
  registration: string;
}

async function getHospitalInfo(): Promise<HospitalInfo> {
  const rows = await prisma.systemConfig.findMany({
    where: {
      key: {
        in: [
          "hospital_name",
          "hospital_address",
          "hospital_phone",
          "hospital_email",
          "hospital_gstin",
          "hospital_registration",
        ],
      },
    },
  });
  const map: Record<string, string> = {};
  rows.forEach((r: { key: string; value: string }) => (map[r.key] = r.value));
  return {
    name: map.hospital_name || "Hospital",
    address: map.hospital_address || "",
    phone: map.hospital_phone || "",
    email: map.hospital_email || "",
    gstin: map.hospital_gstin || "",
    registration: map.hospital_registration || "",
  };
}

function numberToWordsIndian(num: number): string {
  if (num == null || isNaN(num)) return "Zero";
  num = Math.round(num);
  if (num === 0) return "Zero Rupees Only";
  const a = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen",
  ];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const inWords = (n: number): string => {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n / 10)] + (n % 10 ? " " + a[n % 10] : "");
    if (n < 1000)
      return a[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + inWords(n % 100) : "");
    return "";
  };
  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const hundred = num;
  let str = "";
  if (crore) str += inWords(crore) + " Crore ";
  if (lakh) str += inWords(lakh) + " Lakh ";
  if (thousand) str += inWords(thousand) + " Thousand ";
  if (hundred) str += inWords(hundred);
  return str.trim() + " Rupees Only";
}

/**
 * Collect a pdfkit document into a single Buffer. pdfkit is a streaming API
 * (it pipes chunks as they are generated); for HTTP responses we want the
 * complete artifact in memory.
 */
function collectPdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

/**
 * Render the standard letterhead block at the current y cursor.
 */
function drawLetterhead(doc: PDFKit.PDFDocument, h: HospitalInfo): void {
  doc
    .fillColor("#2563eb")
    .fontSize(20)
    .font("Helvetica-Bold")
    .text(h.name, { align: "center" });
  doc.moveDown(0.2);
  doc.fillColor("#64748b").fontSize(9).font("Helvetica");
  if (h.address) doc.text(h.address, { align: "center" });
  const contactLine = [
    h.phone ? `Phone: ${h.phone}` : "",
    h.email ? `Email: ${h.email}` : "",
  ].filter(Boolean).join("  |  ");
  if (contactLine) doc.text(contactLine, { align: "center" });
  const regLine = [
    h.gstin ? `GSTIN: ${h.gstin}` : "",
    h.registration ? `Reg. No: ${h.registration}` : "",
  ].filter(Boolean).join("  |  ");
  if (regLine) doc.fillColor("#94a3b8").text(regLine, { align: "center" });

  // Divider
  doc.moveDown(0.5);
  const y = doc.y;
  doc.strokeColor("#2563eb").lineWidth(1).moveTo(40, y).lineTo(555, y).stroke();
  doc.strokeColor("#2563eb").lineWidth(1).moveTo(40, y + 2).lineTo(555, y + 2).stroke();
  doc.moveDown(0.8);
  doc.fillColor("#1e293b");
}

function drawSectionTitle(doc: PDFKit.PDFDocument, text: string): void {
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#475569").text(text.toUpperCase());
  doc.moveDown(0.2);
  const y = doc.y;
  doc.strokeColor("#e2e8f0").lineWidth(0.5).moveTo(40, y).lineTo(555, y).stroke();
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10).fillColor("#1e293b");
}

function drawKeyVal(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  x: number,
  y: number,
  width = 260
): void {
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748b").text(label, x, y, { width });
  doc.font("Helvetica").fontSize(10).fillColor("#1e293b").text(value, x, y + 11, { width });
}

/**
 * Render a simple bordered table. Columns is an array of {label, width, align}.
 * Rows is an array of string arrays.
 */
function drawTable(
  doc: PDFKit.PDFDocument,
  columns: { label: string; width: number; align?: "left" | "right" | "center" }[],
  rows: string[][]
): void {
  const startX = 40;
  let y = doc.y;
  const rowHeight = 18;

  // Header
  doc.rect(startX, y, 515, rowHeight).fill("#f1f5f9");
  doc.fillColor("#475569").font("Helvetica-Bold").fontSize(9);
  let cx = startX;
  columns.forEach((col) => {
    doc.text(col.label.toUpperCase(), cx + 4, y + 5, {
      width: col.width - 8,
      align: col.align || "left",
    });
    cx += col.width;
  });
  y += rowHeight;

  // Body
  doc.font("Helvetica").fontSize(9).fillColor("#1e293b");
  rows.forEach((row, idx) => {
    if (y > 760) {
      doc.addPage();
      y = doc.y;
    }
    if (idx % 2 === 0) {
      doc.rect(startX, y, 515, rowHeight).fill("#fafafa");
      doc.fillColor("#1e293b");
    }
    cx = startX;
    columns.forEach((col, ci) => {
      doc.text(row[ci] ?? "", cx + 4, y + 5, {
        width: col.width - 8,
        align: col.align || "left",
        ellipsis: true,
      });
      cx += col.width;
    });
    // Border
    doc.strokeColor("#e5e7eb").lineWidth(0.3)
      .moveTo(startX, y + rowHeight).lineTo(startX + 515, y + rowHeight).stroke();
    y += rowHeight;
  });
  doc.y = y + 4;
}

// ─── 1. PRESCRIPTION ────────────────────────────────────────

export async function generatePrescriptionPDFBuffer(
  prescriptionId: string
): Promise<Buffer> {
  const prescription = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      items: true,
      doctor: { include: { user: { select: { name: true, email: true, phone: true } } } },
      patient: { include: { user: { select: { name: true, phone: true, email: true } } } },
      appointment: true,
    },
  });
  if (!prescription) throw new Error("Prescription not found");

  const h = await getHospitalInfo();
  const patient = prescription.patient;
  const doctor = prescription.doctor;
  const items = prescription.items;

  const verifyUrl = `https://medcore.globusdemos.com/verify/rx/${prescription.id}`;
  // Real, scannable QR: PNG buffer at 200px so when drawn at ~120pt it stays
  // sharp and meets the >=100x100px scannability requirement.
  const qrBuffer = await QRCode.toBuffer(verifyUrl, {
    type: "png",
    errorCorrectionLevel: "M",
    width: 240,
    margin: 1,
  });

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const out = collectPdf(doc);

  drawLetterhead(doc, h);

  doc.font("Helvetica-Bold").fontSize(14).fillColor("#475569")
    .text("PRESCRIPTION", { align: "center" });
  doc.moveDown(0.6);

  // Two column patient/doctor block
  const topY = doc.y;
  drawKeyVal(doc, "Patient", patient.user.name, 40, topY);
  drawKeyVal(doc, "MR No.", patient.mrNumber, 40, topY + 28);
  drawKeyVal(doc, "Age / Gender",
    `${patient.age ?? "-"} / ${patient.gender}`, 40, topY + 56);

  drawKeyVal(doc, "Doctor", `Dr. ${doctor.user.name}`, 310, topY);
  drawKeyVal(doc, "Qualification", doctor.qualification || "-", 310, topY + 28);
  drawKeyVal(doc, "Date", formatDate(prescription.createdAt), 310, topY + 56);
  doc.y = topY + 90;

  // Diagnosis box
  doc.rect(40, doc.y, 515, 28).fill("#f1f5f9");
  doc.fillColor("#64748b").font("Helvetica-Bold").fontSize(9)
    .text("DIAGNOSIS", 48, doc.y - 24);
  doc.fillColor("#1e293b").font("Helvetica").fontSize(11)
    .text(prescription.diagnosis, 48, doc.y - 12, { width: 500 });
  doc.y = doc.y + 12;

  drawSectionTitle(doc, "Medications");
  drawTable(
    doc,
    [
      { label: "#", width: 25, align: "center" },
      { label: "Medicine", width: 150 },
      { label: "Dosage", width: 80 },
      { label: "Frequency", width: 80 },
      { label: "Duration", width: 80 },
      { label: "Instructions", width: 100 },
    ],
    items.map((it, idx) => [
      String(idx + 1),
      it.medicineName,
      it.dosage,
      it.frequency,
      it.duration,
      it.instructions || "-",
    ])
  );

  if (prescription.advice) {
    drawSectionTitle(doc, "Advice");
    doc.font("Helvetica").fontSize(10).fillColor("#1e293b")
      .text(prescription.advice, { width: 515 });
  }

  if (prescription.followUpDate) {
    doc.moveDown(0.5);
    doc.rect(40, doc.y, 515, 24).fill("#ecfdf5");
    doc.fillColor("#065f46").font("Helvetica-Bold").fontSize(10)
      .text(`Follow-up: ${formatDate(prescription.followUpDate)}`, 48, doc.y - 18);
    doc.y = doc.y + 8;
  }

  // Signature + QR side-by-side at bottom of content
  doc.moveDown(2);
  let qrY = doc.y;
  // Signature block (right)
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#1e293b")
    .text(`Dr. ${doctor.user.name}`, 380, qrY + 70, { width: 175, align: "center" });
  if (doctor.qualification) {
    doc.font("Helvetica").fontSize(8).fillColor("#64748b")
      .text(doctor.qualification, 380, qrY + 84, { width: 175, align: "center" });
  }
  doc.strokeColor("#475569").lineWidth(0.5)
    .moveTo(395, qrY + 65).lineTo(540, qrY + 65).stroke();

  // QR (left): real, scannable PNG embedded as image. 120pt = ~160px @ 96dpi
  // ensures phone cameras can resolve it.
  doc.image(qrBuffer, 40, qrY, { width: 100, height: 100 });
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#475569")
    .text("Authenticity Verification", 150, qrY + 4, { width: 220 });
  doc.font("Helvetica").fontSize(7).fillColor("#64748b")
    .text("Scan this QR or visit:", 150, qrY + 18, { width: 220 });
  doc.font("Courier").fontSize(7).fillColor("#2563eb")
    .text(verifyUrl, 150, qrY + 30, { width: 220 });
  doc.font("Helvetica").fontSize(7).fillColor("#94a3b8")
    .text(`Rx ID: ${prescription.id}`, 150, qrY + 50, { width: 220 });

  // Footer
  doc.font("Helvetica").fontSize(7).fillColor("#94a3b8")
    .text(`Digitally generated prescription - ${h.name}`, 40, 800, {
      align: "center",
      width: 515,
    });

  doc.end();
  return out;
}

// ─── 2. INVOICE ─────────────────────────────────────────────

export async function generateInvoicePDFBuffer(invoiceId: string): Promise<Buffer> {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      patient: {
        include: { user: { select: { name: true, phone: true, email: true } } },
      },
      items: true,
      payments: { orderBy: { paidAt: "asc" } },
    },
  });
  if (!inv) throw new Error("Invoice not found");

  const h = await getHospitalInfo();
  const p = inv.patient;
  // Issue #202 / #236: derive the canonical totals from the line items so
  // the footer Total = Subtotal + GST holds even when the persisted
  // `invoice.totalAmount` was stored without GST (legacy seed path). We
  // never echo a stale persisted Total — the PDF is the legal tax invoice
  // and must reconcile to the line breakdown above it.
  const totals = computeInvoiceTotals(inv.items, {
    subtotal: inv.subtotal,
    taxAmount: inv.taxAmount,
    cgstAmount: inv.cgstAmount,
    sgstAmount: inv.sgstAmount,
    discountAmount: inv.discountAmount,
    totalAmount: inv.totalAmount,
  });
  const taxable = totals.subtotal - inv.discountAmount - inv.packageDiscount;
  const paid = inv.payments.reduce((s, x) => s + x.amount, 0);
  const displayTotal = +(totals.totalAmount - inv.packageDiscount).toFixed(2);
  const balance = displayTotal - paid - inv.advanceApplied;

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const out = collectPdf(doc);
  drawLetterhead(doc, h);

  doc.font("Helvetica-Bold").fontSize(14).fillColor("#475569")
    .text("TAX INVOICE", { align: "center" });
  doc.moveDown(0.6);

  const topY = doc.y;
  drawKeyVal(doc, "Bill To", p.user.name, 40, topY);
  drawKeyVal(doc, "MR No.", p.mrNumber, 40, topY + 28);
  if (p.user.phone) drawKeyVal(doc, "Phone", p.user.phone, 40, topY + 56);
  drawKeyVal(doc, "Invoice #", inv.invoiceNumber, 310, topY);
  drawKeyVal(doc, "Date", formatDate(inv.createdAt), 310, topY + 28);
  // Issue #235: never render a "PAID" status when the balance is non-zero.
  drawKeyVal(
    doc,
    "Status",
    derivePaymentStatus(inv.paymentStatus, displayTotal, paid + inv.advanceApplied),
    310,
    topY + 56
  );
  doc.y = topY + 90;

  // Per-line GST breakdown — computed at render time via the shared
  // helper so older invoices (no persisted per-line tax columns) still
  // render correctly. Totals block still uses inv.cgstAmount/sgstAmount
  // when present; only the rows are computed here.
  const linesWithTax = inv.items.map((it) => ({
    it,
    tax: computeLineItemTax(it.amount, it.category),
  }));

  drawSectionTitle(doc, "Items");
  drawTable(
    doc,
    [
      { label: "#", width: 22, align: "center" },
      { label: "Description", width: 150 },
      { label: "HSN/SAC", width: 55, align: "center" },
      { label: "Qty", width: 32, align: "center" },
      { label: "Rate", width: 55, align: "right" },
      { label: "Taxable", width: 60, align: "right" },
      { label: "CGST", width: 50, align: "right" },
      { label: "SGST", width: 50, align: "right" },
      { label: "Total", width: 61, align: "right" },
    ],
    linesWithTax.map(({ it, tax }, idx) => [
      String(idx + 1),
      `${it.description} (${it.category})`,
      tax.hsnSac,
      String(it.quantity),
      it.unitPrice.toFixed(2),
      tax.taxable.toFixed(2),
      tax.cgst.toFixed(2),
      tax.sgst.toFixed(2),
      tax.total.toFixed(2),
    ])
  );

  // Aggregate GST sourced from the canonical totals helper so the
  // summary block always reconciles with both the line table above and
  // the highlighted "Total" row below (#202).
  const displayCgst = totals.cgstAmount;
  const displaySgst = totals.sgstAmount;

  // Totals (right-aligned narrow table)
  doc.moveDown(0.6);
  const totalsX = 320;
  const totalsW = 235;
  let ty = doc.y;
  const totalLine = (
    label: string,
    value: string,
    bold = false,
    color = "#1e293b"
  ) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(color);
    doc.text(label, totalsX, ty, { width: 130 });
    doc.text(value, totalsX + 130, ty, { width: 105, align: "right" });
    ty += 16;
  };
  totalLine("Subtotal", "Rs. " + totals.subtotal.toFixed(2));
  if (inv.packageDiscount > 0)
    totalLine("Package Discount", "-Rs. " + inv.packageDiscount.toFixed(2));
  if (inv.discountAmount > 0)
    totalLine("Discount", "-Rs. " + inv.discountAmount.toFixed(2));
  totalLine("Taxable Amount", "Rs. " + taxable.toFixed(2));
  totalLine("CGST", "Rs. " + displayCgst.toFixed(2));
  totalLine("SGST", "Rs. " + displaySgst.toFixed(2));
  if (inv.lateFeeAmount > 0)
    totalLine("Late Fee", "Rs. " + inv.lateFeeAmount.toFixed(2));
  // Highlight Total — sourced from `computeInvoiceTotals` so it always
  // equals Subtotal + GST - Discount, never a stale persisted figure.
  doc.rect(totalsX, ty - 2, totalsW, 18).fill("#f1f5f9");
  doc.fillColor("#1e293b");
  totalLine("Total", "Rs. " + displayTotal.toFixed(2), true);
  if (inv.advanceApplied > 0)
    totalLine("Advance Applied", "-Rs. " + inv.advanceApplied.toFixed(2));
  if (paid > 0) totalLine("Paid", "-Rs. " + paid.toFixed(2));
  totalLine("Balance", "Rs. " + balance.toFixed(2), true,
    balance > 0 ? "#dc2626" : "#16a34a");
  doc.y = ty + 8;

  // Amount in words
  doc.rect(40, doc.y, 515, 28).fill("#f1f5f9");
  doc.fillColor("#475569").font("Helvetica-Bold").fontSize(9)
    .text("AMOUNT IN WORDS", 48, doc.y - 24);
  doc.fillColor("#1e293b").font("Helvetica").fontSize(10)
    .text(numberToWordsIndian(displayTotal), 48, doc.y - 12, { width: 500 });
  doc.y = doc.y + 12;

  if (inv.payments.length > 0) {
    drawSectionTitle(doc, "Payment History");
    drawTable(
      doc,
      [
        { label: "Date", width: 140 },
        { label: "Mode", width: 100 },
        { label: "Reference", width: 175 },
        { label: "Amount", width: 100, align: "right" },
      ],
      inv.payments.map((pm) => [
        formatDateTime(pm.paidAt),
        pm.mode,
        pm.transactionId || "-",
        "Rs. " + pm.amount.toFixed(2),
      ])
    );
  }

  // Footer / terms
  doc.moveDown(1.5);
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#475569")
    .text("Terms & Conditions:", 40);
  doc.font("Helvetica").fontSize(8).fillColor("#64748b")
    .text("1. This is a computer-generated invoice and does not require physical signature.")
    .text("2. Payments are non-refundable except as per hospital policy.")
    .text("3. Subject to local jurisdiction.");

  doc.font("Helvetica").fontSize(7).fillColor("#94a3b8")
    .text(`For ${h.name} - Authorised Signatory`, 40, 800, {
      align: "right",
      width: 515,
    });

  doc.end();
  return out;
}

// ─── 3. DISCHARGE SUMMARY ───────────────────────────────────

export async function generateDischargeSummaryPDFBuffer(
  admissionId: string
): Promise<Buffer> {
  const admission = await prisma.admission.findUnique({
    where: { id: admissionId },
    include: {
      patient: { include: { user: { select: { name: true, phone: true } } } },
      doctor: { include: { user: { select: { name: true } } } },
      bed: { include: { ward: true } },
      labOrders: {
        include: {
          items: {
            include: {
              test: { select: { name: true } },
              results: true,
            },
          },
        },
      },
      medicationOrders: true,
    },
  });
  if (!admission) throw new Error("Admission not found");

  const h = await getHospitalInfo();
  const p = admission.patient;

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const out = collectPdf(doc);
  drawLetterhead(doc, h);

  doc.font("Helvetica-Bold").fontSize(14).fillColor("#475569")
    .text("DISCHARGE SUMMARY", { align: "center" });
  doc.moveDown(0.6);

  const topY = doc.y;
  drawKeyVal(doc, "Patient", p.user.name, 40, topY);
  drawKeyVal(doc, "MR No.", p.mrNumber, 40, topY + 28);
  drawKeyVal(doc, "Age / Gender",
    `${p.age ?? "-"} / ${p.gender}`, 40, topY + 56);

  drawKeyVal(doc, "Admission #", admission.admissionNumber, 310, topY);
  drawKeyVal(doc, "Admitted", formatDateTime(admission.admittedAt), 310, topY + 28);
  drawKeyVal(doc, "Discharged", formatDateTime(admission.dischargedAt), 310, topY + 56);
  doc.y = topY + 90;

  drawKeyVal(doc, "Ward / Bed",
    `${admission.bed.ward.name} / ${admission.bed.bedNumber}`, 40, doc.y);
  drawKeyVal(doc, "Attending Doctor",
    `Dr. ${admission.doctor.user.name}`, 310, doc.y);
  doc.y += 30;

  drawSectionTitle(doc, "Final Diagnosis");
  doc.rect(40, doc.y, 515, 30).fill("#f1f5f9");
  doc.fillColor("#1e293b").font("Helvetica").fontSize(10)
    .text(admission.finalDiagnosis || admission.diagnosis || "-", 48, doc.y - 24, {
      width: 500,
    });
  doc.y = doc.y + 12;

  drawSectionTitle(doc, "Reason for Admission / Chief Complaint");
  doc.font("Helvetica").fontSize(10).fillColor("#1e293b")
    .text(admission.reason || "-", { width: 515 });

  // Investigations
  const labRows: string[][] = [];
  admission.labOrders.forEach((o) => {
    o.items.forEach((it) => {
      const resultStr = it.results.length > 0
        ? it.results.map((r) =>
            `${r.parameter}: ${r.value}${r.unit ? " " + r.unit : ""}` +
            (r.flag !== "NORMAL" ? ` [${r.flag}]` : "")
          ).join(", ")
        : "Pending";
      labRows.push([
        it.test.name,
        o.orderNumber,
        formatDate(o.completedAt || o.orderedAt),
        resultStr,
      ]);
    });
  });
  if (labRows.length > 0) {
    drawSectionTitle(doc, "Investigations");
    drawTable(
      doc,
      [
        { label: "Test", width: 140 },
        { label: "Order #", width: 100 },
        { label: "Date", width: 90 },
        { label: "Result", width: 185 },
      ],
      labRows
    );
  }

  // Treatment Given
  if (admission.medicationOrders.length > 0) {
    drawSectionTitle(doc, "Treatment Given");
    drawTable(
      doc,
      [
        { label: "Medicine", width: 150 },
        { label: "Dosage", width: 80 },
        { label: "Frequency", width: 80 },
        { label: "Route", width: 70 },
        { label: "Period", width: 135 },
      ],
      admission.medicationOrders.map((m) => [
        m.medicineName,
        m.dosage,
        m.frequency,
        m.route,
        `${formatDate(m.startDate)} - ${m.endDate ? formatDate(m.endDate) : "-"}`,
      ])
    );
  }

  if (admission.treatmentGiven) {
    drawSectionTitle(doc, "Treatment Notes");
    doc.font("Helvetica").fontSize(10).fillColor("#1e293b")
      .text(admission.treatmentGiven, { width: 515 });
  }

  drawSectionTitle(doc, "Course in Hospital");
  doc.font("Helvetica").fontSize(10).fillColor("#1e293b")
    .text(admission.dischargeSummary || admission.dischargeNotes || "-", { width: 515 });

  drawSectionTitle(doc, "Condition at Discharge");
  doc.rect(40, doc.y, 515, 30).fill("#ecfdf5");
  doc.fillColor("#065f46").font("Helvetica").fontSize(10)
    .text(admission.conditionAtDischarge || "-", 48, doc.y - 24, { width: 500 });
  doc.y = doc.y + 12;

  if (admission.dischargeMedications) {
    drawSectionTitle(doc, "Discharge Medications");
    doc.rect(40, doc.y, 515, 50).fill("#fefce8");
    doc.fillColor("#78350f").font("Helvetica").fontSize(10)
      .text(admission.dischargeMedications, 48, doc.y - 44, { width: 500 });
    doc.y = doc.y + 12;
  }

  if (admission.followUpInstructions) {
    drawSectionTitle(doc, "Follow-up Instructions");
    doc.font("Helvetica").fontSize(10).fillColor("#1e293b")
      .text(admission.followUpInstructions, { width: 515 });
  }

  // Signature
  doc.moveDown(2);
  const sy = doc.y;
  doc.strokeColor("#475569").lineWidth(0.5)
    .moveTo(380, sy).lineTo(545, sy).stroke();
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#1e293b")
    .text(`Dr. ${admission.doctor.user.name}`, 380, sy + 4, { width: 165, align: "center" });
  doc.font("Helvetica").fontSize(8).fillColor("#64748b")
    .text("Attending Physician", 380, sy + 18, { width: 165, align: "center" });

  doc.font("Helvetica").fontSize(7).fillColor("#94a3b8")
    .text(`Discharge summary generated by ${h.name}`, 40, 800, {
      align: "center",
      width: 515,
    });

  doc.end();
  return out;
}

// ─── HTML helper: real PNG QR for backward-compat HTML view ──

/**
 * Returns a `data:image/png;base64,...` URL for embedding in the legacy
 * HTML prescription print view. Used by `pdf.ts` so the HTML path also
 * gets a real (scannable) QR instead of the fake CSS gradient.
 */
export async function generatePrescriptionQrDataUrl(
  prescriptionId: string
): Promise<string> {
  const verifyUrl = `https://medcore.globusdemos.com/verify/rx/${prescriptionId}`;
  return QRCode.toDataURL(verifyUrl, {
    type: "image/png",
    errorCorrectionLevel: "M",
    width: 200,
    margin: 1,
  });
}
