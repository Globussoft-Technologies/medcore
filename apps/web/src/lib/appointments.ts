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
 * A still-waiting appointment (`BOOKED` / `CHECKED_IN`) that was never seen
 * reads as `NO_SHOW` once its window has elapsed — display only, the DB is
 * never mutated:
 *   - SLOT mode (the row carries a concrete start time): the slot has a clock
 *     time, so it becomes NO_SHOW the moment that slot INSTANT passes.
 *   - TOKEN / CALLING (no slot time): there's no clock time to expire against,
 *     so it becomes NO_SHOW once the appointment's calendar DAY is before today
 *     (a new day has begun without the patient being seen).
 *
 * Terminal / in-progress statuses (`COMPLETED` / `CANCELLED` / `NO_SHOW` /
 * `IN_CONSULTATION` …) are shown as-is.
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
  // Only the "waiting to be seen" states get the time/date-elapsed treatment.
  if (appt.status !== "BOOKED" && appt.status !== "CHECKED_IN") {
    return appt.status;
  }

  const startRaw = appt.startTime ?? appt.slotStart ?? null;
  if (startRaw) {
    // SLOT-mode (or any row with a concrete start time): expire on the instant.
    const start = parseAppointmentInstant(startRaw, appt.date ?? null);
    if (!start) return appt.status;
    return start.getTime() < nowMs ? "NO_SHOW" : appt.status;
  }

  // TOKEN / CALLING (no slot time): expire on the calendar day.
  return isAppointmentDayPast(appt.date ?? null, nowMs)
    ? "NO_SHOW"
    : appt.status;
}

/**
 * Has the appointment's window fully elapsed? SLOT rows (with a concrete start
 * time) expire on that instant; TOKEN / CALLING rows (no slot time) expire when
 * their calendar day is before today. Used to make past rows terminal — they
 * stop offering reversal/undo actions, since you can't act on a missed past
 * appointment (rebook a future one instead).
 */
export function isAppointmentPast(
  appt: {
    startTime?: string | Date | null;
    slotStart?: string | null;
    date?: string | null;
  },
  nowMs: number = Date.now()
): boolean {
  const startRaw = appt.startTime ?? appt.slotStart ?? null;
  if (startRaw) {
    const start = parseAppointmentInstant(startRaw, appt.date ?? null);
    return !!start && start.getTime() < nowMs;
  }
  return isAppointmentDayPast(appt.date ?? null, nowMs);
}

/**
 * Is the appointment scheduled for "today" (local)? Used to gate the
 * day-of actions (Check In + the ⋮ no-show/undo menu): you can't check in
 * or no-show a patient for a future appointment, and a past one is terminal.
 * Compares YYYY-MM-DD strings so there's no instant/timezone drift.
 */
export function isAppointmentToday(
  appt: { date?: string | null },
  nowMs: number = Date.now()
): boolean {
  if (!appt.date) return false;
  const ymd = String(appt.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const n = new Date(nowMs);
  const pad = (x: number) => String(x).padStart(2, "0");
  return (
    ymd === `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`
  );
}

/**
 * Is the appointment's calendar day strictly before "today" (local)? Used by
 * the no-slot (TOKEN / CALLING) branch of {@link displayStatusForAppointment}.
 * Compares YYYY-MM-DD strings so there's no instant/timezone drift.
 */
export function isAppointmentDayPast(
  date: string | null,
  nowMs: number = Date.now()
): boolean {
  if (!date) return false;
  const ymd = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const n = new Date(nowMs);
  const pad = (x: number) => String(x).padStart(2, "0");
  const todayYmd = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
  return ymd < todayYmd;
}

/**
 * Pearl ERP Stage 1 §2.1.2 — render the row's "#" identifier from the
 * appointment's OWN stored data, i.e. what the patient was actually assigned
 * WHEN THEY BOOKED — NOT the doctor's CURRENT `appointmentMode`.
 *
 * A doctor can switch modes (e.g. TOKEN → CALLING) after appointments already
 * exist. The label must stay stable across that switch: a patient who booked
 * under TOKEN keeps their token; one who booked under CALLING (arrival-order
 * queue — no token is ever minted) keeps showing no token. Keying off the live
 * doctor mode would retroactively relabel existing rows, which is wrong.
 *
 * The stored `tokenNumber` is the source of truth for "was a token issued":
 *   - token present (TOKEN booking, or a SLOT booking that minted one)
 *     → `<tokenPrefix>-<tokenNumber>` (e.g. "R-5").
 *   - no token (CALLING arrival-order queue, or a slot-only row)
 *     → `—`. The CALLING queue order lives on the live-queue screen, not here.
 */
export function appointmentRefLabel(appt: {
  tokenNumber: number | null;
  arrivalSeq?: number | null;
  doctor?: {
    appointmentMode?: "CALLING" | "TOKEN" | "SLOT" | null;
    tokenPrefix?: string | null;
  };
}): string {
  // Use the doctor's configured token prefix (e.g. "R") rather than a
  // hardcoded letter; fall back to "T" only when none is set.
  const tokenPrefix = appt.doctor?.tokenPrefix || "T";
  return appt.tokenNumber != null
    ? `${tokenPrefix}-${appt.tokenNumber}`
    : "—";
}
