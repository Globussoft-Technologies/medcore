import { PrismaClient, VisitorPurpose, Role } from "@prisma/client";

const prisma = new PrismaClient();

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const VISITOR_NAMES = [
  "Ramesh Kulkarni", "Sunita Patil", "Deepak Bhosale", "Priya Iyer", "Vijay Rao",
  "Manisha Shah", "Anil Kumar", "Kavita Desai", "Sanjay Verma", "Nandini Nair",
  "Rahul Joshi", "Meena Gupta", "Harish Menon", "Rekha Sharma", "Ashok Pandey",
  "Divya Malhotra", "Bharat Singh", "Geeta Reddy", "Mohan Das", "Lakshmi Pillai",
  "Nitin Chavan", "Swati Jain", "Suresh Yadav", "Anita Deshpande", "Prakash Shetty",
  "Kiran Agarwal", "Manoj Gaikwad", "Fatima Khan", "Arun Mishra", "Neha Kapoor",
];

const BLACKLIST_REASONS = [
  "Aggressive behavior towards staff — asked to leave premises",
  "Attempted to bring prohibited items into ICU ward",
  "History of disturbing patients in maternity ward",
  "Multiple complaints from staff regarding inappropriate conduct",
  "Impersonated a relative to gain access — security incident",
];

const DEPARTMENTS = [
  "ICU", "Ward A", "Ward B", "Maternity", "Pediatrics", "OPD", "Emergency",
  "Administration", "Lab", "Pharmacy",
];

const ID_PROOF_TYPES = ["AADHAAR", "DRIVING_LICENSE", "VOTER_ID", "PAN_CARD", "PASSPORT"];

async function main() {
  console.log("\n=== Seeding Visitor History ===\n");

  const patients = await prisma.patient.findMany({ take: 20 });
  const adminUsers = await prisma.user.findMany({
    where: { role: { in: [Role.ADMIN, Role.RECEPTION] }, isActive: true },
    take: 3,
  });
  const addedBy = adminUsers[0]?.id;

  // Check if we already have plenty
  const existingVisitors = await prisma.visitor.count();
  if (existingVisitors >= 50) {
    console.log(`  Already have ${existingVisitors} visitors — skipping insert`);
  }

  const totalToCreate = Math.max(0, 50 - existingVisitors);
  const now = Date.now();

  // Some returning visitors (same phone across multiple entries)
  const returningPool = [
    { name: "Rakesh Khanna", phone: "9900112211" },
    { name: "Sunita Patil", phone: "9900112212" },
    { name: "Mohan Das", phone: "9900112213" },
  ];

  let visitorsCreated = 0;
  let passSeq = (await prisma.visitor.count()) + 1;

  for (let i = 0; i < totalToCreate; i++) {
    // ~20% are returning visitors
    const isReturning = Math.random() < 0.2 && returningPool.length > 0;
    const rv = isReturning ? randomItem(returningPool) : null;

    const name = rv ? rv.name : randomItem(VISITOR_NAMES);
    const phone = rv ? rv.phone : `98${randomInt(10000000, 99999999)}`;

    // Spread over last 30 days
    const daysOffset = randomInt(0, 30);
    const hourOfDay = randomInt(8, 20);
    const checkInMs = now - daysOffset * 24 * 3600_000 - (24 - hourOfDay) * 3600_000 + randomInt(0, 59) * 60_000;
    const checkInAt = new Date(checkInMs);

    // Duration: 15min to 8h, most 30-120 min
    const durationMin = (() => {
      const r = Math.random();
      if (r < 0.1) return randomInt(15, 30);
      if (r < 0.7) return randomInt(30, 120);
      if (r < 0.95) return randomInt(120, 300);
      return randomInt(300, 480);
    })();
    const checkOutAt =
      daysOffset === 0 && Math.random() < 0.3
        ? null // still on-site
        : new Date(checkInAt.getTime() + durationMin * 60_000);

    // Purpose distribution: PATIENT_VISIT dominates
    const purpose: VisitorPurpose = (() => {
      const r = Math.random();
      if (r < 0.65) return VisitorPurpose.PATIENT_VISIT;
      if (r < 0.8) return VisitorPurpose.APPOINTMENT;
      if (r < 0.9) return VisitorPurpose.MEETING;
      if (r < 0.96) return VisitorPurpose.DELIVERY;
      return VisitorPurpose.OTHER;
    })();

    const patientId =
      purpose === VisitorPurpose.PATIENT_VISIT && patients.length > 0
        ? randomItem(patients).id
        : null;

    const passNumber = `VP-${new Date().getFullYear()}-${String(passSeq).padStart(5, "0")}`;
    passSeq++;

    await prisma.visitor.create({
      data: {
        passNumber,
        name,
        phone,
        idProofType: randomItem(ID_PROOF_TYPES),
        idProofNumber: `${randomInt(1000, 9999)}-${randomInt(1000, 9999)}-${randomInt(1000, 9999)}`,
        patientId: patientId ?? undefined,
        purpose,
        department: randomItem(DEPARTMENTS),
        checkInAt,
        checkOutAt,
        notes:
          purpose === VisitorPurpose.DELIVERY
            ? randomItem(["Medical supplies delivery", "Food delivery", "Courier package"])
            : purpose === VisitorPurpose.MEETING
            ? randomItem(["Vendor meeting", "Interview candidate", "External consultant"])
            : null,
      },
    });
    visitorsCreated++;
  }

  // ─── Blacklist entries ────────────────────────────────
  const blacklistEntries = [
    { name: "Kabir Razdan", phone: "9100000001", idProofNumber: "5555-1111-2222" },
    { name: "Unknown — Incident 2025-11-03", phone: "9100000002", idProofNumber: "3456-7890-1234" },
    { name: "Satish Kumar (alias)", phone: "9100000003", idProofNumber: "9999-0000-1111" },
    { name: "Vijay Shah", phone: "9100000004", idProofNumber: null },
    { name: "Unnamed — Maternity incident 2026-02", phone: "9100000005", idProofNumber: null },
  ];

  let blacklisted = 0;
  for (let i = 0; i < blacklistEntries.length; i++) {
    const entry = blacklistEntries[i];
    const reason = BLACKLIST_REASONS[i % BLACKLIST_REASONS.length];
    const existing = entry.idProofNumber
      ? await prisma.visitorBlacklist.findFirst({ where: { idProofNumber: entry.idProofNumber } })
      : await prisma.visitorBlacklist.findFirst({ where: { phone: entry.phone } });
    if (existing) continue;

    await prisma.visitorBlacklist.create({
      data: {
        name: entry.name,
        phone: entry.phone,
        idProofType: entry.idProofNumber ? "AADHAAR" : null,
        idProofNumber: entry.idProofNumber,
        reason,
        addedBy: addedBy ?? "system",
      },
    });
    blacklisted++;
  }

  console.log(`\n✔ Visitors created:      ${visitorsCreated}`);
  console.log(`✔ Blacklist entries:     ${blacklisted}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
