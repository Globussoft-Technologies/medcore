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
import { formatDoctorName } from "../lib/format-doctor-name";
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

// The "seller" identity printed on a document is PER TENANT — sourced from
// the hospital's own config (Settings → Branding), stored under tenant-scoped
// SystemConfig keys `tenant:<id>:hospital_*`, with Tenant.name as the canonical
// hospital name. Previously read GLOBAL `hospital_*` keys, so every tenant's
// PDF showed the seeded demo hospital instead of its own. No tenant context →
// neutral fallback (never another tenant's details).
const HOSPITAL_KEYS = [
  "hospital_name",
  "hospital_address",
  "hospital_phone",
  "hospital_email",
  "hospital_gstin",
  "hospital_registration",
] as const;

async function getHospitalInfo(
  tenantId?: string | null,
): Promise<HospitalInfo> {
  const map: Record<string, string> = {};
  let tenantName: string | null = null;
  let isDefaultTenant = false;

  if (tenantId) {
    const prefix = `tenant:${tenantId}:`;
    const rows = await prisma.systemConfig.findMany({
      where: { key: { in: HOSPITAL_KEYS.map((s) => `${prefix}${s}`) } },
    });
    rows.forEach(
      (r: { key: string; value: string }) =>
        (map[r.key.slice(prefix.length)] = r.value),
    );
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, subdomain: true },
    });
    tenantName = tenant?.name ?? null;
    isDefaultTenant = tenant?.subdomain === "default";
  }

  // Seeded GLOBAL config only backfills the platform default/demo tenant (or a
  // no-tenant context). Real tenants never inherit the demo — unset fields stay
  // blank rather than printing another hospital's details.
  if (isDefaultTenant || !tenantId) {
    const globalRows = await prisma.systemConfig.findMany({
      where: { key: { in: [...HOSPITAL_KEYS] } },
    });
    globalRows.forEach((r: { key: string; value: string }) => {
      if (map[r.key] === undefined) map[r.key] = r.value;
    });
  }

  return {
    name: tenantName || map.hospital_name || "Hospital",
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
  // Vertical padding inside a cell (text is drawn 5pt below the row top, with
  // matching breathing room beneath). Issue #1111: rows must grow to fit
  // wrapped cell text (e.g. long "Instructions") instead of using a fixed
  // height — otherwise multi-line text overflows and overlaps the next row.
  const cellPadY = 5;

  // Header
  doc.rect(startX, y, 515, rowHeight).fill("#f1f5f9");
  doc.fillColor("#475569").font("Helvetica-Bold").fontSize(9);
  let cx = startX;
  columns.forEach((col) => {
    doc.text(col.label.toUpperCase(), cx + 4, y + cellPadY, {
      width: col.width - 8,
      align: col.align || "left",
    });
    cx += col.width;
  });
  y += rowHeight;

  // Body
  doc.font("Helvetica").fontSize(9).fillColor("#1e293b");
  rows.forEach((row, idx) => {
    // Measure the tallest cell so the row is exactly as tall as its content.
    const contentHeight = columns.reduce((max, col, ci) => {
      const h = doc.heightOfString(row[ci] ?? "", {
        width: col.width - 8,
        align: col.align || "left",
      });
      return Math.max(max, h);
    }, 0);
    const rowH = Math.max(rowHeight, contentHeight + cellPadY * 2);

    // Spill to a new page ONLY when this row genuinely won't fit within the
    // page's printable area (page height minus the bottom margin). Using the
    // real geometry — rather than a conservative constant — means a single
    // row that still fits never triggers a premature page break.
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    if (y + rowH > pageBottom) {
      doc.addPage();
      y = doc.y;
    }
    if (idx % 2 === 0) {
      doc.rect(startX, y, 515, rowH).fill("#fafafa");
      doc.fillColor("#1e293b");
    }
    cx = startX;
    columns.forEach((col, ci) => {
      doc.text(row[ci] ?? "", cx + 4, y + cellPadY, {
        width: col.width - 8,
        align: col.align || "left",
      });
      cx += col.width;
    });
    // Border
    doc.strokeColor("#e5e7eb").lineWidth(0.3)
      .moveTo(startX, y + rowH).lineTo(startX + 515, y + rowH).stroke();
    y += rowH;
  });
  doc.y = y + 4;
}

