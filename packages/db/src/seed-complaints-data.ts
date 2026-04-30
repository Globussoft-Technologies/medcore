import { PrismaClient, ComplaintStatus, Role } from "@prisma/client";

const prisma = new PrismaClient();

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function hoursFromNow(h: number): Date {
  const d = new Date();
  d.setHours(d.getHours() + h);
  return d;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// SLA hours by priority
const SLA_HOURS: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 24,
  MEDIUM: 72,
  LOW: 168,
};

type ComplaintSpec = {
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  status: ComplaintStatus;
  category: string;
  subCategory?: string;
  description: string;
  resolution?: string;
  escalationReason?: string;
  createdDaysAgo: number;
  slaOverdue?: boolean;
  name?: string;
  phone?: string;
};

const COMPLAINTS: ComplaintSpec[] = [
  // ─── CRITICAL (3) ─────────────────────────────────────
  {
    priority: "CRITICAL",
    status: "ESCALATED",
    category: "Patient Safety",
    subCategory: "Medication Error",
    description:
      "Patient received incorrect dosage of anticoagulant during morning medication round. No adverse event yet but INR pending. Demand immediate investigation and written response.",
    escalationReason: "Medication safety incident — escalated to Medical Director",
    createdDaysAgo: 2,
    slaOverdue: true,
    name: "Arun Malhotra",
    phone: "9900112233",
  },
  {
    priority: "CRITICAL",
    status: "UNDER_REVIEW",
    category: "Doctor attitude",
    subCategory: "Refusal of care",
    description:
      "On-call doctor allegedly refused to attend to a semi-conscious patient in the ER for 20 minutes citing shift change. Family extremely distressed.",
    createdDaysAgo: 0,
    name: "Shailesh Pawar",
    phone: "9822100001",
  },
  {
    priority: "CRITICAL",
    status: "UNDER_REVIEW",
    category: "Infection Control",
    subCategory: "Hospital Acquired Infection",
    description:
      "Post-operative patient developed surgical site infection within 48h of procedure. Family questioning sterilization protocols in the OT.",
    createdDaysAgo: 1,
    name: "Priya Kulkarni",
    phone: "9822100002",
  },

  // ─── HIGH (4) ─────────────────────────────────────────
  {
    priority: "HIGH",
    status: "RESOLVED",
    category: "Billing",
    subCategory: "Duplicate charges",
    description:
      "Invoice #INV20436 has two line items for the same MRI scan. Requesting reversal of ₹8,500.",
    resolution:
      "Verified with radiology — duplicate entry confirmed. Credit note issued (CN-0094) and refund processed to original payment mode within 3 working days. Apology call made to patient.",
    createdDaysAgo: 6,
    name: "Vikram Shah",
    phone: "9811122233",
  },
  {
    priority: "HIGH",
    status: "OPEN",
    category: "Waiting time",
    subCategory: "OPD",
    description:
      "Waited 3 hours past appointment time to see Dr. Rao on 10 April. Rescheduling was not communicated despite confirmed appointment on the app.",
    createdDaysAgo: 3,
  },
  {
    priority: "HIGH",
    status: "OPEN",
    category: "Doctor attitude",
    description:
      "Consultant was dismissive of symptoms and did not address my questions about treatment options. Felt rushed throughout the consultation.",
    createdDaysAgo: 2,
  },
  {
    priority: "HIGH",
    status: "ESCALATED",
    category: "Insurance",
    subCategory: "Cashless denial",
    description:
      "Cashless approval was denied at discharge despite pre-authorization on admission. Patient forced to pay ₹1.2L out of pocket. No TPA coordinator available to resolve.",
    escalationReason: "Escalated to Insurance desk head — SLA breach risk",
    createdDaysAgo: 4,
  },

  // ─── MEDIUM (5) ───────────────────────────────────────
  {
    priority: "MEDIUM",
    status: "RESOLVED",
    category: "Cleanliness",
    subCategory: "Ward hygiene",
    description:
      "Ward B toilet had not been cleaned for what appeared to be several hours during our stay on 2 April.",
    resolution:
      "Housekeeping supervisor counseled. Cleaning frequency increased to 4-hourly in all patient wards and documented via hourly audit sheets posted at entrance.",
    createdDaysAgo: 12,
  },
  {
    priority: "MEDIUM",
    status: "RESOLVED",
    category: "Food",
    subCategory: "Dietary restrictions",
    description:
      "Diabetic patient was served rice pudding with added sugar despite dietary note on chart.",
    resolution:
      "Root cause: dietician's note did not reach kitchen for the evening meal. New workflow — dietary restrictions now printed on every meal tag and signed-off at dispatch.",
    createdDaysAgo: 15,
  },
  {
    priority: "MEDIUM",
    status: "UNDER_REVIEW",
    category: "Billing",
    subCategory: "Unclear charges",
    description:
      "Several line items on the bill are unclear. Requesting itemized explanation of 'consumables — miscellaneous' charge of ₹3,200.",
    createdDaysAgo: 5,
  },
  {
    priority: "MEDIUM",
    status: "OPEN",
    category: "Parking",
    description:
      "Parking attendant rude to visitors, refused entry despite valid visitor pass. Needs training in courtesy.",
    createdDaysAgo: 1,
  },
  {
    priority: "MEDIUM",
    status: "OPEN",
    category: "Communication",
    subCategory: "Discharge process",
    description:
      "Discharge summary and medications not explained properly. Family was left unclear about follow-up timings and dressing changes.",
    createdDaysAgo: 3,
  },

  // ─── LOW (3) ──────────────────────────────────────────
  {
    priority: "LOW",
    status: "RESOLVED",
    category: "Reception",
    subCategory: "Information request",
    description:
      "Could not find doctor's consultation schedule on website clearly.",
    resolution:
      "Website updated with clearer weekly schedule layout. Feedback shared with digital team.",
    createdDaysAgo: 22,
  },
  {
    priority: "LOW",
    status: "CLOSED",
    category: "Facilities",
    subCategory: "AC",
    description: "AC in waiting area was not working on a hot afternoon.",
    resolution: "Unit serviced same day; filter replaced. Closed.",
    createdDaysAgo: 30,
  },
  {
    priority: "LOW",
    status: "CLOSED",
    category: "Pharmacy",
    subCategory: "Stock",
    description: "Preferred brand of Vitamin D3 was not in stock at pharmacy.",
    resolution: "Alternative brand suggested by pharmacist. Requested brand added to reorder list.",
    createdDaysAgo: 25,
  },
];

