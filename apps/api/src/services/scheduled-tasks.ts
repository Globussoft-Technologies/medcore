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
import { autoEnrolAndRemove } from "./chronic-care-enrolment";
import { runChronicCareSequenceSends } from "./chronic-care-scheduler";
import { dispatchPendingCampaigns } from "./campaign-dispatcher-sweep";
import { collectYesterdayUsage } from "./tenant-usage-collector";
import { generateMonthlyPlatformInvoices } from "./platform-invoice-generator";
import { sendMonthlyInvoiceEmails } from "./platform-invoice-mailer";
import { seedPlatformBillingConfig } from "./platform-billing-config";
import {
  checkGracePeriodExpirations,
  checkTrialExpirations,
} from "./platform-subscription-state";
import { runTenantArchiveSweep } from "./tenant-archival";

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

// Issue #879 bonus + #841 family: the seed data and some manual
// registrations save doctors with `User.name = "Dr. Rajesh Sharma"`. When
// the 24h / 1h reminder templates prepend their own "Dr. " the patient sees
// "Dr. Dr. Rajesh Sharma". The web side has a `formatDoctorName` helper
// (apps/web/src/lib/format-doctor-name.ts) for the same problem; we
// duplicate the 4-line logic here rather than reach across the apps→web
// boundary. TODO: lift this to `@medcore/shared` so both apps share one
// implementation.
function formatDoctorName(name: string | null | undefined): string {
  if (!name) return "";
  const stripped = name.replace(/^(Dr\.?\s+)+/i, "").trim();
  if (!stripped) return "";
  return `Dr. ${stripped}`;
}

