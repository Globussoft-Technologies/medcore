import { prisma } from "@medcore/db";
import { NotificationType } from "@medcore/shared";
import { sendNotification } from "./notification";

/**
 * Decide whether a patient is due for a check-in today. A check-in is due
 * when (now - lastCheckInAt) >= checkInFrequencyDays, OR when the patient
 * has never checked in. Exported for unit tests.
 */
export function isCheckInDue(
  freqDays: number,
  lastCheckInAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!lastCheckInAt) return true;
  const hoursSince = (now.getTime() - lastCheckInAt.getTime()) / 36e5;
  return hoursSince >= freqDays * 24;
}

/**
 * Evaluate a single check-in against the plan thresholds. Threshold keys
 * are domain-specific (e.g. bpSystolic, bgFasting, pefr). Each threshold
 * value is the cut-off — any `responses[key]` >= threshold is considered a
 * breach. Returns the list of breached keys + observed values, or null when
 * nothing is breached.
 */
export function evaluateThresholds(
  thresholds: Record<string, number>,
  responses: Record<string, unknown>
): { key: string; observed: number; threshold: number }[] | null {
  const breaches: { key: string; observed: number; threshold: number }[] = [];
  for (const [key, cutoff] of Object.entries(thresholds)) {
    const raw = responses[key];
    const observed = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(observed)) continue;
    if (observed >= cutoff) {
      breaches.push({ key, observed, threshold: cutoff });
    }
  }
  return breaches.length > 0 ? breaches : null;
}

/**
 * Run one pass of the chronic-care reminder loop. Intended to be called by
 * the setInterval stub below every 15 minutes. Finds every active plan
 * whose patient is due for a check-in and emits a reminder notification.
 *
 * NOTE: No LLM call yet — this pass only handles reminder fan-out and
 * threshold evaluation. Conversational coaching (Feature 4 Phase 2) will
 * wrap this scheduler once the Sarvam coaching prompt is hardened.
 */
export async function runChronicCareReminders(): Promise<{
  sent: number;
  errors: number;
}> {
  const plans = await prisma.chronicCarePlan.findMany({
    where: { active: true },
  });

  let sent = 0;
  let errors = 0;

  for (const plan of plans) {
    try {
      const lastCheckIn = await prisma.chronicCareCheckIn.findFirst({
        where: { planId: plan.id },
        orderBy: { loggedAt: "desc" },
        select: { loggedAt: true },
      });

      if (!isCheckInDue(plan.checkInFrequencyDays, lastCheckIn?.loggedAt ?? null)) {
        continue;
      }

      const patient = await prisma.patient.findUnique({
        where: { id: plan.patientId },
        select: {
          userId: true,
          user: { select: { name: true } },
        },
      });
      if (!patient?.userId) continue;

      await sendNotification({
        userId: patient.userId,
        type: NotificationType.APPOINTMENT_REMINDER,
        title: "Check-in reminder",
        message: `Hi ${patient.user?.name ?? "there"}, please log today's ${plan.condition.toLowerCase()} readings in the app.`,
        data: {
          chronicCarePlanId: plan.id,
          condition: plan.condition,
        },
      });
      sent++;
    } catch (err) {
      console.error(
        `[chronic-care-scheduler] failed for plan ${plan.id}:`,
        err
      );
      errors++;
    }
  }

  return { sent, errors };
}

/**
 * Start the chronic-care reminder scheduler. Runs every 15 minutes.
 * Call once at app startup. This is a SCAFFOLD: threshold-based alerts
 * originate from the `POST /plans/:id/check-in` route when a patient logs
 * data, not from this loop.
 */
export function startChronicCareScheduler(): void {
  setInterval(async () => {
    const result = await runChronicCareReminders().catch(() => ({
      sent: 0,
      errors: 1,
    }));
    if (result.sent > 0 || result.errors > 0) {
      console.log(
        JSON.stringify({
          event: "chronic_care_reminders",
          ...result,
          ts: new Date().toISOString(),
        })
      );
    }
  }, 15 * 60 * 1000);
}
