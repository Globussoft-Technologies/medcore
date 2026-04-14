import { PrismaClient, Role, ShiftType, LeaveType, LeaveStatus } from "@prisma/client";

const prisma = new PrismaClient();

function toUtcDate(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0)
  );
}

function isWeekday(d: Date): boolean {
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
}

async function main() {
  console.log("=== Seeding HR data (shifts & leave) ===\n");

  // Fetch all relevant staff users
  const staff = await prisma.user.findMany({
    where: {
      role: { in: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION] },
      isActive: true,
    },
    select: { id: true, name: true, role: true },
  });

  if (staff.length === 0) {
    console.log("No staff users found — run primary seed first (db:seed).");
    return;
  }
  console.log(`Found ${staff.length} staff users`);

  // Next 7 days starting today (UTC)
  const today = toUtcDate(new Date());
  const days: Date[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    return d;
  });

  let shiftsCreated = 0;
  let shiftsSkipped = 0;

  // Iterate nurses to alternate morning/afternoon
  const nurses = staff.filter((u) => u.role === Role.NURSE);
  const doctors = staff.filter((u) => u.role === Role.DOCTOR);
  const reception = staff.filter((u) => u.role === Role.RECEPTION);
  const admins = staff.filter((u) => u.role === Role.ADMIN);

  // Helper to safely create a shift (ignore unique-constraint duplicates)
  async function createShift(
    userId: string,
    date: Date,
    type: ShiftType,
    startTime: string,
    endTime: string
  ) {
    try {
      await prisma.staffShift.create({
        data: { userId, date, type, startTime, endTime },
      });
      shiftsCreated++;
    } catch (err: any) {
      if (err?.code === "P2002") {
        shiftsSkipped++;
      } else {
        throw err;
      }
    }
  }

  // Doctors — morning 09:00–13:00 on weekdays
  for (const day of days) {
    if (!isWeekday(day)) continue;
    for (const d of doctors) {
      await createShift(d.id, day, ShiftType.MORNING, "09:00", "13:00");
    }
  }

  // Nurses — alternate morning/afternoon every day
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    for (let j = 0; j < nurses.length; j++) {
      const n = nurses[j];
      // Alternate by (i + j) parity: even -> morning, odd -> afternoon
      if ((i + j) % 2 === 0) {
        await createShift(n.id, day, ShiftType.MORNING, "07:00", "15:00");
      } else {
        await createShift(n.id, day, ShiftType.AFTERNOON, "15:00", "23:00");
      }
    }
  }

  // Reception — morning 09:00–18:00 on weekdays
  for (const day of days) {
    if (!isWeekday(day)) continue;
    for (const r of reception) {
      await createShift(r.id, day, ShiftType.MORNING, "09:00", "18:00");
    }
  }

  // Admins — morning 09:00–18:00 on weekdays
  for (const day of days) {
    if (!isWeekday(day)) continue;
    for (const a of admins) {
      await createShift(a.id, day, ShiftType.MORNING, "09:00", "18:00");
    }
  }

  console.log(`  Shifts: created ${shiftsCreated}, skipped ${shiftsSkipped}`);

  // ─── Leave requests ──────────────────────────────────────
  const leaveTarget =
    nurses[0] || doctors[0] || reception[0] || admins[0] || staff[0];
  const approver = admins[0] || staff.find((u) => u.role === Role.ADMIN);
  if (!leaveTarget || !approver) {
    console.log("Cannot seed leaves — no users available");
    return;
  }

  // Clear existing sample leave requests for target user (optional)
  // We'll rely on no unique constraint; just create fresh ones.

  const inDays = (n: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };

  // 1. Pending leave (future)
  await prisma.leaveRequest.create({
    data: {
      userId: leaveTarget.id,
      type: LeaveType.CASUAL,
      fromDate: inDays(20),
      toDate: inDays(22),
      totalDays: 3,
      reason: "Family function",
      status: LeaveStatus.PENDING,
    },
  });

  // 2. Approved leave (past)
  await prisma.leaveRequest.create({
    data: {
      userId: leaveTarget.id,
      type: LeaveType.SICK,
      fromDate: inDays(-30),
      toDate: inDays(-29),
      totalDays: 2,
      reason: "Fever and flu",
      status: LeaveStatus.APPROVED,
      approvedBy: approver.id,
      approvedAt: inDays(-31),
    },
  });

  // 3. Rejected leave
  await prisma.leaveRequest.create({
    data: {
      userId: leaveTarget.id,
      type: LeaveType.EARNED,
      fromDate: inDays(-10),
      toDate: inDays(-5),
      totalDays: 6,
      reason: "Vacation plans",
      status: LeaveStatus.REJECTED,
      approvedBy: approver.id,
      approvedAt: inDays(-12),
      rejectionReason: "Insufficient earned-leave balance",
    },
  });

  console.log("  Leave requests: created 3 samples (pending, approved, rejected)");
  console.log(`  Target user: ${leaveTarget.name} (${leaveTarget.role})`);

  console.log("\nHR seeding complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