// Has this exact reminder (identified by appointmentId + title) already been
// sent? Used to guarantee each appointment reminder fires ONCE, even though
// the crons run on overlapping windows. We look for a prior APPOINTMENT_
// REMINDER notification whose `data.appointmentId` matches and whose title is
// the same band (24h vs 1h). Cheap point-read; the Notification table is
// indexed on (userId, createdAt) and we filter by JSON path + title.
async function reminderAlreadySent(
  appointmentId: string,
  title: string,
): Promise<boolean> {
  const existing = await prisma.notification.findFirst({
    where: {
      type: NotificationType.APPOINTMENT_REMINDER,
      title,
      data: { path: ["appointmentId"], equals: appointmentId },
    },
    select: { id: true },
  });
  return existing !== null;
}

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
      // Dedup: send the 24h reminder ONCE per appointment. The cron runs
      // hourly with a 23–25h window, so an appointment can fall in the window
      // on two consecutive ticks; without this guard the patient would get
      // the same reminder twice. We skip if a 24h reminder notification was
      // already created for this appointment.
      if (await reminderAlreadySent(a.id, "Appointment Reminder (24h)")) {
        continue;
      }
      // Issue #879: the original template said "tomorrow" — accurate at send
      // time, but the notification row persists and the patient can read it
      // days later when "tomorrow" is no longer correct. Bake the actual
      // appointment date into the message so it stays factually accurate
      // regardless of when the user opens it. Format as DD MMM YYYY for
      // unambiguous Indian-context readability.
      const apptDate = a.date instanceof Date ? a.date : new Date(a.date);
      const apptDateStr = apptDate.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      await sendNotification({
        userId: a.patient.user.id,
        type: NotificationType.APPOINTMENT_REMINDER,
        title: "Appointment Reminder (24h)",
        message: `Hi ${a.patient.user.name}, reminder: your appointment with ${formatDoctorName(a.doctor.user.name)} is scheduled for ${apptDateStr}${a.slotStart ? ` at ${a.slotStart}` : ""}. Token #${a.tokenNumber}.`,
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
      // Dedup: the 1h cron runs every 15 min with a 45–75 min window, so an
      // appointment can fall in the window across up to 3 ticks. Send the 1h
      // reminder ONCE per appointment.
      if (await reminderAlreadySent(a.id, "Appointment Starting Soon (1h)")) {
        continue;
      }
      await sendNotification({
        userId: a.patient.user.id,
        type: NotificationType.APPOINTMENT_REMINDER,
        title: "Appointment Starting Soon (1h)",
        message: `Hi ${a.patient.user.name}, your appointment with ${formatDoctorName(a.doctor.user.name)} starts at ${a.slotStart}. Please arrive 10 min early. Token #${a.tokenNumber}.`,
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

// ─── Auto-escalate SLA-breached complaints (Issue #760) ──────
//
// `auto_assign_overdue_complaints` (Issue #161) only handles the
// assignment-routing side: it picks the lowest-load admin for any OPEN
// complaint that's been unassigned >48h. It does NOT change the row's
// `status`, so a CRITICAL ticket sitting at 798h overdue (the symptom
// reported in #760) still showed `status=OPEN` indefinitely with no
// visible escalation flag — and the matching `POST /complaints/auto-escalate`
// endpoint, which DID transition such rows to `ESCALATED`, was only ever
// invoked manually (no scheduler entry).
//
// This task closes that gap. Every hour we transition any OPEN /
// UNDER_REVIEW row whose `slaDueAt` is in the past AND that hasn't
// already been escalated to `ESCALATED`, stamp `escalatedAt` + a
// machine-readable `escalationReason`, emit one audit row per ticket so
// the trail captures "auto-system did this, not a human", and notify
// the assignee (or admin pool when unassigned) so the escalation
// actually surfaces to a live human.
//
// Idempotent: a second pass finds zero rows because `escalatedAt: null`
// is the gate. The guard mirrors `POST /complaints/auto-escalate`'s
// shape so behaviour stays identical to the existing manual endpoint.

export async function autoEscalateSlaBreachedComplaints(now: Date = new Date()): Promise<{
  escalated: number;
  ids: string[];
}> {
  const overdue = await prisma.complaint.findMany({
    where: {
      status: { in: ["OPEN", "UNDER_REVIEW"] },
      slaDueAt: { lt: now },
      escalatedAt: null,
    },
    select: {
      id: true,
      ticketNumber: true,
      priority: true,
      assignedTo: true,
      createdAt: true,
      slaDueAt: true,
    },
    take: 500,
  });
  if (overdue.length === 0) return { escalated: 0, ids: [] };

  // Pre-fetch admin pool for unassigned escalations — these get notified
  // so a human actually sees the breach instead of the row sitting in a
  // queue tab unread.
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
  });

  const escalatedIds: string[] = [];
  for (const c of overdue) {
    try {
      const overdueHours = Math.floor(
        (now.getTime() - new Date(c.slaDueAt!).getTime()) / 3600000
      );
      await prisma.$transaction([
        prisma.complaint.update({
          where: { id: c.id },
          data: {
            status: "ESCALATED",
            escalatedAt: now,
            escalationReason: `Auto-escalated: SLA breach (priority=${c.priority}, ${overdueHours}h past slaDueAt)`,
          },
        }),
        prisma.auditLog.create({
          data: {
            action: "COMPLAINT_AUTO_ESCALATED_SLA_BREACH",
            entity: "complaint",
            entityId: c.id,
            details: {
              ticketNumber: c.ticketNumber,
              priority: c.priority,
              overdueHours,
              slaDueAt: c.slaDueAt,
              wasAssigned: !!c.assignedTo,
            } as any,
          } as any,
        }),
      ]);
      escalatedIds.push(c.id);

      // Notify the assignee directly so the escalation lands in the
      // owner's inbox — fall back to the admin pool when unassigned so
      // CRITICAL/HIGH tickets aren't escalated into the void.
      const recipients = c.assignedTo
        ? [c.assignedTo]
        : admins.map((a) => a.id);
      for (const userId of recipients) {
        try {
          await sendNotification({
            userId,
            type: NotificationType.SCHEDULE_SUMMARY,
            title: `Complaint escalated (SLA breach)`,
            message: `${c.ticketNumber} (${c.priority}) is ${overdueHours}h past its SLA and has been auto-escalated. Please action immediately.`,
            data: {
              complaintId: c.id,
              ticketNumber: c.ticketNumber,
              priority: c.priority,
              overdueHours,
            },
          });
        } catch (notifErr) {
          console.error(
            "[auto_escalate_sla_breached_complaints] notify",
            userId,
            notifErr
          );
        }
      }
    } catch (err) {
      console.error(
        "[auto_escalate_sla_breached_complaints] escalate failed",
        c.id,
        err
      );
    }
  }
  return { escalated: escalatedIds.length, ids: escalatedIds };
}

async function autoEscalateSlaBreachedComplaintsTask(): Promise<void> {
  try {
    const result = await autoEscalateSlaBreachedComplaints();
    if (result.escalated > 0) {
      console.log(
        `[auto_escalate_sla_breached_complaints] escalated ${result.escalated} SLA-breached complaints`
      );
    }
  } catch (err) {
    console.error("[auto_escalate_sla_breached_complaints]", err);
  }
}

// ─── Auto-flag expired blood units (Issue #737) ────────
//
// Even though /match and /inventory filter expired rows out of the runtime
// query, the inventory-page count column reads the raw `status` column. So
// an expired unit whose `status` is still `AVAILABLE` inflates the
// "Available" count and stays orphaned in the table. This task transitions
// any `AVAILABLE` unit whose `expiresAt < now` to `EXPIRED`, emits a single
// audit row per batch, and is safe to re-run (idempotent — a second pass
// finds zero AVAILABLE+expired rows). Runs daily at 1am host time.
//
// NOTE: this is purely a status-cleanup pass. The transfusion-safety guard
// is the per-request expiry check inside the `/issue` handler — this cron
// just keeps the inventory dashboard honest.
export async function autoFlagExpiredBloodUnits(now: Date = new Date()): Promise<{
  flagged: number;
  ids: string[];
}> {
  const stale = await prisma.bloodUnit.findMany({
    where: { status: "AVAILABLE", expiresAt: { lt: now } },
    select: { id: true, unitNumber: true },
    take: 500,
  });
  if (stale.length === 0) return { flagged: 0, ids: [] };
  await prisma.bloodUnit.updateMany({
    where: { id: { in: stale.map((u) => u.id) } },
    data: { status: "EXPIRED" },
  });
  try {
    await prisma.auditLog.create({
      data: {
        action: "BLOOD_UNIT_AUTO_EXPIRED",
        entity: "blood_unit",
        entityId: "batch",
        details: {
          count: stale.length,
          unitNumbers: stale.map((u) => u.unitNumber),
        } as any,
      } as any,
    });
  } catch (err) {
    console.error("[auto_flag_expired_blood_units] audit", err);
  }
  return { flagged: stale.length, ids: stale.map((u) => u.id) };
}

async function autoFlagExpiredBloodUnitsTask(): Promise<void> {
  try {
    const result = await autoFlagExpiredBloodUnits();
    if (result.flagged > 0) {
      console.log(
        `[auto_flag_expired_blood_units] flagged ${result.flagged} expired units`
      );
    }
  } catch (err) {
    console.error("[auto_flag_expired_blood_units]", err);
  }
}

// ─── Auto-checkout zombie visitors (Issue #734) ────────
//
// An ACTIVE visitor (checkOutAt = null) sitting >12h past their checkInAt
// is a data anomaly — receptionist almost certainly forgot to scan them
// out, but the dashboard "Currently Inside" count shows them as live which
// hurts emergency-evacuation accuracy and seat-count analytics. This task
// runs every 30 min, picks up any ACTIVE row older than the configured
// ceiling (default 12h, override via env `MAX_VISIT_DURATION_HOURS`), sets
// `checkOutAt = now` and appends a marker to `notes` so a human reviewer
// can tell it was an auto-close, and emits an audit row per batch.
const MAX_VISIT_DURATION_HOURS_DEFAULT = 12;

export async function autoCheckoutStaleVisitors(now: Date = new Date()): Promise<{
  checkedOut: number;
  ids: string[];
}> {
  const ceilingHours = (() => {
    const raw = process.env.MAX_VISIT_DURATION_HOURS;
    if (!raw) return MAX_VISIT_DURATION_HOURS_DEFAULT;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : MAX_VISIT_DURATION_HOURS_DEFAULT;
  })();
  const cutoff = new Date(now.getTime() - ceilingHours * 60 * 60 * 1000);
  const stale = await prisma.visitor.findMany({
    where: { checkOutAt: null, checkInAt: { lt: cutoff } },
    select: { id: true, passNumber: true, notes: true },
    take: 500,
  });
  if (stale.length === 0) return { checkedOut: 0, ids: [] };
  const marker = `Auto-checked-out: ${ceilingHours}h limit`;
  for (const v of stale) {
    try {
      await prisma.visitor.update({
        where: { id: v.id },
        data: {
          checkOutAt: now,
          notes: v.notes ? `${v.notes}\n${marker}` : marker,
        },
      });
    } catch (err) {
      console.error("[auto_checkout_stale_visitors] update", v.id, err);
    }
  }
  try {
    await prisma.auditLog.create({
      data: {
        action: "VISITOR_AUTO_CHECK_OUT",
        entity: "visitor",
        entityId: "batch",
        details: {
          count: stale.length,
          passNumbers: stale.map((v) => v.passNumber),
          ceilingHours,
        } as any,
      } as any,
    });
  } catch (err) {
    console.error("[auto_checkout_stale_visitors] audit", err);
  }
  return {
    checkedOut: stale.length,
    ids: stale.map((v) => v.id),
  };
}

async function autoCheckoutStaleVisitorsTask(): Promise<void> {
  try {
    const result = await autoCheckoutStaleVisitors();
    if (result.checkedOut > 0) {
      console.log(
        `[auto_checkout_stale_visitors] auto-checked-out ${result.checkedOut} zombie visitor(s)`
      );
    }
  } catch (err) {
    console.error("[auto_checkout_stale_visitors]", err);
  }
}

// ─── Auto-close stuck telemedicine sessions (Issue #743) ─
//
// Telemedicine sessions whose `status` is IN_PROGRESS but whose `startedAt`
// is older than `MAX_TELEMED_DURATION_HOURS` (default 2h, env-overridable)
// are stuck — either the doctor closed the tab without hitting "End",
// the WebRTC connection dropped without a teardown signal, or the patient
// abandoned the call. Leaving them IN_PROGRESS skews the live-sessions
// dashboard and blocks doctor-side cleanup. This task transitions any
// such row to COMPLETED, sets `endedAt = now`, appends a marker to
// `doctorNotes` so a human reviewer can tell it was an auto-close, and
// emits a single batch audit row. Mirrors the auto-checkout-stale-visitors
// + auto-flag-expired-blood-units patterns.
//
// Note: `TelemedicineStatus` enum has no `AUTO_CLOSED` member — we use
// `COMPLETED` (the natural terminal state) and rely on the `doctorNotes`
// marker + the `TELEMEDICINE_AUTO_CLOSED_STUCK` audit action for the
// "this was system-closed, not human-closed" signal.
const MAX_TELEMED_DURATION_HOURS_DEFAULT = 2;

export async function autoCloseStuckTelemedicineSessions(now: Date = new Date()): Promise<{
  closed: number;
  ids: string[];
}> {
  const ceilingHours = (() => {
    const raw = process.env.MAX_TELEMED_DURATION_HOURS;
    if (!raw) return MAX_TELEMED_DURATION_HOURS_DEFAULT;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : MAX_TELEMED_DURATION_HOURS_DEFAULT;
  })();
  const cutoff = new Date(now.getTime() - ceilingHours * 60 * 60 * 1000);
  const stuck = await prisma.telemedicineSession.findMany({
    where: { status: "IN_PROGRESS", startedAt: { lt: cutoff } },
    select: { id: true, sessionNumber: true, doctorNotes: true },
    take: 500,
  });
  if (stuck.length === 0) return { closed: 0, ids: [] };
  const marker = `Auto-closed: ${ceilingHours}h limit`;
  for (const s of stuck) {
    try {
      await prisma.telemedicineSession.update({
        where: { id: s.id },
        data: {
          status: "COMPLETED",
          endedAt: now,
          doctorNotes: s.doctorNotes ? `${s.doctorNotes}\n${marker}` : marker,
        },
      });
    } catch (err) {
      console.error("[auto_close_stuck_telemedicine_sessions] update", s.id, err);
    }
  }
  try {
    await prisma.auditLog.create({
      data: {
        action: "TELEMEDICINE_AUTO_CLOSED_STUCK",
        entity: "telemedicine_session",
        entityId: "batch",
        details: {
          count: stuck.length,
          sessionNumbers: stuck.map((s) => s.sessionNumber),
          ceilingHours,
        } as any,
      } as any,
    });
  } catch (err) {
    console.error("[auto_close_stuck_telemedicine_sessions] audit", err);
  }
  return { closed: stuck.length, ids: stuck.map((s) => s.id) };
}

async function autoCloseStuckTelemedicineSessionsTask(): Promise<void> {
  try {
    const result = await autoCloseStuckTelemedicineSessions();
    if (result.closed > 0) {
      console.log(
        `[auto_close_stuck_telemedicine_sessions] auto-closed ${result.closed} stuck session(s)`
      );
    }
  } catch (err) {
    console.error("[auto_close_stuck_telemedicine_sessions]", err);
  }
}

// ─── Chronic-care cohort auto-enrolment (Pearl §5.2 row 143) ───
//
// Every hour, re-evaluate every active ChronicCareCohort's `cohortRule`
// and reconcile per-patient ChronicCarePlan rows: enrol newly-matching
// patients, deactivate plans whose patients no longer match. Idempotent
// — a no-op pass logs nothing. ScheduledTaskRun captures the run via
// `runTaskWithAudit` (Pearl §8.4 row 222).
async function autoEnrolChronicCareCohortsTask(): Promise<void> {
  try {
    const result = await autoEnrolAndRemove();
    if (result.enrolled > 0 || result.removed > 0 || result.errors > 0) {
      console.log(
        `[auto_enrol_chronic_care_cohorts] cohorts=${result.cohortsEvaluated} enrolled=${result.enrolled} removed=${result.removed} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.error("[auto_enrol_chronic_care_cohorts]", err);
  }
}

// ─── Chronic-care sequence-step sweep (Pearl §5.2 row 144) ─────
//
// Every hour, walk every active cohort-linked ChronicCarePlan and send
// the next pending CohortSequenceStep whose `delayDays` window has
// elapsed. Companion to the on-visit hook in
// `services/notification-triggers.ts:onPatientCheckedIn` which handles
// the skip-and-advance case (row 145).
async function chronicCareSequenceSweepTask(): Promise<void> {
  try {
    const result = await runChronicCareSequenceSends();
    if (result.sent > 0 || result.errors > 0) {
      console.log(
        `[chronic_care_sequence_sweep] sent=${result.sent} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.error("[chronic_care_sequence_sweep]", err);
  }
}

// ─── Campaign dispatcher sweep (Pearl §5.1 piece 2b row 131/132/137/336/338) ───
//
// Every 5 min, find Campaign rows in `SCHEDULED` status whose
// `scheduledAt` is in the past and dispatch them via the existing sync
// fan-out. Per-tick cap: 10 campaigns (the remainder defer to the next
// tick). Per-recipient send-window quiet-hour clamp enforced at sweep
// time — out-of-window campaigns stay SCHEDULED and retry next tick.
// Implementation: services/campaign-dispatcher-sweep.ts.
async function campaignDispatchSweepTask(): Promise<void> {
  try {
    const result = await dispatchPendingCampaigns(prisma);
    if (
      result.dispatched > 0 ||
      result.errors > 0 ||
      result.deferredQuietHours > 0 ||
      result.cancelledNoAudience > 0 ||
      result.cancelledNoChannels > 0
    ) {
      console.log(
        `[campaign_dispatch_sweep] inspected=${result.inspected} dispatched=${result.dispatched} deferredQuietHours=${result.deferredQuietHours} cancelledNoAudience=${result.cancelledNoAudience} cancelledNoChannels=${result.cancelledNoChannels} skippedInactiveTenant=${result.skippedInactiveTenant} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.error("[campaign_dispatch_sweep]", err);
  }
}

// ─── Tenant usage daily collector (Pearl §8.3 row 214) ─
//
// Once daily, group the prior UTC day's Notification rows by
// (tenantId, channel) and upsert one TenantUsageDaily row per tenant
// for that date. Idempotent (upsert on `@@unique([tenantId, date])`).
// Powers per-tenant plan-quota vs actual-usage visibility for the
// super-admin billing surface (UI consumer ships as a separate piece).
async function tenantUsageDailyCollectorTask(): Promise<void> {
  try {
    const result = await collectYesterdayUsage(prisma);
    if (result.totalRowsWritten > 0) {
      console.log(
        `[tenant_usage_daily_collector] date=${result.date} tenantsProcessed=${result.tenantsProcessed} rowsWritten=${result.totalRowsWritten}`,
      );
    }
  } catch (err) {
    console.error("[tenant_usage_daily_collector]", err);
  }
}

// ─── Monthly platform-invoice generator (Pearl §8.3 row 215 piece 3b) ─
//
// On the 1st of every UTC month at ~02:00 UTC, walk every ACTIVE
// TenantSubscription and create a PlatformInvoice for the PREVIOUS
// month (idempotent — re-runs find the row + skip). The scheduler
// doesn't have first-class day-of-month support, so the task body
// short-circuits unless `now.getUTCDate() === 1`. The hourly cadence
// with the `runAtHour: 2` filter means we get one shot at ~02:00 UTC
// on the 1st; if the host is down at that hour the task waits for
// the next month rather than back-filling (operators can re-run
// manually via the retry endpoint — the function is idempotent).
async function monthlyPlatformInvoiceGeneratorTask(): Promise<void> {
  const now = new Date();
  if (now.getUTCDate() !== 1) return;
  try {
    const result = await generateMonthlyPlatformInvoices(prisma, now);
    if (
      result.generated > 0 ||
      result.skippedAlreadyExists > 0 ||
      result.skippedInactive > 0 ||
      result.errors > 0
    ) {
      console.log(
        `[monthly_platform_invoice_generator] yyyymm=${result.yyyymm} generated=${result.generated} skippedAlreadyExists=${result.skippedAlreadyExists} skippedInactive=${result.skippedInactive} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.error("[monthly_platform_invoice_generator]", err);
  }
}

// ─── Platform-subscription grace-period sweep (Pearl §8.3 row 215 piece 3c) ─
//
// Daily at 03:00 host-time: walk every `past_due` TenantSubscription and
// flip rows whose `pastDueSince + 7d < now` to `suspended` (login
// blocked except for billing surface). Idempotent — a second pass on
// the same day finds zero rows because the prior pass already
// suspended them. The Razorpay webhook (routes/webhooks/platform-razorpay.ts)
// is the OTHER entry point that can transition rows; both call the
// same idempotent helper in services/platform-subscription-state.ts so
// race conditions reconverge to the right state.
async function platformGracePeriodSweepTask(): Promise<void> {
  try {
    const result = await checkGracePeriodExpirations(prisma);
    if (result.inspected > 0 || result.suspended > 0 || result.errors > 0) {
      console.log(
        `[platform_grace_period_sweep] inspected=${result.inspected} suspended=${result.suspended} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.error("[platform_grace_period_sweep]", err);
  }
}

// ─── Platform-invoice email mailer (Pearl §8.3 piece 3f) ─
//
// Daily at 05:00 host-time: walks every ISSUED PlatformInvoice that
// hasn't been emailed yet (idempotency tracked via AuditLog action
// `PLATFORM_INVOICE_EMAILED`) and delivers it to the tenant's
// `billingContactEmail`. Tenants without a contact email are skipped
// (logged once per row) so the operator can fill it in later. SendGrid
// failures don't write an audit row, so the next sweep retries.
async function platformInvoiceMailerTask(): Promise<void> {
  try {
    const result = await sendMonthlyInvoiceEmails(prisma);
    if (
      result.sent > 0 ||
      result.skippedNoContact > 0 ||
      result.errors > 0
    ) {
      console.log(
        `[platform_invoice_mailer] inspected=${result.inspected} sent=${result.sent} alreadyEmailed=${result.skippedAlreadyEmailed} noContact=${result.skippedNoContact} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.error("[platform_invoice_mailer]", err);
  }
}

// ─── Platform-subscription trial-expiration sweep (Pearl §8.3 piece 3d) ─
//
// Daily at 03:00 host-time (paired with the grace-period sweep so both
// state-machine checks run back-to-back). Walks every `trial`
// TenantSubscription whose `trialEndsAt < now` and flips it to
// `past_due`, starting the 7-day grace clock that the sister sweep
// above eventually drains to `suspended`. Idempotent.
async function platformTrialExpirationSweepTask(): Promise<void> {
  try {
    const result = await checkTrialExpirations(prisma);
    if (result.inspected > 0 || result.pastDued > 0 || result.errors > 0) {
      console.log(
        `[platform_trial_expiration_sweep] inspected=${result.inspected} pastDued=${result.pastDued} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.error("[platform_trial_expiration_sweep]", err);
  }
}

// ─── Tenant 90-day S3 archival sweep (Pearl §8.1 row 233) ──────────
//
// Daily at 04:00 host-time: find every tenant currently SUSPENDED
// (`active=false`) for >=90 days (`deactivatedAt` older than the
// 90-day cutoff) and stream-export their tenant-scoped data
// (Patients, Appointments, Prescriptions, Invoices, AuditLog) to S3
// at key `tenant-archives/{tenantId}/{ts}.tar.gz`, with SHA-256
// checksum stamped on `Tenant.archiveChecksum`. Live-data purge is a
// SEPARATE operator-gated `purgeArchivedTenant()` function (not auto-
// wired — irreversible, wants explicit operator confirmation).
// Idempotent: re-runs find no candidates because `archivedAt is null`
// is part of the eligibility gate.
async function tenantArchiveSweepTask(): Promise<void> {
  try {
    const result = await runTenantArchiveSweep(prisma);
    if (
      result.inspected > 0 ||
      result.archived > 0 ||
      result.errors > 0
    ) {
      console.log(
        `[tenant_archive_sweep] inspected=${result.inspected} archived=${result.archived} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.error("[tenant_archive_sweep]", err);
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
  // Issue #760 — every 60 min. Transitions OPEN/UNDER_REVIEW complaints
  // whose `slaDueAt` is past to status=ESCALATED with an "Auto-escalated:
  // SLA breach" reason, emits one audit row per ticket, and notifies the
  // assignee (or admin pool if unassigned). Hourly cadence is tight enough
  // that CRITICAL tickets (4h SLA) don't sit in OPEN past their breach by
  // more than ~1h, but generous enough that one slow tick won't double-fire
  // because `escalatedAt: null` gates the next pass.
  {
    name: "auto_escalate_sla_breached_complaints",
    intervalMinutes: 60,
    run: autoEscalateSlaBreachedComplaintsTask,
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
  // Issue #737 — daily 1am host time. Flips AVAILABLE blood units whose
  // `expiresAt` is already in the past to status=EXPIRED so the inventory
  // dashboard count reflects reality without runtime filtering.
  {
    name: "auto_flag_expired_blood_units",
    intervalMinutes: 24 * 60,
    runAtHour: 1,
    run: autoFlagExpiredBloodUnitsTask,
  },
  // Issue #734 — every 30 min. Auto-closes ACTIVE visitor rows whose
  // checkInAt is >MAX_VISIT_DURATION_HOURS (default 12h) ago. Receptionist
  // almost certainly forgot to scan them out; the audit trail records the
  // auto-checkout so a human can correct if needed.
  {
    name: "auto_checkout_stale_visitors",
    intervalMinutes: 30,
    run: autoCheckoutStaleVisitorsTask,
  },
  // Issue #743 — every 30 min. Transitions IN_PROGRESS telemedicine
  // sessions whose startedAt is >MAX_TELEMED_DURATION_HOURS (default 2h)
  // ago to COMPLETED with an Auto-closed marker, so the live-sessions
  // dashboard doesn't carry zombie rows for 24h+.
  {
    name: "auto_close_stuck_telemedicine_sessions",
    intervalMinutes: 30,
    run: autoCloseStuckTelemedicineSessionsTask,
  },
  // Pearl §5.2 row 143 — hourly auto-enrol / auto-remove. Re-evaluates
  // every active ChronicCareCohort's `cohortRule` against current patient
  // rows, creates/activates ChronicCarePlan rows for new matches, and
  // deactivates plans for patients who no longer match. Idempotent.
  {
    name: "auto_enrol_chronic_care_cohorts",
    intervalMinutes: 60,
    run: autoEnrolChronicCareCohortsTask,
  },
  // Pearl §5.2 row 144 — hourly sweep that advances the per-enrolment
  // sequence stepper. Sends the next pending CohortSequenceStep whose
  // delayDays window has elapsed. On-visit fast-path lives in
  // `services/notification-triggers.ts:onPatientCheckedIn` (row 145).
  {
    name: "chronic_care_sequence_sweep",
    intervalMinutes: 60,
    run: chronicCareSequenceSweepTask,
  },
  // Pearl §5.1 piece 2b (rows 131, 132, 137, 336, 338) — every 5 min, find
  // Campaign rows whose `scheduledAt` is in the past and dispatch via the
  // existing sync fan-out. Per-tick cap: 10 campaigns. Quiet-hour clamp
  // (Campaign.sendWindowStart/End) defers out-of-window dispatches to the
  // next tick. Inactive tenants are skipped. Wraps `dispatchCampaign`
  // (services/campaign-dispatcher.ts) for per-recipient send work.
  {
    name: "campaign_dispatch_sweep",
    intervalMinutes: 5,
    run: campaignDispatchSweepTask,
  },
  // Pearl §8.3 row 214 — daily 01:00 UTC (host-time scheduler approximates
  // via `runAtHour: 1`; prod hosts run IST so this lands ~01:00 IST =
  // 19:30 UTC prior day. The collector's "yesterday" computation uses UTC
  // explicitly so the date boundary is stable regardless of host TZ).
  // Groups the prior UTC day's notifications by (tenantId, channel) and
  // upserts one TenantUsageDaily row per tenant — idempotent on the
  // `@@unique([tenantId, date])` constraint.
  {
    name: "tenant_usage_daily_collector",
    intervalMinutes: 24 * 60,
    runAtHour: 1,
    run: tenantUsageDailyCollectorTask,
  },
  // Pearl §8.3 row 215 piece 3b — monthly platform-invoice generator. The
  // scheduler has no first-class day-of-month gate, so the task body returns
  // immediately on every day except the 1st (UTC). `runAtHour: 2` narrows
  // the firing window to ~02:00 host-time (prod runs IST, so ~02:00 IST =
  // ~20:30 UTC the prior day — the task's "1st UTC" guard then keeps the
  // generator from firing until the host's date crosses into the 1st UTC,
  // which happens 5h30m after IST midnight). `intervalMinutes: 24*60` so
  // the per-day "did we already run today" tracking still works.
  {
    name: "monthly_platform_invoice_generator",
    intervalMinutes: 24 * 60,
    runAtHour: 2,
    run: monthlyPlatformInvoiceGeneratorTask,
  },
  // Pearl §8.3 row 215 piece 3c — daily at 03:00 host-time. Walks every
  // `past_due` TenantSubscription and flips rows whose pastDueSince was
  // more than `GRACE_PERIOD_DAYS` (7d) ago to `suspended`. Companion to
  // the Razorpay platform webhook (routes/webhooks/platform-razorpay.ts)
  // — both call the same idempotent helpers in
  // services/platform-subscription-state.ts.
  {
    name: "platform_grace_period_sweep",
    intervalMinutes: 24 * 60,
    runAtHour: 3,
    run: platformGracePeriodSweepTask,
  },
  // Pearl §8.3 piece 3d — daily at 03:00 host-time. Walks every `trial`
  // TenantSubscription whose `trialEndsAt < now` and flips it to
  // `past_due`. Runs back-to-back with the grace-period sweep so the
  // entire state-machine chain (trial → past_due → suspended) settles
  // in one daily window.
  {
    name: "platform_trial_expiration_sweep",
    intervalMinutes: 24 * 60,
    runAtHour: 3,
    run: platformTrialExpirationSweepTask,
  },
  // Pearl §8.3 piece 3f — daily at 05:00 host-time. Mails every ISSUED
  // PlatformInvoice that hasn't already been delivered to the tenant's
  // billingContactEmail. Idempotent — audit log gates re-sends.
  {
    name: "platform_invoice_mailer",
    intervalMinutes: 24 * 60,
    runAtHour: 5,
    run: platformInvoiceMailerTask,
  },
  // Pearl §8.1 row 233 — daily at 04:00 host-time. Finds every tenant
  // suspended (`active=false`) for >=90 days and uploads a gzipped JSON
  // export of their tenant-scoped data to S3 (key:
  // `tenant-archives/{tenantId}/{ts}.tar.gz`), stamping `archivedAt` +
  // `archiveS3Key` + `archiveSizeBytes` + `archiveChecksum` on the
  // Tenant row. Live-data purge is a separate operator-gated function
  // (`purgeArchivedTenant`) — not on the cron path.
  {
    name: "tenant_archive_sweep",
    intervalMinutes: 24 * 60,
    runAtHour: 4,
    run: tenantArchiveSweepTask,
  },
];

let intervalHandle: NodeJS.Timeout | null = null;

/**
 * Pearl §8.4 (gap row 222 closure, 2026-05-22) — observability wrap.
 *
 * Runs a single task's `run()` while persisting a ScheduledTaskRun row so
 * super-admins can see what ran, what errored, and what to retry.
 * Intentionally narrow: a try/catch around the existing task body, with
 * status RUNNING → SUCCESS|FAILED. The original error-handling inside each
 * task (`console.error("[task_name] ...", err)`) still runs because we
 * re-throw is NOT done — we only swallow it the same way the prior
 * fire-and-forget code did. If creating the audit row itself fails, we log
 * and proceed so a DB hiccup never blocks the scheduler.
 *
 * `retryOfRunId` is forwarded when this invocation was kicked off manually
 * from `POST /api/v1/scheduled-jobs/:id/retry`, so the UI can show the
 * retry chain.
 */
export async function runTaskWithAudit(
  task: ScheduledTask,
  opts: { retryOfRunId?: string } = {}
): Promise<{ runId: string | null; status: "SUCCESS" | "FAILED" }> {
  const startedAt = new Date();
  let runId: string | null = null;
  try {
    const row = await prisma.scheduledTaskRun.create({
      data: {
        taskName: task.name,
        status: "RUNNING",
        startedAt,
        ...(opts.retryOfRunId ? { retryOfRunId: opts.retryOfRunId } : {}),
      },
      select: { id: true },
    });
    runId = row.id;
  } catch (err) {
    console.error(`[scheduler] failed to record run start for ${task.name}`, err);
  }

  try {
    await task.run();
    const completedAt = new Date();
    if (runId) {
      try {
        await prisma.scheduledTaskRun.update({
          where: { id: runId },
          data: {
            status: "SUCCESS",
            completedAt,
            durationMs: completedAt.getTime() - startedAt.getTime(),
          },
        });
      } catch (err) {
        console.error(`[scheduler] failed to record SUCCESS for ${task.name}`, err);
      }
    }
    return { runId, status: "SUCCESS" };
  } catch (err) {
    const completedAt = new Date();
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (runId) {
      try {
        await prisma.scheduledTaskRun.update({
          where: { id: runId },
          data: {
            status: "FAILED",
            completedAt,
            durationMs: completedAt.getTime() - startedAt.getTime(),
            error: msg.slice(0, 5000),
          },
        });
      } catch (innerErr) {
        console.error(`[scheduler] failed to record FAILED for ${task.name}`, innerErr);
      }
    }
    console.error(`[scheduler] ${task.name} failed`, err);
    return { runId, status: "FAILED" };
  }
}

/**
 * Pearl §8.4 — lookup a registered task by name. Used by the retry route to
 * locate the original task body when re-invoking a failed run.
 */
export function getRegisteredTask(name: string): ScheduledTask | null {
  return TASKS.find((t) => t.name === name) ?? null;
}

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
      // Fire-and-forget; runTaskWithAudit handles SUCCESS/FAILED persistence
      // and swallows the error the same way the prior `.catch(console.error)`
      // wrap did.
      runTaskWithAudit(task).catch((err) =>
        console.error(`[scheduler] ${task.name} wrap failed`, err)
      );
    } catch (err) {
      console.error(`[scheduler] tick error for ${task.name}`, err);
    }
  }
}

export function registerScheduledTasks(): void {
  if (intervalHandle) return;
  console.log(`[scheduler] registering ${TASKS.length} scheduled tasks`);
  // Pearl §8.3 piece 3g — idempotently seed the operator-tunable
  // platform-billing config rows (usage unit prices, GST state + rates,
  // grace window). Safe to run on every boot — existing rows are left
  // alone so prior operator edits survive restarts.
  seedPlatformBillingConfig()
    .then((r) => {
      if (r.inserted > 0) {
        console.log(
          `[platform_billing_config] seeded ${r.inserted} default row(s); ${r.alreadyPresent} already present`,
        );
      }
    })
    .catch((err) =>
      console.error("[platform_billing_config] seed failed", err),
    );
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
      await runTaskWithAudit(task);
    } catch (err) {
      console.error(`[scheduler-test] ${task.name} failed`, err);
    }
  }
}
