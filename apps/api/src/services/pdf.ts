import { prisma } from "@medcore/db";
import { generatePrescriptionQrDataUrl } from "./pdf-generator";

// ─── Helpers ────────────────────────────────────────────

function escapeHtml(text: unknown): string {
  return (text ?? "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "—";
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
  rows.forEach((r) => (map[r.key] = r.value));
  return {
    name: map.hospital_name || "Hospital",
    address: map.hospital_address || "",
    phone: map.hospital_phone || "",
    email: map.hospital_email || "",
    gstin: map.hospital_gstin || "",
    registration: map.hospital_registration || "",
  };
}

function letterhead(h: HospitalInfo): string {
  return `
  <div style="text-align:center;border-bottom:3px double #2563eb;padding-bottom:14px;margin-bottom:18px;">
    <h1 style="font-size:24px;color:#2563eb;margin:0 0 4px;">${escapeHtml(h.name)}</h1>
    ${h.address ? `<p style="font-size:12px;color:#64748b;margin:2px 0;">${escapeHtml(h.address)}</p>` : ""}
    <p style="font-size:11px;color:#64748b;margin:2px 0;">
      ${h.phone ? `Phone: ${escapeHtml(h.phone)}` : ""}
      ${h.email ? ` &nbsp;|&nbsp; Email: ${escapeHtml(h.email)}` : ""}
    </p>
    <p style="font-size:11px;color:#94a3b8;margin:2px 0;">
      ${h.gstin ? `GSTIN: ${escapeHtml(h.gstin)}` : ""}
      ${h.registration ? ` &nbsp;|&nbsp; Reg. No: ${escapeHtml(h.registration)}` : ""}
    </p>
  </div>`;
}

function baseStyles(): string {
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Verdana, sans-serif; color: #1e293b; background: #fff; }
  .page { max-width: 820px; margin: 0 auto; padding: 36px; }
  table { width:100%; border-collapse: collapse; }
  th { background:#f8fafc; text-align:left; padding:8px 10px; font-size:11px; text-transform:uppercase; color:#64748b; border-bottom:2px solid #e2e8f0; }
  td { padding:7px 10px; border-bottom:1px solid #e5e7eb; font-size:13px; vertical-align:top; }
  h2.title { text-align:center; font-size:16px; text-transform:uppercase; letter-spacing:2px; color:#475569; margin-bottom:18px; }
  .section { margin-bottom:18px; }
  .section h3 { font-size:12px; color:#94a3b8; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; }
  .box { background:#f1f5f9; border-left:4px solid #2563eb; padding:10px 14px; border-radius:0 6px 6px 0; font-size:13px; }
  .signblock { display:flex; justify-content:flex-end; margin-top:36px; }
  .signblock .sig { text-align:center; }
  .signline { height:50px; width:200px; border-bottom:1px solid #333; margin-bottom:4px; }
  .footer { margin-top:30px; padding-top:10px; border-top:1px solid #e2e8f0; text-align:center; font-size:10px; color:#94a3b8; }
  @media print {
    .page { padding:18px; max-width:100%; }
    .no-print { display:none !important; }
  }
  `;
}

function htmlDoc(title: string, bodyContent: string, autoPrint = true): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>${baseStyles()}</style>
</head><body><div class="page">${bodyContent}
<div class="no-print" style="text-align:center;margin-top:24px;">
  <button onclick="window.print()" style="background:#2563eb;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;">Print / Save as PDF</button>
</div>
</div>${autoPrint ? `<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});</script>` : ""}
</body></html>`;
}

function numberToWordsIndian(num: number): string {
  if (num == null || isNaN(num)) return "Zero";
  num = Math.round(num);
  if (num === 0) return "Zero Rupees Only";
  const a = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const b = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];
  const inWords = (n: number): string => {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n / 10)] + (n % 10 ? " " + a[n % 10] : "");
    if (n < 1000)
      return (
        a[Math.floor(n / 100)] +
        " Hundred" +
        (n % 100 ? " " + inWords(n % 100) : "")
      );
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

// ─── 1. PRESCRIPTION (existing, enhanced with QR section) ────

export async function generatePrescriptionPDF(
  prescriptionId: string
): Promise<string> {
  const prescription = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      items: true,
      doctor: {
        include: { user: { select: { name: true, email: true, phone: true } } },
      },
      patient: {
        include: { user: { select: { name: true, phone: true, email: true } } },
      },
      appointment: true,
    },
  });

  if (!prescription) throw new Error("Prescription not found");

  const h = await getHospitalInfo();
  const patient = prescription.patient;
  const doctor = prescription.doctor;
  const items = prescription.items;
  const createdDate = formatDate(prescription.createdAt);
  const followUp = prescription.followUpDate
    ? formatDate(prescription.followUpDate)
    : null;

  const medicineRows = items
    .map(
      (item, idx) => `
      <tr>
        <td style="text-align:center;">${idx + 1}</td>
        <td style="font-weight:500;">${escapeHtml(item.medicineName)}</td>
        <td>${escapeHtml(item.dosage)}</td>
        <td>${escapeHtml(item.frequency)}</td>
        <td>${escapeHtml(item.duration)}</td>
        <td>${escapeHtml(item.instructions || "-")}</td>
      </tr>`
    )
    .join("\n");

  const sigBlock = prescription.signatureUrl
    ? `<img src="${escapeHtml(prescription.signatureUrl)}" alt="Signature" style="max-height:60px;margin-bottom:4px;" />`
    : `<div class="signline"></div>`;

  const verifyUrl = `https://medcore.globusdemos.com/verify/rx/${prescription.id}`;

  // Real, scannable QR code (PNG embedded as data URL). Falls back to a
  // text-only block if QR generation fails for any reason — better to ship
  // a printable Rx than to crash the request.
  let qrImgTag = "";
  try {
    const dataUrl = await generatePrescriptionQrDataUrl(prescription.id);
    qrImgTag = `<img src="${dataUrl}" alt="Verification QR" style="width:120px;height:120px;border:1px solid #e5e7eb;border-radius:4px;" />`;
  } catch {
    qrImgTag = `<div style="width:120px;height:120px;border:1px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:10px;color:#94a3b8;">QR unavailable</div>`;
  }

  const qrSection = `
  <div style="display:flex;align-items:center;gap:14px;margin-top:24px;padding:12px;border:1px dashed #cbd5e1;border-radius:6px;">
    ${qrImgTag}
    <div style="font-size:11px;color:#475569;">
      <p style="font-weight:600;margin-bottom:2px;">Authenticity Verification</p>
      <p>Scan this QR or visit:</p>
      <p style="font-family:monospace;color:#2563eb;word-break:break-all;">${escapeHtml(verifyUrl)}</p>
      <p style="margin-top:3px;color:#94a3b8;">Rx ID: ${escapeHtml(prescription.id)}</p>
    </div>
  </div>`;

  const body = `
  ${letterhead(h)}
  <h2 class="title">Prescription</h2>

  <div style="display:flex;justify-content:space-between;margin-bottom:18px;gap:20px;">
    <div style="flex:1;">
      <h3 style="font-size:11px;color:#94a3b8;text-transform:uppercase;margin-bottom:6px;">Patient Details</h3>
      <table style="font-size:13px;border:none;">
        <tr><td style="border:none;padding:2px 12px 2px 0;color:#64748b;">Name</td><td style="border:none;font-weight:600;">${escapeHtml(patient.user.name)}</td></tr>
        <tr><td style="border:none;padding:2px 12px 2px 0;color:#64748b;">MR No.</td><td style="border:none;">${escapeHtml(patient.mrNumber)}</td></tr>
        ${patient.age != null ? `<tr><td style="border:none;padding:2px 12px 2px 0;color:#64748b;">Age</td><td style="border:none;">${patient.age} yrs</td></tr>` : ""}
        <tr><td style="border:none;padding:2px 12px 2px 0;color:#64748b;">Gender</td><td style="border:none;">${escapeHtml(patient.gender)}</td></tr>
      </table>
    </div>
    <div style="flex:1;text-align:right;">
      <h3 style="font-size:11px;color:#94a3b8;text-transform:uppercase;margin-bottom:6px;">Doctor</h3>
      <p style="font-weight:600;">Dr. ${escapeHtml(doctor.user.name)}</p>
      ${doctor.qualification ? `<p style="font-size:12px;color:#64748b;">${escapeHtml(doctor.qualification)}</p>` : ""}
      ${doctor.specialization ? `<p style="font-size:12px;color:#64748b;">${escapeHtml(doctor.specialization)}</p>` : ""}
      <p style="font-size:12px;color:#64748b;margin-top:4px;">Date: ${createdDate}</p>
    </div>
  </div>

  <div class="box" style="margin-bottom:16px;">
    <span style="font-size:11px;color:#64748b;text-transform:uppercase;">Diagnosis</span>
    <p style="font-size:14px;font-weight:500;margin-top:3px;">${escapeHtml(prescription.diagnosis)}</p>
  </div>

  <table style="margin-bottom:18px;">
    <thead><tr>
      <th style="text-align:center;">#</th><th>Medicine</th><th>Dosage</th><th>Frequency</th><th>Duration</th><th>Instructions</th>
    </tr></thead>
    <tbody>${medicineRows}</tbody>
  </table>

  ${prescription.advice ? `<div class="section"><h3>Advice</h3><p style="font-size:13px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(prescription.advice)}</p></div>` : ""}

  ${followUp ? `<div class="box" style="background:#ecfdf5;border-left-color:#059669;margin-bottom:18px;"><strong>Follow-up:</strong> ${followUp}</div>` : ""}

  <div class="signblock">
    <div class="sig">
      ${sigBlock}
      <p style="font-weight:600;font-size:13px;">Dr. ${escapeHtml(doctor.user.name)}</p>
      ${doctor.qualification ? `<p style="font-size:11px;color:#64748b;">${escapeHtml(doctor.qualification)}</p>` : ""}
    </div>
  </div>

  ${qrSection}

  <div class="footer">Digitally generated prescription — ${escapeHtml(h.name)}</div>
  `;

  return htmlDoc(`Prescription - ${patient.user.name}`, body, false);
}

// ─── 2. DISCHARGE SUMMARY ────────────────────────────────

export async function generateDischargeSummaryHTML(
  admissionId: string
): Promise<string> {
  const admission = await prisma.admission.findUnique({
    where: { id: admissionId },
    include: {
      patient: { include: { user: { select: { name: true, phone: true } } } },
      doctor: {
        include: {
          user: { select: { name: true } },
        },
      },
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

  const labRows = admission.labOrders
    .flatMap((o) =>
      o.items.map(
        (it) => `
      <tr>
        <td>${escapeHtml(it.test.name)}</td>
        <td>${escapeHtml(o.orderNumber)}</td>
        <td>${formatDate(o.completedAt || o.orderedAt)}</td>
        <td>${
          it.results.length > 0
            ? it.results
                .map(
                  (r) =>
                    `${escapeHtml(r.parameter)}: ${escapeHtml(r.value)}${r.unit ? " " + escapeHtml(r.unit) : ""}${r.flag !== "NORMAL" ? ` <span style="color:#dc2626;">[${escapeHtml(r.flag)}]</span>` : ""}`
                )
                .join("<br/>")
            : "Pending"
        }</td>
      </tr>`
      )
    )
    .join("");

  const medRows = admission.medicationOrders
    .map(
      (m) => `
    <tr>
      <td>${escapeHtml(m.medicineName)}</td>
      <td>${escapeHtml(m.dosage)}</td>
      <td>${escapeHtml(m.frequency)}</td>
      <td>${escapeHtml(m.route)}</td>
      <td>${formatDate(m.startDate)} → ${m.endDate ? formatDate(m.endDate) : "—"}</td>
    </tr>`
    )
    .join("");

  const dischargeMedsTable = admission.dischargeMedications
    ? `<div class="section"><h3>Discharge Medications</h3><div style="font-size:13px;white-space:pre-wrap;background:#fefce8;border-left:4px solid #ca8a04;padding:10px 14px;border-radius:0 6px 6px 0;">${escapeHtml(admission.dischargeMedications)}</div></div>`
    : "";

  const body = `
  ${letterhead(h)}
  <h2 class="title">Discharge Summary</h2>

  <div style="display:flex;gap:20px;margin-bottom:18px;">
    <div style="flex:1;font-size:13px;">
      <p><strong>Patient:</strong> ${escapeHtml(p.user.name)}</p>
      <p><strong>MR No.:</strong> ${escapeHtml(p.mrNumber)}</p>
      <p><strong>Age / Gender:</strong> ${p.age ?? "—"} / ${escapeHtml(p.gender)}</p>
      ${p.address ? `<p><strong>Address:</strong> ${escapeHtml(p.address)}</p>` : ""}
      ${p.user.phone ? `<p><strong>Phone:</strong> ${escapeHtml(p.user.phone)}</p>` : ""}
    </div>
    <div style="flex:1;font-size:13px;">
      <p><strong>Admission #:</strong> ${escapeHtml(admission.admissionNumber)}</p>
      <p><strong>Admitted:</strong> ${formatDateTime(admission.admittedAt)}</p>
      <p><strong>Discharged:</strong> ${formatDateTime(admission.dischargedAt)}</p>
      <p><strong>Ward / Bed:</strong> ${escapeHtml(admission.bed.ward.name)} / ${escapeHtml(admission.bed.bedNumber)}</p>
      <p><strong>Attending Doctor:</strong> Dr. ${escapeHtml(admission.doctor.user.name)}</p>
    </div>
  </div>

  <div class="section"><h3>Final Diagnosis</h3>
    <div class="box">${escapeHtml(admission.finalDiagnosis || admission.diagnosis || "—")}</div>
  </div>

  <div class="section"><h3>Reason for Admission / Chief Complaint</h3>
    <p style="font-size:13px;white-space:pre-wrap;">${escapeHtml(admission.reason)}</p>
  </div>

  ${
    labRows
      ? `<div class="section"><h3>Investigations</h3>
    <table><thead><tr><th>Test</th><th>Order #</th><th>Date</th><th>Result</th></tr></thead><tbody>${labRows}</tbody></table>
  </div>`
      : ""
  }

  ${
    medRows
      ? `<div class="section"><h3>Treatment Given</h3>
    <table><thead><tr><th>Medicine</th><th>Dosage</th><th>Frequency</th><th>Route</th><th>Period</th></tr></thead><tbody>${medRows}</tbody></table>
  </div>`
      : ""
  }

  ${admission.treatmentGiven ? `<div class="section"><h3>Treatment Notes</h3><p style="font-size:13px;white-space:pre-wrap;">${escapeHtml(admission.treatmentGiven)}</p></div>` : ""}

  <div class="section"><h3>Course in Hospital</h3>
    <p style="font-size:13px;white-space:pre-wrap;">${escapeHtml(admission.dischargeSummary || admission.dischargeNotes || "—")}</p>
  </div>

  <div class="section"><h3>Condition at Discharge</h3>
    <div class="box" style="background:#ecfdf5;border-left-color:#059669;">${escapeHtml(admission.conditionAtDischarge || "—")}</div>
  </div>

  ${dischargeMedsTable}

  ${admission.followUpInstructions ? `<div class="section"><h3>Follow-up Instructions</h3><p style="font-size:13px;white-space:pre-wrap;">${escapeHtml(admission.followUpInstructions)}</p></div>` : ""}

  <div class="signblock">
    <div class="sig">
      <div class="signline"></div>
      <p style="font-weight:600;font-size:13px;">Dr. ${escapeHtml(admission.doctor.user.name)}</p>
      <p style="font-size:11px;color:#64748b;">Attending Physician</p>
    </div>
  </div>

  <div class="footer">Discharge summary generated by ${escapeHtml(h.name)}</div>
  `;

  return htmlDoc(`Discharge Summary - ${p.user.name}`, body);
}

// ─── 3. LAB REPORT ───────────────────────────────────────

export async function generateLabReportHTML(
  labOrderId: string
): Promise<string> {
  const order = await prisma.labOrder.findUnique({
    where: { id: labOrderId },
    include: {
      patient: {
        include: { user: { select: { name: true, phone: true } } },
      },
      doctor: { include: { user: { select: { name: true } } } },
      items: {
        include: {
          test: true,
          results: { orderBy: { reportedAt: "asc" } },
        },
      },
    },
  });
  if (!order) throw new Error("Lab order not found");

  const h = await getHospitalInfo();
  const p = order.patient;

  const flagColor = (flag: string): string => {
    if (flag === "CRITICAL") return "background:#fee2e2;color:#991b1b;font-weight:600;";
    if (flag === "HIGH" || flag === "LOW") return "background:#fef3c7;color:#92400e;font-weight:600;";
    return "color:#16a34a;";
  };

  const testSections = order.items
    .map((item) => {
      const resultRows = item.results
        .map(
          (r) => `
        <tr>
          <td>${escapeHtml(r.parameter)}</td>
          <td><strong>${escapeHtml(r.value)}</strong></td>
          <td>${escapeHtml(r.unit || "—")}</td>
          <td>${escapeHtml(r.normalRange || item.test.normalRange || "—")}</td>
          <td><span style="padding:2px 8px;border-radius:10px;${flagColor(r.flag)}">${escapeHtml(r.flag)}</span></td>
        </tr>`
        )
        .join("");
      return `
      <div class="section" style="border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:14px;">
        <h3 style="color:#1e293b;font-size:14px;margin-bottom:8px;">${escapeHtml(item.test.name)} <span style="color:#94a3b8;font-size:11px;">(${escapeHtml(item.test.code)})</span></h3>
        ${item.test.category ? `<p style="font-size:11px;color:#64748b;margin-bottom:8px;">Category: ${escapeHtml(item.test.category)}${item.test.sampleType ? ` • Sample: ${escapeHtml(item.test.sampleType)}` : ""}</p>` : ""}
        ${
          resultRows
            ? `<table><thead><tr><th>Parameter</th><th>Value</th><th>Unit</th><th>Normal Range</th><th>Flag</th></tr></thead><tbody>${resultRows}</tbody></table>`
            : `<p style="font-size:12px;color:#94a3b8;">Pending</p>`
        }
      </div>`;
    })
    .join("");

  const verifiedBy = order.items
    .flatMap((i) => i.results.map((r) => r.verifiedBy))
    .filter(Boolean)[0];

  let verifierName: string | null = null;
  if (verifiedBy) {
    const u = await prisma.user.findUnique({
      where: { id: verifiedBy as string },
      select: { name: true },
    });
    verifierName = u?.name || null;
  }

  const body = `
  ${letterhead(h)}
  <h2 class="title">Laboratory Report</h2>

  <div style="display:flex;gap:20px;margin-bottom:16px;font-size:13px;">
    <div style="flex:1;">
      <p><strong>Order #:</strong> ${escapeHtml(order.orderNumber)}</p>
      <p><strong>Patient:</strong> ${escapeHtml(p.user.name)}</p>
      <p><strong>MR No.:</strong> ${escapeHtml(p.mrNumber)}</p>
      <p><strong>Age / Gender:</strong> ${p.age ?? "—"} / ${escapeHtml(p.gender)}</p>
    </div>
    <div style="flex:1;">
      <p><strong>Referring Doctor:</strong> Dr. ${escapeHtml(order.doctor.user.name)}</p>
      <p><strong>Ordered:</strong> ${formatDateTime(order.orderedAt)}</p>
      <p><strong>Collected:</strong> ${formatDateTime(order.collectedAt)}</p>
      <p><strong>Completed:</strong> ${formatDateTime(order.completedAt)}</p>
      <p><strong>Status:</strong> ${escapeHtml(order.status)}</p>
    </div>
  </div>

  ${testSections}

  <div style="display:flex;justify-content:space-between;margin-top:36px;">
    <div style="text-align:center;">
      <div class="signline"></div>
      <p style="font-size:12px;font-weight:600;">Lab Technician</p>
    </div>
    <div style="text-align:center;">
      <div class="signline"></div>
      <p style="font-size:12px;font-weight:600;">${verifierName ? "Dr. " + escapeHtml(verifierName) : "Verified By"}</p>
      <p style="font-size:10px;color:#64748b;">Pathologist</p>
    </div>
  </div>

  <div class="footer" style="margin-top:30px;">
    <p>This report is generated electronically. Results should be interpreted in clinical context.</p>
    <p>Report generated on ${formatDateTime(new Date())} by ${escapeHtml(h.name)}</p>
  </div>
  `;

  return htmlDoc(`Lab Report - ${order.orderNumber}`, body);
}

// ─── 4. INVOICE / TAX INVOICE ────────────────────────────

export async function generateInvoicePDF(invoiceId: string): Promise<string> {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      patient: { include: { user: { select: { name: true, phone: true, email: true } } } },
      items: true,
      payments: { orderBy: { paidAt: "asc" } },
    },
  });
  if (!inv) throw new Error("Invoice not found");

  const h = await getHospitalInfo();
  const p = inv.patient;

  const itemRows = inv.items
    .map(
      (it, idx) => `
    <tr>
      <td style="text-align:center;">${idx + 1}</td>
      <td>${escapeHtml(it.description)}</td>
      <td>${escapeHtml(it.category)}</td>
      <td style="text-align:center;">—</td>
      <td style="text-align:center;">${it.quantity}</td>
      <td style="text-align:right;">${it.unitPrice.toFixed(2)}</td>
      <td style="text-align:right;">${it.amount.toFixed(2)}</td>
    </tr>`
    )
    .join("");

  const taxable = inv.subtotal - inv.discountAmount - inv.packageDiscount;
  const paid = inv.payments.reduce((s, x) => s + x.amount, 0);
  const balance = inv.totalAmount - paid - inv.advanceApplied;

  const paymentRows = inv.payments
    .map(
      (pm) => `
    <tr>
      <td>${formatDateTime(pm.paidAt)}</td>
      <td>${escapeHtml(pm.mode)}</td>
      <td>${escapeHtml(pm.transactionId || "—")}</td>
      <td style="text-align:right;">₹${pm.amount.toFixed(2)}</td>
    </tr>`
    )
    .join("");

  const body = `
  ${letterhead(h)}
  <h2 class="title">Tax Invoice</h2>

  <div style="display:flex;gap:20px;margin-bottom:16px;font-size:13px;">
    <div style="flex:1;">
      <h3 style="font-size:11px;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;">Bill To</h3>
      <p style="font-weight:600;">${escapeHtml(p.user.name)}</p>
      <p>MR: ${escapeHtml(p.mrNumber)}</p>
      ${p.address ? `<p>${escapeHtml(p.address)}</p>` : ""}
      ${p.user.phone ? `<p>Phone: ${escapeHtml(p.user.phone)}</p>` : ""}
    </div>
    <div style="flex:1;text-align:right;">
      <p><strong>Invoice #:</strong> ${escapeHtml(inv.invoiceNumber)}</p>
      <p><strong>Date:</strong> ${formatDate(inv.createdAt)}</p>
      ${inv.dueDate ? `<p><strong>Due Date:</strong> ${formatDate(inv.dueDate)}</p>` : ""}
      <p><strong>Status:</strong> ${escapeHtml(inv.paymentStatus)}</p>
    </div>
  </div>

  <table style="margin-bottom:14px;">
    <thead><tr>
      <th style="text-align:center;">#</th>
      <th>Description</th>
      <th>Category</th>
      <th style="text-align:center;">HSN/SAC</th>
      <th style="text-align:center;">Qty</th>
      <th style="text-align:right;">Unit Price</th>
      <th style="text-align:right;">Amount</th>
    </tr></thead>
    <tbody>${itemRows}</tbody>
  </table>

  <div style="display:flex;justify-content:flex-end;margin-bottom:14px;">
    <table style="width:340px;font-size:13px;">
      <tr><td>Subtotal</td><td style="text-align:right;">₹${inv.subtotal.toFixed(2)}</td></tr>
      ${inv.packageDiscount > 0 ? `<tr><td>Package Discount</td><td style="text-align:right;">-₹${inv.packageDiscount.toFixed(2)}</td></tr>` : ""}
      ${inv.discountAmount > 0 ? `<tr><td>Discount</td><td style="text-align:right;">-₹${inv.discountAmount.toFixed(2)}</td></tr>` : ""}
      <tr><td>Taxable Amount</td><td style="text-align:right;">₹${taxable.toFixed(2)}</td></tr>
      <tr><td>CGST</td><td style="text-align:right;">₹${inv.cgstAmount.toFixed(2)}</td></tr>
      <tr><td>SGST</td><td style="text-align:right;">₹${inv.sgstAmount.toFixed(2)}</td></tr>
      ${inv.lateFeeAmount > 0 ? `<tr><td>Late Fee</td><td style="text-align:right;">₹${inv.lateFeeAmount.toFixed(2)}</td></tr>` : ""}
      <tr style="background:#f1f5f9;font-weight:700;font-size:14px;">
        <td>Total</td><td style="text-align:right;">₹${inv.totalAmount.toFixed(2)}</td>
      </tr>
      ${inv.advanceApplied > 0 ? `<tr><td>Advance Applied</td><td style="text-align:right;">-₹${inv.advanceApplied.toFixed(2)}</td></tr>` : ""}
      ${paid > 0 ? `<tr><td>Paid</td><td style="text-align:right;">-₹${paid.toFixed(2)}</td></tr>` : ""}
      <tr style="font-weight:700;color:${balance > 0 ? "#dc2626" : "#16a34a"};">
        <td>Balance</td><td style="text-align:right;">₹${balance.toFixed(2)}</td>
      </tr>
    </table>
  </div>

  <div class="box" style="margin-bottom:14px;font-size:12px;">
    <strong>Amount in Words:</strong> ${escapeHtml(numberToWordsIndian(inv.totalAmount))}
  </div>

  ${
    paymentRows
      ? `<div class="section"><h3>Payment History</h3>
    <table><thead><tr><th>Date</th><th>Mode</th><th>Reference</th><th style="text-align:right;">Amount</th></tr></thead><tbody>${paymentRows}</tbody></table>
  </div>`
      : ""
  }

  <div class="footer" style="text-align:left;">
    <p style="font-weight:600;color:#475569;margin-bottom:4px;">Terms &amp; Conditions:</p>
    <p>1. This is a computer-generated invoice and does not require physical signature.</p>
    <p>2. Payments are non-refundable except as per hospital policy.</p>
    <p>3. Subject to local jurisdiction.</p>
  </div>

  <div class="signblock">
    <div class="sig">
      <div class="signline"></div>
      <p style="font-size:12px;font-weight:600;">Authorised Signatory</p>
      <p style="font-size:10px;color:#64748b;">For ${escapeHtml(h.name)}</p>
    </div>
  </div>
  `;

  return htmlDoc(`Invoice ${inv.invoiceNumber}`, body);
}

// ─── 5. PAY SLIP ─────────────────────────────────────────

export async function generatePaySlipHTML(
  userId: string,
  monthYYYYMM: string
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");
  const h = await getHospitalInfo();

  const [yearStr, monthStr] = monthYYYYMM.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  const shifts = await prisma.staffShift.findMany({
    where: { userId, date: { gte: start, lte: end } },
  });
  const presentDays = shifts.filter(
    (s) => s.status === "PRESENT" || s.status === "LATE"
  ).length;
  const leaveDays = shifts.filter((s) => s.status === "LEAVE").length;
  const absentDays = shifts.filter((s) => s.status === "ABSENT").length;
  const scheduledDays = shifts.length;

  // Default earnings/deductions structure (no Payroll model)
  const basic = 30000;
  const hra = 12000;
  const da = 3000;
  const medical = 1250;
  const transport = 1600;
  const grossEarnings = basic + hra + da + medical + transport;

  const pf = Math.round(basic * 0.12);
  const esi = Math.round(grossEarnings * 0.0075);
  const tax = 0;
  const otherDed = 0;
  const totalDed = pf + esi + tax + otherDed;
  const net = grossEarnings - totalDed;

  const monthName = start.toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });

  const body = `
  ${letterhead(h)}
  <h2 class="title">Salary Slip</h2>
  <p style="text-align:center;color:#64748b;font-size:13px;margin-bottom:16px;">For the month of <strong>${escapeHtml(monthName)}</strong></p>

  <div style="display:flex;gap:20px;margin-bottom:16px;font-size:13px;">
    <div style="flex:1;">
      <p><strong>Employee Name:</strong> ${escapeHtml(user.name)}</p>
      <p><strong>Employee ID:</strong> ${escapeHtml(user.id.slice(0, 8).toUpperCase())}</p>
      <p><strong>Designation / Role:</strong> ${escapeHtml(user.role)}</p>
      <p><strong>Email:</strong> ${escapeHtml(user.email)}</p>
    </div>
    <div style="flex:1;">
      <p><strong>Pay Period:</strong> ${escapeHtml(monthName)}</p>
      <p><strong>Days Worked:</strong> ${presentDays} / ${scheduledDays || "—"}</p>
      <p><strong>Leave Days:</strong> ${leaveDays}</p>
      <p><strong>Absent Days:</strong> ${absentDays}</p>
    </div>
  </div>

  <div style="display:flex;gap:14px;">
    <div style="flex:1;">
      <h3 style="font-size:12px;color:#16a34a;text-transform:uppercase;margin-bottom:4px;">Earnings</h3>
      <table>
        <tr><td>Basic Salary</td><td style="text-align:right;">₹${basic.toFixed(2)}</td></tr>
        <tr><td>HRA</td><td style="text-align:right;">₹${hra.toFixed(2)}</td></tr>
        <tr><td>DA</td><td style="text-align:right;">₹${da.toFixed(2)}</td></tr>
        <tr><td>Medical Allowance</td><td style="text-align:right;">₹${medical.toFixed(2)}</td></tr>
        <tr><td>Transport Allowance</td><td style="text-align:right;">₹${transport.toFixed(2)}</td></tr>
        <tr style="background:#f0fdf4;font-weight:700;"><td>Gross Earnings</td><td style="text-align:right;">₹${grossEarnings.toFixed(2)}</td></tr>
      </table>
    </div>
    <div style="flex:1;">
      <h3 style="font-size:12px;color:#dc2626;text-transform:uppercase;margin-bottom:4px;">Deductions</h3>
      <table>
        <tr><td>Provident Fund (PF)</td><td style="text-align:right;">₹${pf.toFixed(2)}</td></tr>
        <tr><td>ESI</td><td style="text-align:right;">₹${esi.toFixed(2)}</td></tr>
        <tr><td>Income Tax</td><td style="text-align:right;">₹${tax.toFixed(2)}</td></tr>
        <tr><td>Other Deductions</td><td style="text-align:right;">₹${otherDed.toFixed(2)}</td></tr>
        <tr style="background:#fef2f2;font-weight:700;"><td>Total Deductions</td><td style="text-align:right;">₹${totalDed.toFixed(2)}</td></tr>
      </table>
    </div>
  </div>

  <div class="box" style="margin-top:18px;background:#eff6ff;border-left-color:#2563eb;font-size:14px;">
    <strong>Net Pay:</strong> ₹${net.toFixed(2)}<br/>
    <span style="font-size:12px;color:#475569;">${escapeHtml(numberToWordsIndian(net))}</span>
  </div>

  <div class="signblock">
    <div class="sig">
      <div class="signline"></div>
      <p style="font-size:12px;font-weight:600;">Authorised Signatory (HR)</p>
    </div>
  </div>

  <div class="footer">This is a computer-generated payslip and does not require signature.</div>
  `;

  return htmlDoc(`Pay Slip - ${user.name} - ${monthName}`, body);
}

// ─── 6. PATIENT ID CARD ─────────────────────────────────

export async function generatePatientIdCardHTML(
  patientId: string
): Promise<string> {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: { user: { select: { name: true, phone: true } } },
  });
  if (!patient) throw new Error("Patient not found");
  const h = await getHospitalInfo();

  const photo = patient.photoUrl
    ? `<img src="${escapeHtml(patient.photoUrl)}" alt="Photo" style="width:60px;height:75px;object-fit:cover;border:1px solid #e2e8f0;" />`
    : `<div style="width:60px;height:75px;background:#e2e8f0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:10px;">PHOTO</div>`;

  const body = `
  <div style="display:flex;justify-content:center;padding:24px;">
    <div style="width:340px;height:220px;border:2px solid #2563eb;border-radius:10px;padding:14px;font-family:Arial,sans-serif;background:linear-gradient(135deg,#fff 0%,#f0f9ff 100%);">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #2563eb;padding-bottom:5px;margin-bottom:8px;">
        <div>
          <div style="font-size:12px;font-weight:700;color:#2563eb;">${escapeHtml(h.name)}</div>
          <div style="font-size:8px;color:#64748b;">PATIENT ID CARD</div>
        </div>
        <div style="width:30px;height:30px;background:#2563eb;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;">+</div>
      </div>
      <div style="display:flex;gap:10px;">
        ${photo}
        <div style="flex:1;font-size:10px;line-height:1.5;">
          <div style="font-weight:700;font-size:12px;color:#1e293b;">${escapeHtml(patient.user.name)}</div>
          <div><strong>MR#:</strong> ${escapeHtml(patient.mrNumber)}</div>
          <div><strong>Age/Sex:</strong> ${patient.age ?? "—"} / ${escapeHtml(patient.gender)}</div>
          ${patient.bloodGroup ? `<div><strong>Blood:</strong> ${escapeHtml(patient.bloodGroup)}</div>` : ""}
          ${patient.emergencyContactPhone ? `<div><strong>Emerg:</strong> ${escapeHtml(patient.emergencyContactPhone)}</div>` : ""}
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:6px;">
        <div style="width:42px;height:42px;background:repeating-linear-gradient(0deg,#000 0 3px,#fff 3px 6px),repeating-linear-gradient(90deg,#000 0 3px,transparent 3px 6px);border:1px solid #000;"></div>
        <div style="font-size:8px;color:#64748b;text-align:right;">
          <div>Issued: ${formatDate(patient.user ? new Date() : new Date())}</div>
          ${h.phone ? `<div>${escapeHtml(h.phone)}</div>` : ""}
        </div>
      </div>
    </div>
  </div>
  <style>@page { size: 90mm 60mm; margin: 0; }</style>
  `;

  return htmlDoc(`ID Card - ${patient.user.name}`, body);
}

// ─── 7. VITALS HISTORY (enhanced) ───────────────────────

export async function generateVitalsHistoryHTML(
  patientId: string,
  from?: string,
  to?: string
): Promise<string> {
  const where: Record<string, unknown> = { patientId };
  if (from || to) {
    where.recordedAt = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }
  const [patient, vitals] = await Promise.all([
    prisma.patient.findUnique({
      where: { id: patientId },
      include: { user: { select: { name: true, phone: true } } },
    }),
    prisma.vitals.findMany({ where: where as any, orderBy: { recordedAt: "asc" } }),
  ]);
  if (!patient) throw new Error("Patient not found");
  const h = await getHospitalInfo();

  const rows = vitals
    .map((v) => {
      const bp =
        v.bloodPressureSystolic && v.bloodPressureDiastolic
          ? `${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}`
          : "—";
      const flagStyle = v.isAbnormal ? "background:#fee2e2;" : "";
      return `<tr style="${flagStyle}">
        <td>${formatDateTime(v.recordedAt)}</td>
        <td style="text-align:center;">${bp}</td>
        <td style="text-align:center;">${v.pulseRate ?? "—"}</td>
        <td style="text-align:center;">${v.spO2 ?? "—"}</td>
        <td style="text-align:center;">${v.temperature ?? "—"}${v.temperatureUnit || ""}</td>
        <td style="text-align:center;">${v.respiratoryRate ?? "—"}</td>
        <td style="text-align:center;">${v.weight ?? "—"}</td>
        <td style="text-align:center;">${v.bmi ?? "—"}</td>
        <td style="font-size:10px;color:#dc2626;">${escapeHtml(v.abnormalFlags || "")}</td>
      </tr>`;
    })
    .join("");

  // Inline SVG trend chart for systolic BP & weight
  const sysPoints = vitals
    .map((v) => v.bloodPressureSystolic)
    .filter((x): x is number => typeof x === "number");
  const wtPoints = vitals
    .map((v) => v.weight)
    .filter((x): x is number => typeof x === "number");

  function svgLine(points: number[], color: string, label: string): string {
    if (!points.length) return `<p style="font-size:11px;color:#94a3b8;">${label}: no data</p>`;
    const max = Math.max(...points);
    const min = Math.min(...points);
    const range = Math.max(1, max - min);
    const w = 360,
      hgt = 80,
      pad = 6;
    const stepX = points.length > 1 ? (w - 2 * pad) / (points.length - 1) : 0;
    const path = points
      .map((v, i) => {
        const x = pad + i * stepX;
        const y = hgt - pad - ((v - min) / range) * (hgt - 2 * pad);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `
    <div style="display:inline-block;margin-right:14px;vertical-align:top;">
      <p style="font-size:11px;color:#475569;">${label} (min ${min}, max ${max})</p>
      <svg width="${w}" height="${hgt}" style="border:1px solid #e2e8f0;background:#fafafa;">
        <path d="${path}" fill="none" stroke="${color}" stroke-width="2" />
      </svg>
    </div>`;
  }

  // BMI computation when both height & weight
  const bmiTrend = vitals
    .filter((v) => v.weight && v.height)
    .map((v) => v.bmi || (v.weight! / Math.pow(v.height! / 100, 2)));

  const abnormalCount = vitals.filter((v) => v.isAbnormal).length;

  const body = `
  ${letterhead(h)}
  <h2 class="title">Vitals History Report</h2>

  <div style="display:flex;gap:20px;margin-bottom:16px;font-size:13px;">
    <div style="flex:1;">
      <p><strong>Patient:</strong> ${escapeHtml(patient.user.name)}</p>
      <p><strong>MR No.:</strong> ${escapeHtml(patient.mrNumber)}</p>
      <p><strong>Age / Gender:</strong> ${patient.age ?? "—"} / ${escapeHtml(patient.gender)}</p>
    </div>
    <div style="flex:1;text-align:right;">
      <p><strong>Generated:</strong> ${formatDateTime(new Date())}</p>
      <p><strong>Period:</strong> ${from ? formatDate(from) : "All"} → ${to ? formatDate(to) : "Present"}</p>
      <p><strong>Readings:</strong> ${vitals.length}</p>
      <p><strong>Abnormal:</strong> <span style="color:#dc2626;">${abnormalCount}</span></p>
    </div>
  </div>

  <div class="section">
    <h3>Trends</h3>
    ${svgLine(sysPoints, "#2563eb", "Systolic BP (mmHg)")}
    ${svgLine(wtPoints, "#16a34a", "Weight (kg)")}
    ${svgLine(bmiTrend, "#f59e0b", "BMI")}
  </div>

  <table>
    <thead><tr>
      <th>Date / Time</th><th style="text-align:center;">BP</th><th style="text-align:center;">Pulse</th><th style="text-align:center;">SpO2</th>
      <th style="text-align:center;">Temp</th><th style="text-align:center;">Resp</th><th style="text-align:center;">Wt(kg)</th><th style="text-align:center;">BMI</th><th>Flags</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="9" style="padding:20px;text-align:center;color:#94a3b8;">No vitals recorded.</td></tr>`}</tbody>
  </table>

  <div class="footer">Vitals report generated by ${escapeHtml(h.name)}</div>
  `;

  return htmlDoc(`Vitals - ${patient.user.name}`, body);
}

// ─── 8. MEDICAL FITNESS CERTIFICATE ─────────────────────

export async function generateFitnessCertificateHTML(
  patientId: string,
  purpose: string
): Promise<string> {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: { user: { select: { name: true } } },
  });
  if (!patient) throw new Error("Patient not found");
  const h = await getHospitalInfo();

  const latestVitals = await prisma.vitals.findFirst({
    where: { patientId },
    orderBy: { recordedAt: "desc" },
  });

  const recentResults = await prisma.labResult.findMany({
    where: { orderItem: { order: { patientId } } },
    orderBy: { reportedAt: "desc" },
    take: 8,
    include: { orderItem: { include: { test: { select: { name: true } } } } },
  });

  const labRows = recentResults
    .map(
      (r) => `<tr>
      <td>${escapeHtml(r.orderItem.test.name)}</td>
      <td>${escapeHtml(r.parameter)}</td>
      <td>${escapeHtml(r.value)} ${escapeHtml(r.unit || "")}</td>
      <td>${escapeHtml(r.flag)}</td>
    </tr>`
    )
    .join("");

  const body = `
  ${letterhead(h)}
  <h2 class="title">Medical Fitness Certificate</h2>

  <p style="font-size:14px;line-height:1.8;text-align:justify;margin-bottom:18px;">
    This is to certify that <strong>${escapeHtml(patient.user.name)}</strong>,
    aged <strong>${patient.age ?? "—"} years</strong>,
    <strong>${escapeHtml(patient.gender)}</strong>${patient.address ? `, resident of <strong>${escapeHtml(patient.address)}</strong>` : ""},
    has been medically examined on <strong>${formatDate(new Date())}</strong>
    and based on clinical examination and reports, found <strong style="color:#16a34a;">FIT</strong>
    for <strong>${escapeHtml(purpose)}</strong>.
  </p>

  ${
    latestVitals
      ? `<div class="section"><h3>Vitals Summary (most recent)</h3>
    <table>
      <tr><td>BP</td><td>${latestVitals.bloodPressureSystolic ?? "—"}/${latestVitals.bloodPressureDiastolic ?? "—"} mmHg</td>
        <td>Pulse</td><td>${latestVitals.pulseRate ?? "—"} bpm</td></tr>
      <tr><td>SpO2</td><td>${latestVitals.spO2 ?? "—"}%</td>
        <td>Temp</td><td>${latestVitals.temperature ?? "—"}${latestVitals.temperatureUnit || ""}</td></tr>
      <tr><td>Weight</td><td>${latestVitals.weight ?? "—"} kg</td>
        <td>BMI</td><td>${latestVitals.bmi ?? "—"}</td></tr>
    </table>
  </div>`
      : ""
  }

  ${
    labRows
      ? `<div class="section"><h3>Recent Laboratory Findings</h3>
    <table><thead><tr><th>Test</th><th>Parameter</th><th>Result</th><th>Flag</th></tr></thead><tbody>${labRows}</tbody></table>
  </div>`
      : ""
  }

  <div class="signblock">
    <div class="sig">
      <div class="signline"></div>
      <p style="font-weight:600;font-size:13px;">Examining Physician</p>
      ${h.registration ? `<p style="font-size:11px;color:#64748b;">Reg. No: ${escapeHtml(h.registration)}</p>` : ""}
    </div>
  </div>

  <div class="footer">Issued by ${escapeHtml(h.name)} on ${formatDate(new Date())}</div>
  `;

  return htmlDoc(`Fitness Certificate - ${patient.user.name}`, body);
}

