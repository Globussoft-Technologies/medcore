import { prisma } from "@medcore/db";
import { NotificationType } from "@medcore/shared";
import { getMedicationsDueNow, generateReminderMessage } from "./ai/adherence-bot";
import { sendNotification } from "./notification";

/**
 * Derive a human-readable reminder type from the current hour.
 */
function deriveReminderType(): "morning" | "afternoon" | "evening" | "night" {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/**
 * Run adherence reminder checks for all active schedules.
 * Sends notifications for medications due within ±15 minutes of now.
 */
export async function runAdherenceReminders(): Promise<{
  sent: number;
  errors: number;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const schedules = await prisma.adherenceSchedule.findMany({
    where: {
      active: true,
      endDate: { gte: today },
      startDate: { lte: today },
    },
  });

  let sent = 0;
  let errors = 0;

  for (const schedule of schedules) {
    try {
      const meds = schedule.medications as {
        name: string;
        dosage: string;
        frequency: string;
        reminderTimes: string[];
      }[];

      const dueMeds = getMedicationsDueNow(meds);
      if (dueMeds.length === 0) continue;

      const patient = await prisma.patient.findUnique({
        where: { id: schedule.patientId },
        select: {
          userId: true,
          preferredLanguage: true,
          user: { select: { name: true } },
        },
      });

      if (!patient?.userId) continue;

      const language: "en" | "hi" =
        patient.preferredLanguage === "hi" ? "hi" : "en";

      const message = await generateReminderMessage({
        patientName: patient.user.name,
        medications: dueMeds,
        language,
        reminderType: deriveReminderType(),
      });

      await sendNotification({
        userId: patient.userId,
        type: NotificationType.APPOINTMENT_REMINDER,
        title: "Medication Reminder",
        message,
        data: { scheduleId: schedule.id },
      });

      await prisma.adherenceSchedule.update({
        where: { id: schedule.id },
        data: {
          remindersSent: schedule.remindersSent + 1,
          lastReminderAt: new Date(),
        },
      });

      sent++;
    } catch (err) {
      console.error(`[AdherenceScheduler] Error processing schedule ${schedule.id}:`, err);
      errors++;
    }
  }

  return { sent, errors };
}

/**
 * Start the adherence reminder scheduler. Runs every 15 minutes.
 * Call once at app startup.
 */
export function startAdherenceScheduler(): void {
  setInterval(async () => {
    const result = await runAdherenceReminders().catch(() => ({ sent: 0, errors: 1 }));
    if (result.sent > 0) {
      console.log(
        JSON.stringify({
          event: "adherence_reminders",
          ...result,
          ts: new Date().toISOString(),
        })
      );
    }
  }, 15 * 60 * 1000);
}
