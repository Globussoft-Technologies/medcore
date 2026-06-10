import { prisma } from "@medcore/db";
import { NotificationType } from "@medcore/shared";
import { sendNotification } from "./notification";
import { formatDoctorName } from "../lib/format-doctor-name";
import { advanceChronicCareSequence } from "./chronic-care-scheduler";
import { patientPortalLink } from "../lib/site-link";

// ─── Pearl §5.2 row 145 — on-visit auto-schedule next message ──────────
//
// When a patient checks in (Appointment.status → CHECKED_IN), advance
// every active cohort-linked ChronicCarePlan for that patient by one
// step. This is the "skip-and-advance" pattern from the PRD: an OPD
// visit is the most engaged touchpoint, so we don't wait for the
// delayDays window — we just send the next step now.
//
// Fire-and-forget (caller .catch()es). Safe to call on every status
// transition: `sendChronicCareSequenceStep` is a no-op when the plan
// has no pending steps.
export async function onPatientCheckedIn(patientId: string): Promise<void> {
  try {
    const sent = await advanceChronicCareSequence(patientId);
    if (sent > 0) {
      console.log(
        `[notification-triggers] advanced ${sent} chronic-care plan(s) for patient ${patientId} on check-in`,
      );
    }
  } catch (err) {
    console.error("[notification-triggers] onPatientCheckedIn", err);
  }
}

// ─── Appointment Triggers ──────────────────────────────

export async function onAppointmentBooked(appointment: {
  id: string;
  tokenNumber: number;
  date: Date;
  slotStart?: string | null;
  patient: { id: string; userId: string; user: { name: string; phone: string } };
  doctor: { id: string; userId: string; user: { name: string } };
}): Promise<void> {
  const { patient, doctor, tokenNumber, date, slotStart } = appointment;
  const dateStr = new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timeStr = slotStart ? ` at ${slotStart}` : "";

  // Notify patient
  await sendNotification({
    userId: patient.userId,
    type: NotificationType.APPOINTMENT_BOOKED,
    title: "Appointment Confirmed",
    message: `Hi ${patient.user.name}, your appointment with ${formatDoctorName(doctor.user.name)} is confirmed for ${dateStr}${timeStr}. Your token number is ${tokenNumber}. View your appointments: ${patientPortalLink()}`,
    data: { appointmentId: appointment.id, tokenNumber, doctorName: doctor.user.name },
  });

  // Notify doctor
  await sendNotification({
    userId: doctor.userId,
    type: NotificationType.APPOINTMENT_BOOKED,
    title: "New Appointment",
    message: `New appointment booked: ${patient.user.name} (Token #${tokenNumber}) on ${dateStr}${timeStr}.`,
    data: { appointmentId: appointment.id, tokenNumber, patientName: patient.user.name },
  });
}

export async function onAppointmentCancelled(appointment: {
  id: string;
  tokenNumber: number;
  date: Date;
  patient: { id: string; userId: string; user: { name: string; phone: string } };
  doctor: { id: string; userId: string; user: { name: string } };
}): Promise<void> {
  const { patient, doctor, date } = appointment;
  const dateStr = new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  // Notify patient
  await sendNotification({
    userId: patient.userId,
    type: NotificationType.APPOINTMENT_CANCELLED,
    title: "Appointment Cancelled",
    message: `Hi ${patient.user.name}, your appointment with ${formatDoctorName(doctor.user.name)} on ${dateStr} has been cancelled.`,
    data: { appointmentId: appointment.id },
  });

  // Notify doctor
  await sendNotification({
    userId: doctor.userId,
    type: NotificationType.APPOINTMENT_CANCELLED,
    title: "Appointment Cancelled",
    message: `Appointment with ${patient.user.name} (Token #${appointment.tokenNumber}) on ${dateStr} has been cancelled.`,
    data: { appointmentId: appointment.id, patientName: patient.user.name },
  });
}

export async function onTokenCalled(appointment: {
  id: string;
  tokenNumber: number;
  patient: { id: string; userId: string; user: { name: string; phone: string } };
  doctor: { id: string; userId: string; user: { name: string } };
}): Promise<void> {
  const { patient, doctor, tokenNumber } = appointment;

  await sendNotification({
    userId: patient.userId,
    type: NotificationType.TOKEN_CALLED,
    title: "Your Turn is Next",
    message: `Hi ${patient.user.name}, Token #${tokenNumber} — your turn is next! Please proceed to ${formatDoctorName(doctor.user.name)}'s room.`,
    data: { appointmentId: appointment.id, tokenNumber, doctorName: doctor.user.name },
  });
}

// ─── Queue Position Notification ───────────────────────

/**
 * Compute queue position + estimated wait for an appointment and notify patient.
 * Fires when a patient is CHECKED_IN and every ~15 mins thereafter (via cron).
 */
