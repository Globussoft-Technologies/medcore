import { prisma } from "@medcore/db";
import { NotificationType } from "@medcore/shared";
import { sendNotification, drainScheduled } from "./notification";

// ───────────────────────────────────────────────────────
// Lightweight setInterval-based scheduler.
// ───────────────────────────────────────────────────────
//
// Every 60 seconds we walk through the registered tasks,
// read their `last-run` from the `system_config` key
// `medcore_task_registry:<task_name>`, and run any tasks whose
// interval has elapsed. Each task runner is fire-and-forget.
//
// Tasks are additive — existing notification triggers and
// domain logic remain unchanged. This is purely a scheduler.

interface ScheduledTask {
  name: string;
  /** minimum interval between runs, in minutes */
  intervalMinutes: number;
  /** Optional: only run when local hour matches (0-23) */
  runAtHour?: number;
  run: () => Promise<void>;
}

const TASK_REGISTRY_PREFIX = "medcore_task_registry:";

async function getLastRun(name: string): Promise<Date | null> {
  try {
    const row = await prisma.systemConfig.findUnique({
      where: { key: TASK_REGISTRY_PREFIX + name },
    });
    if (!row?.value) return null;
    const d = new Date(row.value);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

async function setLastRun(name: string, at: Date): Promise<void> {
  try {
    await prisma.systemConfig.upsert({
      where: { key: TASK_REGISTRY_PREFIX + name },
      create: { key: TASK_REGISTRY_PREFIX + name, value: at.toISOString() },
      update: { value: at.toISOString() },
    });
  } catch (err) {
    console.error(`[scheduler] failed to persist last-run for ${name}`, err);
  }
}

// ─── Task implementations ──────────────────────────────

async function appointmentReminders24h(): Promise<void> {
  const now = new Date();
  const start = new Date(now.getTime() + 23 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 25 * 60 * 60 * 1000);
  const appts = await prisma.appointment.findMany({
    where: {
      status: "BOOKED",
      date: { gte: new Date(start.toDateString()), lte: new Date(end.toDateString()) },
    },
    include: {
      patient: { include: { user: true } },
      doctor: { include: { user: true } },
    },
    take: 200,
  });
  for (const a of appts) {
    if (!a.patient?.user) continue;
    try {
      await sendNotification({
        userId: a.patient.user.id,
        type: NotificationType.APPOINTMENT_REMINDER,
        title: "Appointment Reminder (24h)",
        message: `Hi ${a.patient.user.name}, reminder: your appointment with Dr. ${a.doctor.user.name} is tomorrow${a.slotStart ? ` at ${a.slotStart}` : ""}. Token #${a.tokenNumber}.`,
        data: { appointmentId: a.id },
      });
    } catch (err) {
      console.error("[appointment_reminders_24h]", err);
    }
  }
}

async function appointmentReminders1h(): Promise<void> {
  const now = new Date();
  const from = new Date(now.getTime() + 45 * 60 * 1000);
  const to = new Date(now.getTime() + 75 * 60 * 1000);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const appts = await prisma.appointment.findMany({
    where: { status: "BOOKED", date: day },
    include: {
      patient: { include: { user: true } },
      doctor: { include: { user: true } },
    },
    take: 200,
  });
  for (const a of appts) {
    if (!a.slotStart) continue;
    // slotStart is "HH:MM" — compare with now
    const [hh, mm] = a.slotStart.split(":").map((s) => parseInt(s, 10));
    const slotAt = new Date(day);
    slotAt.setHours(hh, mm, 0, 0);
    if (slotAt < from || slotAt > to) continue;
    if (!a.patient?.user) continue;
    try {
      await sendNotification({
        userId: a.patient.user.id,
        type: NotificationType.APPOINTMENT_REMINDER,
        title: "Appointment Starting Soon (1h)",
        message: `Hi ${a.patient.user.name}, your appointment with Dr. ${a.doctor.user.name} starts at ${a.slotStart}. Please arrive 10 min early. Token #${a.tokenNumber}.`,
        data: { appointmentId: a.id },
      });
    } catch (err) {
      console.error("[appointment_reminders_1h]", err);
    }
  }
}

async function feedbackRequestPostVisit(): Promise<void> {
  const now = new Date();
  const from = new Date(now.getTime() - 25 * 60 * 60 * 1000);
  const to = new Date(now.getTime() - 23 * 60 * 60 * 1000);
  const appts = await prisma.appointment.findMany({
    where: {
      status: "COMPLETED",
      date: { gte: new Date(from.toDateString()), lte: new Date(to.toDateString()) },
    },
    include: { patient: { include: { user: true } } },
    take: 200,
  });
  for (const a of appts) {
    if (!a.patient?.user) continue;
    try {
      await sendNotification({
        userId: a.patient.user.id,
        type: NotificationType.SCHEDULE_SUMMARY,
        title: "How was your visit?",
        message: `Hi ${a.patient.user.name}, thank you for your visit. Please share your feedback at /feedback?appointmentId=${a.id}.`,
        data: { appointmentId: a.id },
      });
    } catch (err) {
      console.error("[feedback_request_post_visit]", err);
    }
  }
}

async function overdueInvoiceReminders(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const invoices = await prisma.invoice.findMany({
    where: {
      paymentStatus: { in: ["PENDING", "PARTIAL"] },
      createdAt: { lte: cutoff },
    },
    include: { patient: { include: { user: true } } },
    take: 200,
  });
  for (const inv of invoices) {
    if (!inv.patient?.user) continue;
    try {
      await sendNotification({
        userId: inv.patient.user.id,
        type: NotificationType.BILL_GENERATED,
        title: "Overdue Invoice Reminder",
        message: `Hi ${inv.patient.user.name}, your invoice ${inv.invoiceNumber} of Rs. ${inv.totalAmount.toFixed(2)} is overdue. Please settle at the earliest.`,
        data: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber },
      });
    } catch (err) {
      console.error("[overdue_invoice_reminders]", err);
    }
  }
}

async function patientBirthdays(): Promise<void> {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  // Pull a page of patients with DOB set and filter in memory
  const patients = await prisma.patient.findMany({
    where: { dateOfBirth: { not: null } },
    include: { user: true },
    take: 2000,
  });
  for (const p of patients) {
    if (!p.dateOfBirth) continue;
    const dob = new Date(p.dateOfBirth);
    if (dob.getMonth() + 1 !== month || dob.getDate() !== day) continue;
    try {
      await sendNotification({
        userId: p.user.id,
        type: NotificationType.SCHEDULE_SUMMARY,
        title: "Happy Birthday!",
        message: `Dear ${p.user.name}, the team at MedCore wishes you a very happy birthday. Stay healthy!`,
        data: { patientId: p.id },
      });
    } catch (err) {
      console.error("[patient_birthdays]", err);
    }
  }
}

async function bloodUnitExpiryAlerts(): Promise<void> {
  const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const units = await prisma.bloodUnit.findMany({
    where: {
      status: "AVAILABLE",
      expiresAt: { gt: new Date(), lte: soon },
    },
    take: 500,
  });
  if (units.length === 0) return;
  // Notify blood bank staff (role NURSE/DOCTOR are reasonable; fall back to ADMIN)
  const staff = await prisma.user.findMany({
    where: { role: { in: ["NURSE", "DOCTOR", "ADMIN"] } },
    take: 50,
    select: { id: true, name: true },
  });
  for (const s of staff) {
    try {
      await sendNotification({
        userId: s.id,
        type: NotificationType.SCHEDULE_SUMMARY,
        title: "Blood units expiring soon",
        message: `${units.length} blood unit(s) are expiring within 3 days. Please review inventory.`,
        data: { expiringCount: units.length },
      });
    } catch (err) {
      console.error("[blood_unit_expiry_alerts]", err);
    }
  }
}

async function shiftStartReminders(): Promise<void> {
  const now = new Date();
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const fromMin = now.getHours() * 60 + now.getMinutes() + 45;
  const toMin = now.getHours() * 60 + now.getMinutes() + 75;
  try {
    const shifts = await prisma.staffShift.findMany({
      where: { date: day, status: "SCHEDULED" },
      include: { user: true },
      take: 500,
    });
    for (const sh of shifts) {
      const [hh, mm] = sh.startTime.split(":").map((s) => parseInt(s, 10));
      const minutes = hh * 60 + mm;
      if (minutes < fromMin || minutes > toMin) continue;
      try {
        await sendNotification({
          userId: sh.userId,
          type: NotificationType.SCHEDULE_SUMMARY,
          title: "Shift starting in 1 hour",
          message: `Reminder: your ${sh.type} shift starts at ${sh.startTime}.`,
          data: { shiftId: sh.id },
        });
      } catch (err) {
        console.error("[shift_start_reminders inner]", err);
      }
    }
  } catch (err) {
    console.error("[shift_start_reminders]", err);
  }
}

// ─── Auto-PO: low stock → draft PO (Task 20) ───────────

async function autoDraftPurchaseOrders(): Promise<void> {
  try {
    // Threshold: item.quantity < reorderLevel * (auto_po_threshold/100)
    const cfg = await prisma.systemConfig.findUnique({
      where: { key: "auto_po_threshold" },
    });
    const thresholdPct = cfg?.value ? parseInt(cfg.value, 10) : 50; // default 50%

    const inv = await prisma.inventoryItem.findMany({
      where: {
        reorderLevel: { gt: 0 },
      },
      include: { medicine: true },
      take: 500,
    });
    const needing = inv.filter(
      (i) => i.quantity < (i.reorderLevel * thresholdPct) / 100
    );
    if (needing.length === 0) return;

    // Group by supplier string — use the first active supplier match if any
    const suppliers = await prisma.supplier.findMany({
      where: { isActive: true },
      take: 50,
    });
    if (suppliers.length === 0) return;

    // Group items by normalized supplier name (fallback: first active)
    const groups = new Map<string, typeof needing>();
    for (const it of needing) {
      const key =
        suppliers.find(
          (s) =>
            it.supplier &&
            s.name.toLowerCase() === (it.supplier || "").toLowerCase()
        )?.id || suppliers[0].id;
      const arr = groups.get(key) ?? [];
      arr.push(it);
      groups.set(key, arr);
    }

    for (const [supplierId, items] of groups.entries()) {
      // Skip if there's already an open draft PO for this supplier covering these
      const existingDraft = await prisma.purchaseOrder.findFirst({
        where: {
          supplierId,
          status: { in: ["DRAFT", "PENDING"] },
          notes: { contains: "auto-generated: low stock" },
        },
      });
      if (existingDraft) continue;

      const poItems = items.map((i) => {
        const qty = Math.max(1, i.reorderLevel - i.quantity);
        return {
          description:
            i.medicine?.name ??
            `Inventory item ${i.id.slice(0, 6)}`,
          medicineId: i.medicineId ?? null,
          quantity: qty,
          unitPrice: i.unitCost ?? 0,
          amount: (i.unitCost ?? 0) * qty,
        };
      });
      const subtotal = poItems.reduce((s, p) => s + p.amount, 0);
      const poNumber = `PO-AUTO-${Date.now().toString(36).toUpperCase()}`;
      try {
        await prisma.purchaseOrder.create({
          data: {
            poNumber,
            supplierId,
            status: "DRAFT",
            subtotal,
            taxAmount: 0,
            totalAmount: subtotal,
            notes: `auto-generated: low stock (threshold ${thresholdPct}% of reorder level)`,
            items: { create: poItems },
          },
        });
        console.log(
          `[auto_po_threshold] created draft PO ${poNumber} for ${poItems.length} items`
        );
      } catch (err) {
        console.error("[auto_po_threshold] create failed", err);
      }
    }
  } catch (err) {
    console.error("[auto_po_threshold]", err);
  }
}

// ─── Drain queued (deferred) notifications ─────────────

async function notificationDrainQueued(): Promise<void> {
  try {
    const processed = await drainScheduled();
    if (processed > 0) {
      console.log(`[notification_drain_queued] processed ${processed}`);
    }
  } catch (err) {
    console.error("[notification_drain_queued]", err);
  }
}

// ─── Task registry ─────────────────────────────────────

const TASKS: ScheduledTask[] = [
  {
    name: "appointment_reminders_24h",
    intervalMinutes: 60,
    run: appointmentReminders24h,
  },
  {
    name: "appointment_reminders_1h",
    intervalMinutes: 15,
    run: appointmentReminders1h,
  },
  {
    name: "feedback_request_post_visit",
    intervalMinutes: 60,
    run: feedbackRequestPostVisit,
  },
  {
    name: "overdue_invoice_reminders",
    intervalMinutes: 24 * 60,
    run: overdueInvoiceReminders,
  },
  {
    name: "patient_birthdays",
    intervalMinutes: 24 * 60,
    runAtHour: 9,
    run: patientBirthdays,
  },
  {
    name: "blood_unit_expiry_alerts",
    intervalMinutes: 24 * 60,
    run: bloodUnitExpiryAlerts,
  },
  {
    name: "shift_start_reminders",
    intervalMinutes: 60,
    run: shiftStartReminders,
  },
  {
    name: "auto_po_threshold",
    intervalMinutes: 60,
    run: autoDraftPurchaseOrders,
  },
  {
    name: "notification_drain_queued",
    intervalMinutes: 1,
    run: notificationDrainQueued,
  },
];

let intervalHandle: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const now = new Date();
  for (const task of TASKS) {
    try {
      if (task.runAtHour != null && now.getHours() !== task.runAtHour) continue;
      const last = await getLastRun(task.name);
      if (last) {
        const sinceMin = (now.getTime() - last.getTime()) / 60000;
        if (sinceMin < task.intervalMinutes) continue;
      }
      // Mark as started immediately to avoid double-run on next tick
      await setLastRun(task.name, now);
      // Fire-and-forget; errors are caught inside each task
      task
        .run()
        .catch((err) => console.error(`[scheduler] ${task.name} failed`, err));
    } catch (err) {
      console.error(`[scheduler] tick error for ${task.name}`, err);
    }
  }
}

export function registerScheduledTasks(): void {
  if (intervalHandle) return;
  console.log(`[scheduler] registering ${TASKS.length} scheduled tasks`);
  // First tick after 10s grace so the server finishes booting
  setTimeout(() => {
    tick().catch((err) => console.error("[scheduler] initial tick", err));
  }, 10_000);
  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error("[scheduler] tick", err));
  }, 60_000);
}

export function stopScheduledTasks(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
