import { prisma } from "@medcore/db";
import { NotificationType } from "@medcore/shared";
import { sendNotification } from "./notification";
import { formatDoctorName } from "../lib/format-doctor-name";

/**
 * Find the first WAITING entry for a given doctor and send the patient a
 * notification. Marks the entry as NOTIFIED. Fire-and-forget safe.
 */
export async function notifyNextInWaitlist(doctorId: string): Promise<void> {
  const entry = await prisma.waitlistEntry.findFirst({
    where: { doctorId, status: "WAITING" },
    orderBy: { createdAt: "asc" },
    include: {
      patient: { include: { user: { select: { id: true, name: true } } } },
      doctor: { include: { user: { select: { name: true } } } },
    },
  });

  if (!entry) return;

  await prisma.waitlistEntry.update({
    where: { id: entry.id },
    data: { status: "NOTIFIED", notifiedAt: new Date() },
  });

  await sendNotification({
    userId: entry.patient.user.id,
    type: NotificationType.APPOINTMENT_REMINDER,
    title: "A slot has opened up",
    message: `Hi ${entry.patient.user.name}, a slot with ${formatDoctorName(entry.doctor.user.name)} just opened up. Please book now to secure your appointment.`,
    data: {
      waitlistEntryId: entry.id,
      doctorId: entry.doctorId,
    },
  });
}