async function main() {
  console.log("\n=== Seeding Complaints ===\n");

  // Assignees: reception/admin users
  const assignees = await prisma.user.findMany({
    where: { role: { in: [Role.ADMIN, Role.RECEPTION] }, isActive: true },
    take: 5,
  });
  // Some complaints should reference existing patients
  const patients = await prisma.patient.findMany({
    take: 10,
    include: { user: true },
  });

  let created = 0;
  let seq = 1;
  // Start from a high ticket number to avoid collisions
  const existing = await prisma.complaint.count();
  seq = existing + 1;

  for (const c of COMPLAINTS) {
    // Issue #275 (Apr 2026): unify on the canonical `CMP-YYYY-NNNNN`
    // prefix used by the API generator (apps/api/src/routes/feedback.ts).
    // Previously the seed emitted `COMP-...` while the runtime emitted
    // `CMP...`, leaving reception with a mix of formats in the list.
    const ticketNumber = `CMP-${new Date().getFullYear()}-${String(seq).padStart(5, "0")}`;
    seq++;

    // Check idempotency by ticketNumber
    const exists = await prisma.complaint.findUnique({ where: { ticketNumber } });
    if (exists) continue;

    const createdAt = daysAgo(c.createdDaysAgo);
    const slaDueAt = new Date(createdAt.getTime() + SLA_HOURS[c.priority] * 3600_000);
    // Force overdue where requested
    const finalSlaDueAt = c.slaOverdue ? hoursFromNow(-6) : slaDueAt;

    // Random patient link for ~60% of complaints
    let patientId: string | null = null;
    let name: string | undefined = c.name;
    let phone: string | undefined = c.phone;
    if (!name && patients.length > 0 && Math.random() > 0.4) {
      const p = randomItem(patients);
      patientId = p.id;
      name = p.user.name;
      phone = p.user.phone;
    }

    const assignedTo =
      c.status !== "OPEN" && assignees.length > 0 ? randomItem(assignees).id : null;

    const resolvedAt =
      c.status === "RESOLVED" || c.status === "CLOSED"
        ? new Date(createdAt.getTime() + (SLA_HOURS[c.priority] * 0.7) * 3600_000)
        : null;

    const escalatedAt = c.status === "ESCALATED" ? new Date(createdAt.getTime() + 2 * 3600_000) : null;

    await prisma.complaint.create({
      data: {
        ticketNumber,
        patientId: patientId ?? undefined,
        name,
        phone,
        category: c.category,
        subCategory: c.subCategory,
        description: c.description,
        status: c.status,
        priority: c.priority,
        assignedTo: assignedTo ?? undefined,
        resolution: c.resolution,
        resolvedAt: resolvedAt ?? undefined,
        slaDueAt: finalSlaDueAt,
        escalatedAt: escalatedAt ?? undefined,
        escalationReason: c.escalationReason,
        createdAt,
      },
    });
    created++;
  }

  // Summary
  const byPriority = await prisma.complaint.groupBy({ by: ["priority"], _count: true });
  const byStatus = await prisma.complaint.groupBy({ by: ["status"], _count: true });

  console.log(`\n✔ Complaints created: ${created}`);
  console.log(`  By priority:`);
  byPriority.forEach((p) => console.log(`    ${p.priority}: ${p._count}`));
  console.log(`  By status:`);
  byStatus.forEach((s) => console.log(`    ${s.status}: ${s._count}`));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
