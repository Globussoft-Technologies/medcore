import fs from "fs";
import path from "path";
import { prisma } from "@medcore/db";
import { NotificationType } from "@medcore/shared";
import { sendNotification, drainScheduled } from "./notification";
import { runDailyFraudScan } from "../routes/ai-fraud";
import { runDailyDocQAScheduledTask } from "../routes/ai-doc-qa";
import { runDailyNpsDriverRollup } from "../routes/ai-sentiment";
import { runAuditLogArchival } from "./audit-archival";
import { autoNoShowElapsedBookedTask } from "./auto-noshow";

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

// ─── Cleanup orphaned uploads (Task: cleanup_orphaned_uploads) ──
//
// Walks the on-disk EHR upload directory and deletes physical files that
// are NOT referenced by any PatientDocument.filePath AND are older than
// 30 days. This handles the case where an upload was written to disk but
// the PatientDocument row was never created (eg. failed transaction) or
// was hard-deleted afterwards. Logs the count of removed files.
async function cleanupOrphanedUploads(): Promise<void> {
  try {
    const uploadDir = path.join(process.cwd(), "uploads", "ehr");
    if (!fs.existsSync(uploadDir)) return;
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(uploadDir);
    } catch {
      return;
    }
    if (entries.length === 0) return;

    // Build a set of all referenced storage filenames.
    const referenced = new Set<string>();
    const docs = await prisma.patientDocument.findMany({
      select: { filePath: true },
    });
    for (const d of docs) {
      if (!d.filePath) continue;
      referenced.add(path.basename(d.filePath));
    }

    let removed = 0;
    for (const name of entries) {
      try {
        if (referenced.has(name)) continue;
        const full = path.join(uploadDir, name);
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs > cutoffMs) continue; // not old enough
        fs.unlinkSync(full);
        removed += 1;
      } catch (err) {
        console.error("[cleanup_orphaned_uploads] unlink", name, err);
      }
    }
    if (removed > 0) {
      console.log(`[cleanup_orphaned_uploads] removed ${removed} orphan file(s)`);
    }
  } catch (err) {
    console.error("[cleanup_orphaned_uploads]", err);
  }
}

// ─── Rate-limit bypass alarm (Gap 3) ───────────────────
//
// `DISABLE_RATE_LIMITS=true` is an ops escape hatch for running load tests /
// E2E campaigns against prod without tripping the 429 gate. It MUST be
// short-lived — left on permanently it silently disables the global 600/min
// defence plus every per-route limiter. This alarm counts consecutive
// scheduler ticks that observed the env var set and fires a single
// `RATE_LIMITS_DISABLED_EXTENDED` audit entry once the counter reaches 3
// (≈ 3 minutes of sustained bypass). The counter resets the moment
// DISABLE_RATE_LIMITS is unset. The alarm is rate-limited to once per 6h to
// avoid audit-log spam during an extended campaign.

interface RateLimitAlarmState {
  count: number;
  firedAt: Date | null;
}

const rateLimitAlarmState: RateLimitAlarmState = {
  count: 0,
  firedAt: null,
};

const RATE_LIMIT_ALARM_THRESHOLD = 3;
const RATE_LIMIT_ALARM_COOLDOWN_MS = 6 * 60 * 60 * 1000;

async function rateLimitBypassCheck(): Promise<void> {
  const bypassed = process.env.DISABLE_RATE_LIMITS === "true";
  if (!bypassed) {
    rateLimitAlarmState.count = 0;
    return;
  }
  rateLimitAlarmState.count += 1;
  if (rateLimitAlarmState.count < RATE_LIMIT_ALARM_THRESHOLD) return;

  const now = Date.now();
  if (
    rateLimitAlarmState.firedAt &&
    now - rateLimitAlarmState.firedAt.getTime() < RATE_LIMIT_ALARM_COOLDOWN_MS
  ) {
    return;
  }

  try {
    await prisma.auditLog.create({
      data: {
        action: "RATE_LIMITS_DISABLED_EXTENDED",
        entity: "system",
        entityId: "rate_limit_bypass",
        details: {
          severity: "WARNING",
          consecutiveChecks: rateLimitAlarmState.count,
          message:
            "DISABLE_RATE_LIMITS=true observed across 3+ scheduler ticks — ops must unset this env var unless a load/E2E campaign is still running.",
        } as any,
      } as any,
    });
    rateLimitAlarmState.firedAt = new Date();
  } catch (err) {
    console.error("[rate_limit_bypass_check]", err);
  }
}

