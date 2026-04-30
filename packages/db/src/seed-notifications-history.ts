import {
  PrismaClient,
  NotificationChannel,
  NotificationType,
  NotificationDeliveryStatus,
  Role,
} from "@prisma/client";

const prisma = new PrismaClient();

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Issue #272 (Apr 28 2026): each template is tagged with the audience role(s)
// it belongs to. The seeder MUST only create rows where the recipient user's
// role is in `audience` — patient-facing copy ("your discharge", "your bill",
// "your prescription") must NOT land in a receptionist's or doctor's inbox.
// Without this filter, a RECEPTION user sees "Discharge Summary — Your
// discharge has been processed", which is nonsensical and a routing bug.
export type TemplateDef = {
  type: NotificationType;
  title: string;
  audience: Role[]; // recipient role(s) the template is appropriate for
  messageFn: () => string;
};

export const TEMPLATES: TemplateDef[] = [
  {
    type: NotificationType.APPOINTMENT_BOOKED,
    title: "Appointment Confirmed",
    audience: [Role.PATIENT],
    messageFn: () => `Your appointment with Dr. ${randomItem(["Rao", "Kapoor", "Menon", "Shah"])} on ${randomDateStr()} has been booked. Token #${randomInt(1, 30)}.`,
  },
  {
    type: NotificationType.APPOINTMENT_REMINDER,
    title: "Appointment Reminder",
    audience: [Role.PATIENT],
    messageFn: () => `Reminder: Your appointment is scheduled tomorrow at ${randomInt(9, 19)}:${randomInt(0, 3) * 15 || "00"}. Please arrive 15 min early.`,
  },
  {
    type: NotificationType.APPOINTMENT_CANCELLED,
    title: "Appointment Cancelled",
    audience: [Role.PATIENT],
    messageFn: () => `Your appointment on ${randomDateStr()} has been cancelled. Please reschedule at your convenience.`,
  },
  {
    type: NotificationType.TOKEN_CALLED,
    title: "Your Token is Up",
    audience: [Role.PATIENT],
    messageFn: () => `Token #${randomInt(1, 30)} is now being called. Please proceed to consultation room.`,
  },
  {
    type: NotificationType.PRESCRIPTION_READY,
    title: "Prescription Ready",
    audience: [Role.PATIENT],
    messageFn: () => `Your prescription is ready. Download from the app or collect at pharmacy.`,
  },
  {
    type: NotificationType.BILL_GENERATED,
    title: "Invoice Generated",
    audience: [Role.PATIENT],
    messageFn: () => `Invoice #INV${randomInt(10000, 99999)} for ₹${randomInt(500, 15000)} has been generated.`,
  },
  {
    type: NotificationType.PAYMENT_RECEIVED,
    title: "Payment Received",
    audience: [Role.PATIENT],
    messageFn: () => `We have received your payment of ₹${randomInt(500, 15000)}. Thank you.`,
  },
  {
    type: NotificationType.LAB_RESULT_READY,
    title: "Lab Results Ready",
    audience: [Role.PATIENT],
    messageFn: () => `Your lab results are available. Login to view or contact reception.`,
  },
  {
    type: NotificationType.MEDICATION_DUE,
    title: "Medication Reminder",
    audience: [Role.PATIENT],
    messageFn: () => `It's time to take your ${randomItem(["morning", "afternoon", "evening", "night"])} medication.`,
  },
  {
    type: NotificationType.ADMISSION,
    title: "Admission Confirmed",
    audience: [Role.PATIENT],
    messageFn: () => `Admission confirmed for bed #${randomInt(1, 50)}. Please proceed to the admission desk.`,
  },
  {
    type: NotificationType.DISCHARGE,
    title: "Discharge Summary",
    audience: [Role.PATIENT],
    messageFn: () => `Your discharge has been processed. Summary available in the app.`,
  },
];

const FAILURE_REASONS = [
  "Invalid phone number",
  "Opt-out: recipient unsubscribed",
  "Network timeout",
  "Provider rate limit exceeded",
  "Number on DND registry",
  "WhatsApp API: 24-hour window expired",
  "Email bounced: mailbox full",
];

function randomDateStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + randomInt(1, 14));
  return d.toISOString().split("T")[0];
}

function randomInPast30Days(): Date {
  const d = new Date();
  d.setDate(d.getDate() - randomInt(0, 30));
  d.setHours(randomInt(7, 21), randomInt(0, 59), 0, 0);
  return d;
}

