import { prisma } from "@medcore/db";

/** Risk prediction result for a single appointment. */
export interface NoShowPrediction {
  appointmentId: string;
  riskScore: number; // 0.0–1.0
  riskLevel: "low" | "medium" | "high";
  factors: string[]; // human-readable reason strings
  recommendation: string; // what front desk should do
}

/**
 * Score the no-show risk for a single appointment using a rule-based model.
 * Features considered: historical no-show rate, booking lead time, day of week,
 * time of day, new-patient status, and recent no-show history (last 60 days).
 *
 * @param appointmentId UUID of the appointment to score.
 */
export async function predictNoShow(appointmentId: string): Promise<NoShowPrediction> {
  // 1. Fetch the appointment with patient
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true },
  });

  if (!appointment) {
    throw new Error(`Appointment ${appointmentId} not found`);
  }

  const patientId = appointment.patientId;
  const now = new Date();
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

  // 2. Fetch the patient's last 12 months of appointments (excluding current)
  const pastAppointments = await prisma.appointment.findMany({
    where: {
      patientId,
      id: { not: appointmentId },
      date: { gte: twelveMonthsAgo },
    },
    select: {
      status: true,
      date: true,
    },
  });

  // 3. Calculate features

  // historicalNoShowRate
  let historicalNoShowRate: number;
  if (pastAppointments.length < 5) {
    historicalNoShowRate = 0.1;
  } else {
    const noShowCount = pastAppointments.filter((a) => a.status === "NO_SHOW").length;
    historicalNoShowRate = noShowCount / pastAppointments.length;
  }

  // leadTimeDays: days between createdAt and date
  const appointmentDate = new Date(appointment.date);
  const createdAt = new Date(appointment.createdAt);
  const leadTimeDays = Math.max(
    0,
    Math.floor((appointmentDate.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
  );

  // dayOfWeek: 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const dayOfWeek = appointmentDate.getDay();

  // hourOfDay: parse slotStart "HH:MM"
  let hourOfDay = 12; // default midday if no slot
  if (appointment.slotStart) {
    const parts = appointment.slotStart.split(":");
    hourOfDay = parseInt(parts[0], 10);
  }

  // isNewPatient: fewer than 3 past appointments
  const isNewPatient = pastAppointments.length < 3;

  // hasRecentNoShow: any NO_SHOW in last 60 days
  const sixtyDaysAgo = new Date(now);
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const hasRecentNoShow = pastAppointments.some(
    (a) => a.status === "NO_SHOW" && new Date(a.date) >= sixtyDaysAgo
  );

  // 4. Score calculation
  let score = historicalNoShowRate * 0.4;
  if (leadTimeDays > 14) score += 0.15;
  else if (leadTimeDays > 7) score += 0.08;
  if (dayOfWeek === 1) score += 0.05; // Monday
  if (dayOfWeek === 5) score += 0.05; // Friday
  if (hourOfDay >= 17) score += 0.08; // late afternoon
  if (hourOfDay <= 8) score += 0.05; // very early
  if (isNewPatient) score += 0.05;
  if (hasRecentNoShow) score += 0.2;
  score = Math.min(score, 1.0);

  // 5. Build factors array (only include factors that contributed significantly)
  const factors: string[] = [];

  if (historicalNoShowRate >= 0.2) {
    factors.push(
      `High historical no-show rate (${Math.round(historicalNoShowRate * 100)}%)`
    );
  }
  if (leadTimeDays > 14) {
    factors.push(`Appointment booked ${leadTimeDays} days in advance (long lead time)`);
  } else if (leadTimeDays > 7) {
    factors.push(`Appointment booked ${leadTimeDays} days in advance`);
  }
  if (dayOfWeek === 1) {
    factors.push("Monday appointment (higher no-show day)");
  }
  if (dayOfWeek === 5) {
    factors.push("Friday appointment (higher no-show day)");
  }
  if (hourOfDay >= 17) {
    factors.push("Late afternoon slot (after 5 PM)");
  } else if (hourOfDay <= 8) {
    factors.push("Very early morning slot (8 AM or earlier)");
  }
  if (isNewPatient) {
    factors.push("New patient (fewer than 3 prior appointments)");
  }
  if (hasRecentNoShow) {
    factors.push("Patient had a no-show in the last 60 days");
  }

  // 6. riskLevel
  let riskLevel: "low" | "medium" | "high";
  if (score < 0.25) {
    riskLevel = "low";
  } else if (score < 0.55) {
    riskLevel = "medium";
  } else {
    riskLevel = "high";
  }

  // 7. recommendation
  let recommendation: string;
  if (riskLevel === "low") {
    recommendation = "No action needed";
  } else if (riskLevel === "medium") {
    recommendation = "Send a reminder call";
  } else {
    recommendation = "Call patient to confirm + book a backup slot";
  }

  return {
    appointmentId,
    riskScore: Math.round(score * 1000) / 1000,
    riskLevel,
    factors,
    recommendation,
  };
}

/**
 * Score all BOOKED appointments on a given calendar date, sorted by risk score
 * descending so the front desk can prioritise outreach calls.
 *
 * @param date ISO date string (YYYY-MM-DD).
 */
export async function batchPredictNoShow(date: string): Promise<NoShowPrediction[]> {
  // Fetch all BOOKED appointments for the given date
  const dateObj = new Date(date);
  const bookedAppointments = await prisma.appointment.findMany({
    where: {
      date: dateObj,
      status: "BOOKED",
    },
    select: { id: true },
  });

  const predictions = await Promise.all(
    bookedAppointments.map((appt) => predictNoShow(appt.id))
  );

  // Sort by riskScore descending
  return predictions.sort((a, b) => b.riskScore - a.riskScore);
}