// ─── 9. DEATH CERTIFICATE ────────────────────────────────

export async function generateDeathCertificateHTML(
  patientId: string,
  causeOfDeath: string,
  dateOfDeath: string,
  timeOfDeath: string,
  manner: string = "NATURAL",
  antecedent: string = "",
  otherConditions: string = ""
): Promise<string> {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      user: { select: { name: true } },
      admissions: { orderBy: { admittedAt: "desc" }, take: 1 },
    },
  });
  if (!patient) throw new Error("Patient not found");
  const h = await getHospitalInfo();
  const lastAdmission = patient.admissions[0];

  const body = `
  ${letterhead(h)}
  <h2 class="title">Medical Certificate of Cause of Death</h2>
  <p style="text-align:center;color:#64748b;font-size:11px;margin-bottom:16px;">(India — Form 4)</p>

  <div class="section" style="font-size:13px;">
    <p><strong>Name of Deceased:</strong> ${escapeHtml(patient.user.name)}</p>
    <p><strong>MR No.:</strong> ${escapeHtml(patient.mrNumber)}</p>
    <p><strong>Age:</strong> ${patient.age ?? "—"} years &nbsp; <strong>Sex:</strong> ${escapeHtml(patient.gender)}</p>
    ${patient.address ? `<p><strong>Address:</strong> ${escapeHtml(patient.address)}</p>` : ""}
    ${lastAdmission ? `<p><strong>Date Admitted:</strong> ${formatDateTime(lastAdmission.admittedAt)}</p>` : ""}
    <p><strong>Date of Death:</strong> ${escapeHtml(dateOfDeath)}</p>
    <p><strong>Time of Death:</strong> ${escapeHtml(timeOfDeath)}</p>
  </div>

  <div class="section">
    <h3>Cause of Death</h3>
    <table>
      <tr><td style="width:35%;"><strong>I (a) Immediate Cause</strong></td><td>${escapeHtml(causeOfDeath)}</td></tr>
      <tr><td><strong>I (b) Antecedent Cause</strong></td><td>${escapeHtml(antecedent || "—")}</td></tr>
      <tr><td><strong>II Other Significant Conditions</strong></td><td>${escapeHtml(otherConditions || "—")}</td></tr>
    </table>
  </div>

  <div class="section">
    <h3>Manner of Death</h3>
    <p style="font-size:13px;">
      ${["NATURAL", "ACCIDENTAL", "SUICIDAL", "HOMICIDAL", "UNDETERMINED"]
        .map(
          (m) =>
            `<label style="margin-right:14px;">${manner === m ? "☑" : "☐"} ${m}</label>`
        )
        .join("")}
    </p>
  </div>

  <div class="signblock">
    <div class="sig">
      <div class="signline"></div>
      <p style="font-weight:600;font-size:13px;">Certifying Physician</p>
      ${h.registration ? `<p style="font-size:11px;color:#64748b;">Reg. No: ${escapeHtml(h.registration)}</p>` : ""}
    </div>
  </div>

  <div class="footer">Issued by ${escapeHtml(h.name)}</div>
  `;

  return htmlDoc(`Death Certificate - ${patient.user.name}`, body);
}