/**
 * Split a stored Rx `instructions` string ("Route: XX | Qty: NN | <notes>")
 * back into its structured pieces. Mirrors the web composer in
 * apps/web/src/lib/rx-form.ts. Legacy free-text (no Route:/Qty: prefix) all
 * lands in `notes`.
 */
function parseRxInstructions(raw: string | null | undefined): {
  route: string;
  quantity: string;
  notes: string;
} {
  const out = { route: "", quantity: "", notes: "" };
  if (!raw) return out;
  const notes: string[] = [];
  for (const seg of raw.split("|").map((s) => s.trim()).filter(Boolean)) {
    const r = seg.match(/^Route:\s*(.+)$/i);
    if (r) { out.route = r[1].trim(); continue; }
    const q = seg.match(/^Qty:\s*(.+)$/i);
    if (q) { out.quantity = q[1].trim(); continue; }
    notes.push(seg);
  }
  out.notes = notes.join(" | ");
  return out;
}

/**
 * Issue #1111: render the medications as a proper prescription block instead
 * of cramming "Route | Qty | notes" into a narrow 100pt column (which wrapped
 * into an unreadable vertical strip). Each medicine is one row with its own
 * Qty column; the route + instruction notes wrap full-width on a line BELOW
 * the medicine name. Rows grow to fit and paginate when they don't fit.
 */