/** Test-only reset hook for {@link rateLimitAlarmState}. */
export function _resetRateLimitAlarmForTests(): void {
  rateLimitAlarmState.count = 0;
  rateLimitAlarmState.firedAt = null;
}

/** Test-only peek hook for {@link rateLimitAlarmState}. */
export function _peekRateLimitAlarmStateForTests(): RateLimitAlarmState {
  return { ...rateLimitAlarmState };
}

// ─── Auto-cancel stale SCHEDULED surgeries (Issue #160) ─────
//
// The withStaleFlags helper in routes/surgery.ts only re-labels rows on read;
// the underlying Prisma row stays SCHEDULED forever. After ~7 days a missed
// surgery is unequivocally not happening, so we transition the row to
// CANCELLED and emit an audit log so the audit trail captures the fact that
// no human cancelled it. Hospitals can re-create a fresh row if the case is
// rescheduled — we deliberately do NOT delete data.

const STALE_SURGERY_CANCEL_AFTER_DAYS = 7;

export async function autoCancelStaleScheduledSurgeries(now: Date = new Date()): Promise<{
  cancelled: number;
  ids: string[];
}> {
  const cutoff = new Date(
    now.getTime() - STALE_SURGERY_CANCEL_AFTER_DAYS * 24 * 60 * 60 * 1000
  );
  const stale = await prisma.surgery.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lt: cutoff } },
    select: { id: true, caseNumber: true, scheduledAt: true, surgeonId: true },
    take: 500,
  });
  if (stale.length === 0) return { cancelled: 0, ids: [] };

  const cancelledIds: string[] = [];
  for (const s of stale) {
    try {
      await prisma.$transaction([
        prisma.surgery.update({
          where: { id: s.id },
          data: { status: "CANCELLED" },
        }),
        prisma.auditLog.create({
          data: {
            action: "SURGERY_AUTO_CANCELLED_STALE",
            entity: "surgery",
            entityId: s.id,
            details: {
              caseNumber: s.caseNumber,
              scheduledAt: s.scheduledAt,
              ageDays: Math.floor(
                (now.getTime() - new Date(s.scheduledAt).getTime()) /
                  (24 * 60 * 60 * 1000)
              ),
              cutoffDays: STALE_SURGERY_CANCEL_AFTER_DAYS,
            } as any,
          } as any,
        }),
      ]);
      cancelledIds.push(s.id);
    } catch (err) {
      console.error(
        "[auto_cancel_missed_surgeries] failed to cancel",
        s.id,
        err
      );
    }
  }
  return { cancelled: cancelledIds.length, ids: cancelledIds };
}

async function autoCancelMissedSurgeries(): Promise<void> {
  try {
    const result = await autoCancelStaleScheduledSurgeries();
    if (result.cancelled > 0) {
      console.log(
        `[auto_cancel_missed_surgeries] auto-cancelled ${result.cancelled} stale surgery rows`
      );
    }
  } catch (err) {
    console.error("[auto_cancel_missed_surgeries]", err);
  }
}

// ─── Auto-assign overdue complaints (Issue #161) ──────────────
//
// A complaint that has been OPEN for >48h with no `assignedTo` is dropping
// through the cracks. We pick the on-duty admin with the lowest current
// load (count of complaints currently assigned to them) and route the row
// to them, plus a notification. Audit trail captures the auto-assignment
// so a human can later reassign without losing context.

