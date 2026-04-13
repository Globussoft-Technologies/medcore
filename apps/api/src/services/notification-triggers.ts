import { prisma } from "@medcore/db";
import { NotificationType } from "@medcore/shared";
import { sendNotification } from "./notification";

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
    message: `Hi ${patient.user.name}, your appointment with Dr. ${doctor.user.name} is confirmed for ${dateStr}${timeStr}. Your token number is ${tokenNumber}.`,
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
    message: `Hi ${patient.user.name}, your appointment with Dr. ${doctor.user.name} on ${dateStr} has been cancelled.`,
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
    message: `Hi ${patient.user.name}, Token #${tokenNumber} — your turn is next! Please proceed to Dr. ${doctor.user.name}'s room.`,
    data: { appointmentId: appointment.id, tokenNumber, doctorName: doctor.user.name },
  });
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
    message: `Hi ${patient.user.name}, your prescription from Dr. ${doctor.user.name} is ready. View it here: ${prescriptionLink}`,
    data: { prescriptionId: prescription.id, link: prescriptionLink },
  });
}

// ─── Billing Triggers ──────────────────────────────────

export async function onBillGenerated(invoice: {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  patientId: string;
}): Promise<void> {
  // Look up patient's userId
  const patient = await prisma.patient.findUnique({
    where: { id: invoice.patientId },
    include: { user: { select: { id: true, name: true, phone: true } } },
  });

  if (!patient) return;

  const paymentLink = `/billing/invoices/${invoice.id}/pay`;

  await sendNotification({
    userId: patient.user.id,
    type: NotificationType.BILL_GENERATED,
    title: "Bill Generated",
    message: `Hi ${patient.user.name}, your bill (${invoice.invoiceNumber}) of Rs. ${invoice.totalAmount.toFixed(2)} has been generated. Pay here: ${paymentLink}`,
    data: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: invoice.totalAmount,
      link: paymentLink,
    },
  });
}

export async function onPaymentReceived(
  payment: { id: string; amount: number; mode: string },
  invoice: { id: string; invoiceNumber: string; totalAmount: number; patientId: string }
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
    message: `Good morning Dr. ${doctor.user.name}, you have ${count} appointment${count !== 1 ? "s" : ""} today.\n${patientList}${moreText}`,
    data: {
      doctorId,
      date: today.toISOString().split("T")[0],
      appointmentCount: count,
    },
  });
}