function drawMedications(
  doc: PDFKit.PDFDocument,
  items: {
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions: string | null;
  }[]
): void {
  const startX = 40;
  const totalW = 515;
  const headerH = 18;
  const padY = 5;
  let y = doc.y;

  // x offsets are relative to startX; widths sum to totalW.
  const cols: {
    label: string;
    x: number;
    w: number;
    align?: "left" | "center" | "right";
  }[] = [
    { label: "#", x: 0, w: 25, align: "center" },
    { label: "Medicine", x: 25, w: 150 },
    { label: "Dosage", x: 175, w: 70 },
    { label: "Frequency", x: 245, w: 110 },
    { label: "Duration", x: 355, w: 70 },
    { label: "Qty", x: 425, w: 90, align: "center" },
  ];
  const detailX = startX + cols[1].x; // align the instruction line under "Medicine"
  const detailW = totalW - cols[1].x - 8;

  // Header
  doc.rect(startX, y, totalW, headerH).fill("#f1f5f9");
  doc.fillColor("#475569").font("Helvetica-Bold").fontSize(9);
  cols.forEach((c) =>
    doc.text(c.label.toUpperCase(), startX + c.x + 4, y + padY, {
      width: c.w - 8,
      align: c.align || "left",
    })
  );
  y += headerH;

  items.forEach((it, idx) => {
    const parsed = parseRxInstructions(it.instructions);
    const detailParts: string[] = [];
    if (parsed.route) detailParts.push(`Route: ${parsed.route}`);
    if (parsed.notes) detailParts.push(parsed.notes);
    const detail = detailParts.join("  •  ");

    const mainCells = [
      String(idx + 1),
      it.medicineName,
      it.dosage,
      it.frequency,
      it.duration,
      parsed.quantity || "-",
    ];

    // Height of the main (single-line-ish) row, then the wrapped detail line.
    doc.font("Helvetica").fontSize(9);
    const mainH = cols.reduce(
      (m, c, i) =>
        Math.max(
          m,
          doc.heightOfString(mainCells[i] ?? "", {
            width: c.w - 8,
            align: c.align || "left",
          })
        ),
      0
    );
    let detailH = 0;
    if (detail) {
      doc.font("Helvetica-Oblique").fontSize(8);
      detailH = doc.heightOfString(`Instructions: ${detail}`, { width: detailW });
    }
    const rowH = Math.max(
      headerH,
      mainH + (detail ? detailH + 3 : 0) + padY * 2
    );

    // Paginate only when this row genuinely won't fit.
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    if (y + rowH > pageBottom) {
      doc.addPage();
      y = doc.y;
    }

    if (idx % 2 === 0) {
      doc.rect(startX, y, totalW, rowH).fill("#fafafa");
    }

    // Main columns
    doc.font("Helvetica").fontSize(9).fillColor("#1e293b");
    cols.forEach((c, i) =>
      doc.text(mainCells[i] ?? "", startX + c.x + 4, y + padY, {
        width: c.w - 8,
        align: c.align || "left",
      })
    );

    // Instruction line under the medicine name
    if (detail) {
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#64748b").text(
        `Instructions: ${detail}`,
        detailX + 4,
        y + padY + mainH + 2,
        { width: detailW }
      );
    }

    doc.strokeColor("#e5e7eb").lineWidth(0.3)
      .moveTo(startX, y + rowH).lineTo(startX + totalW, y + rowH).stroke();
    y += rowH;
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

  const h = await getHospitalInfo(prescription.tenantId);
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

  // Doctor block aligned to the right edge of the content area (x=400..555).
  const docX = 400;
  const docW = 155;
  drawKeyVal(doc, "Doctor", formatDoctorName(doctor.user.name), docX, topY, docW);
  drawKeyVal(doc, "Qualification", doctor.qualification || "-", docX, topY + 28, docW);
  // Pearl ERP Stage 1 §2.1.4 — every signed Rx must carry the NMC
  // registration number. Renders "-" when blank so admins can spot
  // missing entries during pilot rollout.
  drawKeyVal(doc, "NMC Reg #", doctor.nmcRegNumber || "-", docX, topY + 56, docW);
  drawKeyVal(doc, "Date", formatDate(prescription.createdAt), docX, topY + 84, docW);
  doc.y = topY + 118;

  // Diagnosis box. Draw the box first, then the label + value INSIDE it
  // (top-down), sizing the box to the wrapped diagnosis text. The previous
  // version drew both strings at negative offsets above the box, which made
  // the "DIAGNOSIS" label and the value overlap ("diaGNOSIS").
  {
    const dy = doc.y;
    const diagnosis = prescription.diagnosis || "-";
    doc.font("Helvetica").fontSize(11);
    const valH = doc.heightOfString(diagnosis, { width: 499 });
    const boxH = 20 + valH + 8; // label row + value + bottom padding
    doc.rect(40, dy, 515, boxH).fill("#f1f5f9");
    doc.fillColor("#64748b").font("Helvetica-Bold").fontSize(9)
      .text("DIAGNOSIS", 48, dy + 6, { width: 499 });
    doc.fillColor("#1e293b").font("Helvetica").fontSize(11)
      .text(diagnosis, 48, dy + 20, { width: 499 });
    doc.y = dy + boxH + 10;
  }

  drawSectionTitle(doc, "Medications");
  drawMedications(doc, items);

  if (prescription.advice) {
    drawSectionTitle(doc, "Advice");
    doc.font("Helvetica").fontSize(10).fillColor("#1e293b")
      .text(prescription.advice, { width: 515 });
  }

  if (prescription.followUpDate) {
    doc.moveDown(0.5);
    // Draw the label INSIDE the box (was drawn 18pt above it, which overlapped
    // the Advice text sitting above).
    const fy = doc.y;
    const boxH = 24;
    doc.rect(40, fy, 515, boxH).fill("#ecfdf5");
    doc.fillColor("#065f46").font("Helvetica-Bold").fontSize(10)
      .text(`Follow-up: ${formatDate(prescription.followUpDate)}`, 48, fy + 7, {
        width: 499,
      });
    doc.y = fy + boxH + 8;
  }

  // Signature + QR side-by-side at bottom of content
  doc.moveDown(2);
  let qrY = doc.y;

  // Decode the stored signature (base64 PNG/JPEG data URL captured by the
  // web SignaturePad → persisted on Prescription.signatureUrl). PDFKit's
  // doc.image() takes either a path or a Buffer, NOT a data URL string, so
  // we strip the `data:image/...;base64,` prefix and decode. We only treat
  // values that match the data-URL shape; legacy `/uploads/sig.png` style
  // paths (and `null`) just skip the image render and fall back to the
  // empty signature line below — same as the pre-feature behaviour.
  let sigBuffer: Buffer | null = null;
  const rawSig = prescription.signatureUrl;
  if (rawSig && /^data:image\/(png|jpeg);base64,/.test(rawSig)) {
    try {
      const b64 = rawSig.replace(/^data:image\/(png|jpeg);base64,/, "");
      sigBuffer = Buffer.from(b64, "base64");
    } catch {
      // Defensive: malformed base64 just falls back to the empty signline.
      sigBuffer = null;
    }
  }

  // Signature block (right). Layout (relative to qrY):
  //   - signature IMAGE drawn from sigBuffer at y=18..62 (44pt tall, ~60px),
  //     same vertical region the original signline occupied,
  //   - thin underline at y=65 (kept even when signed — gives the
  //     signature a "line to sit on" cue),
  //   - "Dr. <name>" at y=70, qualification y=84, NMC y=96.
  if (sigBuffer) {
    try {
      doc.image(sigBuffer, 395, qrY + 18, {
        fit: [145, 44],
        align: "center",
        valign: "bottom",
      });
    } catch {
      // If pdfkit rejects the buffer (corrupt PNG / unsupported variant),
      // silently skip the image — the signline + name still render.
    }
  }
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#1e293b")
    .text(formatDoctorName(doctor.user.name), 380, qrY + 70, { width: 175, align: "center" });
  if (doctor.qualification) {
    doc.font("Helvetica").fontSize(8).fillColor("#64748b")
      .text(doctor.qualification, 380, qrY + 84, { width: 175, align: "center" });
  }
  // Pearl §2.1.4 — NMC reg # under the signature.
  if (doctor.nmcRegNumber) {
    doc.font("Helvetica").fontSize(8).fillColor("#64748b")
      .text(`NMC Reg #${doctor.nmcRegNumber}`, 380, qrY + 96, { width: 175, align: "center" });
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

  // Footer. Issue #1111: anchor it just inside the printable area (page
  // height minus bottom margin minus the line height) rather than a hardcoded
  // y=800. At y=800 a 7pt line spilled past the A4 bottom margin, which made
  // PDFKit auto-append a blank second page even for a one-line prescription.
  const footerY = doc.page.height - doc.page.margins.bottom - 12;
  doc.font("Helvetica").fontSize(7).fillColor("#94a3b8")
    .text(`Digitally generated prescription - ${h.name}`, 40, footerY, {
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

  const h = await getHospitalInfo(inv.tenantId);
  const p = inv.patient;
  // Issue #202 / #236: derive the canonical totals from the line items so
  // the footer Total = Subtotal + GST holds even when the persisted
  // `invoice.totalAmount` was stored without GST (legacy seed path). We
  // never echo a stale persisted Total — the PDF is the legal tax invoice
  // and must reconcile to the line breakdown above it.
  // Issue #901: Invoice money columns are now Prisma.Decimal. Coerce
  // each to a JS number once at the top so the rest of this renderer
  // (totals math, .toFixed formatting, balance display) stays unchanged.
  const numOf = (v: unknown): number => {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    const anyV = v as { toNumber?: () => number };
    return typeof anyV.toNumber === "function" ? anyV.toNumber() : Number(v);
  };
  const invSubtotal = numOf(inv.subtotal);
  const invTaxAmount = numOf(inv.taxAmount);
  const invCgstAmount = numOf(inv.cgstAmount);
  const invSgstAmount = numOf(inv.sgstAmount);
  const invDiscountAmount = numOf(inv.discountAmount);
  const invPackageDiscount = numOf(inv.packageDiscount);
  const invAdvanceApplied = numOf(inv.advanceApplied);
  const invLateFeeAmount = numOf(inv.lateFeeAmount);
  const invTotalAmount = numOf(inv.totalAmount);
  const itemsForTotals = inv.items.map((it) => ({
    amount: numOf(it.amount),
    category: it.category,
  }));
  const totals = computeInvoiceTotals(itemsForTotals, {
    subtotal: invSubtotal,
    taxAmount: invTaxAmount,
    cgstAmount: invCgstAmount,
    sgstAmount: invSgstAmount,
    discountAmount: invDiscountAmount,
    totalAmount: invTotalAmount,
  });
  const taxable = totals.subtotal - invDiscountAmount - invPackageDiscount;
  const paid = inv.payments.reduce((s, x) => s + x.amount, 0);
  const displayTotal = +(totals.totalAmount - invPackageDiscount).toFixed(2);
  const balance = displayTotal - paid - invAdvanceApplied;

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
    derivePaymentStatus(inv.paymentStatus, displayTotal, paid + invAdvanceApplied),
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
    tax: computeLineItemTax(numOf(it.amount), it.category),
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
      numOf(it.unitPrice).toFixed(2),
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
  if (invPackageDiscount > 0)
    totalLine("Package Discount", "-Rs. " + invPackageDiscount.toFixed(2));
  if (invDiscountAmount > 0)
    totalLine("Discount", "-Rs. " + invDiscountAmount.toFixed(2));
  totalLine("Taxable Amount", "Rs. " + taxable.toFixed(2));
  totalLine("CGST", "Rs. " + displayCgst.toFixed(2));
  totalLine("SGST", "Rs. " + displaySgst.toFixed(2));
  if (invLateFeeAmount > 0)
    totalLine("Late Fee", "Rs. " + invLateFeeAmount.toFixed(2));
  // Highlight Total — sourced from `computeInvoiceTotals` so it always
  // equals Subtotal + GST - Discount, never a stale persisted figure.
  doc.rect(totalsX, ty - 2, totalsW, 18).fill("#f1f5f9");
  doc.fillColor("#1e293b");
  totalLine("Total", "Rs. " + displayTotal.toFixed(2), true);
  if (invAdvanceApplied > 0)
    totalLine("Advance Applied", "-Rs. " + invAdvanceApplied.toFixed(2));
  if (paid > 0) totalLine("Paid", "-Rs. " + paid.toFixed(2));
  totalLine("Balance", "Rs. " + balance.toFixed(2), true,
    balance > 0 ? "#dc2626" : "#16a34a");
  doc.y = ty + 8;

  // Amount in words. Anchor everything to a single base Y and draw with
  // POSITIVE offsets inside the box — the old code used negative offsets
  // (doc.y - 24 / doc.y - 12) which put the label and the words ~12pt apart
  // and overlapped them when the totals block ended at certain heights.
  const wordsBoxY = doc.y;
  const wordsBoxH = 36;
  doc.rect(40, wordsBoxY, 515, wordsBoxH).fill("#f1f5f9");
  doc.fillColor("#475569").font("Helvetica-Bold").fontSize(8)
    .text("AMOUNT IN WORDS", 48, wordsBoxY + 6);
  doc.fillColor("#1e293b").font("Helvetica").fontSize(10)
    .text(numberToWordsIndian(displayTotal), 48, wordsBoxY + 18, { width: 500 });
  doc.y = wordsBoxY + wordsBoxH + 8;

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

  // Authorised-signatory line. Place it just below the Terms in the normal
  // content flow (with a small gap) instead of a hard Y=800 — that fixed
  // coordinate sat BELOW the A4 printable area (~770pt), so PDFKit pushed it
  // onto a second, otherwise-empty page. Clamp to the printable bottom so it
  // still sits near the foot of the page when the invoice is long.
  const signatoryBottom = doc.page.height - doc.page.margins.bottom - 10;
  const signatoryY = Math.min(doc.y + 24, signatoryBottom);
  doc.font("Helvetica").fontSize(7).fillColor("#94a3b8")
    .text(`For ${h.name} - Authorised Signatory`, 40, signatoryY, {
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

  const h = await getHospitalInfo(admission.tenantId);
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
    formatDoctorName(admission.doctor.user.name), 310, doc.y);
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
    .text(formatDoctorName(admission.doctor.user.name), 380, sy + 4, { width: 165, align: "center" });
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

export async function generatePatientQrDataUrl(
  patientId: string,
  _mrNumber: string
): Promise<string> {
  const verifyBase = (
    process.env.PUBLIC_APP_URL || "https://medcore.globusdemos.com"
  ).replace(/\/$/, "");
  const verifyUrl = `${verifyBase}/verify/patient/${patientId}`;
  return QRCode.toDataURL(verifyUrl, {
    type: "image/png",
    errorCorrectionLevel: "M",
    width: 160,
    margin: 1,
  });
}

// ─── Platform (subscription) invoice PDF ───────────────────────────────
// The tenant-facing "My Subscription" page downloads its platform invoices as
// a real PDF via this generator. Uses "Rs." (pdfkit's Helvetica lacks the ₹
// glyph). GST rate shown is derived from the stored amount / subtotal so it
// reflects whatever rate the invoice actually carries.
export interface PlatformInvoiceForPdf {
  invoiceNumber: string;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  issuedAt: Date | null;
  paidAt: Date | null;
  hsnSacCode: string;
  subtotalInPaise: number;
  cgstInPaise: number;
  sgstInPaise: number;
  igstInPaise: number;
  totalInPaise: number;
  tenant: { name: string; subdomain: string } | null;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceInPaise: number;
    amountInPaise: number;
  }>;
}

export async function generatePlatformInvoicePDFBuffer(
  inv: PlatformInvoiceForPdf,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const done = collectPdf(doc);
  const money = (p: number) => "Rs. " + (p / 100).toFixed(2);
  const pct = (g: number) =>
    inv.subtotalInPaise ? Math.round((g / inv.subtotalInPaise) * 100) : 0;

  // Header
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#4f46e5").text("MEDCORE", 40, 40);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#666")
    .text("Platform Subscription — Tax Invoice", 40, 64);
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor("#111")
    .text(inv.invoiceNumber, 400, 40, { align: "right", width: 155 });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#666")
    .text("Status: " + inv.status, 400, 62, { align: "right", width: 155 });

  doc.moveTo(40, 90).lineTo(555, 90).strokeColor("#4f46e5").lineWidth(2).stroke();

  // Billed-to + meta
  let y = 104;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text("Billed to", 40, y);
  doc.font("Helvetica").fontSize(10).text(inv.tenant?.name ?? "", 40, y + 14);
  doc.fontSize(9).fillColor("#666").text(inv.tenant?.subdomain ?? "", 40, y + 28);

  doc.fontSize(9).fillColor("#666");
  doc.text(
    `Period: ${formatDate(inv.periodStart)} - ${formatDate(inv.periodEnd)}`,
    300,
    y,
    { align: "right", width: 255 },
  );
  doc.text(`Issued: ${formatDate(inv.issuedAt)}`, 300, y + 12, {
    align: "right",
    width: 255,
  });
  if (inv.paidAt)
    doc.text(`Paid: ${formatDate(inv.paidAt)}`, 300, y + 24, {
      align: "right",
      width: 255,
    });
  doc.text(`HSN/SAC: ${inv.hsnSacCode}`, 300, y + 36, {
    align: "right",
    width: 255,
  });

  // Line-item header
  y = 168;
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#666");
  doc.text("DESCRIPTION", 40, y);
  doc.text("QTY", 320, y, { width: 50, align: "right" });
  doc.text("UNIT", 380, y, { width: 85, align: "right" });
  doc.text("AMOUNT", 475, y, { width: 80, align: "right" });
  y += 14;
  doc.moveTo(40, y).lineTo(555, y).strokeColor("#e5e7eb").lineWidth(1).stroke();
  y += 8;

  doc.font("Helvetica").fontSize(9).fillColor("#111");
  for (const li of inv.lineItems) {
    doc.text(li.description, 40, y, { width: 270 });
    doc.text(String(li.quantity), 320, y, { width: 50, align: "right" });
    doc.text(money(li.unitPriceInPaise), 380, y, { width: 85, align: "right" });
    doc.text(money(li.amountInPaise), 475, y, { width: 80, align: "right" });
    y += 18;
  }
  doc.moveTo(40, y).lineTo(555, y).strokeColor("#e5e7eb").stroke();
  y += 10;

  // Totals (right-aligned block)
  const totalLine = (label: string, val: string, bold = false) => {
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(bold ? 12 : 9)
      .fillColor("#111");
    doc.text(label, 340, y, { width: 130, align: "left" });
    doc.text(val, 475, y, { width: 80, align: "right" });
    y += bold ? 20 : 15;
  };
  totalLine("Subtotal", money(inv.subtotalInPaise));
  if (inv.cgstInPaise > 0)
    totalLine(`CGST (${pct(inv.cgstInPaise)}%)`, money(inv.cgstInPaise));
  if (inv.sgstInPaise > 0)
    totalLine(`SGST (${pct(inv.sgstInPaise)}%)`, money(inv.sgstInPaise));
  if (inv.igstInPaise > 0)
    totalLine(`IGST (${pct(inv.igstInPaise)}%)`, money(inv.igstInPaise));
  doc.moveTo(340, y).lineTo(555, y).strokeColor("#111").lineWidth(1).stroke();
  y += 8;
  totalLine("Total", money(inv.totalInPaise), true);

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#666")
    .text("This is a computer-generated invoice from MedCore.", 40, y + 30);

  doc.end();
  return done;
}