const OVERDUE_COMPLAINT_THRESHOLD_HOURS = 48;

export async function autoAssignOverdueComplaints(now: Date = new Date()): Promise<{
  assigned: number;
  ids: string[];
}> {
  const cutoff = new Date(
    now.getTime() - OVERDUE_COMPLAINT_THRESHOLD_HOURS * 60 * 60 * 1000
  );
  const overdue = await prisma.complaint.findMany({
    where: {
      status: "OPEN",
      assignedTo: null,
      createdAt: { lt: cutoff },
    },
    select: { id: true, ticketNumber: true, category: true, createdAt: true },
    take: 200,
  });
  if (overdue.length === 0) return { assigned: 0, ids: [] };

  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true, name: true },
  });
  if (admins.length === 0) {
    console.warn(
      "[auto_assign_overdue_complaints] no active admin users to assign to"
    );
    return { assigned: 0, ids: [] };
  }

  // Lowest-current-load: count OPEN complaints already assigned per admin.
  const loads = new Map<string, number>();
  for (const a of admins) loads.set(a.id, 0);
  const existing = await prisma.complaint.groupBy({
    by: ["assignedTo"],
    where: { status: "OPEN", assignedTo: { in: admins.map((a) => a.id) } },
    _count: { _all: true },
  });
  for (const e of existing as Array<{ assignedTo: string | null; _count: { _all: number } }>) {
    if (e.assignedTo) loads.set(e.assignedTo, e._count._all);
  }

  function pickAdmin(): { id: string; name: string } {
    let best = admins[0];
    let bestLoad = loads.get(best.id) ?? 0;
    for (const a of admins) {
      const l = loads.get(a.id) ?? 0;
      if (l < bestLoad) {
        best = a;
        bestLoad = l;
      }
    }
    loads.set(best.id, bestLoad + 1);
    return best;
  }

  const assignedIds: string[] = [];
  for (const c of overdue) {
    try {
      const admin = pickAdmin();
      await prisma.$transaction([
        prisma.complaint.update({
          where: { id: c.id },
          data: { assignedTo: admin.id },
        }),
        prisma.auditLog.create({
          data: {
            action: "COMPLAINT_AUTO_ASSIGNED_OVERDUE",
            entity: "complaint",
            entityId: c.id,
            details: {
              ticketNumber: c.ticketNumber,
              category: c.category,
              ageHours: Math.floor(
                (now.getTime() - new Date(c.createdAt).getTime()) / 3600000
              ),
              assigneeId: admin.id,
              assigneeName: admin.name,
            } as any,
          } as any,
        }),
      ]);
      assignedIds.push(c.id);
      try {
        await sendNotification({
          userId: admin.id,
          type: NotificationType.SCHEDULE_SUMMARY,
          title: "Complaint auto-assigned",
          message: `Complaint ${c.ticketNumber} (${c.category}) was OPEN for >${OVERDUE_COMPLAINT_THRESHOLD_HOURS}h and has been auto-assigned to you.`,
          data: { complaintId: c.id, ticketNumber: c.ticketNumber },
        });
      } catch (notifErr) {
        console.error(
          "[auto_assign_overdue_complaints] notify",
          admin.id,
          notifErr
        );
      }
    } catch (err) {
      console.error(
        "[auto_assign_overdue_complaints] assign failed",
        c.id,
        err
      );
    }
  }
  return { assigned: assignedIds.length, ids: assignedIds };
}