// ─── 10. BIRTH CERTIFICATE (ANC delivered) ──────────────

export async function generateBirthCertificateHTML(
  ancCaseId: string
): Promise<string> {
  const anc = await prisma.antenatalCase.findUnique({
    where: { id: ancCaseId },
    include: {
      patient: { include: { user: { select: { name: true } } } },
      doctor: { include: { user: { select: { name: true } } } },
    },
  });
  if (!anc) throw new Error("ANC case not found");
  if (!anc.deliveredAt) throw new Error("Delivery has not been recorded yet");
  const h = await getHospitalInfo();

  const body = `
  ${letterhead(h)}
  <h2 class="title">Birth Certificate</h2>

  <div class="section" style="font-size:14px;line-height:1.9;">
    <p>This is to certify that a baby was born at <strong>${escapeHtml(h.name)}</strong> with the following details:</p>
  </div>

  <div class="section">
    <h3>Baby Details</h3>
    <table>
      <tr><td><strong>Date of Birth</strong></td><td>${formatDate(anc.deliveredAt)}</td></tr>
      <tr><td><strong>Time of Birth</strong></td><td>${formatDateTime(anc.deliveredAt)}</td></tr>
      <tr><td><strong>Sex</strong></td><td>${escapeHtml(anc.babyGender || "—")}</td></tr>
      <tr><td><strong>Birth Weight</strong></td><td>${anc.babyWeight ? anc.babyWeight + " kg" : "—"}</td></tr>
      <tr><td><strong>Type of Delivery</strong></td><td>${escapeHtml(anc.deliveryType || "—")}</td></tr>
    </table>
  </div>

  <div class="section">
    <h3>Mother Details</h3>
    <table>
      <tr><td><strong>Name</strong></td><td>${escapeHtml(anc.patient.user.name)}</td></tr>
      <tr><td><strong>MR No.</strong></td><td>${escapeHtml(anc.patient.mrNumber)}</td></tr>
      <tr><td><strong>Age</strong></td><td>${anc.patient.age ?? "—"}</td></tr>
      ${anc.bloodGroup ? `<tr><td><strong>Blood Group</strong></td><td>${escapeHtml(anc.bloodGroup)}</td></tr>` : ""}
      <tr><td><strong>ANC Case #</strong></td><td>${escapeHtml(anc.caseNumber)}</td></tr>
    </table>
  </div>

  ${anc.outcomeNotes ? `<div class="section"><h3>Notes</h3><p style="font-size:13px;white-space:pre-wrap;">${escapeHtml(anc.outcomeNotes)}</p></div>` : ""}

  <div class="signblock">
    <div class="sig">
      <div class="signline"></div>
      <p style="font-weight:600;font-size:13px;">Dr. ${escapeHtml(anc.doctor.user.name)}</p>
      <p style="font-size:11px;color:#64748b;">Attending Obstetrician</p>
    </div>
  </div>

  <div class="footer">Issued by ${escapeHtml(h.name)} on ${formatDate(new Date())}</div>
  `;

  return htmlDoc(`Birth Certificate - ${anc.caseNumber}`, body);
}

