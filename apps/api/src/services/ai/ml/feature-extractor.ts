// Feature extraction for the no-show predictor.
//
// Turns an Appointment (+ patient + historical appointment list) into a
// fixed-length numeric feature vector suitable for the logistic regression
// model in `./logistic-regression`.
//
// The feature order is stable (see FEATURE_NAMES below) so weights trained
// in one run can be loaded and scored against in a later run.  Any change
// to this ordering is a breaking change and must bump
// `NO_SHOW_FEATURE_VERSION`.

export const NO_SHOW_FEATURE_VERSION = 1;

/** Minimum information required about a past appointment to compute the
 *  patient's history features. */
export interface PastAppointmentSummary {
  /** AppointmentStatus — only "NO_SHOW" vs everything else is used. */
  status: string;
  /** Appointment calendar date. */
  date: Date | string;
}

/** Input required to extract features for a single appointment. */
export interface FeatureInput {
  /** When the appointment was created. */
  createdAt: Date | string;
  /** Calendar date of the appointment. */
  date: Date | string;
  /** Slot start time in "HH:MM" form (may be null for walk-ins). */
  slotStart?: string | null;
  /** AppointmentType — SCHEDULED or WALK_IN. */
  type?: string | null;
  /** Patient age in whole years (pulled from Patient.age on the DB). */
  patientAge?: number | null;
  /** Patient address string, used for a coarse "has address" feature. */
  patientAddress?: string | null;
  /**
   * Haversine/road distance from the hospital, if known (km).  Callers that
   * don't compute distance should leave this undefined — the extractor will
   * emit 0 in that case.
   */
  distanceKm?: number | null;
  /**
   * Historical appointments for the same patient, excluding the appointment
   * being scored.  Recent (last 12 months) is enough — older ones do not
   * contribute to any feature.
   */
  pastAppointments: PastAppointmentSummary[];
}

/** Stable list of feature names, in the order they appear in the vector. */
export const FEATURE_NAMES = [
  // 1. Historical no-show rate for this patient (0..1, Laplace-smoothed)
  "hist_no_show_rate",
  // 2. Lead time in days (clamped to 0..90)
  "lead_time_days",
  // 3-9. One-hot day-of-week (Sun..Sat)
  "dow_sun",
  "dow_mon",
  "dow_tue",
  "dow_wed",
  "dow_thu",
  "dow_fri",
  "dow_sat",
  // 10-11. Sin/Cos encoded hour-of-day
  "hour_sin",
  "hour_cos",
  // 12. 1 if patient has < 3 past appointments
  "new_patient",
  // 13. 1 if patient had any NO_SHOW in the last 90 days
  "recent_no_show_90d",
  // 14-15. Appointment type one-hot
  "type_scheduled",
  "type_walk_in",
  // 16-20. Age bucket one-hot (<18, 18-34, 35-54, 55-74, 75+)
  "age_lt_18",
  "age_18_34",
  "age_35_54",
  "age_55_74",
  "age_75_plus",
  // 21. Distance from hospital in km (clamped)
  "distance_km",
] as const;

export const NUM_FEATURES = FEATURE_NAMES.length;

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d);
}

/** Parse "HH:MM" → hour number; default to 12 on missing/invalid input. */
function parseHour(slotStart: string | null | undefined): number {
  if (!slotStart) return 12;
  const parts = slotStart.split(":");
  const h = parseInt(parts[0] ?? "", 10);
  if (Number.isNaN(h) || h < 0 || h > 23) return 12;
  return h;
}

/** One-hot encode an age into 5 buckets. */
function ageBucket(age: number | null | undefined): [number, number, number, number, number] {
  const bucket: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  if (age == null || age < 0) {
    // Treat unknown age as adult 35-54 (the modal hospital bucket).
    bucket[2] = 1;
    return bucket;
  }
  if (age < 18) bucket[0] = 1;
  else if (age < 35) bucket[1] = 1;
  else if (age < 55) bucket[2] = 1;
  else if (age < 75) bucket[3] = 1;
  else bucket[4] = 1;
  return bucket;
}

/**
 * Extract a feature vector from an appointment + its patient context.
 *
 * The returned array has length {@link NUM_FEATURES} and uses the order
 * defined in {@link FEATURE_NAMES}.
 *
 * @param input  All data needed to compute the features.  See
 *               {@link FeatureInput}.  `pastAppointments` should exclude the
 *               appointment being scored itself so the feature is not
 *               contaminated.
 * @param now    Reference "current time" used for the recent-no-show window.
 *               Defaults to `new Date()`; pass a fixed value in tests for
 *               reproducibility.
 */