async function main() {
  console.log("\n=== Seeding Notification Delivery Logs ===\n");

  const users = await prisma.user.findMany({ where: { isActive: true }, take: 80 });
  if (users.length === 0) {
    console.warn("  No users found. Skipping.");
    return;
  }

  // Issue #272: bucket users by role so each template only seeds rows for
  // an audience-appropriate recipient. A staff member must never receive a
  // patient-templated notification ("Your discharge has been processed").
  const usersByRole = new Map<Role, typeof users>();
  for (const u of users) {
    const list = usersByRole.get(u.role) ?? [];
    list.push(u);
    usersByRole.set(u.role, list);
  }

  const totalToCreate = 220;
  const existing = await prisma.notification.count();
  const target = Math.max(0, 200 - existing);
  const numToCreate = Math.max(target, totalToCreate - existing);
  const actualCount = Math.max(0, Math.min(totalToCreate, numToCreate));

  if (actualCount === 0) {
    console.log(`  Already have ${existing} notifications — skipping`);
    return;
  }

  const CHANNELS: NotificationChannel[] = [
    NotificationChannel.WHATSAPP,
    NotificationChannel.WHATSAPP,
    NotificationChannel.SMS,
    NotificationChannel.SMS,
    NotificationChannel.EMAIL,
    NotificationChannel.PUSH,
  ];

  let created = 0;
  let statusCounts: Record<string, number> = {};

  for (let i = 0; i < actualCount; i++) {
    const tpl = randomItem(TEMPLATES);
    // Issue #272: pick recipient from the template's audience pool only.
    // If no users with that role exist (e.g. no PATIENT seeded yet) skip
    // this iteration rather than fall back to a wrong-role recipient.
    const audiencePool = tpl.audience.flatMap(
      (r) => usersByRole.get(r) ?? []
    );
    if (audiencePool.length === 0) continue;
    const user = randomItem(audiencePool);
    const channel = randomItem(CHANNELS);
    const createdAt = randomInPast30Days();

    // Status distribution: 85% sent/delivered, 10% read, 5% failed
    const r = Math.random();
    let deliveryStatus: NotificationDeliveryStatus;
    let failureReason: string | null = null;
    let deliveredAt: Date | null = null;
    let sentAt: Date | null = null;
    let readAt: Date | null = null;

    if (r < 0.05) {
      deliveryStatus = NotificationDeliveryStatus.FAILED;
      failureReason = randomItem(FAILURE_REASONS);
      sentAt = new Date(createdAt.getTime() + randomInt(1, 30) * 1000);
    } else if (r < 0.15) {
      deliveryStatus = NotificationDeliveryStatus.READ;
      sentAt = new Date(createdAt.getTime() + randomInt(1, 20) * 1000);
      deliveredAt = new Date(sentAt.getTime() + randomInt(1, 15) * 1000);
      readAt = new Date(deliveredAt.getTime() + randomInt(30, 7200) * 1000);
    } else if (r < 0.6) {
      deliveryStatus = NotificationDeliveryStatus.DELIVERED;
      sentAt = new Date(createdAt.getTime() + randomInt(1, 20) * 1000);
      deliveredAt = new Date(sentAt.getTime() + randomInt(1, 15) * 1000);
    } else {
      deliveryStatus = NotificationDeliveryStatus.SENT;
      sentAt = new Date(createdAt.getTime() + randomInt(1, 20) * 1000);
    }

    statusCounts[deliveryStatus] = (statusCounts[deliveryStatus] ?? 0) + 1;

    await prisma.notification.create({
      data: {
        userId: user.id,
        type: tpl.type,
        channel,
        title: tpl.title,
        message: tpl.messageFn(),
        deliveryStatus,
        failureReason,
        sentAt,
        deliveredAt,
        readAt,
        createdAt,
      },
    });
    created++;
  }

  console.log(`\n✔ Notifications created: ${created}`);
  Object.entries(statusCounts).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
}

// Issue #272: only run main() when this file is the script entrypoint
// (tsx src/seed-notifications-history.ts). Importing the module from a
// test must NOT trigger the seed.
const isEntrypoint =
  typeof require !== "undefined"
    ? require.main === module
    : process.argv[1]?.includes("seed-notifications-history");

if (isEntrypoint) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
