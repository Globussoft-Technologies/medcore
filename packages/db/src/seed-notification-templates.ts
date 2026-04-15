// Seeds default NotificationTemplate rows (one per common NotificationType × NotificationChannel combo).
// Uses {{variableName}} Mustache-style placeholders. Safe to re-run: uses upsert on unique [type, channel].

import {
  PrismaClient,
  NotificationChannel,
  NotificationType,
} from "@prisma/client";

const prisma = new PrismaClient();

interface TemplateSeed {
  type: NotificationType;
  channel: NotificationChannel;
  name: string;
  subject?: string;
  body: string;
}

const TEMPLATES: TemplateSeed[] = [
  // ─── APPOINTMENT_BOOKED ────────────────────────────────
  {
    type: NotificationType.APPOINTMENT_BOOKED,
    channel: NotificationChannel.SMS,
    name: "Appointment Booked (SMS)",
    body: "Hi {{patientName}}, your appointment with Dr. {{doctorName}} is confirmed for {{date}} at {{time}}. Token: {{tokenNumber}}. - {{hospitalName}}",
  },
  {
    type: NotificationType.APPOINTMENT_BOOKED,
    channel: NotificationChannel.WHATSAPP,
    name: "Appointment Booked (WhatsApp)",
    body: "Hello {{patientName}}, your appointment with Dr. {{doctorName}} ({{specialization}}) is confirmed for {{date}} at {{time}}. Your token number is {{tokenNumber}}. Please arrive 15 minutes early. — {{hospitalName}}",
  },
  {
    type: NotificationType.APPOINTMENT_BOOKED,
    channel: NotificationChannel.EMAIL,
    name: "Appointment Booked (Email)",
    subject: "Appointment Confirmed — {{date}} at {{hospitalName}}",
    body:
      "Dear {{patientName}},\n\n" +
      "This is to confirm your appointment with Dr. {{doctorName}} ({{specialization}}) on {{date}} at {{time}}.\n\n" +
      "Token Number: {{tokenNumber}}\nLocation: {{hospitalAddress}}\n\n" +
      "Please arrive 15 minutes early and carry a valid photo ID.\n\n" +
      "Regards,\n{{hospitalName}}",
  },
  {
    type: NotificationType.APPOINTMENT_BOOKED,
    channel: NotificationChannel.PUSH,
    name: "Appointment Booked (Push)",
    subject: "Appointment Confirmed",
    body: "Dr. {{doctorName}} on {{date}} at {{time}}. Token #{{tokenNumber}}.",
  },

  // ─── APPOINTMENT_REMINDER ──────────────────────────────
  {
    type: NotificationType.APPOINTMENT_REMINDER,
    channel: NotificationChannel.SMS,
    name: "Appointment Reminder (SMS)",
    body: "Reminder: {{patientName}}, you have an appointment with Dr. {{doctorName}} tomorrow at {{time}}. Token: {{tokenNumber}}. - {{hospitalName}}",
  },
  {
    type: NotificationType.APPOINTMENT_REMINDER,
    channel: NotificationChannel.WHATSAPP,
    name: "Appointment Reminder (WhatsApp)",
    body: "\u23F0 Reminder: Your appointment with Dr. {{doctorName}} is in 1 hour. Please arrive 15 min early. Token: {{tokenNumber}}.",
  },
  {
    type: NotificationType.APPOINTMENT_REMINDER,
    channel: NotificationChannel.EMAIL,
    name: "Appointment Reminder (Email)",
    subject: "Reminder: Your appointment tomorrow at {{time}}",
    body:
      "Dear {{patientName}},\n\n" +
      "This is a friendly reminder that you have an appointment with Dr. {{doctorName}} tomorrow ({{date}}) at {{time}}.\n\n" +
      "Token Number: {{tokenNumber}}\n\n" +
      "Please arrive 15 minutes early.\n\n" +
      "— {{hospitalName}}",
  },
  {
    type: NotificationType.APPOINTMENT_REMINDER,
    channel: NotificationChannel.PUSH,
    name: "Appointment Reminder (Push)",
    subject: "Upcoming Appointment",
    body: "Dr. {{doctorName}} at {{time}} — please arrive early.",
  },

  // ─── APPOINTMENT_CANCELLED ─────────────────────────────
  {
    type: NotificationType.APPOINTMENT_CANCELLED,
    channel: NotificationChannel.SMS,
    name: "Appointment Cancelled (SMS)",
    body: "Hi {{patientName}}, your appointment with Dr. {{doctorName}} on {{date}} has been cancelled. Please reschedule. - {{hospitalName}}",
  },
  {
    type: NotificationType.APPOINTMENT_CANCELLED,
    channel: NotificationChannel.WHATSAPP,
    name: "Appointment Cancelled (WhatsApp)",
    body: "Your appointment with Dr. {{doctorName}} on {{date}} at {{time}} has been cancelled. Reason: {{reason}}. To reschedule, reply to this message or call {{hospitalPhone}}.",
  },
  {
    type: NotificationType.APPOINTMENT_CANCELLED,
    channel: NotificationChannel.EMAIL,
    name: "Appointment Cancelled (Email)",
    subject: "Appointment Cancelled — {{date}}",
    body:
      "Dear {{patientName}},\n\n" +
      "Your appointment with Dr. {{doctorName}} scheduled for {{date}} at {{time}} has been cancelled.\n\n" +
      "Reason: {{reason}}\n\n" +
      "Please log in to reschedule or call us at {{hospitalPhone}}.\n\n" +
      "— {{hospitalName}}",
  },

  // ─── TOKEN_CALLED ─────────────────────────────────────
  {
    type: NotificationType.TOKEN_CALLED,
    channel: NotificationChannel.PUSH,
    name: "Token Called (Push)",
    subject: "Your turn!",
    body: "Your turn is next at Dr. {{doctorName}}'s cabin",
  },
  {
    type: NotificationType.TOKEN_CALLED,
    channel: NotificationChannel.SMS,
    name: "Token Called (SMS)",
    body: "Token #{{tokenNumber}} — please proceed to Dr. {{doctorName}}'s cabin now.",
  },

  // ─── PRESCRIPTION_READY ───────────────────────────────
  {
    type: NotificationType.PRESCRIPTION_READY,
    channel: NotificationChannel.SMS,
    name: "Prescription Ready (SMS)",
    body: "Hi {{patientName}}, your prescription from Dr. {{doctorName}} is ready. Download: {{downloadLink}} - {{hospitalName}}",
  },
  {
    type: NotificationType.PRESCRIPTION_READY,
    channel: NotificationChannel.WHATSAPP,
    name: "Prescription Ready (WhatsApp)",
    body: "\uD83D\uDCDD Your prescription is ready! Download it here: {{downloadLink}}",
  },
  {
    type: NotificationType.PRESCRIPTION_READY,
    channel: NotificationChannel.EMAIL,
    name: "Prescription Ready (Email)",
    subject: "Your prescription from {{hospitalName}}",
    body:
      "Dear {{patientName}},\n\n" +
      "Your prescription from Dr. {{doctorName}} (issued {{date}}) is now ready.\n\n" +
      "Download link: {{downloadLink}}\n" +
      "Verification link (QR): {{verifyLink}}\n\n" +
      "You may present this at any partner pharmacy.\n\n" +
      "— {{hospitalName}}",
  },

  // ─── BILL_GENERATED ───────────────────────────────────
  {
    type: NotificationType.BILL_GENERATED,
    channel: NotificationChannel.SMS,
    name: "Bill Generated (SMS)",
    body: "Invoice #{{invoiceNumber}} for \u20B9{{amount}} is ready. Pay online: {{paymentLink}}",
  },
  {
    type: NotificationType.BILL_GENERATED,
    channel: NotificationChannel.WHATSAPP,
    name: "Bill Generated (WhatsApp)",
    body: "\uD83D\uDCB3 Invoice #{{invoiceNumber}} for \u20B9{{amount}} has been generated. Pay securely: {{paymentLink}}",
  },
  {
    type: NotificationType.BILL_GENERATED,
    channel: NotificationChannel.EMAIL,
    name: "Bill Generated (Email)",
    subject: "Invoice #{{invoiceNumber}} — \u20B9{{amount}}",
    body:
      "Dear {{patientName}},\n\n" +
      "Invoice #{{invoiceNumber}} dated {{date}} for \u20B9{{amount}} has been generated.\n\n" +
      "Pay online: {{paymentLink}}\nDownload: {{downloadLink}}\n\n" +
      "Due date: {{dueDate}}\n\n" +
      "— {{hospitalName}}",
  },

  // ─── PAYMENT_RECEIVED ─────────────────────────────────
  {
    type: NotificationType.PAYMENT_RECEIVED,
    channel: NotificationChannel.SMS,
    name: "Payment Received (SMS)",
    body: "Thank you {{patientName}}! We received \u20B9{{amount}} for invoice #{{invoiceNumber}}. Txn: {{transactionId}}",
  },
  {
    type: NotificationType.PAYMENT_RECEIVED,
    channel: NotificationChannel.EMAIL,
    name: "Payment Received (Email)",
    subject: "Receipt: \u20B9{{amount}} — Invoice #{{invoiceNumber}}",
    body:
      "Dear {{patientName}},\n\n" +
      "We have received your payment.\n\n" +
      "Amount: \u20B9{{amount}}\nInvoice: #{{invoiceNumber}}\nTransaction ID: {{transactionId}}\nDate: {{date}}\nMode: {{paymentMode}}\n\n" +
      "Download receipt: {{receiptLink}}\n\n" +
      "Thank you for choosing {{hospitalName}}.",
  },
  {
    type: NotificationType.PAYMENT_RECEIVED,
    channel: NotificationChannel.WHATSAPP,
    name: "Payment Received (WhatsApp)",
    body: "\u2705 Payment received: \u20B9{{amount}} for invoice #{{invoiceNumber}}. Thank you!",
  },

  // ─── LAB_RESULT_READY ─────────────────────────────────
  {
    type: NotificationType.LAB_RESULT_READY,
    channel: NotificationChannel.WHATSAPP,
    name: "Lab Result Ready (WhatsApp)",
    body: "Your lab results are available. Login to view: {{loginLink}}",
  },
  {
    type: NotificationType.LAB_RESULT_READY,
    channel: NotificationChannel.SMS,
    name: "Lab Result Ready (SMS)",
    body: "Hi {{patientName}}, your lab results ({{testName}}) are ready. View: {{loginLink}} - {{hospitalName}}",
  },
  {
    type: NotificationType.LAB_RESULT_READY,
    channel: NotificationChannel.EMAIL,
    name: "Lab Result Ready (Email)",
    subject: "Lab Results Ready — {{testName}}",
    body:
      "Dear {{patientName}},\n\n" +
      "Your {{testName}} results are now available.\n\n" +
      "View online: {{loginLink}}\nDownload PDF: {{downloadLink}}\n\n" +
      "Please consult your doctor for interpretation.\n\n" +
      "— {{hospitalName}}",
  },

  // ─── MEDICATION_DUE ───────────────────────────────────
  {
    type: NotificationType.MEDICATION_DUE,
    channel: NotificationChannel.PUSH,
    name: "Medication Due (Push)",
    subject: "Medication reminder",
    body: "Medication reminder: {{medicineName}} {{dosage}}",
  },
  {
    type: NotificationType.MEDICATION_DUE,
    channel: NotificationChannel.SMS,
    name: "Medication Due (SMS)",
    body: "Reminder: take {{medicineName}} {{dosage}} now. - {{hospitalName}}",
  },

  // ─── LOW_STOCK_ALERT ──────────────────────────────────
  {
    type: NotificationType.LOW_STOCK_ALERT,
    channel: NotificationChannel.EMAIL,
    name: "Low Stock Alert (Email)",
    subject: "Low stock: {{medicineName}}",
    body:
      "{{medicineName}} is below reorder level ({{currentStock}}/{{reorderLevel}}).\n\n" +
      "Supplier: {{supplierName}}\nLast PO: {{lastPoDate}}\n\n" +
      "Please raise a purchase order at the earliest.",
  },
  {
    type: NotificationType.LOW_STOCK_ALERT,
    channel: NotificationChannel.PUSH,
    name: "Low Stock Alert (Push)",
    subject: "Low Stock",
    body: "{{medicineName}}: {{currentStock}}/{{reorderLevel}} units remaining",
  },

  // ─── ADMISSION ────────────────────────────────────────
  {
    type: NotificationType.ADMISSION,
    channel: NotificationChannel.SMS,
    name: "Admission (SMS)",
    body: "Admitted to {{wardName}}, Bed {{bedNumber}} on {{date}}",
  },
  {
    type: NotificationType.ADMISSION,
    channel: NotificationChannel.EMAIL,
    name: "Admission (Email)",
    subject: "Admission Confirmation — {{patientName}}",
    body:
      "Dear {{patientName}},\n\n" +
      "You have been admitted to {{hospitalName}}.\n\n" +
      "Ward: {{wardName}}\nBed: {{bedNumber}}\nAdmission Date: {{date}}\nAttending Doctor: Dr. {{doctorName}}\n\n" +
      "Please contact the nursing station at extension {{wardExtension}} if you need assistance.\n\n" +
      "— {{hospitalName}}",
  },

  // ─── DISCHARGE ────────────────────────────────────────
  {
    type: NotificationType.DISCHARGE,
    channel: NotificationChannel.SMS,
    name: "Discharge (SMS)",
    body: "Discharged from {{wardName}}. Discharge summary available.",
  },
  {
    type: NotificationType.DISCHARGE,
    channel: NotificationChannel.EMAIL,
    name: "Discharge (Email)",
    subject: "Discharge Summary — {{patientName}}",
    body:
      "Dear {{patientName}},\n\n" +
      "Your discharge from {{wardName}} has been processed on {{date}}.\n\n" +
      "Download summary: {{downloadLink}}\nFollow-up date: {{followUpDate}}\n\n" +
      "Take care and we wish you a speedy recovery.\n\n" +
      "— {{hospitalName}}",
  },

  // ─── SCHEDULE_SUMMARY ─────────────────────────────────
  {
    type: NotificationType.SCHEDULE_SUMMARY,
    channel: NotificationChannel.EMAIL,
    name: "Schedule Summary (Email) — Doctor",
    subject: "Your schedule for {{date}}",
    body:
      "Good morning Dr. {{doctorName}},\n\n" +
      "Here is your schedule for {{date}}:\n\n" +
      "Total appointments: {{totalAppointments}}\nFirst slot: {{firstSlot}}\nLast slot: {{lastSlot}}\nSurgeries scheduled: {{surgeries}}\n\n" +
      "View full schedule: {{scheduleLink}}\n\n" +
      "Have a great day!\n— {{hospitalName}}",
  },
  {
    type: NotificationType.SCHEDULE_SUMMARY,
    channel: NotificationChannel.PUSH,
    name: "Schedule Summary (Push)",
    subject: "Today's schedule",
    body: "{{totalAppointments}} appointments today, starting {{firstSlot}}.",
  },
];

async function main() {
  console.log("\n=== Seeding Notification Templates ===\n");

  let created = 0;
  let updated = 0;

  for (const t of TEMPLATES) {
    const existing = await prisma.notificationTemplate.findUnique({
      where: { type_channel: { type: t.type, channel: t.channel } },
    });
    if (existing) {
      await prisma.notificationTemplate.update({
        where: { id: existing.id },
        data: {
          name: t.name,
          subject: t.subject ?? null,
          body: t.body,
          isActive: true,
        },
      });
      updated++;
    } else {
      await prisma.notificationTemplate.create({
        data: {
          type: t.type,
          channel: t.channel,
          name: t.name,
          subject: t.subject ?? null,
          body: t.body,
          isActive: true,
        },
      });
      created++;
    }
  }

  console.log(`\n  Created: ${created}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Total templates in set: ${TEMPLATES.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