// ─── 11. LEAVE APPROVAL LETTER ──────────────────────────

export async function generateLeaveLetterHTML(
  leaveRequestId: string
): Promise<string> {
  const leave = await prisma.leaveRequest.findUnique({
    where: { id: leaveRequestId },
    include: {
      user: { select: { name: true, role: true, email: true } },
      approver: { select: { name: true } },
    },
  });
  if (!leave) throw new Error("Leave request not found");
  const h = await getHospitalInfo();

  const statusColor =
    leave.status === "APPROVED" ? "#16a34a" : leave.status === "REJECTED" ? "#dc2626" : "#f59e0b";

  const body = `
  ${letterhead(h)}
  <h2 class="title">Leave ${leave.status === "APPROVED" ? "Approval" : leave.status === "REJECTED" ? "Rejection" : "Status"} Letter</h2>

  <div style="text-align:right;font-size:12px;color:#64748b;margin-bottom:16px;">
    Date: ${formatDate(leave.approvedAt || leave.updatedAt)}
  </div>

  <p style="font-size:13px;margin-bottom:8px;">To,</p>
  <p style="font-size:13px;margin-bottom:14px;"><strong>${escapeHtml(leave.user.name)}</strong><br/>${escapeHtml(leave.user.role)}</p>

  <p style="font-size:13px;margin-bottom:8px;"><strong>Subject:</strong> ${escapeHtml(leave.type)} Leave Request</p>

  <p style="font-size:14px;line-height:1.8;text-align:justify;margin-bottom:16px;">
    This is to inform that your leave request for <strong>${leave.totalDays} day(s)</strong>
    from <strong>${formatDate(leave.fromDate)}</strong> to <strong>${formatDate(leave.toDate)}</strong>
    for the reason <em>"${escapeHtml(leave.reason)}"</em> has been
    <strong style="color:${statusColor};">${escapeHtml(leave.status)}</strong>.
  </p>

  ${leave.rejectionReason ? `<div class="box" style="background:#fef2f2;border-left-color:#dc2626;font-size:13px;"><strong>Reason for rejection:</strong> ${escapeHtml(leave.rejectionReason)}</div>` : ""}

  <p style="font-size:13px;margin-top:18px;">For any clarifications, please contact HR.</p>

  <div class="signblock">
    <div class="sig">
      <div class="signline"></div>
      <p style="font-weight:600;font-size:13px;">${leave.approver ? escapeHtml(leave.approver.name) : "Authorised Signatory"}</p>
      <p style="font-size:11px;color:#64748b;">HR / Admin</p>
    </div>
  </div>

  <div class="footer">${escapeHtml(h.name)}</div>
  `;

  return htmlDoc(`Leave Letter - ${leave.user.name}`, body);
}