export async function notifyQueuePosition(appointmentId: string): Promise<void> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      patient: { include: { user: { select: { id: true, name: true } } } },
      doctor: { include: { user: { select: { name: true } } } },
    },
  });
  if (!appt) return;
  if (!["BOOKED", "CHECKED_IN"].includes(appt.status)) return;

  // Everyone on the same queue ahead of this appointment (active consultation + checked_in + booked with earlier token)
  const queue = await prisma.appointment.findMany({
    where: {
      doctorId: appt.doctorId,
      date: appt.date,
      status: { in: ["BOOKED", "CHECKED_IN", "IN_CONSULTATION"] },
    },
    select: { id: true, tokenNumber: true, priority: true, status: true },
    orderBy: [{ priority: "desc" }, { tokenNumber: "asc" }],
  });

  const idx = queue.findIndex((q) => q.id === appt.id);
  if (idx < 0) return;

  const position = idx + 1;
  const avgConsultMin = 15;
  const ahead = idx; // number of patients ahead
  const estimatedWaitMin = ahead * avgConsultMin;

  await sendNotification({
    userId: appt.patient.user.id,
    type: NotificationType.TOKEN_CALLED,
    title: "Your queue position",
    message: `Hi ${appt.patient.user.name}, you are #${position} in queue for ${formatDoctorName(appt.doctor.user.name)}. Estimated wait: ${estimatedWaitMin} minutes.`,
    data: {
      appointmentId,
      position,
      estimatedWaitMinutes: estimatedWaitMin,
    },
  });
}

/**
 * Cron stub — re-send queue position SMS every 15 minutes to all waiting
 * patients. Call this from a scheduled task. Safe to call periodically.
 */
export async function broadcastQueuePositions(): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const waiting = await prisma.appointment.findMany({
    where: {
      date: today,
      status: { in: ["CHECKED_IN"] },
    },
    select: { id: true },
  });
  for (const a of waiting) {
    try {
      await notifyQueuePosition(a.id);
    } catch (e) {
      console.error("[broadcastQueuePositions]", e);
    }
  }
}

// ─── Prescription Trigger ──────────────────────────────

export async function onPrescriptionReady(prescription: {
  id: string;
  patient: { id: string; userId: string; user: { name: string; phone: string } };
  doctor: { id: string; user: { name: string } };
}): Promise<void> {
  const { patient, doctor } = prescription;
  const prescriptionLink = `/prescriptions/${prescription.id}`;

  await sendNotification({
    userId: patient.userId,
    type: NotificationType.PRESCRIPTION_READY,
    title: "Prescription Ready",
    message: `Hi ${patient.user.name}, your prescription from ${formatDoctorName(doctor.user.name)} is ready. View it here: ${prescriptionLink}`,
    data: { prescriptionId: prescription.id, link: prescriptionLink },
  });
}

// ─── Billing Triggers ──────────────────────────────────

// Issue #901: totalAmount widened to `number | { toNumber: () => number }`
// (effectively `number | Prisma.Decimal`) so callers can pass the new
// Decimal-typed Invoice row without coercing at every call-site. We
// coerce locally before formatting.
type AmountLike = number | { toNumber: () => number };
function asNumber(v: AmountLike): number {
  return typeof v === "number" ? v : v.toNumber();
}

export async function onBillGenerated(invoice: {
  id: string;
  invoiceNumber: string;
  totalAmount: AmountLike;
  patientId: string;
}): Promise<void> {
  // Look up patient's userId
  const patient = await prisma.patient.findUnique({
    where: { id: invoice.patientId },
    include: { user: { select: { id: true, name: true, phone: true } } },
  });

  if (!patient) return;

  const paymentLink = `/billing/invoices/${invoice.id}/pay`;
  const totalAmount = asNumber(invoice.totalAmount);

  await sendNotification({
    userId: patient.user.id,
    type: NotificationType.BILL_GENERATED,
    title: "Bill Generated",
    message: `Hi ${patient.user.name}, your bill (${invoice.invoiceNumber}) of Rs. ${totalAmount.toFixed(2)} has been generated. Pay here: ${paymentLink}`,
    data: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount,
      link: paymentLink,
    },
  });
}

export async function onPaymentReceived(
  payment: { id: string; amount: number; mode: string },
  invoice: { id: string; invoiceNumber: string; totalAmount: AmountLike; patientId: string }
): Promise<void> {
  const patient = await prisma.patient.findUnique({
    where: { id: invoice.patientId },
    include: { user: { select: { id: true, name: true, phone: true } } },
  });

  if (!patient) return;

  await sendNotification({
    userId: patient.user.id,
    type: NotificationType.PAYMENT_RECEIVED,
    title: "Payment Received",
    message: `Hi ${patient.user.name}, we received your payment of Rs. ${payment.amount.toFixed(2)} (${payment.mode}) for invoice ${invoice.invoiceNumber}. Thank you!`,
    data: {
      paymentId: payment.id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amountPaid: payment.amount,
    },
  });
}

// ─── Doctor Schedule Summary ───────────────────────────

export async function onDoctorScheduleSummary(doctorId: string): Promise<void> {
  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
    include: { user: { select: { id: true, name: true } } },
  });

  if (!doctor) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const appointments = await prisma.appointment.findMany({
    where: {
      doctorId,
      date: today,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
    },
    include: {
      patient: { include: { user: { select: { name: true } } } },
    },
    orderBy: { tokenNumber: "asc" },
  });

  const count = appointments.length;
  const patientList = appointments
    .slice(0, 5)
    .map((a) => `  Token #${a.tokenNumber}: ${a.patient.user.name}`)
    .join("\n");
  const moreText = count > 5 ? `\n  ...and ${count - 5} more` : "";

  await sendNotification({
    userId: doctor.user.id,
    type: NotificationType.SCHEDULE_SUMMARY,
    title: "Today's Schedule Summary",
    message: `Good morning ${formatDoctorName(doctor.user.name)}, you have ${count} appointment${count !== 1 ? "s" : ""} today.\n${patientList}${moreText}`,
    data: {
      doctorId,
      date: today.toISOString().split("T")[0],
      appointmentCount: count,
    },
  });
}