export function extractFeatures(input: FeatureInput, now: Date = new Date()): number[] {
  const apptDate = toDate(input.date);
  const createdAt = toDate(input.createdAt);

  // 1. Historical no-show rate (Laplace smoothing so 0/0 → 0.1 baseline)
  const past = input.pastAppointments ?? [];
  const noShowCount = past.filter((a) => a.status === "NO_SHOW").length;
  const total = past.length;
  // alpha=1, prior=0.1 → (1*0.1 + noShowCount) / (1 + total)
  const histNoShowRate = (0.1 + noShowCount) / (1 + total);

  // 2. Lead time
  const leadTimeDays = Math.max(
    0,
    Math.min(90, Math.floor((apptDate.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24)))
  );

  // 3-9. Day-of-week one-hot
  const dow = apptDate.getDay(); // 0=Sun..6=Sat
  const dowOneHot = [0, 0, 0, 0, 0, 0, 0];
  dowOneHot[dow] = 1;

  // 10-11. Hour sin/cos
  const hour = parseHour(input.slotStart);
  const hourAngle = (2 * Math.PI * hour) / 24;
  const hourSin = Math.sin(hourAngle);
  const hourCos = Math.cos(hourAngle);

  // 12. New patient
  const newPatient = total < 3 ? 1 : 0;

  // 13. Recent no-show in last 90 days
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const recentNoShow = past.some(
    (a) => a.status === "NO_SHOW" && toDate(a.date) >= ninetyDaysAgo
  )
    ? 1
    : 0;

  // 14-15. Appointment type one-hot
  const typeScheduled = input.type === "SCHEDULED" ? 1 : 0;
  const typeWalkIn = input.type === "WALK_IN" ? 1 : 0;

  // 16-20. Age bucket
  const [ageLt18, age18_34, age35_54, age55_74, age75Plus] = ageBucket(input.patientAge);

  // 21. Distance — clamp to [0, 100] km
  let distanceKm = 0;
  if (typeof input.distanceKm === "number" && isFinite(input.distanceKm)) {
    distanceKm = Math.max(0, Math.min(100, input.distanceKm));
  }

  return [
    histNoShowRate,
    leadTimeDays,
    dowOneHot[0],
    dowOneHot[1],
    dowOneHot[2],
    dowOneHot[3],
    dowOneHot[4],
    dowOneHot[5],
    dowOneHot[6],
    hourSin,
    hourCos,
    newPatient,
    recentNoShow,
    typeScheduled,
    typeWalkIn,
    ageLt18,
    age18_34,
    age35_54,
    age55_74,
    age75Plus,
    distanceKm,
  ];
}

/**
 * Turn a prediction probability into the legacy risk bucket used by the
 * rule-based predictor so existing callers keep working without changes.
 */
export function riskBucket(p: number): "low" | "medium" | "high" {
  if (p < 0.25) return "low";
  if (p < 0.55) return "medium";
  return "high";
}

/**
 * Produce a human-readable list of factors that contributed to a prediction.
 * This inspects the raw feature values (not the weights) so it stays stable
 * across model retrains and is easy for the front desk to understand.
 */
export function explainFeatures(input: FeatureInput, now: Date = new Date()): string[] {
  const past = input.pastAppointments ?? [];
  const factors: string[] = [];

  const total = past.length;
  const noShowCount = past.filter((a) => a.status === "NO_SHOW").length;
  if (total >= 5) {
    const rate = noShowCount / total;
    if (rate >= 0.2) {
      factors.push(`High historical no-show rate (${Math.round(rate * 100)}%)`);
    }
  }

  const apptDate = toDate(input.date);
  const createdAt = toDate(input.createdAt);
  const leadDays = Math.max(
    0,
    Math.floor((apptDate.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
  );
  if (leadDays > 14) {
    factors.push(`Appointment booked ${leadDays} days in advance (long lead time)`);
  } else if (leadDays > 7) {
    factors.push(`Appointment booked ${leadDays} days in advance`);
  }

  const dow = apptDate.getDay();
  if (dow === 1) factors.push("Monday appointment (higher no-show day)");
  if (dow === 5) factors.push("Friday appointment (higher no-show day)");

  const hour = parseHour(input.slotStart);
  if (hour >= 17) factors.push("Late afternoon slot (after 5 PM)");
  else if (hour <= 8) factors.push("Very early morning slot (8 AM or earlier)");

  if (total < 3) factors.push("New patient (fewer than 3 prior appointments)");

  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const hasRecent = past.some(
    (a) => a.status === "NO_SHOW" && toDate(a.date) >= ninetyDaysAgo
  );
  if (hasRecent) factors.push("Patient had a no-show in the last 90 days");

  if (typeof input.distanceKm === "number" && input.distanceKm >= 20) {
    factors.push(`Patient lives ${Math.round(input.distanceKm)} km from the hospital`);
  }

  return factors;
}