// ─── 12. SERVICE / EXPERIENCE CERTIFICATE ───────────────

export async function generateServiceCertificateHTML(
  userId: string,
  conduct: string = "satisfactory"
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");
  const h = await getHospitalInfo();

  const joined = formatDate(user.createdAt);
  const today = formatDate(new Date());

  const body = `
  ${letterhead(h)}
  <h2 class="title">Service Certificate</h2>

  <div style="text-align:right;font-size:12px;color:#64748b;margin-bottom:16px;">
    Date: ${today}
  </div>

  <h3 style="text-align:center;font-size:14px;color:#475569;margin-bottom:16px;">TO WHOMSOEVER IT MAY CONCERN</h3>

  <p style="font-size:14px;line-height:2;text-align:justify;margin-bottom:16px;">
    This is to certify that <strong>${escapeHtml(user.name)}</strong>
    has been working with <strong>${escapeHtml(h.name)}</strong>
    in the capacity of <strong>${escapeHtml(user.role)}</strong>
    from <strong>${joined}</strong> to <strong>${user.isActive ? "present" : today}</strong>.
  </p>

  <p style="font-size:14px;line-height:2;text-align:justify;margin-bottom:16px;">
    During ${user.role === "DOCTOR" ? "his/her" : "their"} tenure with us,
    we have found ${escapeHtml(user.name)} to be sincere, hardworking, and dedicated.
    ${user.role === "DOCTOR" ? "Their" : "Their"} conduct and character have been
    <strong>${escapeHtml(conduct)}</strong>.
  </p>

  <p style="font-size:14px;line-height:1.8;margin-bottom:16px;">
    We wish ${escapeHtml(user.name)} all the best in future endeavors.
  </p>

  <div class="signblock">
    <div class="sig">
      <div class="signline"></div>
      <p style="font-weight:600;font-size:13px;">Authorised Signatory</p>
      <p style="font-size:11px;color:#64748b;">HR Department, ${escapeHtml(h.name)}</p>
    </div>
  </div>

  <div class="footer">This certificate is issued upon request.</div>
  `;

  return htmlDoc(`Service Certificate - ${user.name}`, body);
}

