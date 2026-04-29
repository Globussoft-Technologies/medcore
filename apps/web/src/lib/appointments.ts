/**
 * Shared appointment display helpers.
 *
 * Born from issues #387 / #388 / #389 / #397 — the patient-facing
 * "My Appointments" page and the unified Calendar page were each computing
 * status/time strings independently and disagreeing for the SAME appointment.
 *
 *  - #388: a past `BOOKED` appointment must read as `COMPLETED` on screen
 *    (we don't write to the DB; just transform on render).
 *  - #389: every time string for an appointment must route through the same
 *    formatter so the calendar tile and the list row never disagree.
 *  - #397: calendar tiles should always display a start time when available.
 *
 * The helpers below are pure and have no React dependency so they can be
 * imported by any component or test.
 */
const TZ = "Asia/Kolkata";

const TIME_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TZ,
  hour12: true,
});

/**
 * Pull a usable Date out of whatever the API gave us. Accepts:
 *  - full ISO datetimes (`2026-04-29T10:30:00Z`)
 *  - bare HH:mm strings (`"10:30"`) anchored to today in Asia/Kolkata
 *  - YYYY-MM-DD + HH:mm pairs (handled by the second arg)
 *
 * Returns `null` when the input is empty / unparseable.
 */
function parseAppointmentInstant(
  isoOrTime: string | Date | null | undefined,
  date?: string | null
): Date | null {
  if (!isoOrTime) return null;
  if (isoOrTime instanceof Date) {
    return Number.isFinite(isoOrTime.getTime()) ? isoOrTime : null;
  }
  // Bare "HH:mm" → combine with `date` (or today) so the formatter has a
  // real instant to work with. We construct using local components so the
  // resulting Date represents that wall-clock time in the user's locale,
  // which is also IST in our deployment.
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(isoOrTime)) {
    const [h, m] = isoOrTime.split(":").map(Number);
    const base = date && /^\d{4}-\d{2}-\d{2}/.test(date)
      ? new Date(`${date.slice(0, 10)}T00:00:00`)
      : new Date();
    base.setHours(h, m, 0, 0);
    return base;
  }
  const d = new Date(isoOrTime);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Format an appointment time to a stable Asia/Kolkata `hh:mm AM/PM` string.
 * Accepts the same inputs as {@link parseAppointmentInstant}. Returns an
 * empty string when nothing usable is available so callers can render a
 * dash without an extra null guard.
 */
export function formatAppointmentTime(
  isoOrTime: string | Date | null | undefined,
  date?: string | null
): string {
  const d = parseAppointmentInstant(isoOrTime, date);
  if (!d) return "";
  try {
    return TIME_FORMATTER.format(d);
  } catch {
    return "";
  }
}

/**
 * What status should the user actually SEE for this appointment?
 *
 * `BOOKED` is the booking-time status. After the appointment's start time
 * has passed, the row should render as `COMPLETED` even if no one
 * explicitly transitioned it (issue #388). We never mutate the DB; the
 * transformation happens at render time only.
 *
 * If the row has already been moved to `CANCELLED` / `NO_SHOW` /
 * `COMPLETED` etc., we leave the status untouched.
 */
export function displayStatusForAppointment(
  appt: {
    status: string;
    startTime?: string | Date | null;
    slotStart?: string | null;
    date?: string | null;
  },
  nowMs: number = Date.now()
): string {
  if (appt.status !== "BOOKED") return appt.status;
  const start = parseAppointmentInstant(
    appt.startTime ?? appt.slotStart ?? null,
    appt.date ?? null
  );
  if (!start) return appt.status;
  return start.getTime() < nowMs ? "COMPLETED" : appt.status;
}
