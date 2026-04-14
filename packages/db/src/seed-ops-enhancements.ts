/**
 * MedCore Ops Enhancements Seed
 *
 * Adds realistic demo data for:
 *  - GST breakdown on existing invoices (18% GST, split CGST+SGST)
 *  - 5 credit notes
 *  - 10 advance payments
 *  - Package consumption history for 3 existing purchases
 *  - 3 supplier contracts + performance data
 *  - 2 GRNs against received POs
 *  - 10 expenses (varied categories) with attachments & approval states
 *  - 30 days of shifts + 5 leave balances + 10 public holidays
 *  - 20 more feedback entries + 3 escalated complaints
 *  - Chat department channels: Doctors, Nursing, All Staff
 *  - 10 more visitors with varied purposes + 2 blacklist entries
 *  - 50 notification log entries + 3 broadcasts + notification templates
 */

import {
  PrismaClient,
  PaymentMode,
  ExpenseCategory,
  ShiftType,
  ShiftStatus,
  LeaveType,
  FeedbackCategory,
  NotificationType,
  NotificationChannel,
  NotificationDeliveryStatus,
  VisitorPurpose,
  ApprovalStatus,
  SentimentLabel,
} from "@prisma/client";

const prisma = new PrismaClient();

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function main() {
  console.log("=== Seeding Ops Enhancements ===\n");

  // ─── GST on existing invoices ──────────────────
  console.log("Adding GST breakdown to invoices...");
  const invoices = await prisma.invoice.findMany({ take: 30 });
  let gstUpdated = 0;
  for (const inv of invoices) {
    if (inv.cgstAmount > 0 || inv.sgstAmount > 0) continue;
    const gst = Math.round(((inv.subtotal * 18) / 100) * 100) / 100;
    const half = Math.round((gst / 2) * 100) / 100;
    const total = inv.subtotal + gst - inv.discountAmount;
    await prisma.invoice.update({
      where: { id: inv.id },
      data: {
        taxAmount: gst,
        cgstAmount: half,
        sgstAmount: +(gst - half).toFixed(2),
        totalAmount: Math.max(0, +total.toFixed(2)),
      },
    });
    gstUpdated++;
  }
  console.log(`  Updated ${gstUpdated} invoices with GST 18%`);

  // ─── Credit Notes ──────────────────────────────
  console.log("Creating credit notes...");
  let cnCount = 0;
  const paidInvoices = await prisma.invoice.findMany({
    where: { paymentStatus: "PAID" },
    take: 5,
  });
  for (let i = 0; i < paidInvoices.length && i < 5; i++) {
    const inv = paidInvoices[i];
    const amount = Math.min(500, +(inv.totalAmount * 0.1).toFixed(2));
    await prisma.creditNote.create({
      data: {
        noteNumber: `CN${String(i + 1).padStart(6, "0")}`,
        invoiceId: inv.id,
        amount,
        reason: randomItem([
          "Billing correction",
          "Service cancellation",
          "Duplicate charge",
          "Goodwill",
          "Refund adjustment",
        ]),
        issuedBy: (await prisma.user.findFirst({ where: { role: "ADMIN" } }))?.id || "",
      },
    });
    cnCount++;
  }
  console.log(`  Created ${cnCount} credit notes`);

  // ─── Advance Payments ──────────────────────────
  console.log("Creating advance payments...");
  const patients = await prisma.patient.findMany({ take: 10 });
  const modes: PaymentMode[] = ["CASH", "CARD", "UPI", "ONLINE"];
  const adminUser = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  const recpUser = await prisma.user.findFirst({ where: { role: "RECEPTION" } });
  const receiver = (recpUser || adminUser)!;
  let advCount = 0;
  for (let i = 0; i < Math.min(10, patients.length); i++) {
    const p = patients[i];
    const amt = randomInt(1000, 10000);
    await prisma.advancePayment.create({
      data: {
        receiptNumber: `ADV${String(i + 1).padStart(6, "0")}`,
        patientId: p.id,
        amount: amt,
        balance: amt,
        mode: randomItem(modes),
        transactionId: `TXN${randomInt(100000, 999999)}`,
        notes: "Initial deposit",
        receivedBy: receiver.id,
      },
    });
    advCount++;
  }
  console.log(`  Created ${advCount} advance payments`);

  // ─── Package Consumption ───────────────────────
  console.log("Recording package consumption...");
  const purchases = await prisma.packagePurchase.findMany({
    take: 3,
    include: { package: true },
  });
  for (const pp of purchases) {
    const services = (pp.package.services || "")
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const used = services.slice(0, Math.min(2, services.length)).map((s) => ({
      service: s,
      usedAt: daysAgo(randomInt(1, 30)).toISOString(),
      notes: "Consumed during consultation",
    }));
    await prisma.packagePurchase.update({
      where: { id: pp.id },
      data: { servicesUsed: JSON.stringify(used) },
    });
  }
  console.log(`  Recorded consumption for ${purchases.length} packages`);

  // ─── Supplier contracts + performance ─────────
  console.log("Updating supplier contracts/performance...");
  const suppliers = await prisma.supplier.findMany({ take: 3 });
  for (const s of suppliers) {
    const start = daysAgo(365);
    const end = new Date();
    end.setFullYear(end.getFullYear() + 1);
    await prisma.supplier.update({
      where: { id: s.id },
      data: {
        contractStart: start,
        contractEnd: end,
        rating: +(3 + Math.random() * 2).toFixed(1),
        onTimeDeliveries: randomInt(5, 15),
        lateDeliveries: randomInt(0, 3),
        outstandingAmount: randomInt(0, 50000),
      },
    });
  }
  console.log(`  Updated ${suppliers.length} supplier contracts`);

  // ─── GRNs against received POs ────────────────
  console.log("Creating GRNs...");
  const receivedPOs = await prisma.purchaseOrder.findMany({
    where: { status: "RECEIVED" },
    include: { items: true },
    take: 2,
  });
  let grnCount = 0;
  for (let i = 0; i < receivedPOs.length; i++) {
    const po = receivedPOs[i];
    await prisma.grn.create({
      data: {
        grnNumber: `GRN${String(i + 1).padStart(6, "0")}`,
        poId: po.id,
        receivedBy: adminUser?.id || "",
        invoiceNumber: `SINV${randomInt(1000, 9999)}`,
        notes: "Full receipt OK",
        items: {
          create: po.items.map((it) => ({
            poItemId: it.id,
            quantity: it.quantity,
            batchNumber: `B${randomInt(1000, 9999)}`,
            expiryDate: (() => {
              const d = new Date();
              d.setFullYear(d.getFullYear() + 2);
              return d;
            })(),
          })),
        },
      },
    });
    grnCount++;
  }
  console.log(`  Created ${grnCount} GRNs`);

  // ─── Additional Expenses ──────────────────────
  console.log("Creating additional expenses...");
  const cats: ExpenseCategory[] = [
    "SALARY",
    "UTILITIES",
    "EQUIPMENT",
    "MAINTENANCE",
    "CONSUMABLES",
    "RENT",
    "MARKETING",
    "OTHER",
  ];
  const approvalStates: ApprovalStatus[] = ["APPROVED", "APPROVED", "APPROVED", "PENDING"];
  for (let i = 0; i < 10; i++) {
    const cat = randomItem(cats);
    const amount = cat === "SALARY" || cat === "RENT" ? randomInt(20000, 80000) : randomInt(500, 8000);
    const st = amount > 10000 ? randomItem(approvalStates) : "APPROVED";
    await prisma.expense.create({
      data: {
        category: cat,
        amount,
        description: `${cat.toLowerCase().replace("_", " ")} expense #${i + 1}`,
        date: daysAgo(randomInt(1, 60)),
        paidTo: randomItem([
          "Cleaning Services Pvt Ltd",
          "City Power Co.",
          "Medical Supplies Ltd",
          "Ambuja Cement",
          "Internet Provider",
        ]),
        paidBy: receiver.id,
        referenceNo: `REF${randomInt(10000, 99999)}`,
        attachmentPath: `uploads/expenses/receipt-${i + 1}.pdf`,
        approvalStatus: st,
        approvedBy: st === "APPROVED" ? adminUser?.id : null,
        approvedAt: st === "APPROVED" ? new Date() : null,
      },
    });
  }
  console.log("  Created 10 expenses");

  // Recurring rent expense example
  await prisma.expense.create({
    data: {
      category: "RENT",
      amount: 75000,
      description: "Monthly clinic rent (recurring)",
      date: daysAgo(1),
      paidTo: "Property Owner",
      paidBy: receiver.id,
      referenceNo: "RENT-2026-APR",
      isRecurring: true,
      recurringFrequency: "MONTHLY",
      approvalStatus: "APPROVED",
      approvedBy: adminUser?.id,
      approvedAt: new Date(),
    },
  });

  // ─── Shifts (30 days) ─────────────────────────
  console.log("Creating shifts for 30 days...");
  const staff = await prisma.user.findMany({
    where: { role: { in: ["DOCTOR", "NURSE", "RECEPTION"] }, isActive: true },
    take: 6,
  });
  const types: ShiftType[] = ["MORNING", "AFTERNOON", "NIGHT"];
  const statuses: ShiftStatus[] = ["PRESENT", "PRESENT", "PRESENT", "LATE", "SCHEDULED"];
  let shiftCount = 0;
  for (let d = 0; d < 30; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    date.setUTCHours(0, 0, 0, 0);
    for (const u of staff) {
      const t = randomItem(types);
      const hours = t === "MORNING" ? ["08:00", "14:00"] : t === "AFTERNOON" ? ["14:00", "20:00"] : ["20:00", "08:00"];
      try {
        await prisma.staffShift.create({
          data: {
            userId: u.id,
            date,
            type: t,
            startTime: hours[0],
            endTime: hours[1],
            status: d === 0 ? "SCHEDULED" : randomItem(statuses),
          },
        });
        shiftCount++;
      } catch {}
    }
  }
  console.log(`  Created ${shiftCount} shifts`);

  // ─── Leave Balances ───────────────────────────
  console.log("Creating leave balances...");
  let lbCount = 0;
  const year = new Date().getFullYear();
  for (const u of staff.slice(0, 5)) {
    const entitlements: Record<LeaveType, number> = {
      CASUAL: 12,
      SICK: 12,
      EARNED: 20,
      MATERNITY: 180,
      PATERNITY: 15,
      UNPAID: 0,
    };
    for (const [t, e] of Object.entries(entitlements)) {
      try {
        await prisma.leaveBalance.create({
          data: {
            userId: u.id,
            type: t as LeaveType,
            year,
            entitled: e,
            used: t === "CASUAL" ? randomInt(0, 5) : t === "SICK" ? randomInt(0, 3) : 0,
          },
        });
        lbCount++;
      } catch {}
    }
  }
  console.log(`  Created ${lbCount} leave balance rows`);

  // ─── Holidays ─────────────────────────────────
  console.log("Creating holidays...");
  const holidays = [
    { month: 1, day: 26, name: "Republic Day" },
    { month: 3, day: 29, name: "Holi" },
    { month: 5, day: 1, name: "Labour Day" },
    { month: 8, day: 15, name: "Independence Day" },
    { month: 10, day: 2, name: "Gandhi Jayanti" },
    { month: 10, day: 23, name: "Diwali" },
    { month: 11, day: 14, name: "Children's Day" },
    { month: 12, day: 25, name: "Christmas" },
    { month: 6, day: 15, name: "Eid al-Fitr (est)" },
    { month: 4, day: 14, name: "Ambedkar Jayanti" },
  ];
  let hCount = 0;
  for (const h of holidays) {
    try {
      await prisma.holiday.create({
        data: {
          date: new Date(Date.UTC(year, h.month - 1, h.day)),
          name: h.name,
          type: "PUBLIC",
        },
      });
      hCount++;
    } catch {}
  }
  console.log(`  Created ${hCount} holidays`);

  // ─── Feedback ─────────────────────────────────
  console.log("Creating 20 additional feedback entries...");
  const categories: FeedbackCategory[] = [
    "DOCTOR",
    "NURSE",
    "RECEPTION",
    "CLEANLINESS",
    "FOOD",
    "WAITING_TIME",
    "BILLING",
    "OVERALL",
  ];
  const positiveComments = [
    "Excellent service, very professional staff",
    "Doctor was kind and attentive, thank you",
    "Clean facilities and friendly reception",
    "Quick and helpful nursing team",
    "Great experience overall, highly recommend",
  ];
  const negativeComments = [
    "Waiting time was terrible, very slow",
    "Rude receptionist, disappointing experience",
    "Billing was confusing and had errors",
    "Room was dirty, poor cleanliness standards",
    "Long delay, frustrating process",
  ];
  const neutralComments = [
    "Average service",
    "Nothing special",
    "Could be better",
  ];
  for (let i = 0; i < 20 && i < patients.length * 4; i++) {
    const rating = randomInt(1, 5);
    const positive = rating >= 4;
    const comment =
      rating >= 4
        ? randomItem(positiveComments)
        : rating <= 2
          ? randomItem(negativeComments)
          : randomItem(neutralComments);
    const sentiment: SentimentLabel = positive
      ? "POSITIVE"
      : rating <= 2
        ? "NEGATIVE"
        : "NEUTRAL";
    const score = positive ? +(0.5 + Math.random() * 0.5).toFixed(2) : rating <= 2 ? +(-0.5 - Math.random() * 0.5).toFixed(2) : 0;
    await prisma.patientFeedback.create({
      data: {
        patientId: randomItem(patients).id,
        category: randomItem(categories),
        rating,
        nps: rating >= 4 ? randomInt(8, 10) : rating <= 2 ? randomInt(0, 5) : randomInt(6, 8),
        comment,
        sentiment,
        sentimentScore: score,
        requestedVia: randomItem(["SMS", "EMAIL", "WALK_IN"]),
        submittedAt: daysAgo(randomInt(0, 30)),
      },
    });
  }
  console.log("  Created 20 feedback entries");

  // ─── Escalated Complaints ─────────────────────
  console.log("Creating 3 escalated complaints...");
  let ccCount = 0;
  for (let i = 0; i < 3; i++) {
    const p = randomItem(patients);
    const priority = randomItem(["HIGH", "CRITICAL"]);
    const hoursSla = priority === "CRITICAL" ? 4 : 24;
    const createdAt = daysAgo(randomInt(3, 10));
    const slaDue = new Date(createdAt.getTime() + hoursSla * 3600000);
    await prisma.complaint.create({
      data: {
        ticketNumber: `CMP-ESC-${i + 1}`,
        patientId: p.id,
        name: null,
        phone: null,
        category: randomItem(["SERVICE", "BILLING", "CLEANLINESS", "STAFF_BEHAVIOR"]),
        subCategory: randomItem(["NEGLIGENCE", "DELAY", "RUDE", "ERROR"]),
        description: `Escalated complaint #${i + 1}: serious issue requiring immediate attention`,
        status: "ESCALATED",
        priority,
        slaDueAt: slaDue,
        escalatedAt: new Date(),
        escalationReason: "SLA breached — escalated to management",
        createdAt,
      },
    });
    ccCount++;
  }
  console.log(`  Created ${ccCount} escalated complaints`);

  // ─── Chat Channels ────────────────────────────
  console.log("Creating chat department channels...");
  const doctors = await prisma.user.findMany({ where: { role: "DOCTOR", isActive: true }, select: { id: true } });
  const nurses = await prisma.user.findMany({ where: { role: "NURSE", isActive: true }, select: { id: true } });
  const allStaff = await prisma.user.findMany({
    where: { role: { in: ["ADMIN", "DOCTOR", "NURSE", "RECEPTION"] }, isActive: true },
    select: { id: true },
  });
  const channels = [
    { name: "Doctors", dept: "Doctors", users: doctors },
    { name: "Nursing", dept: "Nursing", users: nurses },
    { name: "All Staff", dept: "All Staff", users: allStaff },
  ];
  let chCount = 0;
  for (const c of channels) {
    const existing = await prisma.chatRoom.findFirst({
      where: { department: c.dept, isChannel: true },
    });
    if (existing) continue;
    await prisma.chatRoom.create({
      data: {
        name: c.name,
        department: c.dept,
        isChannel: true,
        isGroup: true,
        createdBy: adminUser?.id || "",
        participants: {
          create: c.users.map((u) => ({ userId: u.id })),
        },
      },
    });
    chCount++;
  }
  console.log(`  Created ${chCount} chat channels`);

  // ─── Visitors ─────────────────────────────────
  console.log("Creating 10 additional visitors...");
  const purposes: VisitorPurpose[] = [
    "PATIENT_VISIT",
    "DELIVERY",
    "APPOINTMENT",
    "MEETING",
    "OTHER",
  ];
  for (let i = 0; i < 10; i++) {
    const ci = daysAgo(randomInt(0, 7));
    const co = Math.random() < 0.7 ? new Date(ci.getTime() + randomInt(30, 120) * 60000) : null;
    await prisma.visitor.create({
      data: {
        passNumber: `VIS-OPS-${String(i + 1).padStart(4, "0")}`,
        name: `Visitor ${i + 1}`,
        phone: `98${randomInt(10000000, 99999999)}`,
        idProofType: randomItem(["Aadhaar", "PAN", "Driving License"]),
        idProofNumber: `${randomInt(100000, 999999)}`,
        purpose: randomItem(purposes),
        department: randomItem(["Cardiology", "OPD", "ICU", "Reception", "Pediatrics"]),
        patientId: Math.random() < 0.8 ? randomItem(patients).id : null,
        checkInAt: ci,
        checkOutAt: co,
      },
    });
  }
  console.log("  Created 10 visitors");

  // ─── Visitor Blacklist ────────────────────────
  for (let i = 0; i < 2; i++) {
    try {
      await prisma.visitorBlacklist.create({
        data: {
          idProofType: "Aadhaar",
          idProofNumber: `BL${randomInt(100000, 999999)}`,
          name: `Blacklisted Person ${i + 1}`,
          phone: `99${randomInt(10000000, 99999999)}`,
          reason: randomItem([
            "Trespassing in restricted area",
            "Aggressive behavior with staff",
            "Unauthorized photography",
          ]),
          addedBy: adminUser?.id || "",
        },
      });
    } catch {}
  }

  // ─── Notification Templates ───────────────────
  console.log("Creating notification templates...");
  const templates: Array<{
    type: NotificationType;
    channel: NotificationChannel;
    name: string;
    subject?: string;
    body: string;
  }> = [
    {
      type: "APPOINTMENT_REMINDER",
      channel: "SMS",
      name: "Appointment Reminder (SMS)",
      body: "Hi {{name}}, reminder: your appointment with Dr. {{doctor}} is on {{date}} at {{time}}.",
    },
    {
      type: "BILL_GENERATED",
      channel: "EMAIL",
      name: "Invoice Email",
      subject: "Your MedCore invoice {{invoiceNumber}}",
      body: "Dear {{name}},\nYour invoice {{invoiceNumber}} for Rs.{{total}} has been generated.",
    },
    {
      type: "PAYMENT_RECEIVED",
      channel: "SMS",
      name: "Payment Confirmation (SMS)",
      body: "Payment of Rs.{{amount}} received. Thank you, {{name}}!",
    },
    {
      type: "LAB_RESULT_READY",
      channel: "WHATSAPP",
      name: "Lab Result Ready (WA)",
      body: "Hi {{name}}, your lab results are ready. Please login to view.",
    },
  ];
  let tCount = 0;
  for (const t of templates) {
    try {
      await prisma.notificationTemplate.upsert({
        where: { type_channel: { type: t.type, channel: t.channel } },
        update: { name: t.name, subject: t.subject, body: t.body },
        create: { ...t, isActive: true },
      });
      tCount++;
    } catch {}
  }
  console.log(`  Created ${tCount} templates`);

  // ─── Notification Log Entries ─────────────────
  console.log("Creating 50 notification log entries...");
  const allUsers = await prisma.user.findMany({ take: 15 });
  const nTypes: NotificationType[] = [
    "APPOINTMENT_BOOKED",
    "APPOINTMENT_REMINDER",
    "BILL_GENERATED",
    "PAYMENT_RECEIVED",
    "TOKEN_CALLED",
    "PRESCRIPTION_READY",
    "LAB_RESULT_READY",
  ];
  const nChannels: NotificationChannel[] = ["SMS", "EMAIL", "WHATSAPP", "PUSH"];
  const nStatuses: NotificationDeliveryStatus[] = [
    "DELIVERED",
    "DELIVERED",
    "DELIVERED",
    "READ",
    "SENT",
    "FAILED",
  ];
  for (let i = 0; i < 50; i++) {
    const u = randomItem(allUsers);
    const st = randomItem(nStatuses);
    await prisma.notification.create({
      data: {
        userId: u.id,
        type: randomItem(nTypes),
        channel: randomItem(nChannels),
        title: "Notification #" + (i + 1),
        message: "Sample notification message body",
        deliveryStatus: st,
        sentAt: st !== "FAILED" ? daysAgo(randomInt(0, 7)) : null,
        deliveredAt:
          st === "DELIVERED" || st === "READ" ? daysAgo(randomInt(0, 7)) : null,
        readAt: st === "READ" ? daysAgo(randomInt(0, 6)) : null,
        failureReason: st === "FAILED" ? "Gateway timeout" : null,
      },
    });
  }
  console.log("  Created 50 notifications");

  // ─── Broadcasts ───────────────────────────────
  for (let i = 0; i < 3; i++) {
    await prisma.notificationBroadcast.create({
      data: {
        title: `System Announcement #${i + 1}`,
        message: randomItem([
          "Scheduled maintenance this Sunday 2-4 AM.",
          "New COVID vaccination camp this weekend.",
          "Updated visiting hours: 10 AM - 12 PM and 4 PM - 7 PM.",
        ]),
        audience: JSON.stringify({ roles: ["ADMIN", "DOCTOR"] }),
        sentCount: randomInt(10, 50),
        failedCount: randomInt(0, 3),
        createdBy: adminUser?.id || "",
      },
    });
  }

  // ─── Expense Budgets (for current month & year) ───────────
  const nowM = new Date();
  const budgetPlan: Partial<Record<ExpenseCategory, number>> = {
    SALARY: 800000,
    UTILITIES: 40000,
    RENT: 75000,
    CONSUMABLES: 50000,
    MAINTENANCE: 30000,
    MARKETING: 20000,
  };
  for (const [cat, amt] of Object.entries(budgetPlan)) {
    try {
      await prisma.expenseBudget.upsert({
        where: {
          category_year_month: {
            category: cat as ExpenseCategory,
            year: nowM.getFullYear(),
            month: nowM.getMonth() + 1,
          },
        },
        update: { amount: amt },
        create: {
          category: cat as ExpenseCategory,
          year: nowM.getFullYear(),
          month: nowM.getMonth() + 1,
          amount: amt!,
        },
      });
    } catch {}
  }
  console.log("  Upserted monthly budgets");

  // ─── Supplier Catalog Items ─────────────────────
  console.log("Seeding supplier catalog items...");
  let catCount = 0;
  const sampleItems = [
    { itemName: "Paracetamol 500mg (100 tabs)", unitPrice: 30, moq: 10, lead: 3 },
    { itemName: "Surgical Gloves (Box)", unitPrice: 180, moq: 5, lead: 5 },
    { itemName: "Disposable Syringes (100)", unitPrice: 120, moq: 10, lead: 3 },
    { itemName: "IV Saline 500ml", unitPrice: 45, moq: 20, lead: 4 },
  ];
  for (const s of suppliers) {
    for (const it of sampleItems) {
      await prisma.supplierCatalogItem.create({
        data: {
          supplierId: s.id,
          itemName: it.itemName,
          unitPrice: it.unitPrice,
          moq: it.moq,
          leadTimeDays: it.lead,
          isActive: true,
        },
      });
      catCount++;
    }
  }
  console.log(`  Created ${catCount} catalog items`);

  console.log("\n=== Ops Enhancements seed complete ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
