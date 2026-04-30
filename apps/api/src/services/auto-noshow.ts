import { prisma } from "@medcore/db";

/**
 * Auto-NO_SHOW transition for elapsed BOOKED appointments (Issue #388).
 *
 * Companion to the render-layer fix in commit aa3ab9e
 * (`apps/web/src/lib/appointments.ts::displayStatusForAppointment`), which
 * masks past `BOOKED` rows as `COMPLETED` on screen but leaves the database
 * untouched. The render-layer trick is fragile:
 *   - analytics queries grouped by `status` still bucket these as `BOOKED`
 *   - any view that doesn't import the helper renders a stale `BOOKED` badge
 *   - exported reports / FHIR feeds carry `BOOKED` for events that elapsed
 *     days ago
 *
 * This task scans for past-due `BOOKED` rows every 30 minutes and transitions
 * them to `NO_SHOW` so the source of truth eventually catches up.
 *
 * Why `NO_SHOW` and not `COMPLETED`?
 *   Distinguishing the two requires clinician input. For an unattended past
 *   `BOOKED`, `NO_SHOW` is the safest default — it's the most conservative
 *   (no implied clinical work happened) and a doctor can still flip a
 *   `NO_SHOW` to `COMPLETED` later from the chart if needed.
 *
 * Each transition is wrapped in a `$transaction` with an `auditLog` row so
 * the audit trail captures that no human moved the appointment.
 */

/** Grace window before we consider a BOOKED row past-due. */
const GRACE_MINUTES = 30;

/** Cap rows touched per run so a long backlog doesn't lock the DB. */
const BATCH_SIZE = 500;

/**
 * Convert a (`YYYY-MM-DD`, `HH:mm`) pair anchored to **Asia/Kolkata** into
 * a UTC `Date` representing that exact wall-clock instant.
 *
 * IST is a fixed +05:30 offset (no DST), so we can build the ISO string
 * with the literal `+05:30` suffix and let `Date` do the conversion.
 *
 * Returns `null` when either component is missing or malformed.
 */
export function istInstantFromDateAndSlot(
  date: Date | string | null | undefined,
  slotStart: string | null | undefined
): Date | null {
  if (!date || !slotStart) return null;
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(slotStart)) return null;

  let yyyyMmDd: string;
  if (date instanceof Date) {
    if (!Number.isFinite(date.getTime())) return null;
    // Use UTC components — the `date` column is a date-only field stored
    // at midnight UTC by Prisma, so its UTC year/month/day are the
    // appointment's intended IST calendar day.
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    yyyyMmDd = `${y}-${m}-${d}`;
  } else {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(date);
    if (!match) return null;
    yyyyMmDd = match[1];
  }

  // Pad slotStart to HH:mm:ss form.
  const time = slotStart.length === 5 ? `${slotStart}:00` : slotStart;
  const iso = `${yyyyMmDd}T${time}+05:30`;
  const out = new Date(iso);
  return Number.isFinite(out.getTime()) ? out : null;
}

export interface AutoNoShowResult {
  /** Number of rows transitioned to NO_SHOW. */
  transitioned: number;
  /** Rows that matched the BOOKED-by-date filter but were within grace
   * (skipped). Useful for visibility/log lines. */
  skippedWithinGrace: number;
  /** IDs of transitioned appointments. */
  ids: string[];
}

/**
 * Scan for past-due BOOKED appointments and transition them to NO_SHOW.
 * Bounded to {@link BATCH_SIZE} rows per call.
 *
 * @param now Override the current instant for tests.
 */
export async function autoTransitionElapsedBookedToNoShow(
  now: Date = new Date()
): Promise<AutoNoShowResult> {
  // Cheap pre-filter: anything BOOKED whose `date` is BEFORE today (in UTC)
  // is definitely past. Today's rows still need per-row time math because
  // their `slotStart` may be later than `now`. We grab both with a single
  // query bounded by `take` so very large backlogs are walked in batches
  // across successive ticks.
  const upperBound = new Date(now);
  // `date` is stored at midnight UTC. Use end-of-tomorrow UTC as a generous
  // upper bound — anything later than that can't possibly be past-due.
  upperBound.setUTCHours(23, 59, 59, 999);

  const candidates = await prisma.appointment.findMany({
    where: {
      status: "BOOKED",
      date: { lte: upperBound },
    },
    select: {
      id: true,
      date: true,
      slotStart: true,
      tokenNumber: true,
      doctorId: true,
      patientId: true,
    },
    orderBy: { date: "asc" },
    take: BATCH_SIZE,
  });

  if (candidates.length === 0) {
    return { transitioned: 0, skippedWithinGrace: 0, ids: [] };
  }

  const cutoffMs = now.getTime() - GRACE_MINUTES * 60 * 1000;

  const transitionedIds: string[] = [];
  let skippedWithinGrace = 0;

  for (const a of candidates) {
    const instant = istInstantFromDateAndSlot(a.date, a.slotStart);
    if (!instant) {
      // Row has no usable slotStart — fall back to using date-only at
      // 23:59 IST so we still eventually transition truly stale rows.
      // (date alone, even at end-of-day IST, must still be past `cutoffMs`.)
      if (!a.date) continue;
      const eod = istInstantFromDateAndSlot(a.date, "23:59");
      if (!eod || eod.getTime() > cutoffMs) {
        skippedWithinGrace++;
        continue;
      }
    } else if (instant.getTime() > cutoffMs) {
      // Within the grace window — leave it alone.
      skippedWithinGrace++;
      continue;
    }

    try {
      await prisma.$transaction([
        prisma.appointment.update({
          where: { id: a.id },
          data: { status: "NO_SHOW" },
        }),
        prisma.auditLog.create({
          data: {
            action: "APPOINTMENT_AUTO_NO_SHOW_ELAPSED",
            entity: "appointment",
            entityId: a.id,
            details: {
              tokenNumber: a.tokenNumber,
              doctorId: a.doctorId,
              patientId: a.patientId,
              slotStart: a.slotStart,
              date: a.date instanceof Date ? a.date.toISOString() : a.date,
              graceMinutes: GRACE_MINUTES,
              reason:
                "Past-due BOOKED row auto-transitioned to NO_SHOW; doctors can flip to COMPLETED from the chart.",
            } as any,
          } as any,
        }),
      ]);
      transitionedIds.push(a.id);
    } catch (err) {
      console.error(
        "[auto_noshow_elapsed_booked] transition failed",
        a.id,
        err
      );
    }
  }

  return {
    transitioned: transitionedIds.length,
    skippedWithinGrace,
    ids: transitionedIds,
  };
}

/** Scheduler entry point — wraps the worker in a try/catch + log line. */
export async function autoNoShowElapsedBookedTask(): Promise<void> {
  try {
    const result = await autoTransitionElapsedBookedToNoShow();
    if (result.transitioned > 0) {
      console.log(
        `[auto_noshow_elapsed_booked] transitioned ${result.transitioned} BOOKED → NO_SHOW (${result.skippedWithinGrace} within grace)`
      );
    }
  } catch (err) {
    console.error("[auto_noshow_elapsed_booked]", err);
  }
}
