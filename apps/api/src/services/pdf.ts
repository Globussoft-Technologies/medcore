import { prisma } from "@medcore/db";

/**
 * Fetches a single system_config value by key.
 */
async function getConfig(key: string): Promise<string | null> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  return row?.value ?? null;
}

/**
 * Generates an HTML prescription document suitable for printing / PDF conversion.
 */
export async function generatePrescriptionPDF(
  prescriptionId: string
): Promise<string> {
  const prescription = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      items: true,
      doctor: {
        include: {
          user: { select: { name: true, email: true, phone: true } },
        },
      },
      patient: {
        include: {
          user: { select: { name: true, phone: true, email: true } },
        },
      },
      appointment: true,
    },
  });

  if (!prescription) {
    throw new Error("Prescription not found");
  }

  // Hospital info from system_config
  const [hospitalName, hospitalAddress, hospitalPhone, hospitalRegistration] =
    await Promise.all([
      getConfig("hospital_name"),
      getConfig("hospital_address"),
      getConfig("hospital_phone"),
      getConfig("hospital_registration"),
    ]);

  const patient = prescription.patient;
  const doctor = prescription.doctor;
  const items = prescription.items;
  const createdDate = new Date(prescription.createdAt).toLocaleDateString(
    "en-IN",
    { day: "2-digit", month: "long", year: "numeric" }
  );
  const followUp = prescription.followUpDate
    ? new Date(prescription.followUpDate).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : null;

  // Build the medicine table rows
  const medicineRows = items
    .map(
      (item, idx) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${idx + 1}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:500;">${escapeHtml(item.medicineName)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.dosage)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.frequency)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.duration)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.instructions || "-")}</td>
      </tr>`
    )
    .join("\n");

  // Signature block
  const signatureBlock = prescription.signatureUrl
    ? `<img src="${escapeHtml(prescription.signatureUrl)}" alt="Doctor Signature" style="max-height:60px;margin-bottom:4px;" />`
    : `<div style="height:60px;border-bottom:1px solid #333;width:200px;margin-bottom:4px;"></div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Prescription - ${escapeHtml(patient.user.name)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; background: #fff; }
    .page { max-width: 800px; margin: 0 auto; padding: 40px; }
    @media print {
      .page { padding: 20px; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="page">

    <!-- Hospital Header -->
    <div style="text-align:center;border-bottom:3px double #2563eb;padding-bottom:16px;margin-bottom:20px;">
      <h1 style="font-size:24px;color:#2563eb;margin-bottom:4px;">${escapeHtml(hospitalName || "Hospital")}</h1>
      ${hospitalAddress ? `<p style="font-size:13px;color:#64748b;">${escapeHtml(hospitalAddress)}</p>` : ""}
      ${hospitalPhone ? `<p style="font-size:13px;color:#64748b;">Phone: ${escapeHtml(hospitalPhone)}</p>` : ""}
      ${hospitalRegistration ? `<p style="font-size:12px;color:#94a3b8;">Reg. No: ${escapeHtml(hospitalRegistration)}</p>` : ""}
    </div>

    <h2 style="text-align:center;font-size:16px;text-transform:uppercase;letter-spacing:2px;color:#475569;margin-bottom:20px;">
      Prescription
    </h2>

    <!-- Patient & Doctor Details -->
    <div style="display:flex;justify-content:space-between;margin-bottom:20px;gap:20px;">
      <div style="flex:1;">
        <h3 style="font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Patient Details</h3>
        <table style="font-size:14px;">
          <tr><td style="padding:2px 12px 2px 0;color:#64748b;">Name</td><td style="font-weight:600;">${escapeHtml(patient.user.name)}</td></tr>
          <tr><td style="padding:2px 12px 2px 0;color:#64748b;">MR No.</td><td>${escapeHtml(patient.mrNumber)}</td></tr>
          ${patient.age != null ? `<tr><td style="padding:2px 12px 2px 0;color:#64748b;">Age</td><td>${patient.age} years</td></tr>` : ""}
          <tr><td style="padding:2px 12px 2px 0;color:#64748b;">Gender</td><td>${escapeHtml(patient.gender)}</td></tr>
        </table>
      </div>
      <div style="flex:1;text-align:right;">
        <h3 style="font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Doctor Details</h3>
        <p style="font-weight:600;font-size:14px;">Dr. ${escapeHtml(doctor.user.name)}</p>
        ${doctor.qualification ? `<p style="font-size:13px;color:#64748b;">${escapeHtml(doctor.qualification)}</p>` : ""}
        ${doctor.specialization ? `<p style="font-size:13px;color:#64748b;">${escapeHtml(doctor.specialization)}</p>` : ""}
        <p style="font-size:13px;color:#64748b;margin-top:6px;">Date: ${createdDate}</p>
      </div>
    </div>

    <!-- Diagnosis -->
    <div style="background:#f1f5f9;border-left:4px solid #2563eb;padding:12px 16px;margin-bottom:20px;border-radius:0 6px 6px 0;">
      <span style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Diagnosis</span>
      <p style="font-size:15px;font-weight:500;margin-top:4px;">${escapeHtml(prescription.diagnosis)}</p>
    </div>

    <!-- Medicine Table -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;">#</th>
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;">Medicine</th>
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;">Dosage</th>
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;">Frequency</th>
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;">Duration</th>
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;">Instructions</th>
        </tr>
      </thead>
      <tbody>
        ${medicineRows}
      </tbody>
    </table>

    ${
      prescription.advice
        ? `
    <!-- Advice -->
    <div style="margin-bottom:20px;">
      <h3 style="font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Advice</h3>
      <p style="font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(prescription.advice)}</p>
    </div>`
        : ""
    }

    ${
      followUp
        ? `
    <!-- Follow-Up -->
    <div style="background:#ecfdf5;border-left:4px solid #059669;padding:10px 16px;margin-bottom:24px;border-radius:0 6px 6px 0;">
      <span style="font-size:12px;color:#64748b;">Follow-up Date:</span>
      <span style="font-size:14px;font-weight:600;margin-left:8px;">${followUp}</span>
    </div>`
        : ""
    }

    <!-- Signature -->
    <div style="display:flex;justify-content:flex-end;margin-top:40px;">
      <div style="text-align:center;">
        ${signatureBlock}
        <p style="font-weight:600;font-size:14px;">Dr. ${escapeHtml(doctor.user.name)}</p>
        ${doctor.qualification ? `<p style="font-size:12px;color:#64748b;">${escapeHtml(doctor.qualification)}</p>` : ""}
      </div>
    </div>

    <!-- Footer -->
    <div style="margin-top:40px;padding-top:12px;border-top:1px solid #e2e8f0;text-align:center;">
      <p style="font-size:11px;color:#94a3b8;">This is a digitally signed prescription generated by ${escapeHtml(hospitalName || "Hospital")} management system.</p>
    </div>

    <!-- Print button (hidden on print) -->
    <div class="no-print" style="text-align:center;margin-top:24px;">
      <button onclick="window.print()" style="background:#2563eb;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;">
        Print Prescription
      </button>
    </div>

  </div>
</body>
</html>`;

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