// ─── PUBLIC: PRESCRIPTION VERIFICATION PAGE ─────────────

export async function generatePrescriptionVerifyHTML(
  prescriptionId: string
): Promise<string> {
  const rx = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      patient: { include: { user: { select: { name: true } } } },
      doctor: { include: { user: { select: { name: true } } } },
    },
  });
  const h = await getHospitalInfo();

  if (!rx) {
    const body = `
      ${letterhead(h)}
      <div style="text-align:center;padding:40px;">
        <h2 style="color:#dc2626;">❌ Prescription Not Found</h2>
        <p style="color:#64748b;margin-top:10px;">The prescription you are trying to verify does not exist in our records.</p>
      </div>`;
    return htmlDoc("Verify Prescription", body, false);
  }

  // Mask patient name to first letter
  const initial = rx.patient.user.name.charAt(0).toUpperCase() + ".";

  const body = `
  ${letterhead(h)}
  <div style="text-align:center;padding:20px 0;">
    <div style="display:inline-block;background:#dcfce7;color:#166534;padding:8px 18px;border-radius:20px;font-weight:600;">
      ✓ VERIFIED &mdash; Authentic Prescription
    </div>
  </div>
  <div class="section" style="background:#f8fafc;padding:18px;border-radius:8px;">
    <table>
      <tr><td><strong>Prescription ID</strong></td><td style="font-family:monospace;">${escapeHtml(rx.id)}</td></tr>
      <tr><td><strong>Patient (Initial)</strong></td><td>${escapeHtml(initial)}</td></tr>
      <tr><td><strong>Doctor</strong></td><td>Dr. ${escapeHtml(rx.doctor.user.name)}</td></tr>
      <tr><td><strong>Date Issued</strong></td><td>${formatDate(rx.createdAt)}</td></tr>
      <tr><td><strong>Status</strong></td><td>${rx.printed ? "Issued & Printed" : "Issued"}</td></tr>
    </table>
  </div>
  <div class="footer">This verification is provided by ${escapeHtml(h.name)}. For privacy, full patient details are not disclosed.</div>
  `;
  return htmlDoc("Verify Prescription", body, false);
}