async function autoAssignOverdueComplaintsTask(): Promise<void> {
  try {
    const result = await autoAssignOverdueComplaints();
    if (result.assigned > 0) {
      console.log(
        `[auto_assign_overdue_complaints] auto-assigned ${result.assigned} complaints`
      );
    }
  } catch (err) {
    console.error("[auto_assign_overdue_complaints]", err);
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
  {
    name: "cleanup_orphaned_uploads",
    intervalMinutes: 24 * 60,
    run: cleanupOrphanedUploads,
  },
  // ── Ops-quality AI features (Apr 2026) ─────────────────
  {
    name: "ai_doc_qa_daily_sample",
    intervalMinutes: 24 * 60,
    runAtHour: 2,
    run: runDailyDocQAScheduledTask,
  },
  {
    name: "ai_fraud_daily_scan",
    intervalMinutes: 24 * 60,
    runAtHour: 4,
    run: runDailyFraudScan,
  },
  {
    name: "ai_sentiment_nps_rollup",
    intervalMinutes: 24 * 60,
    runAtHour: 5,
    run: runDailyNpsDriverRollup,
  },
  {
    name: "rate_limit_bypass_check",
    intervalMinutes: 1,
    run: rateLimitBypassCheck,
  },
  {
    name: "audit_log_archival",
    intervalMinutes: 24 * 60,
    runAtHour: 3,
    run: async () => {
      await runAuditLogArchival({});
    },
  },
  // Issue #160 — daily 4am IST. The host runs in IST in production; for
  // dev/test machines on UTC the task simply runs at the host's 4am, which
  // is acceptable for an ops-cleanup job.
  {
    name: "auto_cancel_missed_surgeries",
    intervalMinutes: 24 * 60,
    runAtHour: 4,
    run: autoCancelMissedSurgeries,
  },
  // Issue #161 — daily 6am IST. Same host-clock caveat as #160.
  {
    name: "auto_assign_overdue_complaints",
    intervalMinutes: 24 * 60,
    runAtHour: 6,
    run: autoAssignOverdueComplaintsTask,
  },
  // Issue #388 — every 30 min, transition past BOOKED appointments
  // (>30 min beyond their IST start instant) to NO_SHOW so analytics,
  // FHIR exports, and non-helper render paths see the correct status.
  // Companion to render-layer fix in commit aa3ab9e.
  {
    name: "auto_noshow_elapsed_booked",
    intervalMinutes: 30,
    run: autoNoShowElapsedBookedTask,
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

/**
 * Observability hook for `/api/health/deep`. Returns a per-task digest
 * (name, configured interval, last-run timestamp, minutes since last run).
 * Missing last-run rows report `lastRunAt: null` / `minutesSinceLastRun: null`.
 */
export async function getSchedulerStatus(): Promise<
  Array<{
    name: string;
    intervalMinutes: number;
    lastRunAt: string | null;
    minutesSinceLastRun: number | null;
  }>
> {
  const now = Date.now();
  const out: Array<{
    name: string;
    intervalMinutes: number;
    lastRunAt: string | null;
    minutesSinceLastRun: number | null;
  }> = [];
  for (const t of TASKS) {
    const last = await getLastRun(t.name);
    out.push({
      name: t.name,
      intervalMinutes: t.intervalMinutes,
      lastRunAt: last ? last.toISOString() : null,
      minutesSinceLastRun: last
        ? Math.max(0, Math.floor((now - last.getTime()) / 60000))
        : null,
    });
  }
  return out;
}

/**
 * Test-only hook: run one scheduler tick synchronously. Used by the
 * rate-limit-bypass-check test suite so we don't have to sleep for the 60s
 * interval. Unlike the prod `tick()` this awaits each task.
 */
export async function _runSchedulerTickForTests(): Promise<void> {
  const now = new Date();
  for (const task of TASKS) {
    try {
      if (task.runAtHour != null && now.getHours() !== task.runAtHour) continue;
      const last = await getLastRun(task.name);
      if (last) {
        const sinceMin = (now.getTime() - last.getTime()) / 60000;
        if (sinceMin < task.intervalMinutes) continue;
      }
      await setLastRun(task.name, now);
      await task.run();
    } catch (err) {
      console.error(`[scheduler-test] ${task.name} failed`, err);
    }
  }
}
