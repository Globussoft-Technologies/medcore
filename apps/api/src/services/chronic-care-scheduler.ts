import { prisma } from "@medcore/db";
import { NotificationType } from "@medcore/shared";
import { sendNotification } from "./notification";

// ─── Pearl §5.2 (gap rows 144 + 145) — sequence stepper ────────────────
//
// A ChronicCarePlan that was auto-enrolled from a ChronicCareCohort can
// carry a sequence of touchpoints (visit-reminder, lab-reminder,
// education-snippet, etc.). Step N+1 is scheduled when EITHER
//   (a) `delayDays` have elapsed since step N's `lastStepSentAt` (or
//       since enrolment for step 1), OR
//   (b) `advanceChronicCareSequence(patientId)` is called — wired by
//       `services/notification-triggers.ts` when the patient's
//       Appointment.status flips to CHECKED_IN. Per PRD §5.2: "when an
//       enrolled patient is seen in OPD, the next message in the
//       sequence schedules automatically."
//
// Sends are FIRE-AND-FORGET via `sendNotification`. The plan's
// `lastStepSent` + `lastStepSentAt` are bumped after each successful
// send so re-runs are idempotent and the on-visit hook (which advances
// regardless of delay) doesn't double-fire the same step.

/**
 * Look up the next pending CohortSequenceStep for a plan, given the
 * plan's current `lastStepSent`. Returns null when:
 *   - The plan is not cohort-linked.
 *   - The plan has already received the final step.
 *   - The cohort has no remaining active steps.
 */
async function getNextStepForPlan(plan: {
  id: string;
  cohortId: string | null;
  lastStepSent: number;
}): Promise<{
  id: string;
  stepNumber: number;
  delayDays: number;
  templateKey: string;
  channels: string[];
} | null> {
  if (!plan.cohortId) return null;
  const step = await prisma.cohortSequenceStep.findFirst({
    where: {
      chronicCareCohortId: plan.cohortId,
      active: true,
      stepNumber: { gt: plan.lastStepSent },
    },
    orderBy: { stepNumber: "asc" },
    select: {
      id: true,
      stepNumber: true,
      delayDays: true,
      templateKey: true,
      channels: true,
    },
  });
  if (!step) return null;
  return {
    ...step,
    channels: step.channels as unknown as string[],
  };
}

/**
 * Send one sequence step for a plan: fan-out a notification + bump the
 * plan's `lastStepSent` / `lastStepSentAt`. Pure side effects — used by
 * both the timer-driven loop and the on-visit advance hook.
 *
 * Returns true if a step was actually delivered, false otherwise (no
 * step pending, or send error).
 */
export async function sendChronicCareSequenceStep(planId: string): Promise<boolean> {
  const plan = await prisma.chronicCarePlan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      patientId: true,
      condition: true,
      active: true,
      cohortId: true,
      lastStepSent: true,
    },
  });
  if (!plan || !plan.active || !plan.cohortId) return false;

  const step = await getNextStepForPlan(plan);
  if (!step) return false;

  const patient = await prisma.patient.findUnique({
    where: { id: plan.patientId },
    select: { userId: true, user: { select: { name: true } } },
  });
  if (!patient?.userId) return false;

  try {
    await sendNotification({
      userId: patient.userId,
      type: NotificationType.APPOINTMENT_REMINDER,
      title: `Chronic-care touchpoint (${step.templateKey})`,
      message: `Hi ${patient.user?.name ?? "there"}, this is a scheduled touchpoint for your ${plan.condition.toLowerCase()} care plan.`,
      data: {
        chronicCarePlanId: plan.id,
        cohortStepNumber: step.stepNumber,
        templateKey: step.templateKey,
        channels: step.channels,
      },
    });
  } catch (err) {
    console.error(
      `[chronic-care-scheduler] sequence-step send failed for plan ${plan.id} step ${step.stepNumber}`,
      err,
    );
    return false;
  }

  try {
    await prisma.chronicCarePlan.update({
      where: { id: plan.id },
      data: {
        lastStepSent: step.stepNumber,
        lastStepSentAt: new Date(),
      },
    });
  } catch (err) {
    console.error(
      `[chronic-care-scheduler] failed to bump lastStepSent for plan ${plan.id}`,
      err,
    );
  }
  return true;
}

/**
 * Skip-and-advance entry point for the on-visit hook. Per PRD §5.2 row
 * 145 — when an enrolled patient is seen in OPD (Appointment.status
 * flips to CHECKED_IN), schedule the NEXT step in their sequence
 * immediately, ignoring `delayDays`. Walks every active cohort-linked
 * plan for the patient and advances each.
 *
 * Returns the number of plans that received a step.
 */
export async function advanceChronicCareSequence(
  patientId: string,
): Promise<number> {
  const plans = await prisma.chronicCarePlan.findMany({
    where: {
      patientId,
      active: true,
      NOT: { cohortId: null },
    },
    select: { id: true },
  });
  let sent = 0;
  for (const p of plans) {
    try {
      const ok = await sendChronicCareSequenceStep(p.id);
      if (ok) sent++;
    } catch (err) {
      console.error(
        `[chronic-care-scheduler] advance failed for plan ${p.id}`,
        err,
      );
    }
  }
  return sent;
}

/**
 * Timer-driven sweep — walk every active cohort-linked plan that has a
 * pending next step whose `delayDays` window has elapsed (measured from
 * `lastStepSentAt` for steps >=2, or from `createdAt` for step 1). Each
 * eligible plan gets exactly one send per pass. Idempotent.
 */
export async function runChronicCareSequenceSends(
  now: Date = new Date(),
): Promise<{ sent: number; errors: number }> {
  const plans = await prisma.chronicCarePlan.findMany({
    where: {
      active: true,
      NOT: { cohortId: null },
    },
    select: {
      id: true,
      cohortId: true,
      lastStepSent: true,
      lastStepSentAt: true,
      createdAt: true,
    },
  });

  let sent = 0;
  let errors = 0;
  for (const plan of plans) {
    try {
      const step = await getNextStepForPlan(plan);
      if (!step) continue;
      const anchor = plan.lastStepSentAt ?? plan.createdAt;
      const dueAt = new Date(anchor.getTime() + step.delayDays * 24 * 60 * 60 * 1000);
      if (dueAt > now) continue;
      const ok = await sendChronicCareSequenceStep(plan.id);
      if (ok) sent++;
    } catch (err) {
      console.error(
        `[chronic-care-scheduler] sequence-sweep failed for plan ${plan.id}`,
        err,
      );
      errors++;
    }
  }
  return { sent, errors };
}

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
