// Doctor confirmed-leave lookup — single source of truth.
//
// When a doctor has a CONFIRMED (APPROVED) LeaveRequest covering a date,
// that doctor must not surface any bookable slots for that date. The
// booking + reschedule slot grids all funnel through here so the rule is
// applied consistently across surfaces (GET /doctors/:id/slots, the
// public suggest-doctors grid, etc.).
//
// Data model (packages/db/prisma/schema.prisma):
//   - LeaveRequest is keyed by `userId` (the doctor's User id, NOT the
//     Doctor.id), so we resolve Doctor.userId first.
//   - fromDate / toDate are `@db.Date` (UTC-midnight), inclusive range.
//   - status APPROVED == confirmed. PENDING leave is NOT yet confirmed,
//     so it does not hide slots (only an approved leave does).

import { prisma } from "@medcore/db";

/**
 * Returns true if the doctor (by Doctor.id) has an APPROVED LeaveRequest
 * whose [fromDate, toDate] inclusive range covers `dateObj`.
 *
 * `dateObj` should be the UTC-midnight Date for the requested calendar
 * day (same basis the slot routes already use via `new Date("YYYY-MM-DD")`),
 * so the inclusive `fromDate <= dateObj <= toDate` comparison lines up
 * with the `@db.Date` storage.
 */
export async function isDoctorOnConfirmedLeave(
  doctorId: string,
  dateObj: Date,
): Promise<boolean> {
  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
    select: { userId: true },
  });
  if (!doctor?.userId) return false;

  const leave = await prisma.leaveRequest.findFirst({
    where: {
      userId: doctor.userId,
      status: "APPROVED",
      fromDate: { lte: dateObj },
      toDate: { gte: dateObj },
    },
    select: { id: true },
  });
  return leave !== null;
}
